import * as THREE from 'three'
import { MeshmixerGizmo } from './meshmixer-gizmo.js'
import { LineSegments2 } from 'three/addons/lines/LineSegments2.js'
import { LineSegmentsGeometry } from 'three/addons/lines/LineSegmentsGeometry.js'
import { LineMaterial } from 'three/addons/lines/LineMaterial.js'

/**
 * Corte seccional con UN plano unico y gizmo.
 *
 * El plano esta anclado al MODELO (es hijo de modelRoot), no a la escena ni a
 * la camara: girar el foco no desplaza el corte; el corte es propiedad de la
 * pieza y gira con ella. Se coloca con un gizmo tipo Meshmixer (flechas y
 * anillos gruesos) con dos modos:
 *
 *   - Modo MOVER: arrastra el plano por el espacio.
 *   - Modo ROTAR: gira el plano sobre si mismo (espacio local).
 *
 * La superficie de corte se tapa con capping por stencil (caras traseras
 * incrementan el contador, delanteras lo decrementan y un quad coplanar pinta
 * donde el contador no es 0): el interior se ve solido, no hueco.
 *
 * El plano de recorte es una instancia mutable: mover el gizmo solo actualiza
 * su normal/constante y three.js recarga los uniforms en el siguiente render,
 * asi que arrastrar no reconstruye nada.
 */


export class SectionPlaneTool {
  /**
   * @param {THREE.WebGLRenderer} renderer
   * @param {{
   *   scene: THREE.Object3D,
   *   modelRoot: THREE.Object3D,
   *   meshes: THREE.Mesh[],
   *   camera: THREE.Camera,
   *   controls: {enabled: boolean},
   *   onChange: () => void,
   * }} ctx
   */
  constructor(renderer, { scene, modelRoot, meshes, camera, controls, onChange }) {
    this.renderer = renderer
    this.scene = scene
    this.modelRoot = modelRoot
    this.meshes = meshes
    this.camera = camera
    this.controls = controls
    this.onChange = onChange
    this._gizmoForced = null

    this.enabled = false
    this.mode = 'translate'
    this.capColor = 'auto'
    this._seedColor = 0x8a7f72

    // Tamano del visual: envuelve la pieza con margen.
    const box = new THREE.Box3()
    for (const mesh of meshes) {
      if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox()
      box.union(mesh.geometry.boundingBox)
    }
    this.radius = Math.max(box.getSize(new THREE.Vector3()).length() * 0.65, 12)

    // Nodo anclado al modelo, manipulado por el gizmo.
    this.gizmo = new THREE.Group()
    this.gizmo.name = 'section-plane'
    modelRoot.add(this.gizmo)

    // Visual del plano: disco translucido + anillo de borde.
    this.planeMesh = new THREE.Mesh(
      new THREE.CircleGeometry(this.radius, 64),
      new THREE.MeshBasicMaterial({
        color: this._seedColor,
        transparent: true,
        opacity: 0.14,
        side: THREE.DoubleSide,
        depthWrite: false,
      }),
    )
    this.planeMesh.renderOrder = 4
    this.planeMesh.raycast = () => {}
    this.gizmo.add(this.planeMesh)

    this.ringMesh = new THREE.Mesh(
      new THREE.RingGeometry(this.radius * 0.985, this.radius, 96),
      new THREE.MeshBasicMaterial({
        color: this._seedColor,
        transparent: true,
        opacity: 0.5,
        side: THREE.DoubleSide,
        depthWrite: false,
      }),
    )
    this.ringMesh.renderOrder = 5
    this.ringMesh.raycast = () => {}
    this.gizmo.add(this.ringMesh)

    // Tapa (quad coplanar con el corte) y mallas de stencil.
    this.capGroup = new THREE.Group()
    this.capGroup.name = 'section-caps'
    this.gizmo.add(this.capGroup)

    this.stencilGroup = new THREE.Group()
    this.stencilGroup.name = 'section-stencils'
    modelRoot.add(this.stencilGroup)

    // Plano mutable: se refresca al mover el gizmo.
    this.plane = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0)
    this._clippingPlanes = [this.plane]

    this._capGeometry = new THREE.PlaneGeometry(this.radius * 1.9, this.radius * 1.9)
    this._capMesh = null
    this._stencilMeshes = []

