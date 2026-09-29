import * as THREE from 'three'

/**
 * Cortes seccionales con "capping" solido.
 *
 * Un simple clipping plane deja la pieza abierta por dentro: el doctor ve
 * el interior del solide y no puede interpretar la seccion. Para tapar el
 * hueco hay que usar el stencil buffer:
 *
 *   1. Se dibuja la geometria con las caras traseras (incrementando el
 *      stencil) y las delanteras (decrementando), recortadas por el plano.
 *      Solo escriben stencil: ni color ni profundidad.
 *   2. El resultado es "hay solido dentro de este plano" (valor distinto
 *      de 0 gracias al wrap del contador).
 *   3. Un quad situado sobre el plano, que solo se pinta donde el stencil
 *      != 0, tapia el hueco con un color solido.
 *
 * Con varios planos, el IncrementWrap hace que la cuenta se componga sola:
 * el capping solo aparece donde el punto queda dentro del solido y en el
 * lado positivo de todos los planos activos.
 */

// Normales positivas: el plano en `offset` conserva la mitad hacia +eje.
const AXES = {
  x: new THREE.Vector3(1, 0, 0),
  y: new THREE.Vector3(0, 1, 0),
  z: new THREE.Vector3(0, 0, 1),
}

const round = (n, decimals = 4) => {
  const f = 10 ** decimals
  return Math.round(n * f) / f
}

export const AXIS_LABELS = {
  x: 'Coronal (izq-der)',
  y: 'Axial / horizontal',
  z: 'Sagital (ant-post)',
}

export class SectionTool {
  /**
   * @param {THREE.WebGLRenderer} renderer
   * @param {{modelRoot: THREE.Object3D, meshes: THREE.Mesh[], size: THREE.Vector3}} ctx
   */
  constructor(renderer, { modelRoot, meshes, size }) {
    this.renderer = renderer
    this.modelRoot = modelRoot
    this.meshes = meshes
    this.size = size.clone()
    this.radius = this.size.length() * 0.75 + 10

    this.capColor = 0xc0554a
    this.enabled = false
    /**
     * Cada plano lleva su propio interruptor: el corte axial, sagital y coronal
     * son cortes distintos y a menudo solo interesa uno. El interruptor global
     * apaga y enciende el juego completo sin perder los offsets.
     * @type {Array<{axis:'x'|'y'|'z', offset:number, enabled:boolean, label:string, color:number}>}
     */
    this.planes = [
      { axis: 'y', offset: 0, enabled: true, label: 'Axial', color: 0xc0554a },
      { axis: 'z', offset: 0, enabled: false, label: 'Sagital', color: 0x4a7fc0 },
      { axis: 'x', offset: 0, enabled: false, label: 'Coronal', color: 0x4a9a63 },
    ]
    this.active = []

    this.stencilGroup = new THREE.Group()
    this.stencilGroup.name = 'section-stencils'
    this.capGroup = new THREE.Group()
    this.capGroup.name = 'section-caps'
    modelRoot.add(this.stencilGroup, this.capGroup)

    this.capGeometry = new THREE.PlaneGeometry(this.radius * 2, this.radius * 2)
    this._clippingPlanes = []
  }

  axisRange(axis) {
    const key = axis.toLowerCase()
    const half = this.size[key] / 2
    return { min: -half, max: half, half }
  }

  setCapColor(hex) {
    this.capColor = hex
    for (const cap of this.capGroup.children) {
      cap.material.color.setHex(hex)
    }
  }

  /**
   * Fusiona una lista de planos con la configuracion actual.
   *
   * No reemplaza la lista: los tres ejes (axial, sagital, coronal) existen
   * siempre y cada uno guarda su offset y su interruptor. Si el archivo de
   * anotaciones solo menciona el eje sagital, el axial conserva lo que tenia
   * en vez de desaparecer.
   */
  configure(planes) {
    const touched = new Set()
    for (const entry of planes ?? []) {
      const axis = String(entry.axis ?? '').toLowerCase()
      if (!AXES[axis]) continue
      touched.add(axis)
      const base = this.planes.find((p) => p.axis === axis)
      if (!base) {
        this.planes.push({
          axis,
          offset: 0,
          enabled: entry.enabled !== false,
          label: entry.label ?? AXIS_LABELS[axis],
          color: entry.color ?? 0xc0554a,
        })
        continue
      }
      if (Number.isFinite(entry.offset)) base.offset = entry.offset
      if (typeof entry.enabled === 'boolean') base.enabled = entry.enabled
      if (typeof entry.label === 'string' && entry.label) base.label = entry.label
      if (Number.isFinite(entry.color)) base.color = entry.color
    }
    // Un documento que solo lista un eje desactiva los demas: si el archivo
    // dice "corte axial activo", el sagital no debe aparecer de la nada.
    if (touched.size && touched.size < this.planes.length) {
      for (const plane of this.planes) {
        if (!touched.has(plane.axis)) plane.enabled = false
      }
    }
    return this.planes
  }

  setOffset(axis, offset) {
    const plane = this.planes.find((p) => p.axis === axis)
    if (!plane) return
    plane.offset = offset
    if (this.enabled) this.apply()
  }

  /** Enciende o apaga un eje concreto sin tocar los demas. */
  setAxisEnabled(axis, enabled) {
    const plane = this.planes.find((p) => p.axis === axis)
    if (!plane) return
    plane.enabled = !!enabled
    if (this.enabled) this.apply()
  }

  isAxisEnabled(axis) {
    return !!this.planes.find((p) => p.axis === axis)?.enabled
  }

  setEnabled(enabled) {
    this.enabled = !!enabled
    this.apply()
  }

