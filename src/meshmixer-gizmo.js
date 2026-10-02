import * as THREE from 'three'

/**
 * Gizmo tipo Meshmixer para mover/rotar un objeto 3D.
 *
 * Crea flechas gruesas para translacion y anillos gruesos para rotacion,
 * mucho mas faciles de agarrar que las lineas finas de TransformControls.
 * Solo se muestra un modo a la vez (mover o rotar) para no saturar la vista.
 */
export class MeshmixerGizmo {
  /**
   * @param {THREE.Camera} camera
   * @param {HTMLElement} domElement
   * @param {THREE.Group} target objeto que se manipula
   * @param {THREE.OrbitControls|ArcballControls} controls
   * @param {object} [options]
   * @param {number} [options.radius] escala del gizmo
   * @param {() => void} [options.onChange] llamado en cada cambio
   * @param {() => void} [options.onEnd] llamado al soltar
   * @param {() => void} [options.tick] pide un frame de render
   */
  constructor(camera, domElement, target, controls, options = {}) {
    this.camera = camera
    this.domElement = domElement
    this.target = target
    this.controls = controls
    this.radius = options.radius ?? 10
    this.onChange = options.onChange ?? (() => {})
    this.onEnd = options.onEnd ?? (() => {})
    this.tick = options.tick ?? (() => {})

    this.mode = 'translate'
    this.visible = false
    this.raycaster = new THREE.Raycaster()
    this.raycaster.linePrecision = 0.2

    this.group = new THREE.Group()
    this.group.name = 'meshmixer-gizmo'
    this.target.add(this.group)

    this._handles = new Map()
    this._createHandles()

    this._drag = null
    this._plane = new THREE.Plane()
    this._worldPos = new THREE.Vector3()
    this._startPoint = new THREE.Vector3()
    this._startQuat = new THREE.Quaternion()
    this._worldAxis = new THREE.Vector3()
    this._startVector = new THREE.Vector3()
    this._tmpQ = new THREE.Quaternion()

    this._onPointerDown = this._onPointerDown.bind(this)
    this._onPointerMove = this._onPointerMove.bind(this)
    this._onPointerUp = this._onPointerUp.bind(this)

    // Fase de captura para interceptar el gesto antes que los controles de
    // orbita de la camara.
    domElement.addEventListener('pointerdown', this._onPointerDown, true)
    window.addEventListener('pointermove', this._onPointerMove)
    window.addEventListener('pointerup', this._onPointerUp)
  }

  dispose() {
    this.domElement.removeEventListener('pointerdown', this._onPointerDown, true)
    window.removeEventListener('pointermove', this._onPointerMove)
    window.removeEventListener('pointerup', this._onPointerUp)
    this.target.remove(this.group)
    for (const handle of this._handles.values()) {
      handle.traverse((node) => {
        node.geometry?.dispose?.()
        node.material?.dispose?.()
      })
    }
  }

  setMode(mode) {
    this.mode = mode === 'rotate' ? 'rotate' : 'translate'
    this._updateVisibility()
  }

  setVisible(visible) {
    this.visible = !!visible
    this._updateVisibility()
  }

  _updateVisibility() {
    for (const [key, handle] of this._handles) {
      const [mode] = key.split('-')
      handle.visible = this.visible && mode === this.mode
    }
  }

  _createHandles() {
    const r = this.radius
    const arrowLen = r * 0.55
    const arrowHead = r * 0.16
    const shaftR = r * 0.04
    const torusR = r * 0.45
    const tubeR = r * 0.045

    const axes = [
      { name: 'x', dir: new THREE.Vector3(1, 0, 0), color: 0xef4444 },
      { name: 'y', dir: new THREE.Vector3(0, 1, 0), color: 0x22c55e },
      { name: 'z', dir: new THREE.Vector3(0, 0, 1), color: 0x3b82f6 },
    ]

    for (const { name, dir, color } of axes) {
      // --- Flecha de translacion ---
      const arrow = new THREE.Group()
      arrow.name = `translate-${name}`
      arrow.userData = { mode: 'translate', axis: name }

      const shaftGeo = new THREE.CylinderGeometry(shaftR, shaftR, arrowLen, 16)
      shaftGeo.translate(0, arrowLen / 2, 0)
      const shaft = new THREE.Mesh(shaftGeo, this._mat(color))
      shaft.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir)
      arrow.add(shaft)

      const headGeo = new THREE.ConeGeometry(arrowHead, arrowHead * 1.6, 20)
      headGeo.translate(0, arrowHead * 0.8, 0)
      const head = new THREE.Mesh(headGeo, this._mat(color))
      head.position.copy(dir).multiplyScalar(arrowLen)
      head.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir)
      arrow.add(head)

      this._handles.set(arrow.name, arrow)
      this.group.add(arrow)

      // --- Anillo de rotacion ---
      const ring = new THREE.Group()
      ring.name = `rotate-${name}`
      ring.userData = { mode: 'rotate', axis: name }