    // Curvas de corte exactas (una por pieza): interseccion plano↔triangulos
    // calculada en CPU. Solo el perimetro del corte, sin silueta exterior
    // y sin hueco: la linea nace pegada a la geometria por construccion.
    this.cutGroup = new THREE.Group()
    this.cutGroup.name = 'section-cut-lines'
    modelRoot.add(this.cutGroup)
    this._cutMaterials = new Set()
    this._linesDirty = false
    this._lastVisible = []

    // Gizmo tipo Meshmixer: flechas y anillos gruesos en lugar de las lineas
    // finas de TransformControls. Solo un modo a la vez (mover/rotar).
    this.gizmoMode = 'translate'
    this._gizmoVisible = true
    this.gizmo3d = new MeshmixerGizmo(camera, renderer.domElement, this.gizmo, controls, {
      radius: this.radius,
      onChange: () => {
        if (this.enabled) this.apply({ lines: false })
        this.onChange?.()
      },
      onEnd: () => {
        if (this.enabled) {
          this._syncPlane()
          this._buildCutLines(this._lastVisible.length ? this._lastVisible : this.meshes)
        }
        this.onChange?.()
      },
      tick: () => this._frameTick?.(),
    })

    this.setEnabled(false)
  }

  /** Espacio del gizmo: trasladar en mundo, rotar local al plano. */
  setMode(mode) {
    // Con ambos gizmos activos a la vez, "mode" solo cambia el enfasis en la
    // UI; se mantiene la API por compatibilidad con el bridge.
    this.mode = mode === 'rotate' ? 'rotate' : 'translate'
  }

  getMode() {
    return this.mode
  }

  /** Cambia entre modo mover (flechas) y modo rotar (anillos). */
  setGizmoMode(mode) {
    this.gizmoMode = mode === 'rotate' ? 'rotate' : 'translate'
    this.gizmo3d?.setMode(this.gizmoMode)
  }

  /** Muestra u oculta los gizmos sin perder la posicion del plano. */
  _setGizmoVisible(visible) {
    this._gizmoVisible = !!visible
    if (this._gizmoForced === false) visible = false
    else if (this._gizmoForced === true) visible = true
    this.gizmo3d?.setVisible(visible)
  }

  /** API publica para forzar la visibilidad de los gizmos (p. ej. en movil). */
  setGizmoVisible(visible) {
    this._gizmoForced = visible === false || visible === true ? visible : null
    this._setGizmoVisible(this._gizmoVisible)
  }

  setCapColor(hex) {
    if (hex === 'auto' || hex == null) {
      this.capColor = null
      this.planeMesh.material.color.setHex(this._seedColor)
      this.ringMesh.material.color.setHex(this._seedColor)
      if (this.enabled) this.apply()
      return
    }
    this.capColor = Number.isFinite(hex) ? hex : Number.parseInt(String(hex).replace('#', ''), 16)
    this.planeMesh.material.color.setHex(this.capColor)
    this.ringMesh.material.color.setHex(this.capColor)
  }

  setEnabled(enabled) {
    this.enabled = !!enabled
    // Sin corte: ni visual del plano ni gizmo en pantalla.
    this.gizmo.visible = this.enabled
    this._setGizmoVisible(this.enabled)
    this.apply()
  }

  /** Posiciona el gizmo desde una especificacion {point, normal}. */
  setPlane({ point, normal } = {}) {
    if (Array.isArray(point)) this.gizmo.position.fromArray(point)
    if (Array.isArray(normal)) {
      const n = new THREE.Vector3(...normal)
      if (n.lengthSq() > 1e-12 && Number.isFinite(n.x)) {
        this.gizmo.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), n.normalize())
      }
    }
    if (this.enabled) this.apply()
    this.onChange?.()
  }

  /** Centra el plano en la pieza y lo orienta perpendicular a la vista. */
  reset(camera) {
    const cam = camera ?? this.camera
    const viewDir = new THREE.Vector3()
    cam.getWorldDirection(viewDir)
    this.gizmo.position.set(0, 0, 0)
    // La normal (Z local) sigue la direccion de vista: se recorta la mitad
    // cercana y se conserva la lejana (cutaway estandar).
    this.gizmo.quaternion.setFromUnitVectors(
      new THREE.Vector3(0, 0, 1),
      viewDir.clone().normalize(),
    )
    if (this.enabled) this.apply()
    this.onChange?.()
  }

  /**
   * Rota el plano 90 grados sobre el eje horizontal de la vista (pivote en su
   * posicion actual): un corte de frente pasa a quedar de perfil, y viceversa.
   * Cada pulsacion gira otro 90 grados en el mismo sentido.
   */
  orientToCamera(camera) {
    const cam = camera ?? this.camera
    const axis = new THREE.Vector3(1, 0, 0).applyQuaternion(cam.quaternion).normalize()
    const quarter = new THREE.Quaternion().setFromAxisAngle(axis, Math.PI / 2)
    this.gizmo.quaternion.premultiply(quarter)
    if (this.enabled) this.apply()
    this.onChange?.()
  }

  /** Recalcula el plano de recorte a partir de la posicion del gizmo. */
  _syncPlane() {
    this.gizmo.updateMatrixWorld(true)
    this.plane.normal.set(0, 0, 1).applyQuaternion(this.gizmo.quaternion)
    this.plane.constant = -this.gizmo.position.dot(this.plane.normal)
  }

  apply({ lines = true } = {}) {
    this._syncPlane()
    const planes = this.enabled ? this._clippingPlanes : null
    this._setClipping(planes)
    if (this.enabled) {
      this._buildStencil({ lines })
    } else {
      this._teardownStencil()
    }
    this.renderer.localClippingEnabled = true
  }

  _setClipping(planes) {
    for (const mesh of this.meshes) {
      const list = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
      for (const material of list) {
        material.clippingPlanes = planes
        material.clipShadows = true
        material.needsUpdate = true
      }
    }
  }

  _buildStencil({ lines = true } = {}) {
    this._teardownStencil()

    const visibleMeshes = this.meshes.filter(
      (m) => m.visible && !(Array.isArray(m.material) && m.material.some((mat) => mat.visible === false)),
    )
    this._lastVisible = visibleMeshes
    if (!visibleMeshes.length) return

    // Por pieza: pases de stencil + tapa de CADA malla, con el color de esa
    // pieza ligeramente sombreado. El clear de stencil tras cada tapa (i+1)
    // garantiza que cada tapa pinta solo el interior de su propia pieza.
    visibleMeshes.forEach((mesh, index) => {
      const base = new THREE.MeshBasicMaterial()
      base.depthWrite = false
      base.depthTest = false
      base.colorWrite = false
      base.stencilWrite = true
      base.stencilFunc = THREE.AlwaysStencilFunc

      const back = base.clone()
      back.side = THREE.BackSide
      back.clippingPlanes = this._clippingPlanes
      back.stencilFail = THREE.IncrementWrapStencilOp
      back.stencilZFail = THREE.IncrementWrapStencilOp
      back.stencilZPass = THREE.IncrementWrapStencilOp

      const front = base.clone()
      front.side = THREE.FrontSide
      front.clippingPlanes = this._clippingPlanes
      front.stencilFail = THREE.DecrementWrapStencilOp
      front.stencilZFail = THREE.DecrementWrapStencilOp
      front.stencilZPass = THREE.DecrementWrapStencilOp

      const order = (index + 1) * 2
      const backMesh = new THREE.Mesh(mesh.geometry, back)
      backMesh.renderOrder = order
      backMesh.raycast = () => {}
      const frontMesh = new THREE.Mesh(mesh.geometry, front)
      frontMesh.renderOrder = order
      frontMesh.raycast = () => {}

      const capMaterial = new THREE.MeshStandardMaterial({
        // Color por pieza + trama diagonal tenue como en un plano de taller.
        map: this._hatchMap(this._pieceColor(mesh)),
        roughness: 0.85,
        metalness: 0.05,
        side: THREE.DoubleSide,
        stencilWrite: true,
        stencilRef: 0,
        stencilFunc: THREE.NotEqualStencilFunc,
        stencilFail: THREE.ReplaceStencilOp,
        stencilZFail: THREE.ReplaceStencilOp,
        stencilZPass: THREE.ReplaceStencilOp,
        depthWrite: true,
      })
      const cap = new THREE.Mesh(this._capGeometry, capMaterial)
      cap.name = `cap-${String(mesh.name || index)}`
      cap.position.z = 0.015
      cap.renderOrder = order + 1
      cap.raycast = () => {}
      // Limpiar el stencil despues de esta tapa, antes de la siguiente pieza.
      cap.onAfterRender = (renderer) => renderer.clearStencil()

      this.capGroup.add(cap)
      this.stencilGroup.add(backMesh, frontMesh)
      this._stencilMeshes.push(cap, backMesh, frontMesh)
      this.capGroup.userData.pieceCaps = this.capGroup.userData.pieceCaps || []
      this.capGroup.userData.pieceCaps.push({ mesh, cap })
    })

    if (lines) {
      this._linesDirty = false
      this._buildCutLines(visibleMeshes)
    } else {
      this._linesDirty = true
    }
  }

  /**
   * Curvas de corte exactas, una LineSegments2 por pieza visible.
   *
   * Recorre los triangulos y guarda el segmento donde el plano los cruza
   * (las mallas estan horneadas a identidad: el plano en mundo vale tambien
   * en espacio local). Solo aparece la curva del corte — nunca la silueta
   * exterior — y nace sobre la superficie: sin hueco posible.
   */
  _buildCutLines(visibleMeshes) {
    this._clearCutLines()
    const width = this.renderer.domElement.clientWidth || 1
    const height = this.renderer.domElement.clientHeight || 1
    for (const mesh of visibleMeshes) {
      const segments = cutPlaneSegments(mesh.geometry, this.plane)
      if (!segments.length) continue
      const geometry = new LineSegmentsGeometry()
      geometry.setPositions(segments)
      const material = new LineMaterial({
        // Gris oscuro uniforme y fino para todos los objetos cortados.
        color: 0x4a4a4a,
        linewidth: 1.6,
        depthTest: false,
        transparent: true,
      })
      material.resolution.set(width, height)
      this._cutMaterials.add(material)
      const lines = new LineSegments2(geometry, material)
      lines.name = `cut-${String(mesh.name || mesh.id)}`
      lines.renderOrder = 6
      lines.raycast = () => {}
      // Como las Line2 de medida: el culling con coords de mundo las ocultaria.
      lines.frustumCulled = false
      // Conteo para tests/diagnostico (el atributo position de
      // LineSegmentsGeometry es intercalado: su count no cuenta segmentos).
      let maxAbs = 0
      for (let i = 0; i < segments.length; i++) {
        const v = Math.abs(segments[i])
        if (v > maxAbs) maxAbs = v
      }
      lines.userData.segments = segments.length / 6
      lines.userData.maxAbs = maxAbs
      this.cutGroup.add(lines)
    }
  }

  _clearCutLines() {
    for (const child of [...this.cutGroup.children]) {
      this.cutGroup.remove(child)
      child.geometry?.dispose?.()
      if (child.material && !this._cutMaterials.has(child.material)) child.material?.dispose?.()
    }
    for (const material of this._cutMaterials) material.dispose?.()
    this._cutMaterials.clear()
  }

  /** Grosor de linea constante en pantalla: hay que avisar al resize. */
  setResolution(width, height) {
    for (const material of this._cutMaterials) material.resolution.set(width, height)
  }

  _teardownStencil() {
    for (const mesh of this._stencilMeshes) {
      this.stencilGroup.remove(mesh)
      // Solo el cap tiene material propio (las caras de stencil por pieza
      // comparten grupo); disponer todos con material.
      mesh.material?.dispose?.()
    }
    this._stencilMeshes = []
    this.capGroup.clear()
    this.capGroup.userData.pieceCaps = []
    this._clearCutLines()
    this._capMesh = null
    this._stencilGroups = null
  }

  /** Color de la pieza (ligeramente oscurecido) para la superficie de corte. */
  _pieceColor(mesh) {
    const fallback = 0x9a968f
    const list = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
    const colored = list.find((mat) => mat?.color)
    const base = (colored?.color ?? null)?.clone() ?? new THREE.Color(fallback)
    return base.multiplyScalar(0.86)
  }

  /** Trama diagonal tenue pintada proceduralmente (mapa por color de pieza). */
  _hatchMap(color) {
    color = color?.clone?.() ?? new THREE.Color(0x9a968f)
    const key = color.getHexString()
    const cache = (this._hatchCache ??= new Map())
    if (cache.has(key)) return cache.get(key)

    const canvas = document.createElement('canvas')
    canvas.width = canvas.height = 128
    const ctx = canvas.getContext('2d')
    const light = color.clone().lerp(new THREE.Color(0xffffff), 0.1)
    const dark = color.clone().multiplyScalar(0.9)
    ctx.fillStyle = '#' + light.getHexString()
    ctx.fillRect(0, 0, 128, 128)
    ctx.strokeStyle = '#' + dark.getHexString()
    ctx.lineWidth = 1.4
    ctx.beginPath()
    for (let i = -128; i < 256; i += 10) {
      ctx.moveTo(i, 0)
      ctx.lineTo(i + 128, 128)
    }
    ctx.stroke()
    const texture = new THREE.CanvasTexture(canvas)
    texture.wrapS = texture.wrapT = THREE.RepeatWrapping
    texture.repeat.set(10, 10)
    texture.colorSpace = THREE.SRGBColorSpace
    cache.set(key, texture)
    return texture
  }

  /** Cambio de visibilidad/geometria: reconstruir stencil. */
  refreshMeshes(meshes) {
    this.meshes = meshes
    if (this.enabled) {
      this._buildStencil()
    }
  }

  /** Un punto queda "dentro" si esta del lado positivo de la normal. */
  isPointVisible(point) {
    if (!this.enabled) return true
    this._syncPlane()
    return this.plane.distanceToPoint(point) >= 0
  }

  /** ¿El plano en su posicion actual roza la caja de la pieza? */
  planeIntersectsBounds() {
    if (!this.enabled) return true
    this._syncPlane()
    const box = new THREE.Box3()
    for (const mesh of this.meshes) {
      if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox()
      box.union(mesh.geometry.boundingBox)
    }
    if (box.isEmpty()) return false
    return this.plane.intersectsBox(box)
  }

  serialize() {
    this._syncPlane()
    const normal = new THREE.Vector3(0, 0, 1).applyQuaternion(this.gizmo.quaternion)
    return {
      enabled: this.enabled,
      capColor: this.capColor ?? 'auto',
      point: [round(this.gizmo.position.x), round(this.gizmo.position.y), round(this.gizmo.position.z)],
      normal: [round(normal.x), round(normal.y), round(normal.z)],
      mode: this.mode,
    }
  }

  restore(data) {
    if (!data || typeof data !== 'object') return
    if (typeof data.capColor === 'string') {
      if (data.capColor.toLowerCase() === 'auto') this.setCapColor('auto')
      else {
        const hex = Number.parseInt(String(data.capColor).replace('#', ''), 16)
        if (Number.isFinite(hex)) this.setCapColor(hex)
      }
    }
    if (data.point || data.normal) {
      this.setPlane({ point: data.point, normal: data.normal })
    }
    this.setEnabled(!!data.enabled)
    if (typeof data.mode === 'string') this.setMode(data.mode)
  }

  dispose() {
    this.gizmo3d?.dispose?.()
    this._teardownStencil()
    this._capGeometry.dispose()
    this.planeMesh.geometry.dispose()
    this.planeMesh.material.dispose()
    this.ringMesh.geometry.dispose()
    this.ringMesh.material.dispose()
    this.gizmo.removeFromParent()
    this.stencilGroup.removeFromParent()
    this.cutGroup.removeFromParent()
  }
}

