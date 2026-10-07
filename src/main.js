// SPDX-License-Identifier: GPL-3.0-or-later
import * as THREE from 'three'
import { DentalViewer } from './viewer.js'
import { createBridge } from './bridge.js'
import { download, suggestedFilename, createDocument, toStoredConfig } from './annotations.js'
import { api, session } from './app-session.js'
import { authorizedCall } from './authorized.js'
import { configBytes, MAX_CONFIG_BYTES } from './cases.js'
import { loginUrl } from './navigation.js'
import { createModelCache } from './model-cache.js'
import { createAutosave } from './autosave.js'
import { createCaseHistory } from './case-history.js'
import { formatMm } from './units.js'
import { BRAND, applyBrand } from './brand.js'

applyBrand()

const _cuboQ = new THREE.Quaternion()
const _cuboM = new THREE.Matrix4()

const container = document.getElementById('viewport')
const labelLayer = document.getElementById('labels')
const hint = document.getElementById('hint')
const panel = document.getElementById('panel')
const sectionToggle = document.getElementById('section-toggle')
const toolsPanel = document.getElementById('tools-bar')
const objectsPanel = document.getElementById('objects-panel')
const objectsCount = document.getElementById('objects-count')
const objectsList = document.getElementById('objects-list')
const markersPanel = document.getElementById('markers-panel')
const markersCount = document.getElementById('markers-count')
const markersList = document.getElementById('markers-list')
const docTitle = document.getElementById('doc-title')
const loader = document.getElementById('loader')
const loaderText = document.getElementById('loader-text')
const markerDialog = document.getElementById('marker-dialog')
const markerDialogText = document.getElementById('marker-dialog-text')
const markerKindButtons = [...document.querySelectorAll('[data-marker-kind]')]
const markerDialogError = document.getElementById('marker-dialog-error')

const mobileUi = document.getElementById('mobile-ui')
const mobileToolbar = document.getElementById('mobile-toolbar')
const mobileTitle = document.getElementById('mobile-title')
const caseMessage = document.getElementById('case-message')
const saveCaseButton = document.querySelector('[data-action="save-case"]')
const undoButton = document.querySelector('[data-action="undo-case"]')
const redoButton = document.querySelector('[data-action="redo-case"]')
const saveStatus = document.getElementById('save-status')
const mobileObjectsList = document.getElementById('mobile-objects-list')
const mobileMarkersList = document.getElementById('mobile-markers-list')

// Iconos de la interfaz: mismo trazo teal que las barras, sin emojis del sistema.
const ICON_EYE =
  '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M1.6 8s2.4-4.3 6.4-4.3S14.4 8 14.4 8s-2.4 4.3-6.4 4.3S1.6 8 1.6 8z"/><circle cx="8" cy="8" r="1.9"/></svg>'
const ICON_EYE_OFF =
  '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M1.6 8s2.4-4.3 6.4-4.3c1.2 0 2.3.3 3.2.8M14.4 8s-2.4 4.3-6.4 4.3c-1.1 0-2.1-.3-3-.7"/><path d="M2.4 2.4l11.2 11.2"/></svg>'
const ICON_CUT =
  '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="4" cy="4" r="2.2"/><circle cx="4" cy="12" r="2.2"/><path d="M5.8 5.8 14 14M5.8 10.2 14 2"/></svg>'

function setIcon(element, markup) {
  element.innerHTML = markup
  return element
}

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
  if (mobileToolbar) mobileToolbar.hidden = !visible
}

function togglePanelContent(panelEl) {
  panelEl.classList.toggle('is-collapsed')
  const button = panelEl.querySelector('.panel-toggle')
  if (button) button.textContent = panelEl.classList.contains('is-collapsed') ? '+' : '-'
}

function collapsePanelsOnMobile() {
  if (window.innerWidth > 640) return
  for (const panelEl of [panel, toolsPanel, objectsPanel, markersPanel]) {
    if (panelEl && !panelEl.classList.contains('is-collapsed')) togglePanelContent(panelEl)
  }
}

function openMobileModal(id) {
  for (const modal of document.querySelectorAll('.mobile-modal')) modal.hidden = true
  const modal = document.getElementById(id)
  if (modal) modal.hidden = false
}

