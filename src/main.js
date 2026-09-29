import { DentalViewer } from './viewer.js'
import { createBridge } from './bridge.js'
import { download, suggestedFilename, createDocument } from './annotations.js'
import { formatMm } from './units.js'

const container = document.getElementById('viewport')
const labelLayer = document.getElementById('labels')
const statusInfo = document.getElementById('status-info')
const statusUnits = document.getElementById('status-units')
const hint = document.getElementById('hint')
const panel = document.getElementById('panel')
const sectionEnabled = document.getElementById('section-enabled')
const capColor = document.getElementById('cap-color')

const viewer = new DentalViewer(container, { labelLayer })
const bridge = createBridge({ onCommand: handleHostCommand })

let currentModel = null
let forcedUnits = null

// --- Estado ----------------------------------------------------------------

function showHint(text, duration = 2600) {
  hint.textContent = text
  hint.classList.add('is-visible')
  clearTimeout(showHint.timer)
  showHint.timer = setTimeout(() => hint.classList.remove('is-visible'), duration)
}

function setStatus(text) {
  statusInfo.textContent = text
}

function showUnitsBadge(units) {
  const forced = units.source === 'forced'
  const warn = units.confidence < 0.5
  statusUnits.hidden = false
  statusUnits.classList.toggle('is-warn', warn)
  statusUnits.textContent = forced
    ? `${units.maxDimMm.toFixed(1)} mm (forzado: ${units.units})`
    : `${units.maxDimMm.toFixed(1)} mm (${units.units} detectados)`
  statusUnits.title = warn
    ? 'Tamano fuera de rango: revisa las unidades del archivo'
    : `Archivo en ${units.units} (max ${units.maxDimRaw.toFixed(3)}), escalado x${units.scale}`
}

function syncSectionUI() {
  if (!viewer.section) return
  const state = viewer.section.serialize()
  sectionEnabled.checked = state.enabled

  for (const plane of state.planes) {
    const input = document.querySelector(`input[data-axis="${plane.axis}"]`)
    const output = document.querySelector(`output[data-axis-output="${plane.axis}"]`)
    const check = document.querySelector(`input[data-axis-check="${plane.axis}"]`)
    const row = input?.closest('.axis')
    if (!input || !output) continue
    const range = viewer.sectionAxisRange(plane.axis)
    input.min = range.min.toFixed(2)
    input.max = range.max.toFixed(2)
    input.value = String(plane.offset)
    output.textContent = formatMm(plane.offset, 1)
    if (check) check.checked = plane.enabled
    row?.classList.toggle('is-off', !plane.enabled)
  }
}

function panelVisibility(visible) {
  panel.hidden = !visible
}

// --- Eventos del visor -----------------------------------------------------

viewer.on('loaded', (info) => {
  currentModel = info
  panelVisibility(true)
  showUnitsBadge(info.units)
  const { x, y, z } = info.sizeMm
  setStatus(
    `${info.stats.triangles.toLocaleString('es')} tri · ${x} × ${y} × ${z} mm`,
  )
  syncSectionUI()
  bridge.loaded(info)
})

viewer.on('changed', (doc) => {
  bridge.changed(doc)
})

viewer.on('progress', ({ fraction, phase }) => {
  if (phase === 'loading' && Number.isFinite(fraction)) {
    setStatus(`Cargando ${Math.round(fraction * 100)}%`)
  }
})

viewer.on('section', (state) => {
  syncSectionUI()
  const fuera = state.planes.filter(
    (plane) => plane.enabled && !viewer.section.planeIntersectsBounds(plane.axis, plane.offset),
  )
  if (fuera.length) {
    showHint(`El corte ${fuera.map((p) => p.axis.toUpperCase()).join(', ')} cae fuera de la pieza`, 2200)
  }
})

viewer.on('measure-pick', () => showHint('Segundo punto para completar la medida', 4000))

viewer.on('error', (error) => {
  setStatus(error.message)
  bridge.error(error)
})

// --- Herramientas ----------------------------------------------------------

async function loadModel(url, options = {}) {
  setStatus('Cargando modelo…')
  forcedUnits = options.forcedUnits ?? forcedUnits
  const info = await viewer.load(url, { forcedUnits, merge: options.merge ?? true })
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
  const active = viewer.setTool('measure') === 'measure'
  container.classList.toggle('is-measuring', active)
  const button = document.querySelector('[data-action="measure"]')
  button?.setAttribute('aria-pressed', String(active))
  if (active && markerMode) toggleMarkerTool()
  showHint(active ? 'Medir: pulsa dos puntos sobre la pieza. Doble clic en la cifra para borrar.' : '')
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
  showHint(markerMode ? 'Marcador: pulsa un punto de la pieza' : '')
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
  showHint('Marcador añadido' + (text ? `: ${text}` : ''))
}

// --- Comandos del webclip --------------------------------------------------

