import { DentalViewer } from './viewer.js'
import { createBridge } from './bridge.js'
import { download, suggestedFilename, createDocument } from './annotations.js'
import { formatMm } from './units.js'

const container = document.getElementById('viewport')
const labelLayer = document.getElementById('labels')
const hint = document.getElementById('hint')
const panel = document.getElementById('panel')
const sectionEnabled = document.getElementById('section-enabled')
const objectsPanel = document.getElementById('objects-panel')
const objectsCount = document.getElementById('objects-count')
const objectsList = document.getElementById('objects-list')
const markersPanel = document.getElementById('markers-panel')
const markersCount = document.getElementById('markers-count')
const markersList = document.getElementById('markers-list')

const EYE_ON = '\u{1F441}'
const EYE_OFF = '\u{1F441}\u{200D}\u{1F5E8}'

const viewer = new DentalViewer(container, { labelLayer })
const bridge = createBridge({ onCommand: handleHostCommand })

let currentModel = null
let forcedUnits = null
/** 'keep' (colores de la exportacion) | 'dental' (material uniforme clasico) */
let materialMode = 'keep'

// --- Estado ----------------------------------------------------------------

function showHint(text, duration = 2600) {
  hint.textContent = text
  hint.classList.add('is-visible')
  clearTimeout(showHint.timer)
  showHint.timer = setTimeout(() => hint.classList.remove('is-visible'), duration)
}

function setStatus() {}

function panelVisibility(visible) {
  panel.hidden = !visible
  objectsPanel.hidden = !visible
  markersPanel.hidden = !visible
}

function togglePanelContent(panelEl) {
  panelEl.classList.toggle('is-collapsed')
  const button = panelEl.querySelector('.panel-toggle')
  if (button) button.textContent = panelEl.classList.contains('is-collapsed') ? '+' : '-'
}

// --- Corte seccional --------------------------------------------------------

function syncSectionUI() {
  if (!viewer.section) return
  const state = viewer.section.serialize()
  sectionEnabled.checked = state.enabled
  const fuera = state.enabled && !viewer.section.planeIntersectsBounds()
  panel.classList.toggle('is-outside', fuera)
}

// --- Lista de objetos --------------------------------------------------------

function renderObjects() {
  const objects = viewer.listObjects()
  objectsCount.textContent = objects.length > 1 ? `${objects.length} piezas` : '1 pieza'
  objectsList.innerHTML = ''
  objects.forEach((object) => {
    const li = document.createElement('li')
    li.className = 'obj-item' + (object.visible ? '' : ' is-hidden')
    li.title = 'Clic: centrar la vista en esta pieza'

    const eye = document.createElement('button')
    eye.type = 'button'
    eye.className = 'obj-eye' + (object.visible ? '' : ' is-off')
    eye.textContent = object.visible ? EYE_ON : EYE_OFF
    eye.title = object.visible ? 'Ocultar' : 'Mostrar'
    eye.setAttribute('aria-pressed', String(object.visible))
    eye.addEventListener('click', () => {
      viewer.setMeshVisible(object.index, !object.visible)
      renderObjects()
    })

    const name = document.createElement('span')
    name.className = 'obj-name'
    name.textContent = object.name

    const tris = document.createElement('span')
    tris.className = 'obj-tris'
    tris.textContent = `${object.triangles.toLocaleString('es')} tri`

    const cut = document.createElement('button')
    cut.type = 'button'
    cut.className = 'obj-cut'
    cut.textContent = '\u2702'
    cut.title = 'Centrar la vista y activar el corte en esta pieza'
    cut.addEventListener('click', () => {
      viewer.focusObject(object.index, { withPlane: true })
      syncSectionUI()
      showHint(`Corte preparado en "${object.name}": ajusta el plano con el gizmo`, 3200)
    })

    const row = document.createElement('span')
    row.className = 'obj-row'
    row.append(eye, name, tris, cut)
    li.dataset.index = object.index
    row.addEventListener('click', (event) => {
      if (event.target.closest('button')) return
      viewer.focusObject(object.index)
      showHint(`Vista centrada en "${object.name}"`)
    })
    li.append(row)
    objectsList.append(li)
  })
}

// --- Presentacion (marcadores) --------------------------------------------
let activeMarkerId = null

