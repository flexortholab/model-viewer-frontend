import * as THREE from 'three'
import { TransformControls } from 'three/addons/controls/TransformControls.js'

/**
 * Corte seccional con UN plano unico y gizmo.
 *
 * El plano esta anclado al MODELO (es hijo de modelRoot), no a la escena ni a
 * la camara: girar el foco no desplaza el corte; el corte es propiedad de la
 * pieza y gira con ella. Se coloca con un gizmo (TransformControls):
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

    this.enabled = false
    this.mode = 'translate'
    this.capColor = 0xc0554a

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
        color: this.capColor,
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
        color: this.capColor,
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
    this._stencilBack = null
    this._stencilFront = null
    this._stencilMeshes = []

    // Gizmo de transformaciones.
    this.transform = new TransformControls(camera, renderer.domElement)
    this.transform.attach(this.gizmo)
    this._gizmoHelper = this.transform.getHelper ? this.transform.getHelper() : this.transform
    scene.add(this._gizmoHelper)
    this._onGizmoChange = () => {
      if (this.enabled) this.apply()
      this.onChange?.()
    }
    this.transform.addEventListener('change', this._onGizmoChange)
    this.transform.addEventListener('dragging-changed', (event) => {
      // Mientras se arrastra el gizmo, la orbita debe estar quieta.
      if (this.controls) this.controls.enabled = !event.value
    })
    this.transform.visible = false
    this.transform.enabled = false
    this._gizmoHelper.visible = false
  }

  /** Espacio del gizmo: trasladar en mundo, rotar local al plano. */
  setMode(mode) {
    this.mode = mode === 'rotate' ? 'rotate' : 'translate'
    this.transform.setSpace?.(this.mode === 'rotate' ? 'local' : 'world')
  }

  getMode() {
    return this.mode
  }

  setCapColor(hex) {
    this.capColor = hex
    this.planeMesh.material.color.setHex(hex)
    this.ringMesh.material.color.setHex(hex)
  }

  setEnabled(enabled) {
    this.enabled = !!enabled
    this.transform.visible = this.enabled
    this.transform.enabled = this.enabled
    this._gizmoHelper.visible = this.enabled
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
    // La normal (Z local) apunta HACIA la camara: conservamos la mitad cercana.
    this.gizmo.quaternion.setFromUnitVectors(
      new THREE.Vector3(0, 0, 1),
      viewDir.clone().normalize(),
    )
    if (this.enabled) this.apply()
    this.onChange?.()
  }

  /** Recalcula el plano de recorte a partir de la posicion del gizmo. */
  _syncPlane() {
    this.gizmo.updateMatrixWorld(true)
    this.plane.normal.set(0, 0, 1).applyQuaternion(this.gizmo.quaternion)
    this.plane.constant = -this.gizmo.position.dot(this.plane.normal)
  }

  apply() {
    this._syncPlane()
    const planes = this.enabled ? this._clippingPlanes : null
    this._setClipping(planes)
    if (this.enabled) {
      this._buildStencil()
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

  _buildStencil() {
    this._teardownStencil()

    const visibleMeshes = this.meshes.filter(
      (m) => m.visible && !(Array.isArray(m.material) && m.material.some((mat) => mat.visible === false)),
    )
    if (!visibleMeshes.length) return

    const base = new THREE.MeshBasicMaterial()
    base.depthWrite = false
    base.depthTest = false
    base.colorWrite = false
    base.stencilWrite = true
    base.stencilFunc = THREE.AlwaysStencilFunc

    this._stencilBack = base.clone()
    this._stencilBack.side = THREE.BackSide
    this._stencilBack.clippingPlanes = this._clippingPlanes
    this._stencilBack.stencilFail = THREE.IncrementWrapStencilOp
    this._stencilBack.stencilZFail = THREE.IncrementWrapStencilOp
    this._stencilBack.stencilZPass = THREE.IncrementWrapStencilOp

    this._stencilFront = base.clone()
    this._stencilFront.side = THREE.FrontSide
    this._stencilFront.clippingPlanes = this._clippingPlanes
    this._stencilFront.stencilFail = THREE.DecrementWrapStencilOp
    this._stencilFront.stencilZFail = THREE.DecrementWrapStencilOp
    this._stencilFront.stencilZPass = THREE.DecrementWrapStencilOp

    for (const mesh of visibleMeshes) {
      const backMesh = new THREE.Mesh(mesh.geometry, this._stencilBack)
      backMesh.renderOrder = 1
      backMesh.raycast = () => {}
      const frontMesh = new THREE.Mesh(mesh.geometry, this._stencilFront)
      frontMesh.renderOrder = 1
      frontMesh.raycast = () => {}
      this.stencilGroup.add(backMesh, frontMesh)
      this._stencilMeshes.push(backMesh, frontMesh)
    }

    const capMaterial = new THREE.MeshStandardMaterial({
      color: this.capColor,
      metalness: 0.08,
      roughness: 0.72,
      side: THREE.DoubleSide,
      stencilWrite: true,
      stencilRef: 0,
      stencilFunc: THREE.NotEqualStencilFunc,
      stencilFail: THREE.ReplaceStencilOp,
      stencilZFail: THREE.ReplaceStencilOp,
      stencilZPass: THREE.ReplaceStencilOp,
      depthWrite: true,
    })
    this._capMesh = new THREE.Mesh(this._capGeometry, capMaterial)
    this._capMesh.name = 'section-cap'
    // Un pelin por delante del plano (hacia +Z local) para ganar la prueba de
    // profundidad contra la geometria recortada.
    this._capMesh.position.z = 0.015
    this._capMesh.renderOrder = 2
    this._capMesh.raycast = () => {}
    this._capMesh.onAfterRender = (renderer) => renderer.clearStencil()
    this.capGroup.add(this._capMesh)
  }

  _teardownStencil() {
    for (const mesh of this._stencilMeshes) this.stencilGroup.remove(mesh)
    this._stencilMeshes = []
    this._stencilBack?.dispose()
    this._stencilFront?.dispose()
    this._stencilBack = null
    this._stencilFront = null
    if (this._capMesh) {
      this._capMesh.material.dispose()
      this.capGroup.remove(this._capMesh)
      this._capMesh = null
    }
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
      capColor: `#${this.capColor.toString(16).padStart(6, '0')}`,
      point: [round(this.gizmo.position.x), round(this.gizmo.position.y), round(this.gizmo.position.z)],
      normal: [round(normal.x), round(normal.y), round(normal.z)],
      mode: this.mode,
    }
  }

  restore(data) {
    if (!data || typeof data !== 'object') return
    if (typeof data.capColor === 'string') {
      const hex = Number.parseInt(String(data.capColor).replace('#', ''), 16)
      if (Number.isFinite(hex)) this.setCapColor(hex)
    }
    if (data.point || data.normal) {
      this.setPlane({ point: data.point, normal: data.normal })
    }
    this.setEnabled(!!data.enabled)
    if (typeof data.mode === 'string') this.setMode(data.mode)
  }

  dispose() {
    this.transform.removeEventListener('change', this._onGizmoChange)
    this.transform.detach()
    this.transform.dispose?.()
    if (this._gizmoHelper.parent) this._gizmoHelper.parent.remove(this._gizmoHelper)
    this._teardownStencil()
    this._capGeometry.dispose()
    this.planeMesh.geometry.dispose()
    this.planeMesh.material.dispose()
    this.ringMesh.geometry.dispose()
    this.ringMesh.material.dispose()
    this.gizmo.removeFromParent()
    this.stencilGroup.removeFromParent()
  }
}

export { SectionPlaneTool as default }

function round(n, decimals = 4) {
  const f = 10 ** decimals
  return Math.round(n * f) / f
}
