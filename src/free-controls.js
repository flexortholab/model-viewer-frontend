import * as THREE from 'three'
import { ArcballControls } from 'three/addons/controls/ArcballControls.js'

/**
 * Envoltura de ArcballControls que expone la misma superficie que el visor ya
 * consume de OrbitControls (target, update(), enabled, addEventListener,
 * dispose) mas los metodos de angulo que usa el cubo de vistas.
 *
 * Motivo: OrbitControls trabaja en coordenadas esfericas con polar limitado a
 * [0, PI], asi que el arrastre se clava al llegar a superior (0) e inferior
 * (PI) y no se puede seguir dando la vuelta. ArcballControls rota por
 * quaterniones alrededor de un centro fijo y no tiene polos.
 */
export class FreeOrbitControls extends THREE.EventDispatcher {
  constructor(camera, domElement) {
    super()
    this.camera = camera
    // Sin escena a proposito: ArcballControls solo la usa para inyectar su
    // gizmo decorativo en la escena (scene.add(this._gizmos)), que aqui
    // rompe el render. Para girar no hace falta.
    this.arc = new ArcballControls(camera, domElement)
    this.arc.enablePan = true
    this.arc.enableRotate = true
    this.arc.enableZoom = true
    // Arcball usa dampingFactor en escala de retardo (25 = rapido); se expone
    // el valor de OrbitControls solo para no romper quien lo lea.
    this.arc.dampingFactor = 22
    this.arc.rotateSpeed = 0.9
    this.minDistance = 0
    this.maxDistance = Infinity
    this.enableDamping = true
    this.screenSpacePanning = true

    // Arcball ya emite 'change' en su propio bucle de animacion. Reenviarlo es
    // lo que mantiene el render bajo demanda del visor y el cubo al dia.
    this._onArcChange = () => this.dispatchEvent({ type: 'change' })
    this.arc.addEventListener('change', this._onArcChange)
    this._onArcEnd = () => this.dispatchEvent({ type: 'end' })
    this.arc.addEventListener('end', this._onArcEnd)
  }

  get target() {
    return this.arc.target
  }

  set target(value) {
    this.arc.target.copy(value)
  }

  get enabled() {
    return this.arc.enabled
  }

  set enabled(value) {
    this.arc.enabled = value
  }

  get dampingFactor() {
    return this.arc.dampingFactor
  }

  set dampingFactor(value) {
    this.arc.dampingFactor = value
  }

  get rotateSpeed() {
    return this.arc.rotateSpeed
  }

  set rotateSpeed(value) {
    this.arc.rotateSpeed = value
  }

  get minDistance() {
    return this.arc.minDistance
  }

  set minDistance(value) {
    this.arc.minDistance = value
  }

  get maxDistance() {
    return this.arc.maxDistance
  }

  set maxDistance(value) {
    this.arc.maxDistance = value
  }

  get enableRotate() {
    return this.arc.enableRotate
  }

  set enableRotate(value) {
    this.arc.enableRotate = value
  }

  get enableZoom() {
    return this.arc.enableZoom
  }

  set enableZoom(value) {
    this.arc.enableZoom = value
  }

  get enablePan() {
    return this.arc.enablePan
  }

  set enablePan(value) {
    this.arc.enablePan = value
  }

  /**
   * Distancia de la camara al objetivo. El encuadre y las medidas dependen de
   * que exista aunque ArcballControls no lo exponga.
   */
  getDistance() {
    return this.camera.position.distanceTo(this.arc.target)
  }

  /** Compatibilidad con OrbitControls.update() para el bucle de render. */
  update() {
    this.arc.update()
    return true
  }

  /**
   * Reconstruye el estado interno de ArcballControls tras mover la camara a
   * mano desde fuera (setView, cubo de vistas, marcadores, reencuadres).
   *
   * ArcballControls cachea pose, up, zoom y matriz en setCamera(); si no se
   * refresca, vuelve a imponer la orientacion anterior y la vista acaba en una
   * posicion rara. Sin esto, encuadrar dos vistas seguidas desviaba la camara
   * hasta 141 grados.
   */
  sync() {
    this.camera.updateMatrixWorld()
    this.arc.target.copy(this.arc.target)
    this.arc.setCamera(this.camera)
  }

  /** Angulo polar equivalente, derivado de la orientacion real de la camara. */
  getPolarAngle() {
    const offset = this.camera.position.clone().sub(this.arc.target)
    if (offset.lengthSq() === 0) return 0
    return Math.acos(THREE.MathUtils.clamp(offset.normalize().y, -1, 1))
  }

  getAzimuthalAngle() {
    const offset = this.camera.position.clone().sub(this.arc.target)
    if (offset.lengthSq() === 0) return 0
    offset.applyQuaternion(this.camera.quaternion.clone().invert())
    return Math.atan2(offset.x, offset.z)
  }

  dispose() {
    this.arc.removeEventListener('change', this._onArcChange)
    this.arc.removeEventListener('end', this._onArcEnd)
    this.arc.dispose()
  }
}