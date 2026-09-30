import * as THREE from 'three'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js'
import { KTX2Loader } from 'three/addons/loaders/KTX2Loader.js'
import { STLLoader } from 'three/addons/loaders/STLLoader.js'
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js'
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js'
import { ThreeMFLoader } from 'three/addons/loaders/3MFLoader.js'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js'

import { detectUnits } from './units.js'

const SUPPORTED = ['glb', 'gltf', 'stl', 'obj', 'fbx', '3mf']

export function extensionOf(url = '') {
  const clean = String(url).split('?')[0].split('#')[0]
  const ext = clean.includes('.') ? clean.split('.').pop() : ''
  return ext.toLowerCase()
}

export function isSupported(url) {
  return SUPPORTED.includes(extensionOf(url))
}

let dracoLoader = null
let ktx2Loader = null

function getDraco(renderer) {
  if (!dracoLoader) {
    dracoLoader = new DRACOLoader()
    dracoLoader.setDecoderPath(new URL('draco/', document.baseURI).href)
  }
  if (renderer) dracoLoader.setWorkerLimit(4)
  return dracoLoader
}

function getKtx2(renderer) {
  if (!ktx2Loader && renderer) {
    ktx2Loader = new KTX2Loader()
    ktx2Loader.setTranscoderPath(new URL('basis/', document.baseURI).href)
    ktx2Loader.detectSupport(renderer)
  }
  return ktx2Loader
}

/**
 * Carga un modelo por extension. Devuelve el objeto raiz de three.
 */
export async function loadModel(url, { renderer, onProgress } = {}) {
  const ext = extensionOf(url)
  const report = (fraction, label) => onProgress?.(fraction, label)

  switch (ext) {
    case 'glb':
    case 'gltf': {
      const loader = new GLTFLoader()
      loader.setDRACOLoader(getDraco(renderer))
      const ktx2 = getKtx2(renderer)
      if (ktx2) loader.setKTX2Loader(ktx2)
      loader.setMeshoptDecoder(MeshoptDecoder)
      const gltf = await loader.loadAsync(url, (e) => {
        if (e.total) report(e.loaded / e.total, 'glb')
      })
      return gltf.scene
    }
    case 'stl': {
      const loader = new STLLoader()
      const geometry = await loader.loadAsync(url, (e) => {
        if (e.total) report(e.loaded / e.total, 'stl')
      })
      geometry.computeVertexNormals()
      const mesh = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial())
      return mesh
    }
    case 'obj': {
      const loader = new OBJLoader()
      const group = await loader.loadAsync(url, (e) => {
        if (e.total) report(e.loaded / e.total, 'obj')
      })
      return group
    }
    case 'fbx': {
      const loader = new FBXLoader()
      const group = await loader.loadAsync(url, (e) => {
        if (e.total) report(e.loaded / e.total, 'fbx')
      })
      return group
    }
    case '3mf': {
      const loader = new ThreeMFLoader()
      const group = await loader.loadAsync(url, (e) => {
        if (e.total) report(e.loaded / e.total, '3mf')
      })
      return group
    }
    default:
      throw new Error(
        `Formato "${ext || 'desconocido'}" no soportado. Admitidos: ${SUPPORTED.join(', ')}`,
      )
  }
}

const KEEP_ATTRS = ['position', 'normal', 'uv']

/** Reduce una geometria a position/normal/uv para poder fusionarla. */
export function normalizeAttributes(geometry) {
  for (const name of Object.keys(geometry.attributes)) {
    if (!KEEP_ATTRS.includes(name)) geometry.deleteAttribute(name)
  }
  if (!geometry.getAttribute('normal')) geometry.computeVertexNormals()
  if (!geometry.getAttribute('uv')) {
    const count = geometry.getAttribute('position').count
    geometry.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(count * 2), 2))
  }
  geometry.morphAttributes = {}
  return geometry
}

/**
 * Deja el modelo en un espacio de coordenadas canonico:
 *   - todas las mallas con transformacion identidad (geometria horneada)
 *   - escala real en milimetros
 *   - centrado en el origen
 * Devuelve los metadatos de unidades y las estadisticas.
 */