function renderMarkers() {
  const markers = viewer.doc.markers ?? []
  markersCount.textContent = markers.length ? `${markers.length}` : ''
  markersList.innerHTML = ''
  markers.forEach((marker, index) => {
    const li = document.createElement('li')
    li.className = 'marker-item'
    li.dataset.kind = marker.kind
    li.title = 'Pulsa para mostrar el caso en el estado guardado'

    const idx = document.createElement('span')
    idx.className = 'marker-idx'
    idx.textContent = String(index + 1)

    const text = document.createElement('span')
    text.className = 'marker-text' + (marker.text ? '' : ' is-empty')
    text.textContent = marker.text || `Paso ${index + 1}`
    text.title = 'Doble clic para editar el texto'
    text.addEventListener('dblclick', (event) => {
      event.stopPropagation()
      const next = window.prompt('Texto del marcador:', marker.text ?? '')
      if (next === null) return
      viewer.updateMarker(marker.id, { text: next.trim() })
      renderMarkers()
    })

    li.append(idx, text)

    if (marker.id === activeMarkerId) li.classList.add('is-active')

    const del = document.createElement('button')
    del.type = 'button'
    del.className = 'marker-delete'
    del.textContent = '\u00d7'
    del.title = 'Eliminar marcador'
    del.addEventListener('click', () => {
      if (marker.id === activeMarkerId) {
        viewer.exitMarkerFocus()
        activeMarkerId = null
      } else if (viewer._preservingMeasures) viewer.exitMarkerFocus()
      viewer.removeMarker(marker.id)
      renderMarkers()
    })
    li.append(del)

    li.addEventListener('click', (event) => {
      if (event.target.closest('.marker-delete')) return
      const result = viewer.focusMarker(marker.id)
      if (result) {
        activeMarkerId = marker.id
        renderMarkers()
        showHint(`Paso ${index + 1}${result.text ? `: ${result.text}` : ''}`, 3200)
      }
    })
    markersList.append(li)
  })
}

// --- Eventos del visor -----------------------------------------------------

viewer.on('loaded', (info) => {
  currentModel = info
  panelVisibility(true)
  const { x, y, z } = info.sizeMm
  setStatus(
    `${info.stats.triangles.toLocaleString('es')} tri · ${x} × ${y} × ${z} mm`,
  )
  syncSectionUI()
  renderObjects()
  renderMarkers()
  bridge.loaded(info)
})

viewer.on('changed', (doc) => {
  bridge.changed(doc)
  renderMarkers()
})

viewer.on('markers', () => renderMarkers())

viewer.on('objects', () => renderObjects())

viewer.on('progress', ({ fraction, phase }) => {
  if (phase === 'loading' && Number.isFinite(fraction)) {
    setStatus(`Cargando ${Math.round(fraction * 100)}%`)
  }
})

viewer.on('section', () => syncSectionUI())

viewer.on('measure-pick', () => showHint('Segundo punto para completar la medida', 4000))

viewer.on('measure-add', () => {
  // Medida creada: devolver el modelo a la camara libre (era la queja: el
  // modo cotas bloqueaba la orbita indefinidamente).
  showHint('Medida creada', 2600)
})

viewer.on('error', (error) => {
  setStatus(error.message)
  bridge.error(error)
})

// --- Herramientas ----------------------------------------------------------

async function loadModel(url, options = {}) {
  setStatus('Cargando modelo…')
  forcedUnits = options.forcedUnits ?? forcedUnits
  if (typeof options.material === 'string') materialMode = options.material
  const info = await viewer.load(url, {
    forcedUnits,
    merge: options.merge ?? false,
    keepMaterials: materialMode !== 'dental',
  })
  if (options.annotations) await applyAnnotations(options.annotations)
  return info
}

async function applyAnnotations(source) {
  try {
    let raw = source
    if (typeof source === 'string') {
      const response = await fetch(source)
      if (!response.ok) throw new Error(`Anotaciones: HTTP ${response.status}`)
      raw = await response.json()
    }
    const doc = viewer.applyAnnotations(raw)
    if (doc.model && doc.model !== viewer.model?.url) {
      await loadModel(doc.model, { annotations: doc })
    }
    syncSectionUI()
    return doc
  } catch (error) {
    setStatus(error.message)
    throw error
  }
}

function exportAnnotations() {
  if (!viewer.model) return
  const doc = viewer.getAnnotations()
  doc.model = viewer.model.url
  download(doc, suggestedFilename(viewer.model.url))
  showHint('Anotaciones descargadas')
}

