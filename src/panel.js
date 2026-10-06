// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Panel de administracion (index.html, la raiz): lista de casos, alta de un caso
 * nuevo con su GLB, enlace del doctor y borrado. Sin sesion, manda a login.html, que vuelve aqui al
 * entrar. El resto de acciones se iran anadiendo aqui.
 */
import { applyBrand, BRAND } from './brand.js'
import { api, session } from './app-session.js'
import { authorizedCall } from './authorized.js'
import { createModelCache } from './model-cache.js'
import {
  DEFAULT_SORT,
  nextSort,
  caseEditorUrl,
  doctorLinkUrl,
  formatDate,
  formatSize,
  shareActionLabel,
  sortCases,
  validateNewCase,
} from './cases.js'
import { LOGIN_PAGE, loginUrl, PANEL_PAGE, viewerRedirectUrl } from './navigation.js'

applyBrand()
document.title = `Panel · ${BRAND.name}`

const signedIn = document.getElementById('signed-in')
const userEmail = document.getElementById('user-email')
const casesTable = document.getElementById('cases')
const casesBody = casesTable.querySelector('tbody')
const casesMessage = document.getElementById('cases-message')
const casesEmpty = document.getElementById('cases-empty')
const casesCount = document.getElementById('cases-count')
const panelUser = document.getElementById('panel-user')
const toast = document.getElementById('toast')
const loadMoreButton = document.getElementById('load-more')
/** Casos cargados hasta ahora y cursor de la pagina siguiente (null en la ultima). */
let loadedCases = []
let nextCursor = null
/** Orden de la tabla (criterio principal y secundario): se aplica a lo cargado y se mantiene al cargar mas. */
let sortBy = DEFAULT_SORT
const newCaseForm = document.getElementById('new-case')
const newCaseStatus = document.getElementById('new-case-status')
const newCaseError = document.getElementById('new-case-error')
const newCaseSubmit = newCaseForm.querySelector('button[type="submit"]')
let uploading = false

function goToLogin({ expired = false } = {}) {
  window.location.replace(loginUrl(PANEL_PAGE, { expired }))
}

function showSignedIn() {
  userEmail.textContent = session.email() ?? ''
  panelUser.hidden = false
  signedIn.hidden = false
  loadCases()
}

function showCasesMessage(message) {
  casesTable.hidden = true
  casesEmpty.hidden = true
  casesMessage.textContent = message
  casesMessage.hidden = false
}

function showCasesEmpty() {
  casesTable.hidden = true
  casesMessage.hidden = true
  casesEmpty.hidden = false
  casesCount.textContent = ''
}

/** Aviso breve abajo de la pantalla (copiado, errores). */
function showToast(message, { error = false } = {}) {
  toast.textContent = message
  toast.classList.toggle('is-error', error)
  toast.hidden = false
  clearTimeout(showToast.timer)
  showToast.timer = setTimeout(() => {
    toast.hidden = true
  }, error ? 6000 : 3000)
}

const ICON_COPY =
  '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="5.5" y="5.5" width="8" height="8" rx="1.5"/><path d="M10.5 5.5v-2a1 1 0 0 0-1-1h-6a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2"/></svg>'
const ICON_CHECK = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="m3.5 8.5 3 3 6-7"/></svg>'
const ICON_TRASH =
  '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 4.5h10M6.5 4.5v-2h3v2M4.5 4.5l.6 9h5.8l.6-9"/></svg>'

function iconButton({ action, caseId, icon, label, className = '' }) {
  const button = document.createElement('button')
  button.type = 'button'
  button.className = `icon-button ${className}`.trim()
  button.dataset.action = action
  button.dataset.caseId = caseId
  button.title = label
  button.setAttribute('aria-label', label)
  // Iconos fijos del propio codigo, nunca datos del caso.
  button.innerHTML = icon
  return button
}

/**
 * Fila de un caso. Toda la fila abre el caso (ver el listener de la tabla);
 * el nombre es ademas un enlace de verdad, para abrirlo en otra pestana o con
 * el teclado. El nombre puede llevar datos del paciente: siempre como texto,
 * nunca como HTML.
 */
