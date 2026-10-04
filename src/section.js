// SPDX-License-Identifier: GPL-3.0-or-later
import * as THREE from 'three'
import { PivotControls } from 'three-pivot-controls'
import { LineSegments2 } from 'three/addons/lines/LineSegments2.js'
import { LineSegmentsGeometry } from 'three/addons/lines/LineSegmentsGeometry.js'
import { LineMaterial } from 'three/addons/lines/LineMaterial.js'

/**
 * Corte seccional con UN plano unico y gizmo.
 *
 * El plano esta anclado al MODELO (es hijo de modelRoot), no a la escena ni a
 * la camara: girar el foco no desplaza el corte; el corte es propiedad de la
 * pieza y gira con ella. Se coloca con un gizmo PivotControls:
 *
 *   - Flechas y tiradores de plano: mueven el plano en espacio local.
 *   - Tres arcos de eje (X, Y y Z, cada uno de un cuarto de circulo): lo giran
 *     en espacio local. No hay familia de escala.
 *
 * El unico boton "Gizmo" del panel de corte enciende y apaga el gizmo; apagado,
 * el gizmo no se dibuja (escena limpia) pero el corte sigue visible.
 *
 * La superficie de corte se tapa con capping por stencil (caras traseras
 * incrementan el contador, delanteras lo decrementan y un quad coplanar pinta
 * donde el contador no es 0): el interior se ve solido, no hueco.
 *
 * El plano de recorte es una instancia mutable: mover el gizmo solo actualiza
 * su normal/constante y three.js recarga los uniforms en el siguiente render,
 * asi que arrastrar no reconstruye nada.
 */

// Ajustes exactos del gizmo PivotControls elegido en la demo. Se conservan como
// contrato visible y comprobable: mover y rotar a la vez, sin escala, ejes
// X/Y/Z activos, espacio local y los colores pedidos.
export const PIVOT_GIZMO_OPTIONS = Object.freeze({
  translate: true,
  rotate: true,
  scale: false,
  space: 'local',
  size: 1.3,
  fixed: false,
  activeAxes: Object.freeze([true, true, true]),
  axisColors: Object.freeze({ x: 0xff8093, y: 0x80ff80, z: 0x2ecffe }),
  thickness: 1.2,
  length: 1,
  rotateArc: 1 / 4,
})

