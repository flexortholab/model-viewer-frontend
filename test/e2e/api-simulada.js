// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * API del visor simulada con page.route, para probar el editor (?case=) y el
 * enlace del doctor (?share=) sin backend.
 *
 * `vite preview` sirve el build de produccion, que llama a la API de
 * produccion: se interceptan todas sus rutas y cualquier peticion que no este
 * simulada se aborta, para que una prueba nunca llegue al backend real.
 */
import { readFileSync } from 'node:fs'
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

/** URL firmada de S3 simulada: la sirve `simularS3`. */
export const MODELO_FIRMADO = 'https://s3.simulado.example/cases/caso/model.glb?X-Amz-Signature=prueba'

/**
 * GLB minimo con la geometria del STL de ejemplo (3416 triangulos, solo
 * posiciones). Test1.glb tiene 415 k triangulos y con WebGL por software
 * cada prueba del editor y del doctor tardaba decenas de segundos en cargar;
 * aqui se prueba el flujo con la API, no el peso del modelo.
 */
function glbDesdeStl(ruta) {
  const stl = readFileSync(ruta)
  const triangulos = stl.readUInt32LE(80)
  const posiciones = Buffer.alloc(triangulos * 9 * 4)
  const min = [Infinity, Infinity, Infinity]
  const max = [-Infinity, -Infinity, -Infinity]
  for (let t = 0; t < triangulos; t++) {
    for (let v = 0; v < 3; v++) {
      for (let eje = 0; eje < 3; eje++) {
        const valor = stl.readFloatLE(84 + t * 50 + 12 + v * 12 + eje * 4)
        posiciones.writeFloatLE(valor, (t * 9 + v * 3 + eje) * 4)
        min[eje] = Math.min(min[eje], valor)
        max[eje] = Math.max(max[eje], valor)
      }
    }
  }
  const gltf = {
    asset: { version: '2.0' },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0, name: 'pieza' }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
    accessors: [{ bufferView: 0, componentType: 5126, count: triangulos * 3, type: 'VEC3', min, max }],
    bufferViews: [{ buffer: 0, byteLength: posiciones.length }],
    buffers: [{ byteLength: posiciones.length }],
  }
  const relleno = (b, byte) => Buffer.concat([b, Buffer.alloc((4 - (b.length % 4)) % 4, byte)])
  const json = relleno(Buffer.from(JSON.stringify(gltf)), 0x20)
  const bin = relleno(posiciones, 0)
  const cabecera = (longitud, tipo) => {
    const b = Buffer.alloc(8)
    b.writeUInt32LE(longitud, 0)
    b.writeUInt32LE(tipo, 4)
    return b
  }
  const cuerpo = Buffer.concat([cabecera(json.length, 0x4e4f534a), json, cabecera(bin.length, 0x004e4942), bin])
  const glb = Buffer.alloc(12)
  glb.writeUInt32LE(0x46546c67, 0)
  glb.writeUInt32LE(2, 4)
  glb.writeUInt32LE(12 + cuerpo.length, 8)
  return Buffer.concat([glb, cuerpo])
}

const MODELO = glbDesdeStl(new URL('../../public/samples/disyuntor-4-pilares.stl', import.meta.url))

/** Sirve el GLB en la URL firmada simulada, con CORS como el bucket real. */
export async function simularS3(page) {
  await page.route('https://s3.simulado.example/**', (route) =>
    route.fulfill({ status: 200, headers: CORS, contentType: 'model/gltf-binary', body: MODELO }))
}

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
