// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Panel de administracion (index.html, la raiz): lista de casos, alta de un caso
 * nuevo con su GLB y enlace del doctor. Sin sesion, manda a login.html, que vuelve aqui al
 * entrar. El resto de acciones se iran anadiendo aqui.
 */
import { applyBrand, BRAND } from './brand.js'
import { api, session } from './app-session.js'
import { authorizedCall } from './authorized.js'
import { createModelCache } from './model-cache.js'
import {
  caseEditorUrl,
  doctorLinkUrl,
  formatDate,
  formatSize,
  shareActionLabel,
  sortCases,
  statusLabel,
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
const newCaseForm = document.getElementById('new-case')
const newCaseStatus = document.getElementById('new-case-status')
const newCaseError = document.getElementById('new-case-error')
const newCaseSubmit = newCaseForm.querySelector('button[type="submit"]')
let uploading = false
const shareResult = document.getElementById('share-result')
const shareResultText = document.getElementById('share-result-text')
const shareResultUrl = document.getElementById('share-result-url')
const shareError = document.getElementById('share-error')

function goToLogin({ expired = false } = {}) {
  window.location.replace(loginUrl(PANEL_PAGE, { expired }))
}

function showSignedIn() {
  userEmail.textContent = session.email() ?? ''
  signedIn.hidden = false
  loadCases()
}

function showCasesMessage(message) {
  casesTable.hidden = true
  casesMessage.textContent = message
  casesMessage.hidden = false
}

/** Fila de un caso. El nombre puede llevar datos del paciente: siempre como texto, nunca como HTML. */
function caseRow(item) {
  const row = document.createElement('tr')
  const cells = [item.name, statusLabel(item.status), formatDate(item.createdAt), formatDate(item.updatedAt)]
  for (const text of cells) {
    const cell = document.createElement('td')
    cell.textContent = text
    row.appendChild(cell)
  }
  row.cells[1].dataset.status = item.status
  const actions = document.createElement('td')
  actions.className = 'case-actions'
  const open = document.createElement('a')
  open.href = caseEditorUrl(item.id)
  open.textContent = 'Abrir'
  const share = document.createElement('button')
  share.type = 'button'
  share.dataset.action = 'share-case'
  share.dataset.caseId = item.id
  share.textContent = shareActionLabel(item.status)
  actions.append(open, share)
  row.appendChild(actions)
  return row
}

async function loadCases() {
  showCasesMessage('Cargando casos…')
  let result
  try {
    result = await authorizedCall(session, (token) => api.listCases(token))
  } catch {
    showCasesMessage('No se ha podido contactar con el servidor. Recarga la página para volver a probar.')
    return
  }
  if (result._tag === 'SignedOut') {
    goToLogin({ expired: true })
    return
  }
  if (result._tag !== 'Cases') {
    showCasesMessage('No se han podido cargar los casos. Recarga la página para volver a probar.')
    return
  }
  if (result.cases.length === 0) {
    showCasesMessage('Todavía no hay casos.')
    return
  }
  casesBody.replaceChildren(...sortCases(result.cases).map(caseRow))
  casesMessage.hidden = true
  casesTable.hidden = false
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
  newCaseForm.reset()
  showNewCaseStatus(null)
  showNewCaseError(null)
  newCaseForm.hidden = false
  newCaseForm.elements.name.focus()
}

function closeNewCase() {
  if (uploading) return
  newCaseForm.hidden = true
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

function showShareError(message) {
  shareError.hidden = !message
  shareError.textContent = message ?? ''
}

/** Copia al portapapeles; si el navegador no deja, el enlace queda seleccionado para copiarlo a mano. */
async function copyShareLink() {
  try {
    await navigator.clipboard.writeText(shareResultUrl.value)
    shareResultText.textContent = `${shareResultText.dataset.caseName}: enlace copiado. Pégalo en WhatsApp o donde quieras enviarlo.`
  } catch {
    shareResultUrl.select()
    shareResultText.textContent = `${shareResultText.dataset.caseName}: copia el enlace seleccionado (Ctrl+C o Cmd+C).`
  }
}

async function shareCase(button) {
  const caseId = button.dataset.caseId
  const caseName = button.closest('tr')?.cells[0]?.textContent ?? ''
  showShareError(null)
  shareResult.hidden = true
  button.disabled = true
  let result
  try {
    result = await authorizedCall(session, (token) => api.shareCase(token, caseId))
  } catch {
    showShareError('No se ha podido contactar con el servidor. Vuelve a probar en un momento.')
    return
  } finally {
    button.disabled = false
  }
  if (result._tag === 'SignedOut') {
    goToLogin({ expired: true })
    return
  }
  if (result._tag === 'ModelNotUploaded') {
    showShareError(`${caseName}: el modelo no llegó a subirse. Crea el caso de nuevo.`)
    return
  }
  if (result._tag !== 'Shared') {
    showShareError('No se ha podido obtener el enlace. Vuelve a probar en un momento.')
    return
  }
  shareResultUrl.value = doctorLinkUrl(result.sharePath, window.location.href)
  shareResultText.dataset.caseName = caseName
  shareResult.hidden = false
  await copyShareLink()
  if (result.generatedNow) loadCases()
}

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
  if (button?.dataset.action === 'copy-share') copyShareLink()
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