function toggleMeasure() {
  let active = false
  if (viewer.measure?.enabled) {
    viewer.setTool('orbit') // segundo pulsado del boton: salir del modo cotas
  } else {
    active = viewer.setTool('measure') === 'measure'
  }
  container.classList.toggle('is-measuring', active)
  const button = document.querySelector('[data-action="measure"]')
  button?.setAttribute('aria-pressed', String(active))
  if (active && markerMode) toggleMarkerTool()
  showHint(
    active
      ? 'Medir: pulsa dos puntos sobre la pieza. Doble clic en la cifra para borrar.'
      : 'Cámara libre: pulsa Medir para cotar otra vez',
  )
  return active
}

/**
 * Modo marcador: pulsar sobre la pieza anade un marcador (texto via prompt).
 * Convive con la medicion: se activa uno desactiva el otro.
 */
let markerMode = false

function toggleMarkerTool() {
  markerMode = !markerMode
  if (markerMode && viewer.measure?.enabled) {
    viewer.setTool('orbit')
    container.classList.remove('is-measuring')
    document.querySelector('[data-action="measure"]')?.setAttribute('aria-pressed', 'false')
  }
  container.classList.toggle('is-marking', markerMode)
  document.querySelector('[data-action="add-marker"]')?.setAttribute('aria-pressed', String(markerMode))
  showHint(markerMode ? 'Marcador: pulsa un punto de la pieza (guarda vista y corte actuales)' : '')
}

function addMarkerAt(event) {
  viewer.setPointer(event)
  const hit = viewer.pick()
  if (!hit) {
    showHint('No hay pieza bajo el cursor', 1500)
    return
  }
  const text = (window.prompt('Texto del marcador (opcional):', '') ?? '').trim()
  const kindInput = (window.prompt("Clase del marcador: 'note', 'warning' o 'screw':", 'note') ?? '').trim()
  const kind = ['warning', 'screw'].includes(kindInput) ? kindInput : 'note'
  viewer.addMarker({ position: hit.point.toArray(), text, kind })
  showHint('Paso guardado' + (text ? `: ${text}` : ''))
}

// --- Comandos del webclip --------------------------------------------------

const ACTIONS = {
  async load({ model, annotations, units, merge, material }) {
    forcedUnits = units ?? null
    await loadModel(model, { annotations, forcedUnits: units, merge, material })
  },
  async annotations(payload) {
    await applyAnnotations(payload.annotations ?? payload)
  },
  section(payload) {
    viewer.setSection(payload ?? {})
    syncSectionUI()
  },
  sectionPlane({ enabled, point, normal, mode }) {
    viewer.setSectionMode?.(mode)
    viewer.setSection({ enabled, plane: { point, normal } })
    syncSectionUI()
  },
  sectionAxis({ axis, offset }) {
    viewer.setSectionAxis(axis, offset, { enable: true })
    syncSectionUI()
  },
  sectionAxisEnabled() {},
  objects({ index, visible }) {
    viewer.setMeshVisible(Number(index), !!visible)
  },
  tool({ tool }) {
    toggleMeasure()
    if (tool !== 'measure') container.classList.remove('is-measuring')
  },
  view({ name }) {
    viewer.setView(name)
  },
  background({ value }) {
    viewer.setBackground(value)
  },
  wireframe({ enabled }) {
    viewer.setWireframe(enabled)
  },
  opacity({ value }) {
    viewer.setModelOpacity(value)
  },
  frame() {
    viewer.frameModel()
  },
  clearMeasurements() {
    viewer.measure?.clear()
  },
  marker({ position, text, kind, snapshot }) {
    if (!Array.isArray(position)) throw new Error('marker: falta position (array de 3)')
    return viewer.addMarker({ position, text, kind, snapshot: snapshot === true || snapshot === undefined })
  },
  clearMarkers() {
    viewer.clearMarkers()
    renderMarkers()
  },
  updateMarker({ id, text, kind }) {
    const marker = viewer.updateMarker(String(id), { text, kind })
    if (marker) renderMarkers()
    return marker
  },
  focusMarker({ id }) {
    const result = viewer.focusMarker(String(id))
    if (result) {
      syncSectionUI()
      bridge.post('markers', { markers: viewer.doc.markers, focused: id })
    }
    return result
  },
  getAnnotations() {
    bridge.post('annotations', { annotations: viewer.getAnnotations() })
  },
  exportAnnotations() {
    exportAnnotations()
  },
  screenshot() {
    bridge.post('screenshot', { dataUrl: viewer.screenshot() })
  },
  resize() {
    viewer.resize()
  },
}

function handleHostCommand(action, payload) {
  const handler = ACTIONS[action]
  if (!handler) {
    bridge.log('warn', `Accion desconocida: ${action}`)
    return
  }
  Promise.resolve(handler(payload)).catch((error) => bridge.error(error))
}