      const ringGeo = new THREE.TorusGeometry(torusR, tubeR, 16, 64)
      const ringMesh = new THREE.Mesh(ringGeo, this._mat(color))
      if (name === 'x') ringMesh.rotation.y = Math.PI / 2
      if (name === 'y') ringMesh.rotation.x = Math.PI / 2
      // z es el plano por defecto
      ring.add(ringMesh)

      this._handles.set(ring.name, ring)
      this.group.add(ring)
    }

    // Mango central para mover libremente en el plano de la camara.
    const center = new THREE.Mesh(
      new THREE.SphereGeometry(r * 0.08, 16, 12),
      this._mat(0xf59e0b),
    )
    center.name = 'translate-center'
    center.userData = { mode: 'translate', axis: 'center' }
    this._handles.set(center.name, center)
    this.group.add(center)
  }

  _mat(color) {
    return new THREE.MeshBasicMaterial({
      color,
      transparent: true,
      opacity: 0.9,
      depthTest: false,
      side: THREE.DoubleSide,
    })
  }

  _getPointer(event) {
    const rect = this.domElement.getBoundingClientRect()
    return {
      x: ((event.clientX - rect.left) / rect.width) * 2 - 1,
      y: -((event.clientY - rect.top) / rect.height) * 2 + 1,
    }
  }

  _intersectHandle(event) {
    const pointer = this._getPointer(event)
    this.raycaster.setFromCamera(pointer, this.camera)
    const hits = this.raycaster.intersectObjects(Array.from(this._handles.values()), true)
    if (!hits.length) return null
    let node = hits[0].object
    while (node && !node.userData?.mode) node = node.parent
    return node
  }

  _onPointerDown(event) {
    if (!this.visible) return
    const handle = this._intersectHandle(event)
    if (!handle) return
    event.preventDefault()
    event.stopPropagation()
    if (this.controls) this.controls.enabled = false

    this.target.getWorldPosition(this._worldPos)
    const axisName = handle.userData.axis
    const mode = handle.userData.mode

    if (mode === 'translate') {
      this.camera.getWorldDirection(this._worldAxis)
      this._plane.setFromNormalAndCoplanarPoint(this._worldAxis, this._worldPos)
      this.raycaster.ray.intersectPlane(this._plane, this._startPoint)
      this._startPos = this.target.position.clone()

      if (axisName !== 'center') {
        this._worldAxis.set(axisName === 'x' ? 1 : 0, axisName === 'y' ? 1 : 0, axisName === 'z' ? 1 : 0)
        this.target.localToWorld(this._worldAxis)
        this._worldAxis.sub(this._worldPos).normalize()
      }

      this._drag = { mode: 'translate', axis: axisName }
    } else {
      this._worldAxis.set(axisName === 'x' ? 1 : 0, axisName === 'y' ? 1 : 0, axisName === 'z' ? 1 : 0)
      this.target.localToWorld(this._worldAxis)
      this._worldAxis.sub(this._worldPos).normalize()
      this._plane.setFromNormalAndCoplanarPoint(this._worldAxis, this._worldPos)
      this.raycaster.ray.intersectPlane(this._plane, this._startPoint)
      this._startVector.subVectors(this._startPoint, this._worldPos).normalize()
      this._startQuat.copy(this.target.quaternion)

      this._drag = { mode: 'rotate', axis: axisName }
    }

    this.domElement.setPointerCapture?.(event.pointerId)
    this.tick()
  }

  _onPointerMove(event) {
    if (!this._drag) return
    event.preventDefault()

    this.target.getWorldPosition(this._worldPos)
    const pointer = this._getPointer(event)
    this.raycaster.setFromCamera(pointer, this.camera)
    const point = new THREE.Vector3()
    if (!this.raycaster.ray.intersectPlane(this._plane, point)) return

    if (this._drag.mode === 'translate') {
      if (this._drag.axis === 'center') {
        const delta = point.sub(this._startPoint)
        this.target.position.copy(this._startPos).add(delta)
      } else {
        const delta = point.sub(this._startPoint).dot(this._worldAxis)
        this.target.position.copy(this._startPos).addScaledVector(this._worldAxis, delta)
      }
    } else {
      const vector = new THREE.Vector3().subVectors(point, this._worldPos).normalize()
      const dot = this._startVector.dot(vector)
      const cross = new THREE.Vector3().crossVectors(this._startVector, vector)
      let angle = Math.atan2(cross.dot(this._worldAxis), dot)
      // Invertir angulo segun la orientacion de la camara para que el gesto
      // siga al cursor de forma natural.
      this.camera.getWorldDirection(this._tmpQ) // reusar vector
      if (this._tmpQ.dot(this._worldAxis) < 0) angle = -angle
      this._tmpQ.setFromAxisAngle(this._worldAxis, angle)
      this.target.quaternion.copy(this._tmpQ).multiply(this._startQuat)
    }

    this.onChange()
    this.tick()
  }

  _onPointerUp(event) {
    if (!this._drag) return
    this._drag = null
    if (this.controls) this.controls.enabled = true
    this.domElement.releasePointerCapture?.(event.pointerId)
    this.onEnd()
    this.tick()
  }
}