function caseRow(item) {
  const row = document.createElement('tr')
  row.className = 'case-row'
  row.dataset.href = caseEditorUrl(item.id)

  const name = document.createElement('td')
  const open = document.createElement('a')
  open.className = 'case-open'
  open.href = caseEditorUrl(item.id)
  open.textContent = item.name
  name.append(open)

  const created = document.createElement('td')
  created.className = 'col-date'
  created.textContent = formatDate(item.createdAt)

  const updated = document.createElement('td')
  updated.className = 'col-date'
  updated.textContent = formatDate(item.updatedAt)

  const link = document.createElement('td')
  link.className = 'case-link'
  if (item.status === 'linked' && item.linkGeneratedAt) {
    const date = document.createElement('span')
    date.className = 'link-date'
    date.textContent = formatDate(item.linkGeneratedAt)
    const cell = document.createElement('span')
    cell.className = 'link-cell'
    cell.append(date, iconButton({ action: 'share-case', caseId: item.id, icon: ICON_COPY, label: 'Copiar enlace' }))
    link.append(cell)
  } else {
    const generate = document.createElement('button')
    generate.type = 'button'
    generate.className = 'secondary'
    generate.dataset.action = 'share-case'
    generate.dataset.caseId = item.id
    generate.textContent = shareActionLabel(item.status)
    link.append(generate)
  }

  const actions = document.createElement('td')
  actions.className = 'case-actions'
  const openLink = document.createElement('a')
  openLink.className = 'case-open-link'
  openLink.href = caseEditorUrl(item.id)
  openLink.textContent = 'Abrir ›'
  actions.append(
    iconButton({ action: 'delete-case', caseId: item.id, icon: ICON_TRASH, label: 'Borrar caso', className: 'delete' }),
    openLink,
  )

  row.append(name, created, updated, link, actions)
  return row
}

casesBody.addEventListener('click', (event) => {
  if (event.target.closest('a, button')) return
  const row = event.target.closest('tr.case-row')
  if (row) window.location.href = row.dataset.href
})

async function fetchCasesPage(cursor) {
  try {
    return await authorizedCall(session, (token) => api.listCases(token, { cursor }))
  } catch {
    return { _tag: 'Unavailable' }
  }
}

/**
 * Flecha en las columnas por las que se ordena y, si hay dos, su prioridad
 * (1 y 2). aria-sort solo admite una columna: la principal.
 */
function renderSortHeaders() {
  for (const header of casesTable.querySelectorAll('th[data-sort-key]')) {
    const rank = sortBy.findIndex((criterion) => criterion.key === header.dataset.sortKey)
    const criterion = sortBy[rank]
    const indicator = header.querySelector('.sort-indicator')
    header.classList.toggle('is-sorted', rank >= 0)
    if (rank === 0) header.setAttribute('aria-sort', criterion.direction === 'asc' ? 'ascending' : 'descending')
    else header.removeAttribute('aria-sort')
    indicator.textContent = criterion
      ? `${criterion.direction === 'asc' ? '↑' : '↓'}${sortBy.length > 1 ? rank + 1 : ''}`
      : '↕'
  }
}

function renderCases() {
  renderSortHeaders()
  casesBody.replaceChildren(...sortCases(loadedCases, sortBy).map(caseRow))
  casesMessage.hidden = true
  casesEmpty.hidden = true
  casesTable.hidden = false
  loadMoreButton.hidden = !nextCursor
  casesCount.textContent = `${loadedCases.length}${nextCursor ? '+' : ''}`
}

/** Primera pagina: al entrar y tras crear, compartir o borrar un caso. */
async function loadCases() {
  showCasesMessage('Cargando casos…')
  loadMoreButton.hidden = true
  const result = await fetchCasesPage(null)
  if (result._tag === 'SignedOut') {
    goToLogin({ expired: true })
    return
  }
  if (result._tag === 'Unavailable') {
    showCasesMessage('No se ha podido contactar con el servidor. Recarga la página para volver a probar.')
    return
  }
  if (result._tag !== 'Cases') {
    showCasesMessage('No se han podido cargar los casos. Recarga la página para volver a probar.')
    return
  }
  loadedCases = result.cases
  nextCursor = result.nextCursor
  if (loadedCases.length === 0 && !nextCursor) {
    showCasesEmpty()
    return
  }
  renderCases()
}

async function loadMoreCases() {
  if (!nextCursor) return
  loadMoreButton.disabled = true
  const result = await fetchCasesPage(nextCursor)
  loadMoreButton.disabled = false
  if (result._tag === 'SignedOut') {
    goToLogin({ expired: true })
    return
  }
  if (result._tag !== 'Cases') {
    showToast('No se han podido cargar más casos. Vuelve a probar en un momento.', { error: true })
    return
  }
  loadedCases = [...loadedCases, ...result.cases]
  nextCursor = result.nextCursor
  renderCases()
}

