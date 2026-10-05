// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Panel de administracion (panel.html): acceso con email y contrasena y
 * lista de casos. El resto de acciones se iran anadiendo aqui.
 */
import { applyBrand, BRAND } from './brand.js'
import { api, session } from './app-session.js'
import { authorizedCall } from './authorized.js'
import { formatDate, sortCases, statusLabel } from './cases.js'

applyBrand()
document.title = `Panel · ${BRAND.name}`

const loginForm = document.getElementById('login')
const loginError = document.getElementById('login-error')
const signedIn = document.getElementById('signed-in')
const userEmail = document.getElementById('user-email')
const submitButton = loginForm.querySelector('button[type="submit"]')
const casesTable = document.getElementById('cases')
const casesBody = casesTable.querySelector('tbody')
const casesMessage = document.getElementById('cases-message')

function showLogin(message) {
  signedIn.hidden = true
  loginForm.hidden = false
  loginError.hidden = !message
  loginError.textContent = message ?? ''
  loginForm.elements.email.focus()
}

function showSignedIn() {
  loginForm.hidden = true
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
    showLogin('La sesión ha caducado. Vuelve a entrar.')
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

function loginFailureMessage(result) {
  if (result._tag === 'InvalidCredentials') return 'Email o contraseña incorrectos.'
  if (result.status === 429) return 'Demasiados intentos. Espera un momento y vuelve a probar.'
  return 'No se ha podido iniciar sesión. Vuelve a probar en un momento.'
}

loginForm.addEventListener('submit', async (event) => {
  event.preventDefault()
  const email = loginForm.elements.email.value.trim().toLowerCase()
  const passwordInput = loginForm.elements.password
  const password = passwordInput.value
  if (!email || !password) {
    showLogin('Escribe el email y la contraseña.')
    return
  }
  submitButton.disabled = true
  try {
    const result = await api.login(email, password)
    if (result._tag === 'LoggedIn') {
      session.start(email, result.tokens)
      loginForm.reset()
      showSignedIn()
    } else {
      showLogin(loginFailureMessage(result))
    }
  } catch {
    showLogin('No se ha podido contactar con el servidor. Revisa la conexión.')
  } finally {
    // La contrasena solo vive en el campo mientras se escribe.
    passwordInput.value = ''
    submitButton.disabled = false
  }
})

document.addEventListener('click', (event) => {
  const button = event.target.closest('button[data-action]')
  if (button?.dataset.action === 'logout') {
    session.end()
    showLogin()
  }
})

async function boot() {
  const access = await session.accessToken()
  if (access._tag === 'Authenticated') showSignedIn()
  else if (access._tag === 'Unavailable')
    showLogin('No se ha podido contactar con el servidor. Vuelve a probar en un momento.')
  else showLogin()
}

boot()
