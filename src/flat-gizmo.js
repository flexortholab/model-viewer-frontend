import * as THREE from 'three'
import { Line2 } from 'three/addons/lines/Line2.js'
import { LineGeometry } from 'three/addons/lines/LineGeometry.js'
import { LineMaterial } from 'three/addons/lines/LineMaterial.js'

/**
 * Gizmo plano tipo cinta para mover/rotar un objeto 3D.
 *
 * Lineas gruesas (Line2) + cabezas de flecha para translacion y anillos
 * gruesos para rotacion. Las mallas de golpe son invisibles pero gruesas,
 * asi que agarrar el gizmo es comodo aunque la linea visible sea fina.
 * Solo se muestra un modo a la vez (mover/rotar) para no saturar la vista.
 */
export class FlatGizmo {
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

    this.group = new THREE.Group()
    this.group.name = 'flat-gizmo'
    this.target.add(this.group)

    this._handles = new Map()
    this._lineMaterials = []
    this._createHandles()

    this._drag = null
    this._plane = new THREE.Plane()
    this._worldPos = new THREE.Vector3()
    this._startPoint = new THREE.Vector3()
    this._startPos = new THREE.Vector3()
    this._startQuat = new THREE.Quaternion()
    this._worldAxis = new THREE.Vector3()
    this._startVector = new THREE.Vector3()
    this._tmpQ = new THREE.Quaternion()
    this._camDir = new THREE.Vector3()

    this._onPointerDown = this._onPointerDown.bind(this)
    this._onPointerMove = this._onPointerMove.bind(this)
    this._onPointerUp = this._onPointerUp.bind(this)

    // Fase de captura para interceptar el gesto antes que la orbita.
    domElement.addEventListener('pointerdown', this._onPointerDown, true)
    window.addEventListener('pointermove', this._onPointerMove)
    window.addEventListener('pointerup', this._onPointerUp)

    this.setResolution(domElement.clientWidth, domElement.clientHeight)
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
    for (const material of this._lineMaterials) material.dispose()
  }

  setResolution(width, height) {
    for (const material of this._lineMaterials) material.resolution.set(width, height)
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

  _lineMat(color) {
    const material = new LineMaterial({
      color,
      linewidth: 4.0,
      transparent: true,
      opacity: 0.95,
      depthTest: false,
    })
    this._lineMaterials.push(material)
    return material
  }

  _hitMat() {
    return new THREE.MeshBasicMaterial({
      transparent: true,
      opacity: 0,
      depthTest: false,
      side: THREE.DoubleSide,
    })
  }

  _createHandles() {
    const r = this.radius
    const len = r * 0.55
    const ringR = r * 0.50
    const hitRadius = r * 0.07
    const arrowHeadR = r * 0.07
    const arrowHeadH = r * 0.12

    const axes = [
      { name: 'x', dir: new THREE.Vector3(1, 0, 0), color: 0xef4444 },
      { name: 'y', dir: new THREE.Vector3(0, 1, 0), color: 0x22c55e },
      { name: 'z', dir: new THREE.Vector3(0, 0, 1), color: 0x3b82f6 },
    ]

    for (const { name, dir, color } of axes) {
      // --- Flecha de translacion: linea gruesa + cabeza ---
      const arrow = new THREE.Group()
      arrow.name = `translate-${name}`
      arrow.userData = { mode: 'translate', axis: name }

      const end = dir.clone().multiplyScalar(len)
      const lineGeo = new LineGeometry().setPositions([0, 0, 0, end.x, end.y, end.z])
      const line = new Line2(lineGeo, this._lineMat(color))
      line.renderOrder = 1001
      line.raycast = () => {}
      arrow.add(line)

      const head = new THREE.Mesh(
        new THREE.ConeGeometry(arrowHeadR, arrowHeadH, 16),
        new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.95, depthTest: false }),
      )
      head.position.copy(end)
      head.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir)
      head.renderOrder = 1002
      arrow.add(head)

      // Cilindro invisible de golpe grueso.
      const hit = new THREE.Mesh(
        new THREE.CylinderGeometry(hitRadius, hitRadius, len, 12),
        this._hitMat(),
      )
      hit.position.copy(end).multiplyScalar(0.5)
      hit.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir)
      arrow.add(hit)

      this._handles.set(arrow.name, arrow)
      this.group.add(arrow)

      // --- Anillo de rotacion: circulo grueso + toro invisible ---
      const ring = new THREE.Group()
      ring.name = `rotate-${name}`
      ring.userData = { mode: 'rotate', axis: name }

      const circlePoints = []
      const segments = 64
      for (let i = 0; i <= segments; i++) {
        const a = (i / segments) * Math.PI * 2
        let p
        if (name === 'x') p = new THREE.Vector3(0, Math.cos(a) * ringR, Math.sin(a) * ringR)
        else if (name === 'y') p = new THREE.Vector3(Math.cos(a) * ringR, 0, Math.sin(a) * ringR)
        else p = new THREE.Vector3(Math.cos(a) * ringR, Math.sin(a) * ringR, 0)
        circlePoints.push(p.x, p.y, p.z)
      }
      const ringGeo = new LineGeometry().setPositions(circlePoints)
      const ringLine = new Line2(ringGeo, this._lineMat(color))
      ringLine.renderOrder = 1001
      ringLine.raycast = () => {}
      ring.add(ringLine)

      const ringHit = new THREE.Mesh(
        new THREE.TorusGeometry(ringR, hitRadius, 12, 48),
        this._hitMat(),
      )
      if (name === 'x') ringHit.rotation.y = Math.PI / 2
      if (name === 'y') ringHit.rotation.x = Math.PI / 2
      ring.add(ringHit)

      this._handles.set(ring.name, ring)
      this.group.add(ring)
    }

    // Mango central para mover libremente en el plano de la camara.
    const center = new THREE.Group()
    center.name = 'translate-center'
    center.userData = { mode: 'translate', axis: 'center' }
    const centerVis = new THREE.Mesh(
      new THREE.SphereGeometry(r * 0.06, 16, 12),
      new THREE.MeshBasicMaterial({ color: 0xf59e0b, transparent: true, opacity: 0.95, depthTest: false }),
    )
    centerVis.renderOrder = 1002
    center.add(centerVis)
    const centerHit = new THREE.Mesh(
      new THREE.SphereGeometry(r * 0.10, 16, 12),
      this._hitMat(),
    )
    center.add(centerHit)
    this._handles.set(center.name, center)
    this.group.add(center)
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
      if (axisName === 'center') {
        this.camera.getWorldDirection(this._worldAxis)
      } else {
        this._worldAxis.set(axisName === 'x' ? 1 : 0, axisName === 'y' ? 1 : 0, axisName === 'z' ? 1 : 0)
        this.target.localToWorld(this._worldAxis)
        this._worldAxis.sub(this._worldPos).normalize()
        this.camera.getWorldDirection(this._camDir)
        // Plano perpendicular a la camara para arrastrar comodamente.
        this._plane.setFromNormalAndCoplanarPoint(this._camDir, this._worldPos)
      }
      if (axisName !== 'center') {
        this.raycaster.ray.intersectPlane(this._plane, this._startPoint)
      } else {
        this.camera.getWorldDirection(this._worldAxis)
        this._plane.setFromNormalAndCoplanarPoint(this._worldAxis, this._worldPos)
        this.raycaster.ray.intersectPlane(this._plane, this._startPoint)
      }
      this._startPos.copy(this.target.position)
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
      this.camera.getWorldDirection(this._camDir)
      if (this._camDir.dot(this._worldAxis) < 0) angle = -angle
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
