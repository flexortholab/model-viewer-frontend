import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'

import { loadModel, normalizeModel, applyDentalMaterial, prepareMaterialsForReview, isSupported } from './loaders.js'
import { SectionPlaneTool } from './section.js'
import { MeasureTool } from './measure.js'
import { createDocument, validateDocument } from './annotations.js'
import { formatMm, round } from './units.js'

export class DentalViewer {
  constructor(container, { labelLayer } = {}) {
    this.container = container
    this.labelLayer = labelLayer

    this.scene = new THREE.Scene()
    // Fondo blanco por defecto: las escenas se exportan a color desde Blender
    // y el doctor trabaja sobre un lienzo claro. ??background=dark vuelve al
    // tema oscuro.
    this.scene.background = new THREE.Color(0xffffff)

    this.renderer = new THREE.WebGLRenderer({
      antialias: true,
      stencil: true,
      preserveDrawingBuffer: true,
      powerPreference: 'high-performance',
    })
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    this.renderer.localClippingEnabled = true
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping
    this.renderer.toneMappingExposure = 1.05
    container.appendChild(this.renderer.domElement)

    this.camera = new THREE.PerspectiveCamera(38, 1, 0.1, 2000)
    this.camera.position.set(40, 30, 60)

    this.controls = new OrbitControls(this.camera, this.renderer.domElement)
    this.controls.enableDamping = true
    this.controls.dampingFactor = 0.08
    this.controls.rotateSpeed = 0.85
    this.controls.screenSpacePanning = true

    this._setupLights()
    this._setupGrid()

    this.raycaster = new THREE.Raycaster()
    this.raycaster.firstHitOnly = true
    this.pointer = new THREE.Vector2()

    this.modelRoot = new THREE.Group()
    this.modelRoot.name = 'model'
    this.scene.add(this.modelRoot)

    this.section = null
    this.measure = null
    this.markerGroup = new THREE.Group()
    this.modelRoot.add(this.markerGroup)

    this.doc = createDocument()
    this.model = null
    this.listeners = new Map()

    this._onResize = () => this.resize()
    window.addEventListener('resize', this._onResize)
    this.resize()

    this._loop = this._loop.bind(this)
    this.renderer.setAnimationLoop(this._loop)
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
    const hemi = new THREE.HemisphereLight(0xdfe8ff, 0x2a2622, 1.6)
    const key = new THREE.DirectionalLight(0xffffff, 2.6)
    key.position.set(60, 80, 70)
    const fill = new THREE.DirectionalLight(0xbcd0ff, 0.9)
    fill.position.set(-70, 20, -40)
    const rim = new THREE.DirectionalLight(0xffd9b0, 0.7)
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
    this.camera.aspect = width / height
    this.camera.updateProjectionMatrix()
    this.renderer.setSize(width, height, false)
    this.measure?.setResolution(width, height)
    this.emit('resize', { width, height })
  }