function closeMobileModals() {
  for (const modal of document.querySelectorAll('.mobile-modal')) modal.hidden = true
}

function goHome() {
  closeMobileModals()
  activeMarkerId = null
  viewer.exitMarkerFocus()
  viewer.setSection({ enabled: false })
  viewer.setMarkersVisible(false)
  for (const obj of viewer.listObjects()) viewer.setMeshVisible(obj.index, true)
  showHint('Vista inicial')
}

// --- Corte seccional --------------------------------------------------------

function syncSectionUI() {
  if (!viewer.section) return
  const state = viewer.section.serialize()
  sectionToggle?.setAttribute('aria-pressed', String(state.enabled))
  const fuera = state.enabled && !viewer.section.planeIntersectsBounds()
  panel.classList.toggle('is-outside', fuera)
  const gizmoBtn = document.getElementById('gizmo-toggle')
  gizmoBtn?.setAttribute('aria-pressed', String(!!viewer.section.gizmoOn))
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
    setIcon(eye, object.visible ? ICON_EYE : ICON_EYE_OFF)
    eye.title = object.visible ? 'Ocultar' : 'Mostrar'
    eye.setAttribute('aria-pressed', String(object.visible))
    eye.addEventListener('click', () => {
      viewer.setMeshVisible(object.index, !object.visible)
      renderObjects()
    })

    const name = document.createElement('span')
    name.className = 'obj-name'
    name.textContent = object.name

    const cut = document.createElement('button')
    cut.type = 'button'
    cut.className = 'obj-cut'
    setIcon(cut, ICON_CUT)
    cut.title = 'Activar el corte en esta pieza (sin cambiar el zoom)'
    cut.addEventListener('click', () => {
      viewer.focusObject(object.index, { withPlane: true })
      syncSectionUI()
      showHint(`Corte preparado en "${object.name}": ajusta el plano con el gizmo`, 3200)
    })

    const row = document.createElement('span')
    row.className = 'obj-row'
    row.append(eye, name, cut)
    li.dataset.index = object.index
    row.addEventListener('click', (event) => {
      if (event.target.closest('button')) return
      viewer.focusObject(object.index)
      showHint(`Vista centrada en "${object.name}"`)
    })
    li.append(row)
    objectsList.append(li)
  })
  renderMobileObjects()
}

function renderMobileObjects() {
  if (!mobileObjectsList) return
  const objects = viewer.listObjects()
  mobileObjectsList.innerHTML = ''
  objects.forEach((object) => {
    const li = document.createElement('li')
    li.className = 'obj-item' + (object.visible ? '' : ' is-hidden')

    // Toda la fila es un unico boton grande (ojo + nombre), para acertar con
    // el dedo: no hace falta apuntar al ojo.
    const toggle = document.createElement('button')
    toggle.type = 'button'
    toggle.className = 'obj-toggle'
    toggle.title = object.visible ? 'Ocultar' : 'Mostrar'
    toggle.setAttribute('aria-pressed', String(object.visible))

    const eye = document.createElement('span')
    eye.className = 'obj-eye' + (object.visible ? '' : ' is-off')
    eye.setAttribute('aria-hidden', 'true')
    setIcon(eye, object.visible ? ICON_EYE : ICON_EYE_OFF)

    const name = document.createElement('span')
    name.className = 'obj-name'
    name.textContent = object.name

    toggle.append(eye, name)
    toggle.addEventListener('click', () => {
      viewer.setMeshVisible(object.index, !object.visible)
      renderObjects()
    })
    li.append(toggle)
    mobileObjectsList.append(li)
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
    text.textContent = marker.text || `Marcador ${index + 1}`
    text.title = readOnly ? marker.text || '' : 'Doble clic para editar el texto'
    text.addEventListener('dblclick', (event) => {
      event.stopPropagation()
      if (readOnly) return
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
    if (!readOnly) li.append(del)

    li.addEventListener('click', (event) => {
      if (event.target.closest('.marker-delete')) return
      const result = viewer.focusMarker(marker.id)
      if (result) {
        activeMarkerId = marker.id
        renderMarkers()
        showHint(`Marcador ${index + 1}${result.text ? `: ${result.text}` : ''}`, 3200)
      }
    })
    markersList.append(li)
  })
  renderMobileMarkers()
}

function renderMobileMarkers() {
  if (!mobileMarkersList) return
  const markers = viewer.doc.markers ?? []
  mobileMarkersList.innerHTML = ''
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
    text.textContent = marker.text || `Marcador ${index + 1}`

    li.append(idx, text)

    if (marker.id === activeMarkerId) li.classList.add('is-active')

    li.addEventListener('click', () => {
      const result = viewer.focusMarker(marker.id)
      if (result) {
        activeMarkerId = marker.id
        renderMarkers()
        closeMobileModals()
        showHint(`Marcador ${index + 1}${result.text ? `: ${result.text}` : ''}`, 3200)
      }
    })
    mobileMarkersList.append(li)
  })
}

