// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Panel de administracion (panel.html): acceso con email y contrasena.
 * La lista de casos y el resto de acciones se iran anadiendo aqui.
 */
import { applyBrand, BRAND } from './brand.js'
import { api, session } from './app-session.js'

applyBrand()
document.title = `Panel · ${BRAND.name}`

const loginForm = document.getElementById('login')
const loginError = document.getElementById('login-error')
const signedIn = document.getElementById('signed-in')
const userEmail = document.getElementById('user-email')
const submitButton = loginForm.querySelector('button[type="submit"]')

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
