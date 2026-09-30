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

    // Dos gizmos sobre el mismo plano: flechas (mover) y anillos (rotar)
    // siempre visibles; mientras se arrastra uno, el otro queda bloqueado
    // para que la orbita no capture el gesto.
    this.transformT = new TransformControls(camera, renderer.domElement)
    this.transformT.setMode?.('translate')
    this.transformT.attach(this.gizmo)
    this._helperT = this.transformT.getHelper ? this.transformT.getHelper() : this.transformT
    scene.add(this._helperT)

    this.transformR = new TransformControls(camera, renderer.domElement)
    this.transformR.setMode?.('rotate')
    this.transformR.setSpace?.('local')
    this.transformR.attach(this.gizmo)
    this._helperR = this.transformR.getHelper ? this.transformR.getHelper() : this.transformR
    scene.add(this._helperR)

    this._onGizmoChange = () => {
      if (this.enabled) this.apply()
      this.onChange?.()
    }
    for (const [own, other] of [[this.transformT, this.transformR], [this.transformR, this.transformT]]) {
      own.addEventListener('change', this._onGizmoChange)
      own.addEventListener('dragging-changed', (event) => {
        // Mientras se arrastra un gizmo: orbita quieta y el otro bloqueado.
        if (this.controls) this.controls.enabled = !event.value
        other.enabled = !event.value
      })
    }
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

  /** Muestra u oculta los gizmos sin perder la posicion del plano. */
  _setGizmoVisible(visible) {
    this.transformT.enabled = visible
    this.transformR.enabled = visible
    this._helperT.visible = visible
    this._helperR.visible = visible
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

      // Contorno del corte por pieza: malla "hull invertida" (caras traseras)
      // engrandecida un pelin: queda visible solo como ribete en el borde
      // del corte y en la silueta exterior de la pieza.
      if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox()
      const mBox = mesh.geometry.boundingBox
      const mCenter = mBox.getCenter(new THREE.Vector3())
      const mRadius = Math.max(mBox.getSize(new THREE.Vector3()).length() / 2, 1)
      const growth = Math.max(this.radius * 1.5385 * 0.0035, 0.4) // radius ≈ diag*0.65
      const factor = 1 + growth / mRadius
      const outlineColor = (this._pieceColor(mesh) ?? new THREE.Color(this._seedColor)).multiplyScalar(0.62)
      const outline = new THREE.Mesh(
        mesh.geometry,
        new THREE.MeshBasicMaterial({
          color: outlineColor,
          side: THREE.BackSide,
          clippingPlanes: this._clippingPlanes,
        }),
      )
      // Escalar la pieza sobre su propio centro (matrixAutoUpdate off).
      outline.position.copy(mCenter).multiplyScalar(1 - factor)
      outline.scale.setScalar(factor)
      outline.quaternion.identity()
      outline.updateMatrix()
      outline.matrixAutoUpdate = false
      outline.renderOrder = order - 1
      outline.raycast = () => {}
      this.stencilGroup.add(outline)
      this._stencilMeshes.push(outline)
    })
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
    const light = color.clone().lerp(new THREE.Color(0xffffff), 0.25)
    const dark = color.clone().multiplyScalar(0.72)
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
    texture.repeat.set(6, 6)
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
    for (const transform of [this.transformT, this.transformR]) {
      transform.removeEventListener('change', this._onGizmoChange)
      transform.detach()
      transform.dispose?.()
      transform.removeEventListener('dragging-changed', () => {})
    }
    for (const helper of [this._helperT, this._helperR]) {
      if (helper.parent) helper.parent.remove(helper)
    }
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