// --- Cubo de vistas --------------------------------------------------------
// Rota con la camara y resalta la cara dominante. Solo se actualiza en
// frames pintados. La matriz la calcula three (cuaternion invertido
// conjugado por diag(1,-1,1): de ejes GL con Y arriba a ejes CSS con Y
// abajo); aqui solo se vuelca a CSS.
const cubeInner = document.getElementById('viewcube-inner')
const cubeFaces = [...document.querySelectorAll('#viewcube-inner [data-cube]')]

function updateViewCube() {
  if (!cubeInner) return
  const camera = viewer.camera
  // El cubo gira con la camara (rotacion inversa, sin espejar): la cara cuya
  // normal apunta a la camara es exactamente la que se ve del modelo.
  _cuboQ.copy(camera.quaternion).invert()
  _cuboM.makeRotationFromQuaternion(_cuboQ)
  const e = _cuboM.elements
  cubeInner.style.transform = `matrix3d(${e.map((n) => n.toFixed(5)).join(',')})`

  // Cara dominante segun de donde mira la camara (posicion - objetivo).
  const dx = camera.position.x - viewer.controls.target.x
  const dy = camera.position.y - viewer.controls.target.y
  const dz = camera.position.z - viewer.controls.target.z
  const ax = Math.abs(dx)
  const ay = Math.abs(dy)
  const az = Math.abs(dz)
  const current = ax >= ay && ax >= az ? (dx > 0 ? 'izquierda' : 'derecha')
    : ay >= az ? (dy > 0 ? 'superior' : 'inferior')
      : dz > 0 ? 'frontal' : 'trasera'
  for (const face of cubeFaces) {
    face.classList.toggle('is-current', face.dataset.cube === current)
  }
}

viewer.on('frame', updateViewCube)

// --- Eventos del visor -----------------------------------------------------

viewer.on('loaded', (info) => {
  currentModel = info
  panelVisibility(true)
  collapsePanelsOnMobile()
  // Titulo: nombre del caso si viene del panel; si no, nombre del archivo
  // sin extension. Solo en el contenido de la pagina, nunca en <title>.
  const base = String(info.name ?? '').split('/').pop().split('?')[0].split('#')[0]
  const title = openedCase?.name ?? (base.includes('.') ? base.slice(0, base.lastIndexOf('.')) : base)
  if (docTitle) {
    docTitle.textContent = title || BRAND.name
    docTitle.hidden = false
  }
  if (mobileTitle) {
    mobileTitle.textContent = title || BRAND.name
  }
  if (loader) loader.hidden = true
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
  scheduleAutosave(doc)
})

viewer.on('markers', () => renderMarkers())

viewer.on('objects', () => renderObjects())

function showLoadProgress(fraction) {
  if (loader) {
    loader.hidden = false
    if (loaderText && Number.isFinite(fraction)) {
      loaderText.textContent = `Cargando modelo… ${Math.round(fraction * 100)}%`
    }
  }
  if (Number.isFinite(fraction)) setStatus(`Cargando ${Math.round(fraction * 100)}%`)
}

viewer.on('progress', ({ fraction, phase }) => {
  if (phase === 'loading') showLoadProgress(fraction)
})

viewer.on('section', () => syncSectionUI())

viewer.on('measure-pick', () => showHint('Segundo punto para completar la medida', 4000))

viewer.on('measure-add', (measurement) => {
  // Una a una: al completar la medida se vuelve solo a camara libre.
  // Hay que pedir Medir otra vez para la siguiente.
  if (viewer.measure?.enabled) toggleMeasure()
  showHint(`Medida creada${measurement?.label ? `: ${measurement.label}` : ''}`, 2600)
})