const ACTIONS = {
  async load({ model, annotations, units, merge }) {
    forcedUnits = units ?? null
    await loadModel(model, { annotations, forcedUnits: units, merge })
  },
  async annotations(payload) {
    await applyAnnotations(payload.annotations ?? payload)
  },
  section(payload) {
    viewer.setSection(payload)
    syncSectionUI()
  },
  sectionAxis({ axis, offset }) {
    viewer.setSectionAxis(axis, offset, { enable: true })
    syncSectionUI()
  },
  sectionAxisEnabled({ axis, enabled }) {
    viewer.setSectionAxisEnabled(axis, enabled)
    syncSectionUI()
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
  marker({ position, text, kind }) {
    if (!Array.isArray(position)) throw new Error('marker: falta position (array de 3)')
    return viewer.addMarker({ position, text, kind })
  },
  clearMarkers() {
    viewer.clearMarkers()
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

document.getElementById('toolbar').addEventListener('click', (event) => {
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
    case 'measure':
      toggleMeasure()
      break
    case 'clear-measurements':
      viewer.measure?.clear()
      showHint('Medidas borradas')
      break
    case 'add-marker':
      toggleMarkerTool()
      break
    case 'clear-markers':
      viewer.clearMarkers()
      showHint('Marcadores borrados')
      break
    case 'export':
      exportAnnotations()
      break
    case 'toggle-panel':
      panel.classList.toggle('is-collapsed')
      button.textContent = panel.classList.contains('is-collapsed') ? '+' : '–'
      break
  }
})

sectionEnabled.addEventListener('change', () => {
  viewer.setSection({ enabled: sectionEnabled.checked })
  showHint(
    sectionEnabled.checked
      ? 'Corte seccional activo'
      : 'Corte seccional desactivado (se conservan las posiciones)',
  )
})

capColor.addEventListener('input', () => {
  viewer.setCapColor(Number.parseInt(capColor.value.slice(1), 16))
})

for (const input of document.querySelectorAll('input[data-axis]')) {
  input.addEventListener('input', () => {
    const axis = input.dataset.axis
    const offset = Number(input.value)
    document.querySelector(`output[data-axis-output="${axis}"]`).textContent = formatMm(offset, 1)
    viewer.setSectionAxis(axis, offset, { enable: true })
    if (!sectionEnabled.checked) {
      sectionEnabled.checked = true
      viewer.setSection({ enabled: true })
    }
  })
}

for (const check of document.querySelectorAll('input[data-axis-check]')) {
  check.addEventListener('change', () => {
    const axis = check.dataset.axisCheck
    viewer.setSectionAxisEnabled(axis, check.checked)
    // Si es el ultimo eje activo, activar el corte general: el interruptor
    // global refleja "hay algun corte encendido".
    const anyActive = viewer.section.planes.some((plane) => plane.enabled)
    if (anyActive && !sectionEnabled.checked) {
      sectionEnabled.checked = true
      viewer.setSection({ enabled: true })
    }
    if (!anyActive && sectionEnabled.checked) {
      sectionEnabled.checked = false
      viewer.setSection({ enabled: false })
    }
  })
}

container.addEventListener('pointerdown', (event) => {
  if (markerMode && !event.target.closest('.panel, #toolbar')) {
    addMarkerAt(event)
    return
  }
  if (!viewer.measure?.enabled) return
  if (event.target.closest('.panel, #toolbar')) return
  viewer.handleMeasureClick(event)
})

container.addEventListener('pointermove', (event) => {
  if (!viewer.measure?.enabled) return
  viewer.handleMeasureMove(event)
})

window.addEventListener('keydown', (event) => {
  if (event.target.matches('input, textarea')) return
  switch (event.key.toLowerCase()) {
    case 'm':
      toggleMeasure()
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
    case 'k':
      toggleMarkerTool()
      break
  }
})

// --- Arranque --------------------------------------------------------------

async function boot() {
  const params = new URLSearchParams(window.location.search)
  forcedUnits = params.get('units') || null

  if (params.has('background')) viewer.setBackground(params.get('background'))
  if (params.get('embed') === '1') {
    document.getElementById('toolbar').hidden = true
    panelVisibility(false)
  }

  const model = params.get('model')
  const annotations = params.get('annotations')

  if (model) {
    await loadModel(model, { annotations })
  } else {
    viewer.doc = createDocument()
    panelVisibility(true)
    setStatus('Esperando modelo. Usa ?model=... o el comando postMessage "load".')
  }

  if (params.has('section')) {
    const spec = params.get('section') // p.ej. "y=2.5" o "z=-1"
    const [axis, value] = String(spec).split('=')
    if (axis && Number.isFinite(Number(value))) {
      viewer.setSection({ enabled: true })
      viewer.setSectionAxis(axis.toLowerCase(), Number(value))
    }
  }

  bridge.ready()
}

boot().catch((error) => {
  setStatus(error.message)
  bridge.error(error)
})

// Util para depurar desde la consola del navegador.
window.dentalViewer = viewer
