// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Panel de administracion (panel.html): lista de casos. Sin sesion, manda a
 * login.html, que vuelve aqui al entrar. El resto de acciones se iran
 * anadiendo aqui.
 */
import { applyBrand, BRAND } from './brand.js'
import { api, session } from './app-session.js'
import { authorizedCall } from './authorized.js'
import { formatDate, sortCases, statusLabel } from './cases.js'
import { LOGIN_PAGE, loginUrl, PANEL_PAGE } from './navigation.js'

applyBrand()
document.title = `Panel · ${BRAND.name}`

const signedIn = document.getElementById('signed-in')
const userEmail = document.getElementById('user-email')
const casesTable = document.getElementById('cases')
const casesBody = casesTable.querySelector('tbody')
const casesMessage = document.getElementById('cases-message')

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

document.addEventListener('click', (event) => {
  const button = event.target.closest('button[data-action]')
  if (button?.dataset.action === 'logout') {
    session.end()
    window.location.replace(LOGIN_PAGE)
  }
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

boot()