viewer.on('error', (error) => {
  if (loader) loader.hidden = true
  setStatus(error.message)
  bridge.error(error)
})

// --- Herramientas ----------------------------------------------------------

async function loadModel(url, options = {}) {
  setStatus('Cargando modelo…')
  if (loader) {
    loader.hidden = false
    if (loaderText) loaderText.textContent = 'Cargando modelo…'
  }
  forcedUnits = options.forcedUnits ?? forcedUnits
  if (typeof options.material === 'string') materialMode = options.material
  const info = await viewer.load(url, {
    format: options.format,
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
      ? 'Medir: pulsa dos puntos sobre la pieza (al completar vuelve a camara libre).'
      : 'Cámara libre: pulsa Medir para cotar otra vez',
  )
  return active
}

const MARKER_KINDS = ['note', 'warning', 'screw']
let pendingMarkerPoint = null
let selectedMarkerKind = 'note'

function setSelectedMarkerKind(kind) {
  selectedMarkerKind = MARKER_KINDS.includes(kind) ? kind : 'note'
  for (const button of markerKindButtons) {
    button.setAttribute('aria-pressed', String(button.dataset.markerKind === selectedMarkerKind))
  }
}

function clearMarkerDialogError() {
  if (!markerDialogError) return
  markerDialogError.hidden = true
  markerDialogText?.classList.remove('is-invalid')
}

function showMarkerDialogError() {
  if (markerDialogError) markerDialogError.hidden = false
  markerDialogText?.classList.add('is-invalid')
  focusMarkerDialogText()
}

function focusMarkerDialogText() {
  // El foco se pide dos veces: en el propio gesto y en el siguiente frame.
  // Con raton real la accion por defecto del pointerdown mueve el foco tras
  // los handlers, y sin el segundo intento habria que pinchar en el cuadro.
  markerDialogText?.focus({ preventScroll: true })
  requestAnimationFrame(() => {
    if (!markerDialog.hidden && markerDialog.contains(document.activeElement) === false) {
      markerDialogText?.focus({ preventScroll: true })
    }
  })
}

function openMarkerDialog(point) {
  pendingMarkerPoint = point
  if (markerDialogText) markerDialogText.value = ''
  clearMarkerDialogError()
  setSelectedMarkerKind('note')
  markerDialog.hidden = false
  focusMarkerDialogText()
}

function closeMarkerDialog() {
  markerDialog.hidden = true
  pendingMarkerPoint = null
}

function confirmMarkerDialog() {
  if (!pendingMarkerPoint) {
    closeMarkerDialog()
    return
  }
  const text = (markerDialogText?.value ?? '').trim()
  if (!text) {
    // El texto es obligatorio: no se crea el marcador y se mantiene el dialogo.
    showMarkerDialogError()
    return
  }
  viewer.addMarker({ position: pendingMarkerPoint, text, kind: selectedMarkerKind })
  showHint(`Marcador guardado: ${text}`)
  closeMarkerDialog()
  // Un marcador por pulsacion del boton, igual que las medidas.
  if (markerMode) toggleMarkerTool()
}

for (const button of markerKindButtons) {
  button.addEventListener('click', () => setSelectedMarkerKind(button.dataset.markerKind))
}
markerDialog?.querySelector('[data-marker-dialog="confirm"]')?.addEventListener('click', confirmMarkerDialog)
for (const button of markerDialog?.querySelectorAll('[data-marker-dialog="cancel"]') ?? []) {
  button.addEventListener('click', closeMarkerDialog)
}
markerDialog?.addEventListener('click', (event) => {
  if (event.target === markerDialog) closeMarkerDialog()
})
markerDialog?.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    event.stopPropagation()
    closeMarkerDialog()
  }
})
markerDialogText?.addEventListener('input', clearMarkerDialogError)
markerDialogText?.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') {
    event.preventDefault()
    confirmMarkerDialog()
  }
})

/**
 * Modo marcador: pulsar sobre la pieza abre el dialogo del marcador.
 * Convive con la medicion: se activa uno desactiva el otro.
 */
let markerMode = false

