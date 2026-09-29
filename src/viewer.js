import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'

import { loadModel, normalizeModel, applyDentalMaterial, isSupported } from './loaders.js'
import { SectionTool, AXIS_LABELS } from './section.js'
import { MeasureTool } from './measure.js'
import { createDocument, validateDocument } from './annotations.js'
import { formatMm, round } from './units.js'

export class DentalViewer {
  constructor(container, { labelLayer } = {}) {
    this.container = container
    this.labelLayer = labelLayer

    this.scene = new THREE.Scene()
    this.scene.background = new THREE.Color(0x14161a)

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
   * @param {{forcedUnits?:string|null, merge?:boolean}} options
   */
  async load(url, options = {}) {
    if (!url) throw new Error('Falta la URL del modelo.')
    if (!isSupported(url)) throw new Error(`Formato no soportado: ${url}`)

    this.emit('progress', { phase: 'loading', url })

    const root = await loadModel(url, {
      renderer: this.renderer,
      onProgress: (fraction, label) => this.emit('progress', { phase: 'loading', fraction, label }),
    })

    const result = normalizeModel(root, {
      forcedUnits: options.forcedUnits ?? null,
      merge: options.merge ?? true,
    })

    // Limpieza del modelo anterior.
    this.section?.dispose()
    this.measure?.dispose()
    this.modelRoot.clear()
    // modelRoot.clear() descolgó markerGroup: hay que re-adjuntarlo para que
    // los marcadores sigan visibles (y disponibles) tras cargar otro modelo.
    this.modelRoot.add(this.markerGroup)

    this.modelRoot.add(root)
    applyDentalMaterial(result.meshes)

    this.model = { url, ...result }
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
    }
    this.emit('loaded', info)
    return info
  }

  _setupTools() {
    this.section = new SectionTool(this.renderer, {
      modelRoot: this.modelRoot,
      meshes: this.model.meshes,
      size: this.model.size,
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
        light: 0xf2f3f5,
        dark: 0x14161a,
        studio: 0x8f9296,
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

  // --- Corte seccional -----------------------------------------------------

  setSection({ enabled, planes } = {}) {
    if (!this.section) throw new Error('No hay modelo cargado.')
    if (planes) this.section.configure(planes)
    if (enabled !== undefined) this.section.setEnabled(enabled)
    else this.section.apply()
    this._syncDoc()
    this.emit('section', this.section.serialize())
    return this.section.serialize()
  }

  setSectionAxis(axis, offset, { enable = true } = {}) {
    if (enable) this.section?.setAxisEnabled(axis, true)
    this.section?.setOffset(axis, offset)
    this._syncDoc()
    this.emit('section', this.section.serialize())
  }

  setSectionAxisEnabled(axis, enabled) {
    this.section?.setAxisEnabled(axis, enabled)
    this._syncDoc()
    this.emit('section', this.section.serialize())
  }

  sectionAxisRange(axis) {
    return this.section?.axisRange(axis) ?? { min: -1, max: 1, half: 1 }
  }

  axisLabel(axis) {
    return AXIS_LABELS[axis] ?? axis
  }

  setCapColor(hex) {
    this.section?.setCapColor(hex)
    this._syncDoc()
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

    this.section.restore(doc.section)
    this.measure.restore(doc.measurements)
    this._renderMarkers()

    if (doc.model && doc.model !== this.model.url) {
      return doc // el modelo corresponde a otro archivo: lo carga el host
    }
    this.emit('annotations', doc)
    return doc
  }

  addMarker({ position, text = '', kind = 'note' }) {
    const marker = { id: `k${this.markerGroup.children.length + 1}`, position, text, kind }
    this.doc.markers.push(marker)
    this._renderMarkers()
    this._syncDoc()
    return marker
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
    this.doc.measurements = this.measure.serialize()
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
    const hit = this.pick()
    if (!hit) return null
    if (!this._pendingPoint) {
      this._pendingPoint = hit.point.clone()
      this.measure.setPending(hit.point)
      this.emit('measure-pick', { point: hit.point.clone() })
      return null
    }
    const measurement = this.measure.add(this._pendingPoint, hit.point)
    this._pendingPoint = null
    this.measure.setPending(null)
    this.emit('measure-add', measurement)
    return measurement
  }

  handleMeasureMove(event) {
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
        lateral: [1, 0.05, 0.02],
        lingual: [-1, 0.05, 0.02],
        isometrica: [0.42, 0.36, 0.83],
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