// --- Interfaz --------------------------------------------------------------

// Un solo receptor de clics para TODA la UI (toolbar, paneles): sin esto los
// botones de los paneles no reaccionan en Firefox.
document.addEventListener('click', (event) => {
  const button = event.target.closest('button')
  if (!button) return

  if (button.dataset.view) {
    viewer.setView(button.dataset.view)
    return
  }
  switch (button.dataset.action) {
    case 'frame':
      viewer.frameModel()
      break
    case 'move':
      // Camara libre: cancela cotas y marcador a la vez.
      if (viewer.measure?.enabled) toggleMeasure()
      if (markerMode) toggleMarkerTool()
      showHint('Cámara libre')
      break
    case 'measure':
      toggleMeasure()
      break
    case 'add-marker':
      toggleMarkerTool()
      break
    case 'clear-markers':
      viewer.clearMarkers()
      renderMarkers()
      showHint('Marcadores borrados')
      break
    case 'clear-measurements':
      viewer.measure?.clear()
      showHint('Medidas borradas')
      break
    case 'export':
      exportAnnotations()
      break
    case 'toggle-panel':
      togglePanelContent(panel)
      break
    case 'toggle-objects':
      togglePanelContent(objectsPanel)
      break
    case 'toggle-markers':
      togglePanelContent(markersPanel)
      break
    case 'section-reset':
      viewer.resetSectionPlane()
      showHint('Plano centrado en la pieza, perpendicular a la vista actual')
      break
    case 'section-orient':
      viewer.orientSectionPlane()
      showHint('Plano girado 90 grados en su sitio', 2200)
      break
    case 'marker-unfocus':
      viewer.exitMarkerFocus()
      activeMarkerId = null
      renderMarkers()
      showHint('Vista libre: se vuelven a mostrar todas las mediciones')
      break
  }
})

sectionEnabled.addEventListener('change', () => {
  viewer.setSection({ enabled: sectionEnabled.checked })
  showHint(
    sectionEnabled.checked
      ? 'Corte activo: mueve/rota el plano con el gizmo'
      : 'Corte desactivado (se conserva la posicion del plano)',
  )
})


container.addEventListener('pointerdown', (event) => {
  if (markerMode && !event.target.closest('.panel, #toolbar, #toolbars')) {
    addMarkerAt(event)
    return
  }
  if (!viewer.measure?.enabled) return
  if (event.target.closest('.panel, #toolbar, #toolbars')) return
  viewer.handleMeasureClick(event)
})

container.addEventListener('pointermove', (event) => {
  if (!viewer.measure?.enabled) return
  viewer.handleMeasureMove(event)
})

container.addEventListener('pointerup', () => {
  viewer.handleMeasureRelease?.()
})

window.addEventListener('keydown', (event) => {
  if (event.target.matches('input, textarea')) return
  switch (event.key.toLowerCase()) {
    case 'm':
      toggleMeasure()
      break
    case 'k':
      toggleMarkerTool()
      break
    case 'f':
      viewer.frameModel()
      break
    case 'e':
      exportAnnotations()
      break
    case 'escape':
      if (viewer.measure?.enabled) toggleMeasure()
      if (markerMode) toggleMarkerTool()
      break
  }
})

// --- Arranque --------------------------------------------------------------

async function boot() {
  const params = new URLSearchParams(window.location.search)
  forcedUnits = params.get('units') || null
  materialMode = params.get('material') === 'dental' ? 'dental' : 'keep'

  if (params.has('background')) viewer.setBackground(params.get('background'))

  const model = params.get('model')
  const annotations = params.get('annotations')

  if (model) {
    await loadModel(model, { annotations })
  } else {
    viewer.doc = createDocument()
    panelVisibility(false)
    setStatus('Esperando modelo. Usa ?model=... o el comando postMessage "load".')
  }

  if (params.has('section')) {
    const spec = params.get('section') // p.ej. "y=2.5" o "z=-1"
    const [axis, value] = String(spec).split('=')
    if (axis && Number.isFinite(Number(value))) {
      viewer.setSection({ enabled: true })
      viewer.setSectionAxis(axis.toLowerCase(), Number(value))
      syncSectionUI()
    }
  }

  bridge.ready()
}

boot().catch((error) => {
  console.error('[dental-viewer] arranque:', error)
  setStatus(error.message)
  bridge.error(error)
})

// Util para depurar desde la consola del navegador.
window.dentalViewer = viewer