function toggleMarkerTool() {
  markerMode = !markerMode
  if (!markerMode) closeMarkerDialog()
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
  if (!markerDialog?.hidden) return
  viewer.setPointer(event)
  const hit = viewer.pick()
  if (!hit) {
    showHint('No hay pieza bajo el cursor', 1500)
    return
  }
  // Sin esto el navegador mueve el foco tras el handler y el cuadro de texto
  // no recibe lo que se escribe nada mas abrir el dialogo.
  event.preventDefault()
  openMarkerDialog(hit.point.toArray())
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
  removeMeasurement({ id }) {
    return viewer.measure?.remove(String(id)) ?? false
  },
  setMeasurementNote({ id, note }) {
    const measurement = viewer.measure?.setNote(String(id), note ?? '')
    if (measurement) viewer.measure?.select(String(id))
    return measurement
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
  if (button.dataset.cube) {
    viewer.setView(button.dataset.cube)
    return
  }
  if (button.dataset.mobile) {
    const modalId = 'mobile-' + button.dataset.mobile
    const modal = document.getElementById(modalId)
    if (modal && !modal.hidden) {
      modal.hidden = true
    } else {
      openMobileModal(modalId)
    }
    return
  }
  if ('mobileClose' in button.dataset) {
    closeMobileModals()
    return
  }
  switch (button.dataset.action) {
    case 'frame':
      viewer.frameModel()
      break
    case 'home':
      goHome()
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
    case 'clear-measurements':
      viewer.measure?.clear()
      showHint('Medidas borradas')
      break
    case 'remove-last-measurement': {
      const removed = viewer.measure?.removeLast()
      showHint(removed ? 'Medición borrada' : 'No hay medición que borrar')
      break
    }
    case 'export':
      exportAnnotations()
      break
    case 'save-case':
      saveCase()
      break
    case 'undo-case':
      undoCase()
      break
    case 'redo-case':
      redoCase()
      break
    case 'toggle-panel':
      togglePanelContent(panel)
      break
    case 'toggle-tools':
      togglePanelContent(toolsPanel)
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
      showHint('Plano girado 90 grados sobre su eje', 2200)
      break
    case 'section-rotate':
      viewer.rotateSectionPlane()
      showHint('Plano rotado 90 grados sobre su eje', 2200)
      break
    case 'gizmo-toggle': {
      viewer.section?.setGizmoMode('combined')
      // El gizmo mueve el plano de corte y, con el corte apagado, no se ve:
      // encenderlo activa tambien el corte.
      if (viewer.section?.gizmoOn && !viewer.section.enabled) viewer.setSection({ enabled: true })
      syncSectionUI()
      const on = !!viewer.section?.gizmoOn
      showHint(on ? 'Gizmo: flechas y planos para mover, arcos de X, Y y Z para rotar' : 'Gizmo oculto')
      break
    }
    case 'section-toggle': {
      const enabled = !viewer.section?.enabled
      viewer.setSection({ enabled })
      syncSectionUI()
      showHint(
        enabled
          ? 'Corte activo: enciende el gizmo para ajustar el plano (flechas y anillos)'
          : 'Corte desactivado (se conserva la posicion del plano)',
      )
      break
    }
    case 'marker-unfocus':
      viewer.exitMarkerFocus()
      activeMarkerId = null
      renderMarkers()
      showHint('Vista libre: se ocultan mediciones, corte y marcadores')
      break
  }
})

container.addEventListener('pointerdown', (event) => {
  if (markerMode && !event.target.closest('.panel, .toolbar, #viewcube, #mobile-ui')) {
    addMarkerAt(event)
    return
  }
  if (event.target.closest('.panel, .toolbar, #viewcube, #mobile-ui')) return
  if (viewer.measure?.enabled) {
    viewer.handleMeasureClick(event)
    return
  }
  // Modo libre: clic selecciona una medida (clic en vacio suelta).
  if (event.button === 0 && !event.target.closest('.panel, .toolbar, #viewcube, #mobile-ui')) {
    // Editar tiene prioridad: agarrar un extremo para ajustarlo con precision.
    const grab = viewer.grabMeasureEndpoint?.(event)
    if (grab) {
      container.style.cursor = 'grabbing'
      showHint(`${grab.measurement.label} · arrastra el extremo para ajustarlo`, 3200)
      return
    }
    // A continuacion, mover un marcador.
    const marker = viewer.grabMarker?.(event)
    if (marker) {
      // En solo lectura se agarra igual (un clic corto enfoca el marcador),
      // pero no se mueve: ver pointermove.
      if (readOnly) return
      container.style.cursor = 'grabbing'
      showHint('Arrastra el marcador para cambiar su posición', 3200)
      return
    }
    const found = viewer.measure?.findMeasurement(event.clientX, event.clientY)
    const selected = viewer.measure?.select(found?.id ?? null)
    if (selected) {
      showHint(`${selected.label} · clic en vacío para soltar, doble clic para la nota, Supr para borrar`, 3200)
    }
  }
})

