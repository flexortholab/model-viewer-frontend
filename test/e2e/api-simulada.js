// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * API del visor simulada con page.route, para probar el editor (?case=) y el
 * enlace del doctor (?share=) sin backend.
 *
 * `vite preview` sirve el build de produccion, que llama a la API de
 * produccion: se interceptan todas sus rutas y cualquier peticion que no este
 * simulada se aborta, para que una prueba nunca llegue al backend real.
 */
import { PRODUCTION_API_BASE } from '../../src/api-url.js'
import { SESSION_STORAGE_KEY } from '../../src/session.js'

const API = `${PRODUCTION_API_BASE}/api/v1`

// La pagina (localhost) y la API son origenes distintos: el navegador exige
// CORS, y con la cabecera Authorization hace antes un preflight OPTIONS.
const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, PUT, POST, DELETE, OPTIONS',
  'access-control-allow-headers': 'authorization, content-type',
}

/** El GLB de ejemplo hace de URL firmada de S3. */
export const modeloFirmado = (baseURL) => `${baseURL}/samples/Test1.glb`

/**
 * Sesion del panel ya iniciada, con tokens falsos que no caducan durante la
 * prueba (sin refresh). Se escribe antes de que cargue la pagina.
 */
export async function iniciarSesion(page) {
  const dentroDeUnaHora = new Date(Date.now() + 3_600_000).toISOString()
  const dentroDeUnMes = new Date(Date.now() + 30 * 86_400_000).toISOString()
  const sesion = {
    email: 'tecnico@example.com',
    accessToken: 'token-de-prueba',
    accessTokenExpiresAt: dentroDeUnaHora,
    refreshToken: 'refresh-de-prueba',
    refreshTokenExpiresAt: dentroDeUnMes,
  }
  await page.addInitScript(([clave, valor]) => {
    window.localStorage.setItem(clave, valor)
  }, [SESSION_STORAGE_KEY, JSON.stringify(sesion)])
}

/**
 * Intercepta la API. `rutas` es una lista de { metodo, ruta, responder },
 * donde `ruta` va sin el prefijo /api/v1 y `responder(request)` devuelve
 * { status, result }. Devuelve la lista de peticiones recibidas
 * ({ metodo, ruta, body }) y las que no estaban simuladas.
 */
export async function simularApi(page, rutas) {
  const peticiones = []
  const noSimuladas = []
  await page.route(`${PRODUCTION_API_BASE}/**`, async (route) => {
    const request = route.request()
    const metodo = request.method()
    if (metodo === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS })
    const ruta = new URL(request.url()).pathname.replace(new URL(API).pathname, '')
    const simulada = rutas.find((r) => r.metodo === metodo && r.ruta === ruta)
    if (!simulada) {
      noSimuladas.push(`${metodo} ${ruta}`)
      return route.abort()
    }
    const body = request.postData() ? JSON.parse(request.postData()) : null
    peticiones.push({ metodo, ruta, body })
    const { status = 200, result } = simulada.responder(request)
    return route.fulfill({
      status,
      headers: CORS,
      contentType: 'application/json',
      body: JSON.stringify({ result }),
    })
  })
  return { peticiones, noSimuladas }
}
