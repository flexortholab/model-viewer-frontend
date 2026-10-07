// SPDX-License-Identifier: GPL-3.0-or-later
import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'

import { FreeOrbitControls } from './free-controls.js'
import { loadModel, normalizeModel, applyDentalMaterial, prepareMaterialsForReview, isSupported, isSupportedFormat, extensionOf } from './loaders.js'
import { SectionPlaneTool } from './section.js'
import { MeasureTool } from './measure.js'
import { Line2 } from 'three/addons/lines/Line2.js'
import { LineMaterial } from 'three/addons/lines/LineMaterial.js'
import { LineGeometry } from 'three/addons/lines/LineGeometry.js'
import { createDocument, validateDocument } from './annotations.js'
import { formatMm, round } from './units.js'

// Altura del frustum de la camara ortografica, en unidades de escena. Marca
// cuanto se ve en vertical; el ancho sale del aspecto del contenedor.
const ORTHO_VIEW_HEIGHT = 120

export class DentalViewer {
  constructor(container, { labelLayer } = {}) {
    this.container = container
    this.labelLayer = labelLayer

    this.scene = new THREE.Scene()
    // Fondo blanco por defecto: las escenas se exportan a color desde Blender
    // y el doctor trabaja sobre un lienzo claro. ??background=dark vuelve al
    // tema oscuro.
    this.scene.background = new THREE.Color(0xffffff)

    // En moviles se reduce la carga de la GPU: sin antialias y pixel ratio 1.
    this._isMobile = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(
      navigator.userAgent,
    ) || navigator.maxTouchPoints > 2

    this.renderer = new THREE.WebGLRenderer({
      antialias: !this._isMobile,
      stencil: true,
      preserveDrawingBuffer: true,
      powerPreference: this._isMobile ? 'default' : 'high-performance',
    })
    this.renderer.setPixelRatio(this._isMobile ? 1 : Math.min(window.devicePixelRatio, 2))
    this.renderer.localClippingEnabled = true
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping
    this.renderer.toneMappingExposure = 1.05
    container.appendChild(this.renderer.domElement)

// Camara ortografica: la perspectiva plana y sin distorsion de "ojo de pez"
// que si produce una camara en perspectiva. El frustum se define por altura
// (VIEW_HEIGHT) y se ajusta al aspecto en resize().
this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, -2000, 6000)
this.camera.position.set(40, 30, 60)

    // Navegacion por defecto: giro libre. OrbitControls trabaja en coordenadas
    // esfericas con el polar limitado a [0, PI], asi que al llegar a superior o
    // inferior el arrastre se clava y no se puede seguir dando la vuelta.
    // ArcballControls rota por quaterniones y no tiene esos polos.
    // El modo antiguo sigue disponible con ?giro=orbit.
    const giroParam = new URLSearchParams(window.location.search).get('giro')
    const giro = giroParam || 'libre'

    this.controls = giro === 'libre'
      ? new FreeOrbitControls(this.camera, this.renderer.domElement)
      : new OrbitControls(this.camera, this.renderer.domElement)

    this.controls.enableDamping = true
    this.controls.dampingFactor = giro === 'libre' ? 22 : 0.08
    this.controls.rotateSpeed = giro === 'libre' ? 0.9 : 0.85
    this.controls.screenSpacePanning = true
    this.navigationMode = giro

    this._setupLights()
    this._setupGrid()

    this.raycaster = new THREE.Raycaster()
    this.raycaster.firstHitOnly = true
    this.pointer = new THREE.Vector2()
    this._tmp = new THREE.Vector3()

    this.modelRoot = new THREE.Group()
    this.modelRoot.name = 'model'
    this.scene.add(this.modelRoot)

    this.section = null
    this.measure = null
    this.markerGroup = new THREE.Group()
    this.modelRoot.add(this.markerGroup)

    this._markersVisible = true
    this._focusedMarkerId = null

    this.doc = createDocument()
    this.model = null
    this.listeners = new Map()

    this._onResize = () => this.resize()
    window.addEventListener('resize', this._onResize)
    this.resize()