container.addEventListener('dblclick', (event) => {
  if (viewer.measure?.enabled || markerMode) return
  if (event.target.closest('.panel, .toolbar, #viewcube, #mobile-ui')) return
  const found = viewer.measure?.findMeasurement(event.clientX, event.clientY)
  if (!found) return
  viewer.measure.select(found.id)
  const next = window.prompt('Nota de la medida (vacío para quitarla):', found.note ?? '')
  if (next === null) return
  viewer.measure.setNote(found.id, next.trim())
  showHint(next.trim() ? 'Nota guardada' : 'Nota quitada')
})

container.addEventListener('pointermove', (event) => {
  if (viewer.measure?.enabled) {
    viewer.handleMeasureMove(event)
    return
  }
  // Camara libre: arrastres de marcador o de extremo de medida.
  if (!readOnly && viewer.dragMarker?.(event)) return
  if (viewer.dragMeasureEndpoint?.(event)) return
  if (!event.target.closest('.panel, .toolbar, #viewcube, #mobile-ui')) {
    const grabM = viewer.measure?.findEndpoint?.(event.clientX, event.clientY)
    const grabK = viewer._findMarkerAt?.(event.clientX, event.clientY)
    container.style.cursor = grabM || grabK ? 'grab' : ''
  }
})

container.addEventListener('pointerleave', () => {
  viewer.measure?.setHover(null)
  container.style.cursor = ''
})

const releaseDrag = (event) => {
  if (viewer._dragMarker) {
    const start = viewer._dragMarkerStart
    const moved = start ? Math.hypot((event?.clientX ?? start.x) - start.x, (event?.clientY ?? start.y) - start.y) : 10
    const marker = viewer.releaseMarker?.()
    container.style.cursor = ''
      // Si fue un clic corto sin mover, enfocar el marcador (comportamiento de lista).
    if (marker && moved < 4) {
      activeMarkerId = marker.id
      viewer.focusMarker(marker.id)
      renderMarkers()
    }
    return
  }
  if (!viewer._dragMeasure) return
  container.style.cursor = ''
  viewer.handleMeasureRelease?.()
}
container.addEventListener('pointerup', releaseDrag)
container.addEventListener('pointercancel', releaseDrag)
// Tambien en window: si el puntero se suelta fuera del lienzo, el arrastre
// debe terminar igual.
window.addEventListener('pointerup', releaseDrag)

window.addEventListener('keydown', (event) => {
  if (event.target?.matches?.('input, textarea')) return
  // Atajos del caso abierto: deshacer, rehacer y guardar.
  if (caseHistory && (event.metaKey || event.ctrlKey)) {
    const key = event.key.toLowerCase()
    if (key === 'z' && !event.shiftKey) undoCase()
    else if ((key === 'z' && event.shiftKey) || key === 'y') redoCase()
    else if (key === 's') saveCase()
    else return
    event.preventDefault()
    return
  }
  switch (event.key.toLowerCase()) {
    case 'm':
      toggleMeasure()
      break
    case 'k':
      if (!readOnly) toggleMarkerTool()
      break
    case 'f':
      viewer.frameModel()
      break
    case 'e':
      if (!readOnly) exportAnnotations()
      break
    case 'escape':
      if (viewer.measure?.enabled) toggleMeasure()
      if (markerMode) toggleMarkerTool()
      viewer.measure?.select(null)
      break
    case 'delete':
    case 'backspace': {
      const selected = viewer.measure?.selected()
      if (selected) {
        viewer.measure.remove(selected.id)
        showHint('Medida borrada')
      }
      break
    }
  }
})