export { SectionPlaneTool as default }

/**
 * Segmentos de interseccion entre un plano y una geometria indexada o no.
 *
 * Devuelve un array plano [x1,y,z1, x2,y2,z2, ...] con el segmento donde el
 * plano cruza cada triangulo (test de cambio de signo por arista con
 * tolerancia; triangulos coplanares se ignoran). Puro: sin three salvo el
 * plano, para poder testearlo en node.
 *
 * @param {THREE.BufferGeometry} geometry con atributo position
 * @param {THREE.Plane} plane en el mismo espacio que la geometria
 */
export function cutPlaneSegments(geometry, plane) {
  const pos = geometry.getAttribute('position')
  if (!pos) return []
  const arr = pos.array
  const index = geometry.getIndex()?.array ?? null
  const triCount = index ? index.length / 3 : pos.count / 3
  const { x: nx, y: ny, z: nz } = plane.normal
  const constant = plane.constant
  const eps = 1e-6
  const out = []

  const dist = (i) => arr[i * 3] * nx + arr[i * 3 + 1] * ny + arr[i * 3 + 2] * nz + constant

  // Cruce de una arista (a,b) con distancias (da,db): interpola el punto.
  const cross = (ia, ib, da, db, target) => {
    const t = da / (da - db)
    target[0] = arr[ia * 3] + (arr[ib * 3] - arr[ia * 3]) * t
    target[1] = arr[ia * 3 + 1] + (arr[ib * 3 + 1] - arr[ia * 3 + 1]) * t
    target[2] = arr[ia * 3 + 2] + (arr[ib * 3 + 2] - arr[ia * 3 + 2]) * t
  }

  const p0 = [0, 0, 0]
  const p1 = [0, 0, 0]
  for (let t = 0; t < triCount; t++) {
    const ia = index ? index[t * 3] : t * 3
    const ib = index ? index[t * 3 + 1] : t * 3 + 1
    const ic = index ? index[t * 3 + 2] : t * 3 + 2
    const da = dist(ia)
    const db = dist(ib)
    const dc = dist(ic)
    const za = Math.abs(da) <= eps
    const zb = Math.abs(db) <= eps
    const zc = Math.abs(dc) <= eps
    // Triangulo coplanar: lo ignoran los vecinos no coplanares (emiten la
    // arista compartida) para no duplicar ni dejar huecos en zonas planas.
    if (za && zb && zc) continue
    // Arista contenida en el plano con el tercer vertice fuera: ESA es la
    // curva de corte (p. ej. plano apoyado en una cara plana del modelo).
    if (za && zb && !zc) {
      out.push(arr[ia * 3], arr[ia * 3 + 1], arr[ia * 3 + 2], arr[ib * 3], arr[ib * 3 + 1], arr[ib * 3 + 2])
      continue
    }
    if (zb && zc && !za) {
      out.push(arr[ib * 3], arr[ib * 3 + 1], arr[ib * 3 + 2], arr[ic * 3], arr[ic * 3 + 1], arr[ic * 3 + 2])
      continue
    }
    if (zc && za && !zb) {
      out.push(arr[ic * 3], arr[ic * 3 + 1], arr[ic * 3 + 2], arr[ia * 3], arr[ia * 3 + 1], arr[ia * 3 + 2])
      continue
    }
    // Mismo lado estricto: no hay cruce.
    const pos1 = da > eps
    const pos2 = db > eps
    const pos3 = dc > eps
    const neg1 = da < -eps
    const neg2 = db < -eps
    const neg3 = dc < -eps
    if ((pos1 && pos2 && pos3) || (neg1 && neg2 && neg3)) continue

    let found = 0
    // Arista a-b
    if ((pos1 && neg2) || (neg1 && pos2)) {
      cross(ia, ib, da, db, found === 0 ? p0 : p1)
      found++
    } else if (found < 2 && Math.abs(da) <= eps && Math.abs(db) > eps) {
      if (found === 0) { p0[0] = arr[ia * 3]; p0[1] = arr[ia * 3 + 1]; p0[2] = arr[ia * 3 + 2] }
      else { p1[0] = arr[ia * 3]; p1[1] = arr[ia * 3 + 1]; p1[2] = arr[ia * 3 + 2] }
      found++
    }
    // Arista b-c
    if (found < 2 && ((pos2 && neg3) || (neg2 && pos3))) {
      cross(ib, ic, db, dc, found === 0 ? p0 : p1)
      found++
    } else if (found < 2 && Math.abs(db) <= eps && Math.abs(dc) > eps) {
      if (found === 0) { p0[0] = arr[ib * 3]; p0[1] = arr[ib * 3 + 1]; p0[2] = arr[ib * 3 + 2] }
      else { p1[0] = arr[ib * 3]; p1[1] = arr[ib * 3 + 1]; p1[2] = arr[ib * 3 + 2] }
      found++
    }
    // Arista c-a
    if (found < 2 && ((pos3 && neg1) || (neg3 && pos1))) {
      cross(ic, ia, dc, da, found === 0 ? p0 : p1)
      found++
    } else if (found < 2 && Math.abs(dc) <= eps && Math.abs(da) > eps) {
      if (found === 0) { p0[0] = arr[ic * 3]; p0[1] = arr[ic * 3 + 1]; p0[2] = arr[ic * 3 + 2] }
      else { p1[0] = arr[ic * 3]; p1[1] = arr[ic * 3 + 1]; p1[2] = arr[ic * 3 + 2] }
      found++
    }
    if (found === 2) {
      // Evita segmentos degenerados (punto tocando el plano en un vertice).
      const dx = p1[0] - p0[0]
      const dy = p1[1] - p0[1]
      const dz = p1[2] - p0[2]
      if (dx * dx + dy * dy + dz * dz > eps * eps) {
        out.push(p0[0], p0[1], p0[2], p1[0], p1[1], p1[2])
      }
    }
  }
  return out
}

function round(n, decimals = 4) {
  const f = 10 ** decimals
  return Math.round(n * f) / f
}