// --- Caso nuevo ---

function showNewCaseStatus(message) {
  newCaseStatus.hidden = !message
  newCaseStatus.textContent = message ?? ''
}

function showNewCaseError(message) {
  newCaseError.hidden = !message
  newCaseError.textContent = message ?? ''
}

function openNewCase() {
  casesEmpty.hidden = true
  newCaseForm.reset()
  showNewCaseStatus(null)
  showNewCaseError(null)
  newCaseForm.hidden = false
  newCaseForm.elements.name.focus()
}

function closeNewCase() {
  if (uploading) return
  newCaseForm.hidden = true
  if (loadedCases.length === 0 && !nextCursor && casesMessage.hidden) casesEmpty.hidden = false
}

function setUploading(value) {
  uploading = value
  newCaseSubmit.disabled = value
  for (const element of newCaseForm.elements) element.disabled = value
}

/** Mensaje si la subida falla despues de crear el caso: el caso queda en borrador, sin modelo. */
function uploadFailureMessage(result) {
  const reason =
    result._tag === 'Expired'
      ? 'la subida ha tardado más de 5 minutos'
      : 'no se ha podido subir el modelo'
  return `El caso se ha creado, pero ${reason}. Crea el caso de nuevo; el anterior se queda como borrador sin modelo.`
}

newCaseForm.addEventListener('submit', async (event) => {
  event.preventDefault()
  const file = newCaseForm.elements.model.files[0]
  const checked = validateNewCase({ name: newCaseForm.elements.name.value, file })
  if (checked._tag === 'Invalid') {
    showNewCaseError(checked.message)
    return
  }
  showNewCaseError(null)
  setUploading(true)
  try {
    showNewCaseStatus('Creando el caso…')
    const created = await authorizedCall(session, (token) =>
      api.createCase(token, { name: checked.name, sizeBytes: checked.sizeBytes }),
    )
    if (created._tag === 'SignedOut') {
      goToLogin({ expired: true })
      return
    }
    if (created._tag !== 'Created') {
      showNewCaseStatus(null)
      showNewCaseError(
        created._tag === 'Invalid'
          ? 'El servidor no ha aceptado el nombre o el tamaño del modelo.'
          : 'No se ha podido crear el caso. Vuelve a probar en un momento.',
      )
      return
    }
    showNewCaseStatus(`Subiendo el modelo (${formatSize(checked.sizeBytes)})…`)
    const uploaded = await api.uploadModel(created.upload, file)
    if (uploaded._tag !== 'Uploaded') {
      showNewCaseStatus(null)
      showNewCaseError(uploadFailureMessage(uploaded))
      loadCases()
      return
    }
    setUploading(false)
    closeNewCase()
    loadCases()
  } catch {
    showNewCaseStatus(null)
    showNewCaseError('Se ha perdido la conexión. Revisa la lista: si el caso aparece, se ha quedado sin modelo.')
    loadCases()
  } finally {
    setUploading(false)
  }
})

// --- Enlace del doctor ---

/** Copia al portapapeles; si el navegador no deja, se muestra para copiarlo a mano. */
async function copyToClipboard(url) {
  try {
    await navigator.clipboard.writeText(url)
    return true
  } catch {
    window.prompt('Copia el enlace del doctor:', url)
    return false
  }
}

/** Icono de copiar en ✓ durante un momento, como confirmacion en la propia fila. */
function flashCopied(button) {
  if (!button.classList.contains('icon-button')) return
  button.innerHTML = ICON_CHECK
  button.classList.add('is-done')
  setTimeout(() => {
    button.innerHTML = ICON_COPY
    button.classList.remove('is-done')
  }, 1500)
}

async function shareCase(button) {
  const caseId = button.dataset.caseId
  const caseName = loadedCases.find((c) => c.id === caseId)?.name ?? ''
  button.disabled = true
  let result
  try {
    result = await authorizedCall(session, (token) => api.shareCase(token, caseId))
  } catch {
    showToast('No se ha podido contactar con el servidor. Vuelve a probar en un momento.', { error: true })
    return
  } finally {
    button.disabled = false
  }
  if (result._tag === 'SignedOut') {
    goToLogin({ expired: true })
    return
  }
  if (result._tag === 'ModelNotUploaded') {
    showToast(`${caseName}: el modelo no llegó a subirse. Crea el caso de nuevo.`, { error: true })
    return
  }
  if (result._tag !== 'Shared') {
    showToast('No se ha podido obtener el enlace. Vuelve a probar en un momento.', { error: true })
    return
  }
  const copied = await copyToClipboard(doctorLinkUrl(result.sharePath, window.location.href))
  if (copied) {
    flashCopied(button)
    showToast(result.generatedNow ? 'Enlace generado y copiado al portapapeles' : 'Enlace copiado al portapapeles')
  }
  if (result.generatedNow) loadCases()
}