// --- Caso abierto desde el panel (?case=) ----------------------------------
//
// El modelo llega por una URL firmada de S3 que caduca en minutos, y la
// configuracion (marcadores, medidas, corte) por la API. Guardar sustituye
// la configuracion entera del caso.

/** Caso abierto: { id, name }. Null cuando el visor se usa con ?model=. */
let openedCase = null

/**
 * Solo lectura (pagina del doctor, ?share=): no se crean, editan, mueven ni
 * borran marcadores ni se exporta. Medir, cortar y ocultar piezas sigue
 * disponible, pero nada se guarda.
 */
let readOnly = false

function setReadOnly() {
  readOnly = true
  if (markerMode) toggleMarkerTool()
  for (const button of document.querySelectorAll('[data-action="add-marker"], [data-action="export"]')) {
    button.classList.add('is-read-only')
  }
  renderMarkers()
}

function showCaseMessage(text) {
  if (loader) loader.hidden = true
  caseMessage.textContent = text
  caseMessage.hidden = false
}

/**
 * Carga el GLB de un caso o de un enlace pasando por la cache de 5 minutos
 * (src/model-cache.js). Si el navegador no tiene Cache Storage o falla, se
 * descarga de la URL firmada como siempre.
 */
async function loadCaseModel(key, signedUrl) {
  let source = null
  try {
    if (window.caches) {
      source = await createModelCache({ cacheStorage: window.caches }).getModel(key, signedUrl, {
        onProgress: showLoadProgress,
      })
    }
  } catch {
    source = null
  }
  if (!source || source._tag === 'Failed') return loadModel(signedUrl)
  const objectUrl = URL.createObjectURL(source.blob)
  try {
    return await loadModel(objectUrl, { format: 'glb' })
  } finally {
    URL.revokeObjectURL(objectUrl)
  }
}

async function openCase(caseId) {
  if (loader) {
    loader.hidden = false
    if (loaderText) loaderText.textContent = 'Abriendo caso…'
  }
  const hadSession = session.email() !== null
  const result = await authorizedCall(session, (token) => api.getCase(token, caseId))
  if (result._tag === 'SignedOut') {
    window.location.replace(loginUrl(`viewer.html?case=${encodeURIComponent(caseId)}`, { expired: hadSession }))
    return
  }
  if (result._tag === 'NotFound') {
    showCaseMessage('Este caso no existe. Vuelve al panel para abrir otro.')
    return
  }
  if (result._tag !== 'Found') {
    showCaseMessage('No se ha podido abrir el caso. Recarga la página para volver a probar.')
    return
  }
  openedCase = { id: caseId, name: result.case.name }
  for (const element of document.querySelectorAll('.case-only')) element.hidden = false
  await loadCaseModel(`case/${caseId}`, result.case.model.url)
  // Sin `model`: una configuracion guardada nunca debe recargar otra URL.
  await applyAnnotations(toStoredConfig(result.case.config ?? {}))
  // La vista de origen es siempre la de inicio (isometrica), este o no editado.
  viewer.resetView()
  startCaseHistory()
}

async function openShare(shareId) {
  if (loader) {
    loader.hidden = false
    if (loaderText) loaderText.textContent = 'Abriendo caso…'
  }
  let result
  try {
    result = await api.getShare(shareId)
  } catch {
    showCaseMessage('No se ha podido abrir el caso. Revisa la conexión y recarga la página.')
    return
  }
  if (result._tag === 'NotFound') {
    showCaseMessage('Este enlace no es válido o ha sido revocado. Pide uno nuevo al laboratorio.')
    return
  }
  if (result._tag !== 'Found') {
    showCaseMessage('No se ha podido abrir el caso. Recarga la página para volver a probar.')
    return
  }
  // El nombre del caso solo va en el contenido de la pagina; <title> sigue
  // siendo el de la marca (lo ve la vista previa de WhatsApp).
  openedCase = { id: null, name: result.shared.name }
  setReadOnly()
  await loadCaseModel(`share/${shareId}`, result.shared.model.url)
  await applyAnnotations(toStoredConfig(result.shared.config ?? {}))
  // La vista de origen es siempre la de inicio (isometrica), este o no editado.
  viewer.resetView()
}