// three-pivot-controls trabaja en unidades de mundo cuando `fixed` es false.
// En este visor ortografico en milimetros, el valor 1.3 de la demo quedaria
// diminuto: la calibracion multiplica ese tamano para que la punta de la
// flecha quede al 16.5% del alto visible (33% de diametro), sin cambiar el
// resto de la configuracion. Con `fixed: false`, el zoom posterior sigue
// cambiando el tamano aparente, como en la demo.
const PIVOT_ARROW_TIP_LOCAL = 0.62
const PIVOT_ARROW_TIP_SCREEN_RADIUS = 0.165

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
    this.mode = 'pivot'
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

    // Visual del plano: solo anillo de borde. El disco queda oculto por
    // peticion: al activar el corte no debe aparecer la superficie gris.
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
    this.planeMesh.visible = false
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
    this._dragging = false
    // Que familia de asas se esta arrastrando ('translate' | 'rotate' | null).
    this._dragOwner = null
    this._linesDirty = false
    this._lastVisible = []

    // Atenuado del gizmo: a plena vista al arrastrar o al pasar el raton,
    // casi transparente en reposo (15%). Sin raton no hay hover (tactil): se
    // muestra al tocar/arrastrar igualmente.
    this._fadeMats = null
    this._fadeLevel = 1
    this._pointerInside = false
    renderer.domElement.addEventListener('pointerenter', () => {
      this._pointerInside = true
      this._frameTick?.()
    })
    renderer.domElement.addEventListener('pointerleave', () => {
      this._pointerInside = false
      this._frameTick?.()
    })

    // Un solo gizmo PivotControls sobre el plano: flechas y arcos a la vez, sin
    // familia de escala. PivotControls ya reparte el raton entre sus asas y no
    // necesita dos controles ni zonas de preferencia manuales.
    this.pivotOptions = PIVOT_GIZMO_OPTIONS
    this.pivot = new PivotControls(camera, renderer.domElement, {
      ...PIVOT_GIZMO_OPTIONS,
      activeAxes: [...PIVOT_GIZMO_OPTIONS.activeAxes],
      axisColors: { ...PIVOT_GIZMO_OPTIONS.axisColors },
    })
    this.pivot.attach(this.gizmo)
    this._pivotHelper = this.pivot.getHelper()
    scene.add(this._pivotHelper)
    this._pivotViewportScale = 1
    this._fitPivotGizmoToView()

    // null = gizmo oculto con el corte visible (escena limpia).
    this.gizmoMode = null
    this._gizmoVisible = true

    this._onPivotDragStart = (event) => {
      // Mientras se arrastra el gizmo la orbita se queda quieta.
      if (this.controls) this.controls.enabled = false
      this._dragging = true
      this._dragOwner = event?.handle?.mode ?? null
      this.onChange?.()
    }
    this._onPivotDrag = () => {
      // Arrastrar recalcula el capping cada frame (barato en GPU) pero las
      // curvas de corte se reconstruyen al SOLTAR (recorrer 1M triangulos en
      // cada frame bloquearia el arrastre). PivotControls ya ha movido el
      // objeto del plano antes de emitir el evento.
      this._dragging = true
      if (this.enabled) this.apply({ lines: false })
      this._linesDirty = true
      this.onChange?.()
    }
    this._onPivotDragEnd = () => {
      if (this.controls) this.controls.enabled = true
      this._dragging = false
      this._dragOwner = null
      if (this._linesDirty && this.enabled) {
        this._linesDirty = false
        this._syncPlane()
        this._buildCutLines(this._lastVisible.length ? this._lastVisible : this.meshes)
      }
      this.onChange?.()
    }
    this.pivot.addEventListener('dragstart', this._onPivotDragStart)
    this.pivot.addEventListener('drag', this._onPivotDrag)
    this.pivot.addEventListener('dragend', this._onPivotDragEnd)
    this.setEnabled(false)
  }

  /** Espacio del gizmo: PivotControls incluye mover y rotar a la vez. */
  setMode(mode) {
    // Se mantiene la API por compatibilidad con documentos y con el bridge: el
    // gizmo siempre ofrece ambas familias, asi que cualquier modo heredado
    // equivale al modo unico 'pivot'.
    if (mode == null) return
    this.mode = 'pivot'
  }

  getMode() {
    return this.mode
  }

  /**
   * Enciende o apaga el gizmo completo como interruptor (flechas y anillos a la
   * vez). `mode` se conserva por compatibilidad con el bridge: cualquier valor
   * no nulo lo enciende y volver a llamarlo lo apaga.
   */
  setGizmoMode(mode) {
    if (mode == null) this.gizmoMode = null
    else this.gizmoMode = this.gizmoMode == null ? 'combined' : null
    this._applyGizmoMode()
  }

  /** true si el gizmo esta encendido. */
  get gizmoOn() {
    return this.gizmoMode != null
  }

  /**
   * Calcula la calibracion de viewport para PivotControls. La libreria deja el
   * tamano 1.3 en unidades de mundo porque `fixed` es false; en este visor
   * ortografico en milimetros eso solo sirve como tamano base. El factor lleva
   * la punta de la flecha al 16.5% del alto visible actual, es decir, un
   * diametro aproximado del 33%, sin tocar la configuracion pedida.
   */
  _fitPivotGizmoToView() {
    const height = (this.camera.top - this.camera.bottom) / this.camera.zoom
    if (!Number.isFinite(height) || height <= 0) return
    this._pivotViewportScale =
      (height * PIVOT_ARROW_TIP_SCREEN_RADIUS) /
      (PIVOT_GIZMO_OPTIONS.size * PIVOT_ARROW_TIP_LOCAL)
  }

  /**
   * Sincroniza el helper PivotControls con el plano antes de pintar. Hay que
   * llamarlo en cada frame: la libreria pide `update()` antes del render y,
   * justo despues, se reaplica la calibracion de viewport que `update()`
   * reescribe.
   */
  updatePivotGizmo() {
    if (!this.pivot) return
    this.pivot.update()
    this.pivot.getHelper().scale.multiplyScalar(this._pivotViewportScale ?? 1)
  }

  /**
   * Flechas y arcos a la vez. null = gizmo oculto.
   */
  _applyGizmoMode() {
    let visible = this.enabled && this._gizmoVisible && this.gizmoMode != null
    if (this._gizmoForced === false) visible = false
    else if (this._gizmoForced === true) visible = true

    // PivotControls controla el objeto directamente: basta con adjuntarlo o
    // soltarlo. No hay que ocultar una familia durante el arrastre porque sus
    // asas conviven por construccion.
    if (visible) this.pivot.attach(this.gizmo)
    else this.pivot.detach()
  }

  /** Muestra u oculta los gizmos sin perder la posicion del plano. */
  _setGizmoVisible(visible) {
    this._gizmoVisible = !!visible
    this._applyGizmoMode()
  }

  /** API publica para forzar la visibilidad de los gizmos (p. ej. en movil). */
  setGizmoVisible(visible) {
    this._gizmoForced = visible === false || visible === true ? visible : null
    this._setGizmoVisible(this._gizmoVisible)
  }

  /**
   * Atenua el visual del plano cuando el raton no esta encima. PivotControls
   * gestiona el resaltado de sus propias asas, asi que aqui solo se tocan los
   * materiales del visual del plano. Devuelve true mientras la transicion sigue en
   * curso (el visor le da frames hasta que se asienta). Solo opacidades: nada
   * del pipeline cambia.
   */
  updateGizmoFade() {
    if (!this._fadeMats) {
      this._fadeMats = []
      for (const mesh of [this.planeMesh, this.ringMesh]) {
        const list = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
        for (const material of list) {
          if (!material || this._fadeMats.some((e) => e.material === material)) continue
          material.transparent = true
          this._fadeMats.push({ material, base: material.opacity })
        }
      }
    }
    const target = !this.enabled || this.gizmoMode == null
      ? 1
      : (this._pointerInside || this._dragging ? 1 : 0.45)
    const next = this._fadeLevel + (target - this._fadeLevel) * 0.25
    const settled = Math.abs(next - target) < 0.01
    this._fadeLevel = settled ? target : next
    for (const { material, base } of this._fadeMats) {
      material.opacity = base * this._fadeLevel
    }
    return !settled
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
    if (this.enabled) this._fitPivotGizmoToView()
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
   * Gira el plano 90 grados sobre un eje propio del gizmo (pivote en su
   * posicion actual). Los ejes son los del plano, no los de la vista: el
   * resultado es el mismo lo coloque quien lo coloque (Alinear, tijeras o el
   * propio gizmo). Como el eje de giro siempre es perpendicular a la normal
   * (Z local), el giro nunca es un no-op. Cada pulsacion gira otros 90 grados
   * en el mismo sentido; a las 4 se vuelve al origen.
   *
   * `camera` se conserva por compatibilidad con la API anterior (ya no decide
   * el eje).
   */
  _quarterTurnLocal(x, y, z) {
    const quarter = new THREE.Quaternion().setFromAxisAngle(
      new THREE.Vector3(x, y, z), Math.PI / 2,
    )
    this.gizmo.quaternion.multiply(quarter)
    if (this.enabled) this.apply()
    this.onChange?.()
  }

  /**
   * Rota el plano 90 grados sobre su propio eje vertical (Y local).
   * Complementa a orientToCamera (eje propio horizontal): entre los dos
   * botones se cubren todas las orientaciones del plano sin tocar el gizmo.
   */
  rotateVertical(camera) {
    this._quarterTurnLocal(0, 1, 0)
  }

  /**
   * Rota el plano 90 grados sobre su propio eje horizontal (X local): un corte
   * de frente pasa a quedar de perfil, y viceversa.
   */
  orientToCamera(camera) {
    this._quarterTurnLocal(1, 0, 0)
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
        // Con depth test la curva se ve SOLO donde el corte esta a la vista:
        // cualquier geometria solida por delante la tapa y la pieza se lee
        // maciza, en vez de transparentarse las lineas del corte. La tapa
        // (cap) esta 0.015 por detras del plano, asi que el contorno no
        // desaparece nunca contra su propia cara de corte.
        depthTest: true,
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

  /**
   * Punto de medicion sobre la CARA YA CORTADA.
   *
   * Esa cara no es geometria: es el capping por stencil, un quad pintado donde
   * el contador no es 0. El rayo la atraviesa sin llegar a ninguna malla, asi
   * que no hay nada que raycastear: se resuelve el plano y se decide si el punto
   * cae sobre material.
   *
   * El criterio es el mismo que usa el capping en GPU: desde un pelin por
   * delante del plano (ya en el lado conservado) se lanza el rayo de vista en
   * direccion aleatoria; si su PRIMERA cara es trasera, el rayo salia de dentro
   * del solido, luego el punto esta dentro de la seccion y la cara se ve
   * pintada ahi. Si la primera cara es delantera, el rayo venia del vacio: hay
   * punto, pero no cara, y se descarta.
   *
   * @param {THREE.Ray} ray rayo de la camara (ya construido)
   * @returns {{point: THREE.Vector3, object: null, face: null, isCap: true}|null}
   */
  pickCap(ray) {
    if (!this.enabled) return null
    this._syncPlane()
    const point = ray.intersectPlane(this.plane, new THREE.Vector3())
    if (!point) return null

    const solids = this.meshes.filter(
      (m) => m.visible && !(Array.isArray(m.material) && m.material.some((mat) => mat.visible === false)),
    )
    if (!solids.length) return null

    const delta = Math.max(this.radius * 1e-4, 1e-4)
    const probe = this._capProbe ??= new THREE.Raycaster()
    probe.set(point.clone().addScaledVector(this.plane.normal, delta), ray.direction.clone())
    const hits = probe.intersectObjects(solids, false)
    const face = hits[0]?.face
    if (!face) return null
    // Cara trasera vista desde el rayo = el rayo venia de dentro del solido.
    const world = face.normal.clone().transformDirection(hits[0].object.matrixWorld)
    if (world.dot(ray.direction) <= 0) return null

    return { point, object: null, face: null, isCap: true, distance: ray.origin.distanceTo(point) }
  }

  /** Un punto queda "dentro" si esta del lado positivo de la normal. */
  isPointVisible(point) {
    if (!this.enabled) return true
    this._syncPlane()
    // Tolerancia: los puntos de la cara cortada caen EN el plano (distancia
    // ~0 por error de coma flotante) y son validos; sin ella su etiqueta se
    // esconderia y no se podria cotar sobre el corte.
    return this.plane.distanceToPoint(point) >= -Math.max(this.radius * 1e-5, 1e-6)
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
    this.pivot.removeEventListener('dragstart', this._onPivotDragStart)
    this.pivot.removeEventListener('drag', this._onPivotDrag)
    this.pivot.removeEventListener('dragend', this._onPivotDragEnd)
    this.pivot.detach()
    this.pivot.dispose?.()
    if (this._pivotHelper.parent) this._pivotHelper.parent.remove(this._pivotHelper)
    this.pivot = null
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