    // Render bajo demanda: la GPU descansa cuando no hay cambios (los
    // controles con inercia siguen pidiendo frames via controls.update()).
    // Cola de 30 frames tras cada cambio + frame al mover el raton: margen
    // de sobra para que ninguna vista se quede sin pintar en ningun equipo.
    this._dirty = true
    this._tail = 0
    this._loop = this._loop.bind(this)
    this.renderer.setAnimationLoop(this._loop)
    this.renderer.domElement.addEventListener('pointermove', () => {
      this.requestRender()
    })
  }

  /** Marca un frame pendiente (llamar tras cualquier cambio visual). */
  requestRender() {
    this._dirty = true
  }

  /**
   * Coloca la camara y el objetivo, y resincroniza los controles.
   *
   * Todo movimiento de camara hecho desde fuera (setView, cubo, marcadores,
   * reencuadres) debe pasar por aqui: ArcballControls cachea la pose en
   * setCamera() y, sin resincronizar, vuelve a imponer la orientacion previa.
   */
  _placeCamera(position, target) {
    if (position) this.camera.position.copy(position)
    if (target) this.controls.target.copy(target)
    this.camera.up.set(0, 1, 0)
    this.camera.lookAt(this.controls.target)
    this.controls.update()
    this.controls.sync?.()
    this.requestRender()
  }

  /**
   * Cambia el tipo de navegacion en caliente, conservando la vista actual.
   * 'libre' (ArcballControls) no tiene polos; 'orbit' es el modo antiguo.
   */
  setNavigationMode(modo = 'libre') {
    if (modo === this.navigationMode) return
    const destino = new THREE.Vector3()
    this.camera.getWorldDirection(destino)
    const distancia = this.camera.position.distanceTo(this.controls.target)
    const objetivo = this.controls.target.clone()
    this.controls.dispose()

    this.navigationMode = modo
    this.controls = modo === 'orbit'
      ? new OrbitControls(this.camera, this.renderer.domElement)
      : new FreeOrbitControls(this.camera, this.renderer.domElement)
    this.controls.enableDamping = true
    this.controls.dampingFactor = modo === 'orbit' ? 0.08 : 22
    this.controls.rotateSpeed = modo === 'orbit' ? 0.85 : 0.9
    this.controls.screenSpacePanning = true

    // Reenganchar el listener de 'change' que usa el visor (puede no existir
    // todavia si se cambia de modo antes del primer load).
    this._onControlsChange ||= () => this.measure?.rebuild?.(false)
    this.controls.addEventListener('change', this._onControlsChange)
    this.controls.target.copy(objetivo)
    // Mantener la orientacion (y la distancia) al cambiar de modo.
    this._placeCamera(
      new THREE.Vector3().copy(objetivo).addScaledVector(destino, -distancia),
      objetivo,
    )
  }

  /** Que GPU ejecuta el WebGL (para diagnosticar integrada vs dedicada). */
  gpuInfo() {
    try {
      const gl = this.renderer.getContext()
      const ext = gl.getExtension('WEBGL_debug_renderer_info')
      const raw = ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER)
      return String(raw ?? 'desconocida')
    } catch {
      return 'desconocida'
    }
  }

  on(event, fn) {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set())
    this.listeners.get(event).add(fn)
    return () => this.listeners.get(event).delete(fn)
  }

  emit(event, payload) {
    for (const fn of this.listeners.get(event) ?? []) fn(payload)
  }

  _setupLights() {
    // Luz suave y difusa de estudio: legible sin brillos cromados.
    const hemi = new THREE.HemisphereLight(0xdfe8ff, 0x2a2622, 1.25)
    const key = new THREE.DirectionalLight(0xffffff, 1.9)
    key.position.set(60, 80, 70)
    const fill = new THREE.DirectionalLight(0xbcd0ff, 0.7)
    fill.position.set(-70, 20, -40)
    const rim = new THREE.DirectionalLight(0xffd9b0, 0.55)
    rim.position.set(20, -40, -60)
    this.scene.add(hemi, key, fill, rim)
    this.keyLight = key
  }

  _setupGrid() {
    // Suelo sutil: da referencia de escala y sombra sin distraer.
    const shadowCatcher = new THREE.Mesh(
      new THREE.PlaneGeometry(600, 600),
      new THREE.ShadowMaterial({ opacity: 0.28 }),
    )
    shadowCatcher.rotation.x = -Math.PI / 2
    shadowCatcher.position.y = -1
    shadowCatcher.receiveShadow = true
    this.scene.add(shadowCatcher)
    this.shadowCatcher = shadowCatcher

    this.renderer.shadowMap.enabled = true
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap
  }

  resize() {
    const width = this.container.clientWidth || 1
    const height = this.container.clientHeight || 1
    this._applyOrthoFrustum()
    this.renderer.setSize(width, height, false)
    this.measure?.setResolution(width, height)
    this.section?.setResolution?.(width, height)
    this.requestRender()
    this.emit('resize', { width, height })
  }

  /**
   * @param {string} url .glb | .gltf | .stl | .obj | .fbx | .3mf
   * @param {{forcedUnits?:string|null, merge?:boolean, keepMaterials?:boolean, format?:string}} options
   *   `format` fuerza el formato cuando la URL no lo dice (URL blob: de la cache).
   */
  async load(url, options = {}) {
    if (!url) throw new Error('Falta la URL del modelo.')
    const supported = options.format ? isSupportedFormat(options.format) : isSupported(url)
    if (!supported) throw new Error(`Formato no soportado: ${url}`)

    this.emit('progress', { phase: 'loading', url })

    const root = await loadModel(url, {
      renderer: this.renderer,
      format: options.format,
      onProgress: (fraction, label) => this.emit('progress', { phase: 'loading', fraction, label }),
    })

    // Sin merge por defecto: las escenas de Blender traen varios objetos y la
    // lista de objetos con el ojo los necesita por separado.
    const result = normalizeModel(root, {
      forcedUnits: options.forcedUnits ?? null,
      merge: options.merge ?? false,
      format: extensionOf(url),
    })

    // Limpieza del modelo anterior.
    this.section?.dispose()
    this.measure?.dispose()
    this.modelRoot.clear()
    // modelRoot.clear() descolgó markerGroup: hay que re-adjuntarlo para que
    // los marcadores sigan visibles (y disponibles) tras cargar otro modelo.
    this.modelRoot.add(this.markerGroup)

    this.modelRoot.add(root)
    // Colored exports: preserve the original materials unless asked otherwise.
    if (options.keepMaterials) {
      prepareMaterialsForReview(result.meshes)
    } else {
      applyDentalMaterial(result.meshes)
    }

    this.model = { url, keepMaterials: options.keepMaterials ?? false, ...result }
    this.doc.model = url

    this._setupTools()
    this.frameModel()

    const info = {
      url,
      name: url.split('/').pop(),
      units: {
        detected: result.units.units,
        source: result.units.source,
        confidence: result.units.confidence,
        rawMaxDim: round(result.units.maxDimRaw),
        maxDimMm: round(result.units.maxDimMm),
        alternatives: result.units.alternatives,
      },
      sizeMm: {
        x: round(result.size.x),
        y: round(result.size.y),
        z: round(result.size.z),
      },
      stats: result.stats,
      objects: this.listObjects(),
      gpu: this.gpuInfo(),
    }
    this.emit('loaded', info)
    return info
  }

  _setupTools() {
    this.section = new SectionPlaneTool(this.renderer, {
      scene: this.scene,
      modelRoot: this.modelRoot,
      meshes: this.model.meshes,
      camera: this.camera,
      controls: this.controls,
      onChange: () => this._syncDoc(),
      _frameTick: () => this.requestRender(),
    })
    if (this._isMobile) this.section.setGizmoVisible(false)

    this.measure = new MeasureTool({
      container: this.container,
      labelLayer: this.labelLayer,
      camera: this.camera,
      renderer: this.renderer,
      section: this.section,
      onChange: () => this._syncDoc(),
    })
    this.markerGroup.add(this.measure.group)
    this.measure.setResolution(this.container.clientWidth, this.container.clientHeight)

    // Cada carga re-crea las herramientas: retirar el listener anterior evita
    // acumular copias (y referencias al measure viejo) en cada load().
    if (this._onControlsChange) {
      this.controls.removeEventListener('change', this._onControlsChange)
    }
    this._onControlsChange = () => this.measure?.rebuild?.(false)
    this.controls.addEventListener('change', this._onControlsChange)
  }

  /**
   * Encuadra la camara sobre el modelo con un margen razonable.
   *
   * En camara ortografica el tamaño de lo que se ve no depende de la distancia
   * sino del frustum: por eso se ajusta `_viewHeight` al modelo (con margen) y
   * se coloca la camara a una distancia fija suficiente para no clipping.
   */
  frameModel({ margin = 1.16 } = {}) {
    if (!this.model) return
    const radius = Math.max(this.model.size.length() / 2, 5)
    this.camera.near = -radius * 100
    this.camera.far = radius * 200
    this.camera.updateProjectionMatrix()

    const center = this.model.bounds.getCenter(new THREE.Vector3())
    const dir = new THREE.Vector3(0.42, 0.36, 0.83).normalize()

    // Ajustar la escala para que el modelo entre con margen en vertical y
    // horizontal, segun la direccion desde la que se mira.
    this._fitOrtho(this.model.bounds, dir, margin)
    this._placeCamera(
      new THREE.Vector3().copy(center).addScaledVector(dir, radius * 3),
      center,
    )

    if (this.shadowCatcher) {
      this.shadowCatcher.position.y = this.model.bounds.min.y - 1
      this.keyLight.position.copy(dir).multiplyScalar(radius * 4).add(center)
    }
    // Al reenquadrar solo se recentra la camara; los planos conservan su
    // posicion para no perder el corte que el doctor estaba revisando.
    this.requestRender()
    this.emit('framed', { center, radius })
  }

  /**
   * Calcula la altura de frustum necesaria para que una caja quepa con margen
   * vista desde `dir`, y la aplica. Es el equivalente en ortografico a mover
   * la camara de lejos: cambia cuanto se ve, no el angulo.
   */
  _fitOrtho(box, dir, margin = 1.16) {
    const forward = dir.clone().normalize()
    const worldUp = Math.abs(forward.y) > 0.98
      ? new THREE.Vector3(0, 0, 1)
      : new THREE.Vector3(0, 1, 0)
    const right = new THREE.Vector3().crossVectors(worldUp, forward).normalize()
    const up = new THREE.Vector3().crossVectors(forward, right).normalize()

    const half = box.getSize(new THREE.Vector3()).multiplyScalar(0.5)
    let extY = 1e-6
    let extX = 1e-6
    for (let sx = -1; sx <= 1; sx += 2) {
      for (let sy = -1; sy <= 1; sy += 2) {
        for (let sz = -1; sz <= 1; sz += 2) {
          const corner = new THREE.Vector3(sx * half.x, sy * half.y, sz * half.z)
          extY = Math.max(extY, Math.abs(corner.dot(up)))
          extX = Math.max(extX, Math.abs(corner.dot(right)))
        }
      }
    }
    const aspect = this.container.clientWidth / Math.max(this.container.clientHeight, 1)
    // Alto necesario, y el ancho equivalente; el mayor manda para no recortar.
    const neededY = extY * 2 * margin
    const neededX = (extX * 2 * margin) / Math.max(aspect, 1e-6)
    this._viewHeight = Math.max(neededY, neededX, 1)
    this._applyOrthoFrustum()
  }

  _applyOrthoFrustum() {
    const width = this.container.clientWidth || 1
    const height = this.container.clientHeight || 1
    const aspect = width / height
    const halfH = (this._viewHeight ?? ORTHO_VIEW_HEIGHT) / 2
    const halfW = halfH * aspect
    this.camera.left = -halfW
    this.camera.right = halfW
    this.camera.top = halfH
    this.camera.bottom = -halfH
    this.camera.updateProjectionMatrix()
  }

  setBackground(value) {
    if (value === 'light' || value === 'dark' || value === 'studio') {
      const map = {
        light: 0xffffff,
        dark: 0x14161a,
        studio: 0xf0f0f0,
      }
      this.scene.background = new THREE.Color(map[value])
      this.renderer.toneMappingExposure = value === 'light' ? 0.85 : 1.05
    } else {
      this.scene.background = new THREE.Color(value)
    }
    this.requestRender()
  }

  setWireframe(enabled) {
    for (const mesh of this.model?.meshes ?? []) {
      const list = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
      for (const material of list) material.wireframe = !!enabled
    }
    this.requestRender()
  }

  setModelOpacity(value) {
    const opacity = Number(value)
    for (const mesh of this.model?.meshes ?? []) {
      const list = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
      for (const material of list) {
        material.transparent = opacity < 1
        material.opacity = opacity
        material.needsUpdate = true
      }
    }
    this.requestRender()
  }

  /** Activa el modo medicion y devuelve el estado. */
  setTool(tool) {
    const enabled = tool === 'measure' ? this.measure.setEnabled(true) : this.measure?.setEnabled(false)
    this.controls.enabled = !enabled
    this.container.classList.toggle('is-measuring', !!enabled)
    this.requestRender()
    this.emit('tool', { tool: enabled ? 'measure' : 'orbit' })
    return enabled ? 'measure' : 'orbit'
  }

  // --- Corte seccional (plano unico con gizmo) -------------------------------

  setSection({ enabled, plane } = {}) {
    if (!this.section) throw new Error('No hay modelo cargado.')
    if (plane) this.section.setPlane(plane)
    if (enabled !== undefined) {
      this.section.setEnabled(enabled)
      if (enabled) {
        // Sin posicion guardada: centrar el plano de cara a la camara y
        // girarlo 90 grados (de frente a perfil): asi se ve el corte nada
        // mas activarlo, en vez de un plano de cara que tapa la vista.
        if (!plane && !this.section.gizmo.position.lengthSq()) {
          this.section.reset(this.camera)
          this.section.orientToCamera(this.camera)
        }
        if (this._isMobile) this.section.setGizmoVisible(false)
      }
    } else {
      this.section.apply()
    }
    this._syncDoc()
    this.emit('section', this.section.serialize())
    return this.section.serialize()
  }

  /**
   * Compatibilidad con el viejo semieje: interpreta el eje/offset como una
   * normal de plano en ese eje desplazada `offset` mm del centro, conservando
   * la mitad positiva (misma semantica que la version anterior).
   */
  setSectionAxis(axis, offset, { enable = true } = {}) {
    axis = String(axis ?? '').toLowerCase()
    const dir = { x: new THREE.Vector3(1, 0, 0), y: new THREE.Vector3(0, 1, 0), z: new THREE.Vector3(0, 0, 1) }[axis]
    if (dir) {
      const point = dir.clone().multiplyScalar(Number(offset) || 0)
      this.section?.setPlane({ point: point.toArray(), normal: dir.toArray() })
    }
    if (enable && this.section && !this.section.enabled) {
      this.section.setEnabled(true)
      this._syncDoc()
      this.emit('section', this.section.serialize())
    }
  }

  setSectionAxisEnabled() {}

  sectionAxisRange() {
    return { min: -1, max: 1, half: 1 }
  }

  axisLabel(axis) {
    return String(axis ?? '').toUpperCase()
  }

  setCapColor(hex) {
    this.section?.setCapColor(hex)
    this._syncDoc()
  }

  setSectionMode(mode) {
    this.section?.setMode(mode)
  }

  resetSectionPlane() {
    this.section?.reset(this.camera)
    this._syncDoc()
    this.emit('section', this.section.serialize())
  }

  /** Reorienta el plano en su posicion actual para cortarlo de frente. */
  orientSectionPlane() {
    this.section?.orientToCamera(this.camera)
    this._syncDoc()
    this.emit('section', this.section.serialize())
  }

  /** Gira el plano 90 grados sobre el eje vertical de la vista, en su sitio. */
  rotateSectionPlane() {
    this.section?.rotateVertical(this.camera)
    this._syncDoc()
    this.emit('section', this.section.serialize())
  }

  // --- Lista de objetos -------------------------------------------------------

  listObjects() {
    return (this.model?.meshes ?? []).map((mesh, index) => ({
      index,
      name: nameOf(mesh, index),
      visible: mesh.visible,
      triangles: Math.round(
        mesh.geometry.getIndex()
          ? mesh.geometry.getIndex().count / 3
          : mesh.geometry.getAttribute('position').count / 3,
      ),
    }))
  }

  setMeshVisible(index, visible) {
    const mesh = this.model?.meshes?.[index]
    if (!mesh) return
    mesh.visible = !!visible
    this.section?.refreshMeshes(this.model.meshes)
    this._syncDoc()
    this.emit('objects', this.listObjects())
  }

  /**
   * Distancia a la que una caja entra COMPLETA en el encuadre mirando desde
   * `dir`. Multiplicar el radio por un factor fijo (2.1) recortaba la pieza:
   * con 38 grados de FOV hacen falta ~3.1x el radio de la esfera envolvente.
   * Aqui se proyecta la caja al espacio de camara y se resuelve la distancia
   * minima que mantiene los ochoVertices dentro del frustum, con margen.
   */
  /**
   * Distancia a la que colocar la camara ortografica.
   *
   * En ortografica la escala no depende de la distancia: lo unico que hace la
   * distancia es evitar el clipping, asi que basta con alejarse un multiplo
   * del radio del modelo.
   */
  _frameDistance(box, dir, { margin = 1.18 } = {}) {
    const half = box.getSize(new THREE.Vector3()).multiplyScalar(0.5)
    return Math.max(half.length() * 3 * margin, 1)
  }

  /**
   * Centra la vista en un objeto concreto; con withPlane coloca y activa el
   * corte de ese objeto (despues lo ajusta el doctor con el gizmo).
   *
   * El boton de tijeras NO hace zoom: reencuadra la escena entera para no
   * perder el contexto de la pieza y solo coloca el plano de corte sobre ella.
   */
  focusObject(index, { withPlane = false } = {}) {
    const mesh = this.model?.meshes?.[index]
    if (!mesh) return null
    if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox()
    const box = mesh.geometry.boundingBox.clone()
    const center = box.getCenter(new THREE.Vector3())
    const radius = Math.max(box.getSize(new THREE.Vector3()).length() / 2, 2)

    if (withPlane) {
      // Encuadre de la ESCENA completa sin perder el angulo actual: se
      // conserva la direccion de la camara y solo se aleja lo necesario para
      // que quepa todo el modelo. Llamar a frameModel() aqui devolvia la
      // vista a la isometrica y se perdia el giro que hubiera hecho el
      // usuario (y con el, la orientacion del corte).
      const viewDir = new THREE.Vector3()
      this.camera.getWorldDirection(viewDir)
      const sceneCenter = this.model.bounds.getCenter(new THREE.Vector3())
      this._placeCamera(
        new THREE.Vector3().copy(sceneCenter).addScaledVector(viewDir, -this._frameDistance(this.model.bounds, viewDir)),
        sceneCenter,
      )
      this.section?.setPlane({ point: center.toArray(), normal: viewDir.normalize().toArray() })
      // Igual que al activar el corte global: de perfil por defecto.
      this.section?.orientToCamera?.(this.camera)
      if (!this.section?.enabled) this.section?.setEnabled(true)
      this._syncDoc()
      this.emit('section', this.section.serialize())
    } else {
      const dir = new THREE.Vector3(0.42, 0.36, 0.83).normalize()
      this._placeCamera(new THREE.Vector3().copy(center).addScaledVector(dir, this._frameDistance(box, dir)), center)
    }
    this.emit('framed', { center, radius, object: index })
    this.emit('objects', this.listObjects())
    this.requestRender()
    return { center, radius }
  }

  /** Vuelve a encuadrar el caso completo (salir del paso enfocado). */
  exitFocus() {
    this.frameModel()
    return true
  }

  /**
   * Vista de inicio del caso (isometrica), contado lo que traiga guardado.
   *
   * Al abrir un caso o un enlace compartido se aplica la configuracion
   * guardada (corte, marcadores, medidas) y despues se recoloca la camara
   * aqui: el doctor SIEMPRE empieza en la isometrica aunque el caso este
   * editado, y cada paso de la presentacion coloca su propia vista.
   */
  resetView() {
    this.camera.zoom = 1
    this.camera.updateProjectionMatrix()
    this.frameModel()
  }

  // --- Anotaciones ---------------------------------------------------------

  getAnnotations() {
    this._syncDoc()
    return this.doc
  }

  applyAnnotations(raw) {
    const doc = validateDocument(raw)
    this.doc = doc
    if (!this.model) return doc

    // Copiar los arrays ANTES: section.restore dispara _syncDoc (via onChange)
    // y reescribiria doc.measurements/doc.section con el estado actual.
    const measurements = doc.measurements
    this.section.restore(doc.section)
    this.measure.restore(measurements)
    this._renderMarkers()

    if (doc.model && doc.model !== this.model.url) {
      return doc // el modelo corresponde a otro archivo: lo carga el host
    }
    this.emit('annotations', doc)
    return doc
  }

  addMarker({ position, text = '', kind = 'note', snapshot = true }) {
    const serial = this.section?.serialize() ?? null
    const marker = {
      id: `k${this.markerGroup.children.length + 1}_${Date.now().toString(36).slice(-4)}`,
      position,
      text,
      kind,
    }
    if (snapshot && serial) {
      // Snapshot de presentacion: como estaba la vista, el corte, las
      // mediciones y la visibilidad de objetos en el momento de crear el
      // marcador. Pulsarlo en la lista lo restaura todo.
      marker.view = {
        position: this.camera.position.toArray().map((n) => round(n)),
        target: this.controls.target.toArray().map((n) => round(n)),
        // Zoom: en ortografica ArcballControls lo guarda en camera.zoom (la
        // distancia no magnifica nada). Sin esto un paso creado con la pieza
        // ampliada se restauraba con el zoom que hubiera en ese momento.
        zoom: round(this.camera.zoom, 6),
      }
      marker.section = serial
      marker.measurements = this.measure?.serialize() ?? []
      marker.objects = this.listObjects().map(({ index, visible }) => ({ index, visible }))
    }
    this.doc.markers.push(marker)
    this._renderMarkers()
    this._syncDoc()
    this.emit('markers', this.doc.markers)
    return marker
  }

  removeMarker(id) {
    const index = this.doc.markers.findIndex((m) => m.id === id)
    if (index === -1) return false
    for (const marker of this.doc.markers) this.measure?.removeOverlay(`marker:${marker.id}`)
    this.doc.markers.splice(index, 1)
    this._renderMarkers()
    this._syncDoc()
    this.emit('markers', this.doc.markers)
    return true
  }

  /** Edita el texto/clase de un marcador existente (doble clic en la lista). */
  updateMarker(id, { text, kind } = {}) {
    const marker = this.doc.markers.find((m) => m.id === id)
    if (!marker) return null
    if (typeof text === 'string') marker.text = text
    if (['note', 'warning', 'screw'].includes(kind)) marker.kind = kind
    this._renderMarkers()
    this._syncDoc()
    this.emit('markers', this.doc.markers)
    return marker
  }

  /** Muestra el caso como estaba cuando se creo el marcador. */
  focusMarker(id) {
    const marker = this.doc.markers.find((m) => m.id === id)
    if (!marker) return null
    if (marker.view?.position && marker.view?.target) {
      // El zoom va ANTES de colocar la camara: ArcballControls cachea zoom y
      // matriz en setCamera(), asi que ponerlo despues haria que el siguiente
      // gesto de rueda partiese de un zoom viejo. Los pasos antiguos sin zoom
      // en el JSON conservan el que haya ahora.
      if (Number.isFinite(marker.view.zoom)) {
        this.camera.zoom = marker.view.zoom
        this.camera.updateProjectionMatrix()
      }
      this._placeCamera(new THREE.Vector3().fromArray(marker.view.position), new THREE.Vector3().fromArray(marker.view.target))
      this.emit('view', marker.id)
    }
    if (marker.section) {
      // Mientras dura el paso, _syncDoc no debe reescribir las mediciones
      // del documento (el conjunto completo vive en doc.measurements).
      this._preservingMeasures = true
      this.section?.restore({ ...marker.section, enabled: !!marker.section.enabled })
      if (this._isMobile) this.section?.setGizmoVisible(false)
    } else {
      this.section?.setEnabled(false)
    }
    this._preservingMeasures = true
    if (Array.isArray(marker.measurements)) {
      this.measure?.restore(marker.measurements)
      this.measure?.update()
    } else {
      this.measure?.clear()
    }
    if (Array.isArray(marker.objects)) {
      for (const { index, visible } of marker.objects) {
        this.setMeshVisible(index, visible)
      }
    }
    this._preservingMeasures = false
    // Muestra solo el marcador del paso activo.
    this.setMarkersVisible(true, id)
    // Pulso visual en la etiqueta del marcador.
    this.measure?.pulse?.(`marker:${id}`)
    this.emit('markers', this.doc.markers)
    this.requestRender()
    return marker
  }

  /** Sale del marcador enfocado y limpia medidas, corte y marcadores. */
  exitMarkerFocus() {
    this._preservingMeasures = true
    this.measure?.clear()
    this.measure?.update()
    this._preservingMeasures = false
    this.section?.setEnabled(false)
    this.setMarkersVisible(false)
    this.frameModel()
    this.emit('markers', this.doc.markers)
    return true
  }

  /** Retira todos los marcadores de la pieza (y sus etiquetas). */
  clearMarkers() {
    for (const marker of [...this.doc.markers]) {
      this.measure?.removeOverlay(`marker:${marker.id}`)
    }
    for (const child of this.markerGroup.children.filter((c) => c.userData?.isMarker)) {
      child.traverse((node) => {
        node.geometry?.dispose?.()
        node.material?.dispose?.()
      })
      this.markerGroup.remove(child)
    }
    this.doc.markers = []
    this._syncDoc()
  }

  _renderMarkers() {
    // Retira los marcadores anteriores (y sus overlays) antes de dibujar.
    for (const child of this.markerGroup.children.filter((c) => c.userData?.isMarker)) {
      child.traverse((node) => {
        node.geometry?.dispose?.()
        node.material?.dispose?.()
      })
      this.markerGroup.remove(child)
    }
    for (const marker of this.doc.markers) this.measure?.removeOverlay(`marker:${marker.id}`)

    if (!this._markersVisible) return

    const anchor = new THREE.Vector3()
    const markerColors = {
      note: 0x22c55e,
      screw: 0xa855f7,
      warning: 0xef4444,
    }
    for (const marker of this.doc.markers) {
      // En modo paso enfocado solo se dibuja el marcador activo.
      if (this._focusedMarkerId && marker.id !== this._focusedMarkerId) continue

      anchor.fromArray(marker.position)
      const color = markerColors[marker.kind] ?? markerColors.note

      const group = new THREE.Group()
      group.userData.isMarker = true
      group.userData.markerId = marker.id

      const dot = new THREE.Mesh(
        new THREE.SphereGeometry(0.275, 16, 12),
        new THREE.MeshBasicMaterial({ color, depthTest: false }),
      )
      dot.renderOrder = 1000
      group.add(dot)

      const stemMat = new LineMaterial({
        color,
        linewidth: 3.2,
        transparent: true,
        opacity: 0.85,
        depthTest: false,
      })
      stemMat.resolution.set(this.renderer.domElement.clientWidth, this.renderer.domElement.clientHeight)
      const stemGeo = new LineGeometry().setPositions([0, 0, 0, 0, 5, 0])
      const stem = new Line2(stemGeo, stemMat)
      stem.renderOrder = 999
      group.add(stem)

      group.position.copy(anchor)
      this.markerGroup.add(group)

      if (marker.text && this.measure) {
        const el = document.createElement('div')
        el.className = `marker-label marker-${marker.kind}`
        el.textContent = marker.text
        this.measure.addOverlay(`marker:${marker.id}`, el, anchor.clone().add(new THREE.Vector3(0, 5.5, 0)))
      }
    }
  }

  setMarkersVisible(visible, focusedId = null) {
    this._markersVisible = visible
    this._focusedMarkerId = focusedId
    this._renderMarkers()
  }

  _syncDoc() {
    if (!this.section || !this.measure) return
    this.doc.section = this.section.serialize()
    if (!this._preservingMeasures) {
      this.doc.measurements = this.measure.serialize()
    }
    this.doc.units = 'mm'
    this.requestRender()
    this.emit('changed', this.doc)
  }

  // --- Interaccion ---------------------------------------------------------

  setPointer(event) {
    const rect = this.renderer.domElement.getBoundingClientRect()
    this.pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1
    this.pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1
  }

  /** Interseccion con el modelo que respeta los planos de corte activos. */
  pick() {
    if (!this.model) return null
    this.raycaster.setFromCamera(this.pointer, this.camera)
    const hits = this.raycaster.intersectObjects(this.model.meshes, false)
    let closer = null
    for (const hit of hits) {
      // `hits` viene ordenado por distancia: el primero no recortado es el mas
      // cercano visible, pero puede ser la pared del fondo de la pieza.
      if (this.section && !this.section.isPointVisible(hit.point)) continue
      closer = hit
      break
    }
    // Lo que se ve recortado no tiene malla que raycastear: la cara cortada es
    // el capping por stencil. Con corte activo se prueba el plano y el punto se
    // acepta solo si cae sobre la seccion solida (cotas sobre el corte). La cara
    // esta mas cerca que la pared del fondo, asi que gana si la hay.
    const cap = this.section?.pickCap?.(this.raycaster.ray) ?? null
    if (cap && (!closer || cap.distance < closer.distance)) return cap
    return closer
  }

  /**
   * Intenta agarrar un extremo de medida. Funciona con la herramienta de
   * medir activa y tambien en camara libre, para poder retocar cualquier
   * medida sin volver a entrar en modo medicion.
   * @returns {{measurement: object, key: string}|null}
   */
  grabMeasureEndpoint(event) {
    const grab = this.measure?.findEndpoint?.(event.clientX, event.clientY)
    if (!grab) return null
    this._dragMeasure = grab
    this.measure.select(grab.measurement.id)
    this.measure.setHover(null)
    // Sin camara mientras se arrastra el extremo, o la pieza se moveria con el.
    this.controls.enabled = false
    this.requestRender()
    return grab
  }

  /** Arrastra el extremo agarrado con adherencia a la superficie. */
  dragMeasureEndpoint(event) {
    if (!this._dragMeasure) return false
    this.setPointer(event)
    const hit = this.pick()
    if (hit) {
      const snapped = this.measure.snapToSurface?.(hit) ?? hit.point
      this.measure.moveEndpoint(this._dragMeasure.measurement, this._dragMeasure.key, snapped ?? hit.point)
    }
    return true
  }

  /**
   * Intenta agarrar un marcador para moverlo de sitio.
   * @returns {object|null} el marcador agarrado
   */
  grabMarker(event) {
    const marker = this._findMarkerAt(event.clientX, event.clientY)
    if (!marker) return null
    this._dragMarker = marker
    this._dragMarkerStart = { x: event.clientX, y: event.clientY }
    this.controls.enabled = false
    this.measure?.setHover(null)
    this.requestRender()
    return marker
  }

  /** Mueve el marcador agarrado a la superficie bajo el cursor. */
  dragMarker(event) {
    if (!this._dragMarker) return false
    this.setPointer(event)
    const hit = this.pick()
    if (hit) {
      const snapped = this.measure.snapToSurface?.(hit) ?? hit.point
      this._dragMarker.position = (snapped ?? hit.point).toArray()
      this._renderMarkers()
      this._syncDoc()
    }
    return true
  }

  /** Suelta el marcador y, si fue un clic corto, enfoca ese paso. */
  releaseMarker({ focusIfClick = true } = {}) {
    if (!this._dragMarker) return null
    const marker = this._dragMarker
    this._dragMarker = null
    this.controls.enabled = !this.measure?.enabled
    this._syncDoc()
    this.emit('markers', this.doc.markers)
    return marker
  }

  _findMarkerAt(clientX, clientY, tolerance = 14) {
    const rect = this.container.getBoundingClientRect()
    const px = clientX - rect.left
    const py = clientY - rect.top
    const width = this.container.clientWidth || 1
    const height = this.container.clientHeight || 1
    let best = null
    let bestDist = tolerance
    for (const marker of this.doc.markers) {
      this._tmp.fromArray(marker.position).project(this.camera)
      if (this._tmp.z > 1) continue
      const x = (this._tmp.x * 0.5 + 0.5) * width
      const y = (-this._tmp.y * 0.5 + 0.5) * height
      const dist = Math.hypot(x - px, y - py)
      if (dist < bestDist) {
        bestDist = dist
        best = marker
      }
    }
    return best
  }

  handleMeasureClick(event) {
    this.setPointer(event)
    // Edicion: si el cursor agarra un extremo de una medida, arrastrarlo
    // manda sobre crear una nueva.
    if (this.grabMeasureEndpoint(event)) return null
    const hit = this.pick()
    if (!hit) return null
    // Adherencia a superficie/borde: ajusta al vertice cercano si procede.
    const snapped = this.measure.snapToSurface?.(hit) ?? hit.point
    if (!this._pendingPoint) {
      this._pendingPoint = (snapped ?? hit.point).clone()
      this.measure.setPending(this._pendingPoint)
      this.requestRender()
      this.emit('measure-pick', { point: (snapped ?? hit.point).clone() })
      return null
    }
    const measurement = this.measure.add(this._pendingPoint, snapped ?? hit.point)
    this._pendingPoint = null
    this.measure.setPending(null)
    this.measure.setHover(null)
    this.requestRender()
    this.emit('measure-add', measurement)
    return measurement
  }

  handleMeasureMove(event) {
    if (this.dragMeasureEndpoint(event)) return
    this.setPointer(event)
    const hit = this.pick()
    if (!hit || !this.measure?.enabled) {
      this.measure?.setHover(null)
      return
    }
    // Anillo de snap + goma elastica con cifra en vivo si hay primer punto.
    const snapped = this.measure.snapToSurface?.(hit) ?? hit.point
    this.measure.setHover(snapped ?? hit.point, !!snapped && snapped !== hit.point)
    this.requestRender()
    if (this._pendingPoint) {
      this.emit('measure-hover', { point: (snapped ?? hit.point).clone() })
    }
  }

  // --- Vistas --------------------------------------------------------------

  setView(view) {
    if (typeof view === 'string') {
      const views = {
        frontal: [0, 0.12, 1],
        trasera: [0, 0.12, -1],
        superior: [0, 1, 0.001],
        inferior: [0, -1, 0.001],
        // Izquierda/derecha anatomicas del paciente (FDI): su derecha
        // esta en -X y su izquierda en +X; la camara se coloca de ese lado.
        izquierda: [1, 0.05, 0.02],
        derecha: [-1, 0.05, 0.02],
        isometrica: [0.42, 0.36, 0.83],
        // Alias del bridge antiguo.
        lateral: [-1, 0.05, 0.02],
        lingual: [1, 0.05, 0.02],
      }
      const dirName = views[view]
      if (!dirName) return
      const center = this.model.bounds.getCenter(new THREE.Vector3())
      const dir = new THREE.Vector3(...dirName).normalize()
      // La escala se recalcula para la nueva direccion: en ortografica cada
      // vista puede necesitar un frustum distinto para no recortar la pieza.
      this._fitOrtho(this.model.bounds, dir, 1.1)
      this._placeCamera(
        new THREE.Vector3().copy(center).addScaledVector(dir, this._frameDistance(this.model.bounds, dir, { margin: 1.1 })),
        center,
      )
      this.emit('view', view)
      return
    }
    if (view?.position && view?.target) {
      this._placeCamera(new THREE.Vector3().fromArray(view.position), new THREE.Vector3().fromArray(view.target))
    }
  }

  /** Escala en mm de un punto, segun el frustum de la camara ortografica. */
  screenToWorldMm(pixel) {
    const alto = this.camera.top - this.camera.bottom
    const perPixel = alto / (this.container.clientHeight || 1)
    return perPixel * pixel
  }

  screenshot(scale = 1) {
    const ratio = Math.max(1, Math.min(Number(scale) || 1, 4))
    if (ratio === 1) {
      this.renderer.render(this.scene, this.camera)
      return this.renderer.domElement.toDataURL('image/png')
    }
    const width = this.container.clientWidth || 1
    const height = this.container.clientHeight || 1
    this.renderer.setSize(width * ratio, height * ratio, false)
    this.renderer.render(this.scene, this.camera)
    const dataUrl = this.renderer.domElement.toDataURL('image/png')
    this.renderer.setSize(width, height, false)
    return dataUrl
  }

  handleMeasureRelease() {
    if (this._dragMeasure) {
      this._dragMeasure = null
      this.measure?.syncDoc?.()
      this.emit('measure-edit-end')
    }
    // La camara vuelve a estar disponible salvo que sigamos midiendo.
    this.controls.enabled = !this.measure?.enabled
  }

  _loop() {
    // El helper PivotControls sigue al plano antes de pintar.
    this.section?.updatePivotGizmo?.()
    // El atenuado del gizmo pide frames mientras transiciona.
    if (this.section?.updateGizmoFade?.()) this._dirty = true
    // controls.update() devuelve true mientras la camara se mueve (arrastre
    // o inercia): esos frames se pintan. Lo demas, solo si algo lo pidio,
    // mas una cola de 30 frames para rematar inercias y transiciones.
    const moved = this.controls.update()
    if (!moved && !this._dirty && this._tail <= 0) return
    const wasDirty = this._dirty
    this._dirty = false
    this._tail = moved || wasDirty ? 30 : this._tail - 1
    this.renderer.render(this.scene, this.camera)
    this.measure?.update()
    this.emit('frame')
  }

  dispose() {
    this.renderer.setAnimationLoop(null)
    window.removeEventListener('resize', this._onResize)
    this.controls.dispose()
    this.section?.dispose()
    this.measure?.dispose()
    this.renderer.dispose()
    this.renderer.domElement.remove()
  }
}

export { formatMm }

/** Nombre amigable de un objeto para la lista. */
function nameOf(mesh, index) {
  if (mesh.name) return mesh.name
  if (mesh.parent?.name) return `${mesh.parent.name} #${index + 1}`
  return `Pieza ${index + 1}`
}
