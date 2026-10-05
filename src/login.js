// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Pagina de acceso (login.html). Tras entrar vuelve a la pagina de `?next=`
 * (por defecto, el panel). Si ya hay sesion, va directa.
 */
import { applyBrand, BRAND } from './brand.js'
import { api, session } from './app-session.js'
import { safeNext } from './navigation.js'

applyBrand()
document.title = `Acceso · ${BRAND.name}`

const params = new URLSearchParams(window.location.search)
const next = safeNext(params.get('next'), window.location.href)

const loginForm = document.getElementById('login')
const loginError = document.getElementById('login-error')
const submitButton = loginForm.querySelector('button[type="submit"]')

function showLogin(message) {
  loginForm.hidden = false
  loginError.hidden = !message
  loginError.textContent = message ?? ''
  loginForm.elements.email.focus()
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
      window.location.replace(next)
      return
    }
    showLogin(loginFailureMessage(result))
  } catch {
    showLogin('No se ha podido contactar con el servidor. Revisa la conexión.')
  } finally {
    // La contrasena solo vive en el campo mientras se escribe.
    passwordInput.value = ''
    submitButton.disabled = false
  }
})

async function boot() {
  const access = await session.accessToken()
  if (access._tag === 'Authenticated') {
    window.location.replace(next)
    return
  }
  if (params.get('expired')) showLogin('La sesión ha caducado. Vuelve a entrar.')
  else if (access._tag === 'Unavailable')
    showLogin('No se ha podido contactar con el servidor. Vuelve a probar en un momento.')
  else showLogin()
}

boot()