  /**
   * @param {string} url .glb | .gltf | .stl | .obj | .fbx | .3mf
   * @param {{forcedUnits?:string|null, merge?:boolean, keepMaterials?:boolean}} options
   */
  async load(url, options = {}) {
    if (!url) throw new Error('Falta la URL del modelo.')
    if (!isSupported(url)) throw new Error(`Formato no soportado: ${url}`)

    this.emit('progress', { phase: 'loading', url })

    const root = await loadModel(url, {
      renderer: this.renderer,
      onProgress: (fraction, label) => this.emit('progress', { phase: 'loading', fraction, label }),
    })

    // Sin merge por defecto: las escenas de Blender traen varios objetos y la
    // lista de objetos con el ojo los necesita por separado.
    const result = normalizeModel(root, {
      forcedUnits: options.forcedUnits ?? null,
      merge: options.merge ?? false,
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
    })

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

  /** Encuadra la camara sobre el modelo con un margen razonable. */
  frameModel({ distanceFactor = 1.9 } = {}) {
    if (!this.model) return
    const radius = Math.max(this.model.size.length() / 2, 5)
    this.camera.near = Math.max(radius / 500, 0.05)
    this.camera.far = radius * 200
    this.camera.updateProjectionMatrix()

    const center = this.model.bounds.getCenter(new THREE.Vector3())
    const distance = radius * distanceFactor
    const dir = new THREE.Vector3(0.42, 0.36, 0.83).normalize()
    this.camera.position.copy(center).addScaledVector(dir, distance)
    this.camera.up.set(0, 1, 0)
    this.controls.target.copy(center)
    this.controls.update()

    if (this.shadowCatcher) {
      this.shadowCatcher.position.y = this.model.bounds.min.y - 1
      this.keyLight.position.copy(dir).multiplyScalar(radius * 4).add(center)
    }
    // Al reenquadrar solo se recentra la camara; los planos conservan su
    // posicion para no perder el corte que el doctor estaba revisando.
    this.emit('framed', { center, radius })
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
  }

  setWireframe(enabled) {
    for (const mesh of this.model?.meshes ?? []) {
      const list = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
      for (const material of list) material.wireframe = !!enabled
    }
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
  }

  /** Activa el modo medicion y devuelve el estado. */
  setTool(tool) {
    const enabled = tool === 'measure' ? this.measure.setEnabled(true) : this.measure?.setEnabled(false)
    this.controls.enabled = !enabled
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
        // Sin posicion guardada: centrar el plano de cara a la camara.
        if (!plane && !this.section.gizmo.position.lengthSq()) this.section.reset(this.camera)
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
   * Centra la vista en un objeto concreto; con conPlane coloca y activa el
   * corte de ese objeto (despues lo ajusta el doctor con el gizmo).
   */
  focusObject(index, { withPlane = false } = {}) {
    const mesh = this.model?.meshes?.[index]
    if (!mesh) return null
    if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox()
    const box = mesh.geometry.boundingBox.clone()
    const center = box.getCenter(new THREE.Vector3())
    const radius = Math.max(box.getSize(new THREE.Vector3()).length() / 2, 2)

    this.camera.near = Math.max(radius / 500, 0.05)
    this.camera.far = radius * 200
    this.camera.updateProjectionMatrix()

    if (withPlane) {
      const viewDir = new THREE.Vector3()
      this.camera.getWorldDirection(viewDir)
      this.camera.position.copy(center).addScaledVector(viewDir, radius * 2.1)
      this.controls.target.copy(center)
      this.controls.update()
      this.section?.setPlane({ point: center.toArray(), normal: viewDir.normalize().toArray() })
      if (!this.section?.enabled) this.section?.setEnabled(true)
      this._syncDoc()
      this.emit('section', this.section.serialize())
    } else {
      const dir = new THREE.Vector3(0.42, 0.36, 0.83).normalize()
      this.camera.position.copy(center).addScaledVector(dir, radius * 1.9)
      this.controls.target.copy(center)
      this.controls.update()
    }
    this.emit('framed', { center, radius, object: index })
    this.emit('objects', this.listObjects())
    return { center, radius }
  }

  /** Vuelve a encuadrar el caso completo (salir del paso enfocado). */
  exitFocus() {
    this.frameModel()
    return true
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
      // Snapshot de presentacion: como estaba la vista, el corte y las
      // mediciones en el momento de crear el marcador. Pulsarlo en la lista
      // lo restaura todo.
      marker.view = {
        position: this.camera.position.toArray().map((n) => round(n)),
        target: this.controls.target.toArray().map((n) => round(n)),
      }
      marker.section = serial
      marker.measurements = this.measure?.serialize() ?? []
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
      this.camera.position.fromArray(marker.view.position)
      this.controls.target.fromArray(marker.view.target)
      this.controls.update()
      this.emit('view', marker.id)
    }
    if (marker.section) {
      // Mientras dura el paso, _syncDoc no debe reescribir las mediciones
      // del documento (el conjunto completo vive en doc.measurements).
      this._preservingMeasures = true
      this.section?.restore({ ...marker.section, enabled: !!marker.section.enabled })
    }
    if (Array.isArray(marker.measurements)) {
      this.measure?.restore(marker.measurements)
      this.measure?.update()
    }
    // Pulso visual en la etiqueta del marcador.
    this.measure?.pulse?.(`marker:${id}`)
    this.emit('markers', this.doc.markers)
    return marker
  }

  /** Sale del paso enfocado y recupera todas las mediciones. */
  exitMarkerFocus() {
    this._preservingMeasures = false
    this.measure?.restore(this.doc.measurements ?? [])
    this.measure?.update()
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

    const anchor = new THREE.Vector3()
    for (const marker of this.doc.markers) {
      anchor.fromArray(marker.position)
      const color =
        marker.kind === 'warning' ? 0xff6b5a : marker.kind === 'screw' ? 0x8fc7ff : 0xffd479

      const group = new THREE.Group()
      group.userData.isMarker = true
      group.userData.markerId = marker.id

      const dot = new THREE.Mesh(
        new THREE.SphereGeometry(0.55, 16, 12),
        new THREE.MeshBasicMaterial({ color, depthTest: false }),
      )
      dot.renderOrder = 1000
      group.add(dot)

      const stem = new THREE.Line(
        new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3(0, 5, 0)]),
        new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.55, depthTest: false }),
      )
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

  _syncDoc() {
    if (!this.section || !this.measure) return
    this.doc.section = this.section.serialize()
    if (!this._preservingMeasures) {
      this.doc.measurements = this.measure.serialize()
    }
    this.doc.units = 'mm'
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
    for (const hit of hits) {
      if (this.section && !this.section.isPointVisible(hit.point)) continue
      return hit
    }
    return null
  }

  handleMeasureClick(event) {
    this.setPointer(event)
    // Edicion: si el cursor agarra un extremo de una medida, arrastrarlo
    // manda sobre crear una nueva.
    const grab = this.measure.findEndpoint?.(event.clientX, event.clientY)
    if (grab) {
      this._dragMeasure = grab
      return null
    }
    const hit = this.pick()
    if (!hit) return null
    // Adherencia a superficie/borde: ajusta al vertice cercano si procede.
    const snapped = this.measure.snapToSurface?.(hit) ?? hit.point
    if (!this._pendingPoint) {
      this._pendingPoint = (snapped ?? hit.point).clone()
      this.measure.setPending(hit.point)
      this.emit('measure-pick', { point: (snapped ?? hit.point).clone() })
      return null
    }
    const measurement = this.measure.add(this._pendingPoint, snapped ?? hit.point)
    this._pendingPoint = null
    this.measure.setPending(null)
    this.emit('measure-add', measurement)
    return measurement
  }

  handleMeasureMove(event) {
    if (this._dragMeasure) {
      // Arrastre de extremo: ajusta a la superficie y repinta al vuelo.
      this.setPointer(event)
      const hit = this.pick()
      if (hit) {
        const snapped = this.measure.snapToSurface?.(hit) ?? hit.point
        this.measure.moveEndpoint(this._dragMeasure.measurement, this._dragMeasure.key, snapped ?? hit.point)
      }
      return
    }
    this.setPointer(event)
    const hit = this.pick()
    if (!hit || !this.measure?.enabled) return
    if (this._pendingPoint) {
      this.measure.setPending(hit.point)
      this.emit('measure-hover', { point: hit.point.clone() })
    }
  }

  // --- Vistas --------------------------------------------------------------

  setView(view) {
    if (typeof view === 'string') {
      const views = {
        frontal: [0, 0.12, 1],
        superior: [0, 1, 0.001],
        inferior: [0, -1, 0.001],
        // Izquierda y derecha referidos a la vista frontal del paciente.
        derecha: [-1, 0.05, 0.02],
        izquierda: [1, 0.05, 0.02],
        isometrica: [0.42, 0.36, 0.83],
        // Alias del bridge antiguo.
        lateral: [-1, 0.05, 0.02],
        lingual: [1, 0.05, 0.02],
      }
      const dir = views[view]
      if (!dir) return
      const radius = this.model ? this.model.size.length() / 2 : 20
      const center = this.model.bounds.getCenter(new THREE.Vector3())
      const d = new THREE.Vector3(...dir).normalize().multiplyScalar(radius * 1.9)
      this.camera.position.copy(center).add(d)
      this.controls.target.copy(center)
      this.controls.update()
      this.emit('view', view)
      return
    }
    if (view?.position && view?.target) {
      this.camera.position.fromArray(view.position)
      this.controls.target.fromArray(view.target)
      this.controls.update()
    }
  }

  /** Escala en mm de un punto, usando la distancia a la camara. */
  screenToWorldMm(pixel) {
    const perPixel = (2 * Math.tan((this.camera.fov * Math.PI) / 360) * this.camera.position.distanceTo(this.controls.target)) /
      (this.container.clientHeight || 1)
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
    }
  }

  _loop() {
    this.controls.update()
    this.renderer.render(this.scene, this.camera)
    this.measure?.update()
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