export function normalizeModel(root, { forcedUnits = null, merge = false } = {}) {
  root.updateMatrixWorld(true)

  const meshes = []
  root.traverse((child) => {
    if (child.isMesh && child.geometry?.getAttribute('position')) meshes.push(child)
  })
  if (!meshes.length) throw new Error('El archivo no contiene geometria.')

  // 1. Hornear transformaciones en la geometria.
  for (const mesh of meshes) {
    mesh.geometry.applyMatrix4(mesh.matrixWorld)
    mesh.matrix.identity()
    mesh.position.set(0, 0, 0)
    mesh.quaternion.identity()
    mesh.scale.set(1, 1, 1)
    mesh.updateMatrix()
    mesh.matrixAutoUpdate = false
  }

  // 2. Medir en unidades del archivo.
  const rawBox = new THREE.Box3()
  for (const mesh of meshes) mesh.geometry.computeBoundingBox()
  for (const mesh of meshes) rawBox.union(mesh.geometry.boundingBox)
  const rawSize = rawBox.getSize(new THREE.Vector3())
  const maxDimRaw = Math.max(rawSize.x, rawSize.y, rawSize.z)

  // 3. Detectar unidades y escalar a mm.
  const units = detectUnits(maxDimRaw, forcedUnits)
  if (units.scale !== 1) {
    for (const mesh of meshes) mesh.geometry.scale(units.scale, units.scale, units.scale)
  }

  // 4. Centrar en el origen.
  const box = new THREE.Box3()
  for (const mesh of meshes) mesh.geometry.computeBoundingBox()
  for (const mesh of meshes) box.union(mesh.geometry.boundingBox)
  const center = box.getCenter(new THREE.Vector3())
  for (const mesh of meshes) mesh.geometry.translate(-center.x, -center.y, -center.z)

  // 5. Fusionar opcionalmente (FBX/OBJ llegan con cientos de mallas).
  let outputMeshes = meshes
  if (merge && meshes.length > 1) {
    const geometries = meshes.map((m) => normalizeAttributes(m.geometry))
    try {
      const merged = mergeGeometries(geometries, false)
      if (merged) {
        merged.computeBoundingBox()
        for (const mesh of meshes) {
          mesh.parent?.remove(mesh)
          mesh.geometry.dispose()
        }
        const mesh = new THREE.Mesh(merged, new THREE.MeshStandardMaterial())
        mesh.matrixAutoUpdate = false
        outputMeshes = [mesh]
      }
    } catch {
      // Si los atributos no cuadran, seguimos con las mallas separadas.
      outputMeshes = meshes
    }
  }

  const stats = countStats(outputMeshes)
  const bounds = new THREE.Box3()
  for (const mesh of outputMeshes) {
    if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox()
    bounds.union(mesh.geometry.boundingBox)
  }

  return {
    meshes: outputMeshes,
    units,
    bounds,
    size: bounds.getSize(new THREE.Vector3()),
    stats,
  }
}

export function countStats(meshes) {
  let triangles = 0
  let vertices = 0
  let materials = new Set()
  for (const mesh of meshes) {
    const pos = mesh.geometry.getAttribute('position')
    vertices += pos.count
    const index = mesh.geometry.getIndex()
    triangles += index ? index.count / 3 : pos.count / 3
    if (Array.isArray(mesh.material)) mesh.material.forEach((m) => materials.add(m.uuid))
    else if (mesh.material) materials.add(mesh.material.uuid)
  }
  return {
    triangles: Math.round(triangles),
    vertices,
    meshes: meshes.length,
    materials: materials.size,
  }
}

export function applyDentalMaterial(meshes, options = {}) {
  const {
    color = 0xd9d5cc,
    roughness = 0.42,
    metalness = 0.05,
    side = THREE.DoubleSide,
  } = options

  for (const mesh of meshes) {
    mesh.castShadow = true
    mesh.receiveShadow = true
    mesh.material.clippingPlanes = null
    const list = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
    for (const material of list) {
      material.color?.setHex(color)
      if ('roughness' in material) material.roughness = roughness
      if ('metalness' in material) material.metalness = metalness
      material.side = side
      material.needsUpdate = true
    }
  }
}

/**
 * Prepara los materiales de una exportacion a color SIN recolorearlos:
 * conserva el color/texturas del GLB/FBX, solo arregla los detalles que
 * afectan a la revision (doble cara y materiales por defecto virados a un
 * gris neutro para que se vean sobre fondo blanco).
 */
export function prepareMaterialsForReview(meshes) {
  for (const mesh of meshes) {
    mesh.castShadow = true
    mesh.receiveShadow = true
    mesh.material.clippingPlanes = null
    const list = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
    for (const material of list) {
      if (!material.map && 'color' in material && material.color?.getHex() === 0xffffff) {
        // Material virgen (STL procedural/cad): gris neutro para verlo sobre blanco.
        material.color.setHex(0xc9c4bc)
      }
      material.side = THREE.DoubleSide
      material.needsUpdate = true
    }
  }
}