// --- Borrar un caso ---

const deleteDialog = document.getElementById('delete-dialog')
const deleteCaseName = document.getElementById('delete-case-name')
const deleteError = document.getElementById('delete-error')
const confirmDeleteButton = deleteDialog.querySelector('[data-action="confirm-delete"]')
/** Caso pendiente de confirmar: { id, name }. */
let caseToDelete = null

function openDeleteDialog(caseId) {
  const item = loadedCases.find((c) => c.id === caseId)
  if (!item) return
  caseToDelete = { id: item.id, name: item.name }
  // El nombre puede llevar datos del paciente: como texto, nunca como HTML.
  deleteCaseName.textContent = item.name
  deleteError.hidden = true
  confirmDeleteButton.disabled = false
  deleteDialog.hidden = false
  deleteDialog.querySelector('[data-action="cancel-delete"]').focus()
}

function closeDeleteDialog() {
  caseToDelete = null
  deleteDialog.hidden = true
}

async function confirmDelete() {
  if (!caseToDelete) return
  const { id } = caseToDelete
  confirmDeleteButton.disabled = true
  let result
  try {
    result = await authorizedCall(session, (token) => api.deleteCase(token, id))
  } catch {
    result = { _tag: 'Unavailable' }
  }
  if (result._tag === 'SignedOut') {
    goToLogin({ expired: true })
    return
  }
  if (result._tag !== 'Deleted' && result._tag !== 'NotFound') {
    deleteError.textContent = 'No se ha podido borrar el caso. Vuelve a probar en un momento.'
    deleteError.hidden = false
    confirmDeleteButton.disabled = false
    return
  }
  closeDeleteDialog()
  if (window.caches) createModelCache({ cacheStorage: window.caches }).remove(`case/${id}`).catch(() => {})
  loadedCases = loadedCases.filter((c) => c.id !== id)
  if (loadedCases.length === 0 && !nextCursor) showCasesEmpty()
  else renderCases()
}

deleteDialog.addEventListener('click', (event) => {
  if (event.target === deleteDialog) closeDeleteDialog()
})

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && !deleteDialog.hidden) closeDeleteDialog()
})

// Avisa antes de cerrar o recargar la pagina con una subida a medias.
window.addEventListener('beforeunload', (event) => {
  if (uploading) event.preventDefault()
})

document.addEventListener('click', (event) => {
  const button = event.target.closest('button[data-action]')
  if (button?.dataset.action === 'logout') {
    session.end()
    // Los modelos guardados son datos de salud: fuera al cerrar sesion.
    const clearModels = window.caches
      ? createModelCache({ cacheStorage: window.caches }).clear().catch(() => {})
      : Promise.resolve()
    clearModels.then(() => window.location.replace(LOGIN_PAGE))
  }
  if (button?.dataset.action === 'new-case') openNewCase()
  if (button?.dataset.action === 'cancel-new-case') closeNewCase()
  if (button?.dataset.action === 'share-case') shareCase(button)
  if (button?.dataset.action === 'load-more') loadMoreCases()
  const sortButton = event.target.closest('button[data-sort]')
  if (sortButton) {
    sortBy = nextSort(sortBy, sortButton.dataset.sort)
    renderCases()
  }
  if (button?.dataset.action === 'delete-case') openDeleteDialog(button.dataset.caseId)
  if (button?.dataset.action === 'cancel-delete') closeDeleteDialog()
  if (button?.dataset.action === 'confirm-delete') confirmDelete()
})

async function boot() {
  const access = await session.accessToken()
  if (access._tag === 'SignedOut') {
    goToLogin()
    return
  }
  if (access._tag === 'Unavailable') {
    signedIn.hidden = false
    showCasesMessage('No se ha podido contactar con el servidor. Recarga la página para volver a probar.')
    return
  }
  showSignedIn()
}

const viewerUrl = viewerRedirectUrl(window.location.search)
if (viewerUrl) window.location.replace(viewerUrl)
else boot()