// --- Autoguardado y deshacer (solo con ?case=) ---
//
// Cuenta como cambio el contenido (marcadores y medidas), no la vista: al
// pulsar un marcador el visor restaura su corte y emite 'changed', y eso no
// debe guardar nada (src/case-history.js, contentKey). Cada guardado es un
// paso de deshacer, sin limite, solo durante la sesion.

/** Historial y autoguardado del caso abierto; null fuera del modo caso. */
let caseHistory = null
let autosave = null
/** Mientras se aplica un paso de deshacer/rehacer, sus 'changed' no cuentan. */
let applyingHistory = false
/**
 * getAnnotations() sincroniza el documento y emite 'changed': mientras el
 * autoguardado lee la configuracion, ese 'changed' no debe volver a programar
 * un guardado (ni entrar en bucle).
 */
let readingConfig = false

const SAVE_STATUS_TEXT = {
  saved: 'Guardado',
  pending: 'Cambios sin guardar',
  saving: 'Guardando…',
  retrying: 'Sin conexión · reintentando',
  'signed-out': 'Sesión caducada · entra en el panel en otra pestaña',
  gone: 'Este caso ya no existe',
}

function currentConfig() {
  readingConfig = true
  try {
    return toStoredConfig(viewer.getAnnotations())
  } finally {
    readingConfig = false
  }
}

function updateHistoryButtons() {
  undoButton.disabled = !caseHistory?.canUndo()
  redoButton.disabled = !caseHistory?.canRedo()
}

function showSaveStatus(status) {
  saveStatus.textContent = SAVE_STATUS_TEXT[status] ?? ''
  saveStatus.dataset.status = status
}

/** Guarda la configuracion actual y la registra como paso. Devuelve el `_tag` de la API. */
async function saveCurrentConfig() {
  const config = currentConfig()
  if (configBytes(config) > MAX_CONFIG_BYTES) {
    showHint('No se puede guardar: hay demasiadas anotaciones para un caso.', 5000)
    return 'Invalid'
  }
  caseHistory.record(config)
  updateHistoryButtons()
  const result = await authorizedCall(session, (token) => api.saveConfig(token, openedCase.id, config))
  return result._tag
}

function startCaseHistory() {
  caseHistory = createCaseHistory(currentConfig())
  autosave = createAutosave({ save: saveCurrentConfig, onStatus: showSaveStatus })
  showSaveStatus('saved')
  updateHistoryButtons()
}

function scheduleAutosave(doc) {
  if (!caseHistory || applyingHistory || readingConfig || readOnly) return
  if (!caseHistory.isCurrent(toStoredConfig(doc))) autosave.schedule()
}

async function applyHistoryStep(config) {
  if (!config) return
  applyingHistory = true
  try {
    activeMarkerId = null
    await applyAnnotations(config)
    renderMarkers()
  } finally {
    applyingHistory = false
  }
  updateHistoryButtons()
  autosave.flush()
}

function undoCase() {
  if (!caseHistory) return
  // Lo que aun no se haya guardado pasa a ser un paso, para poder rehacerlo.
  caseHistory.record(currentConfig())
  applyHistoryStep(caseHistory.undo())
}

function redoCase() {
  if (!caseHistory) return
  applyHistoryStep(caseHistory.redo())
}

/** Boton "Guardar" y Ctrl+S: guardar ya, sin esperar al autoguardado. */
async function saveCase() {
  if (!autosave || !viewer.model) return
  saveCaseButton.disabled = true
  try {
    await autosave.flush()
  } finally {
    saveCaseButton.disabled = false
  }
}

// Avisa antes de cerrar o recargar con cambios sin guardar.
window.addEventListener('beforeunload', (event) => {
  if (autosave?.hasUnsavedChanges()) event.preventDefault()
})

// --- Arranque --------------------------------------------------------------

async function boot() {
  const params = new URLSearchParams(window.location.search)
  forcedUnits = params.get('units') || null
  materialMode = params.get('material') === 'dental' ? 'dental' : 'keep'

  if (params.has('background')) viewer.setBackground(params.get('background'))

  const model = params.get('model')
  const annotations = params.get('annotations')
  const caseId = params.get('case')
  const shareId = params.get('share')

  if (model) {
    await loadModel(model, { annotations })
  } else if (caseId) {
    await openCase(caseId)
  } else if (shareId) {
    await openShare(shareId)
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