  /** Recalcula planos, materiales y capping. */
  apply() {
    this.dispose(false)

    const planes = this.enabled ? this.planes.filter((p) => p.enabled) : []
    this._clippingPlanes = planes.map((p) => {
      const plane = new THREE.Plane()
      const normal = AXES[p.axis].clone()
      plane.setFromNormalAndCoplanarPoint(normal, normal.clone().multiplyScalar(p.offset))
      plane.userData = { axis: p.axis, offset: p.offset, label: p.label }
      return plane
    })

    // El modelo se recorta con los mismos planos.
    for (const mesh of this.meshes) {
      const list = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
      for (const material of list) {
        material.clippingPlanes = planes.length ? this._clippingPlanes : null
        material.clipShadows = true
        material.needsUpdate = true
      }
    }

    if (!planes.length) {
      this.renderer.localClippingEnabled = true
      return
    }

    planes.forEach((plane, i) => {
      this.stencilGroup.add(this._stencilGroup(plane, i + 1))

      const others = this._clippingPlanes.filter((p) => p !== plane)
      const capMaterial = new THREE.MeshStandardMaterial({
        color: plane.color,
        metalness: 0.08,
        roughness: 0.72,
        side: THREE.DoubleSide,
        // El capping de este plano deberespectar los demas planos activos,
        // si no la superficie tapa regiones que ya estan recortadas.
        clippingPlanes: others,
        stencilWrite: true,
        stencilRef: 0,
        stencilFunc: THREE.NotEqualStencilFunc,
        stencilFail: THREE.ReplaceStencilOp,
        stencilZFail: THREE.ReplaceStencilOp,
        stencilZPass: THREE.ReplaceStencilOp,
      })
      const cap = new THREE.Mesh(this.capGeometry, capMaterial)
      cap.name = `cap-${plane.axis}`
      cap.renderOrder = i + 1.1
      cap.onAfterRender = (renderer) => renderer.clearStencil()
      cap.userData.section = plane
      this.capGroup.add(cap)
    })

    this.renderer.localClippingEnabled = true
    this.active = this._clippingPlanes
    this._syncCaps()
  }

  _stencilGroup(plane, renderOrder) {
    const group = new THREE.Group()
    const base = new THREE.MeshBasicMaterial()
    base.depthWrite = false
    base.depthTest = false
    base.colorWrite = false
    base.stencilWrite = true
    base.stencilFunc = THREE.AlwaysStencilFunc

    const back = base.clone()
    back.side = THREE.BackSide
    back.clippingPlanes = [plane]
    back.stencilFail = THREE.IncrementWrapStencilOp
    back.stencilZFail = THREE.IncrementWrapStencilOp
    back.stencilZPass = THREE.IncrementWrapStencilOp

    const front = base.clone()
    front.side = THREE.FrontSide
    front.clippingPlanes = [plane]
    front.stencilFail = THREE.DecrementWrapStencilOp
    front.stencilZFail = THREE.DecrementWrapStencilOp
    front.stencilZPass = THREE.DecrementWrapStencilOp

    for (const mesh of this.meshes) {
      if (!mesh.visible) continue
      const list = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
      if (list.some((m) => m.visible === false)) continue
      const backMesh = new THREE.Mesh(mesh.geometry, back)
      backMesh.renderOrder = renderOrder
      const frontMesh = new THREE.Mesh(mesh.geometry, front)
      frontMesh.renderOrder = renderOrder
      group.add(backMesh, frontMesh)
    }
    return group
  }

  _syncCaps() {
    this.active.forEach((plane, i) => {
      const cap = this.capGroup.children[i]
      if (!cap) return
      plane.coplanarPoint(cap.position)
      cap.lookAt(
        cap.position.x - plane.normal.x,
        cap.position.y - plane.normal.y,
        cap.position.z - plane.normal.z,
      )
      cap.updateMatrix()
    })
  }

  /** Un punto queda "dentro" si esta del lado positivo de todos los planos. */
  isPointVisible(point) {
    if (!this.enabled) return true
    return this._clippingPlanes.every((plane) => plane.distanceToPoint(point) >= 0)
  }

  distanceToPoint(point) {
    if (!this.enabled) return Infinity
    return Math.max(...this._clippingPlanes.map((plane) => -plane.distanceToPoint(point)))
  }

  serialize() {
    return {
      enabled: this.enabled,
      capColor: `#${this.capColor.toString(16).padStart(6, '0')}`,
      planes: this.planes.map((p) => ({
        axis: p.axis,
        offset: round(p.offset),
        enabled: p.enabled,
        label: p.label,
      })),
    }
  }

  restore(data) {
    if (!data) return
    if (data.capColor) {
      const hex = Number.parseInt(String(data.capColor).replace('#', ''), 16)
      if (Number.isFinite(hex)) this.capColor = hex
    }
    if (Array.isArray(data.planes) && data.planes.length) this.configure(data.planes)
    this.enabled = !!data.enabled
    this.apply()
  }

  /**
   * El plano se situa a `offset` mm del centro de la pieza sobre el eje dado,
   * y se conserva la mitad hacia +eje. Devuelve true si el plano toca la
   * geometria, para avisar de que el corte cae fuera de la pieza.
   */
  planeIntersectsBounds(axis, offset) {
    const half = this.size[axis] / 2
    return offset >= -half && offset <= half
  }

  dispose(full = true) {
    this.stencilGroup.traverse((o) => {
      if (o.isMesh) o.material.dispose()
    })
    this.capGroup.traverse((o) => {
      if (o.isMesh) o.material.dispose()
    })
    this.stencilGroup.clear()
    this.capGroup.clear()
    this.active = []

    for (const mesh of this.meshes) {
      const list = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
      for (const material of list) material.clippingPlanes = null
    }
    if (full) this.capGeometry.dispose()
  }
}

export { AXES }
