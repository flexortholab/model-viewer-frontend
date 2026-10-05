// SPDX-License-Identifier: GPL-3.0-or-later
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createApi } from '../src/api.js'

const tokens = {
  accessToken: 'access',
  accessTokenExpiresAt: '2026-10-05T10:15:00.000Z',
  refreshToken: 'refresh',
  refreshTokenExpiresAt: '2026-11-04T10:00:00.000Z',
}

function fakeFetch(status, body) {
  const calls = []
  const fetch = async (url, init) => {
    calls.push({ url, init })
    return { status, json: async () => body }
  }
  return { fetch, calls }
}

test('login envia email y contrasena por POST a /auth/login', async () => {
  const { fetch, calls } = fakeFetch(200, { result: tokens })
  await createApi({ base: 'https://api.test/prod', fetch }).login('roberto@lab.es', 'secreta')

  assert.equal(calls[0].url, 'https://api.test/prod/api/v1/auth/login')
  assert.equal(calls[0].init.method, 'POST')
  assert.equal(calls[0].init.headers['Content-Type'], 'application/json')
  assert.deepEqual(JSON.parse(calls[0].init.body), { email: 'roberto@lab.es', password: 'secreta' })
})

test('login correcto devuelve el par de tokens', async () => {
  const { fetch } = fakeFetch(200, { result: tokens })
  const result = await createApi({ base: '', fetch }).login('roberto@lab.es', 'secreta')

  assert.deepEqual(result, { _tag: 'LoggedIn', tokens })
})

test('login con 401 o 400 son credenciales incorrectas', async () => {
  for (const status of [400, 401]) {
    const { fetch } = fakeFetch(status, { message: 'KO' })
    const result = await createApi({ base: '', fetch }).login('roberto@lab.es', 'mala')

    assert.deepEqual(result, { _tag: 'InvalidCredentials' })
  }
})

test('login con otro estado es un fallo con su codigo', async () => {
  const { fetch } = fakeFetch(429, null)
  const result = await createApi({ base: '', fetch }).login('roberto@lab.es', 'secreta')

  assert.deepEqual(result, { _tag: 'Failed', status: 429 })
})

test('refresh envia el refresh token y devuelve el par nuevo', async () => {
  const { fetch, calls } = fakeFetch(200, { result: tokens })
  const result = await createApi({ base: '', fetch }).refresh('refresh-viejo')

  assert.equal(calls[0].url, '/api/v1/auth/refresh')
  assert.deepEqual(JSON.parse(calls[0].init.body), { refreshToken: 'refresh-viejo' })
  assert.deepEqual(result, { _tag: 'Refreshed', tokens })
})

test('refresh con 401 es un refresh token rechazado', async () => {
  const { fetch } = fakeFetch(401, { message: 'KO' })

  assert.deepEqual(await createApi({ base: '', fetch }).refresh('usado'), { _tag: 'Rejected' })
})

test('una respuesta sin JSON no rompe el cliente', async () => {
  const fetch = async () => ({ status: 502, json: async () => { throw new SyntaxError('no json') } })

  assert.deepEqual(await createApi({ base: '', fetch }).refresh('x'), { _tag: 'Failed', status: 502 })
})

test('listCases pide la lista con el access token', async () => {
  const cases = [{ id: 'c1', name: 'Caso', status: 'draft', createdAt: 'x', updatedAt: 'y' }]
  const { fetch, calls } = fakeFetch(200, { result: cases })
  const result = await createApi({ base: '', fetch }).listCases('access-1')

  assert.equal(calls[0].url, '/api/v1/cases')
  assert.equal(calls[0].init.method, 'GET')
  assert.equal(calls[0].init.headers.Authorization, 'Bearer access-1')
  assert.deepEqual(result, { _tag: 'Cases', cases, nextCursor: null })
})

test('listCases con 401 es una sesion no autorizada', async () => {
  const { fetch } = fakeFetch(401, { message: 'KO' })

  assert.deepEqual(await createApi({ base: '', fetch }).listCases('viejo'), { _tag: 'Unauthorized' })
})

test('createCase envia nombre y tamano y devuelve el caso y su subida firmada', async () => {
  const upload = { method: 'PUT', url: 'https://s3.test/x?X-Amz-Signature=1', headers: { 'Content-Type': 'model/gltf-binary', 'If-None-Match': '*' }, expiresAt: 'z' }
  const { fetch, calls } = fakeFetch(201, { result: { id: 'c1', upload } })
  const result = await createApi({ base: '', fetch }).createCase('access-1', { name: 'Caso', sizeBytes: 123 })

  assert.equal(calls[0].url, '/api/v1/cases')
  assert.equal(calls[0].init.method, 'POST')
  assert.equal(calls[0].init.headers.Authorization, 'Bearer access-1')
  assert.deepEqual(JSON.parse(calls[0].init.body), { name: 'Caso', sizeBytes: 123 })
  assert.deepEqual(result, { _tag: 'Created', caseId: 'c1', upload })
})

test('createCase con 400 es un caso no valido', async () => {
  const { fetch } = fakeFetch(400, { message: 'KO' })

  assert.deepEqual(await createApi({ base: '', fetch }).createCase('a', { name: '', sizeBytes: 0 }), { _tag: 'Invalid' })
})

test('uploadModel hace el PUT a la URL firmada con sus cabeceras exactas y el fichero', async () => {
  const calls = []
  const fetch = async (url, init) => {
    calls.push({ url, init })
    return { ok: true, status: 200 }
  }
  const upload = { method: 'PUT', url: 'https://s3.test/x?X-Amz-Signature=1', headers: { 'Content-Type': 'model/gltf-binary', 'If-None-Match': '*' } }
  const file = { name: 'modelo.glb', size: 3 }

  const result = await createApi({ base: 'https://api.test', fetch }).uploadModel(upload, file)

  assert.deepEqual(result, { _tag: 'Uploaded' })
  assert.equal(calls[0].url, upload.url)
  assert.equal(calls[0].init.method, 'PUT')
  assert.deepEqual(calls[0].init.headers, upload.headers)
  assert.equal(calls[0].init.body, file)
})

test('uploadModel distingue la URL caducada del modelo ya subido', async () => {
  const upload = { method: 'PUT', url: 'u', headers: {} }
  for (const [status, tag] of [[403, 'Expired'], [412, 'AlreadyUploaded'], [500, 'Failed']]) {
    const fetch = async () => ({ ok: false, status })
    const result = await createApi({ base: '', fetch }).uploadModel(upload, {})

    assert.equal(result._tag, tag)
  }
})

test('getCase pide el caso con el access token y lo devuelve', async () => {
  const detail = { id: 'c/1', name: 'Caso', config: {}, model: { url: 'https://s3.test/m.glb?X-Amz-Signature=1', expiresAt: 'z' } }
  const { fetch, calls } = fakeFetch(200, { result: detail })
  const result = await createApi({ base: '', fetch }).getCase('access-1', 'c/1')

  assert.equal(calls[0].url, '/api/v1/cases/c%2F1')
  assert.equal(calls[0].init.headers.Authorization, 'Bearer access-1')
  assert.deepEqual(result, { _tag: 'Found', case: detail })
})

test('getCase con 404 o un id mal formado (400) es un caso que no existe', async () => {
  for (const status of [400, 404]) {
    const { fetch } = fakeFetch(status, { message: 'KO' })

    assert.deepEqual(await createApi({ base: '', fetch }).getCase('a', 'x'), { _tag: 'NotFound' })
  }
})

test('saveConfig sustituye la configuracion con PUT', async () => {
  const config = { version: 1, markers: [{ id: 'k1', position: [0, 0, 0] }] }
  const { fetch, calls } = fakeFetch(200, { result: { id: 'c1', updatedAt: '2026-10-05T10:00:00.000Z' } })
  const result = await createApi({ base: '', fetch }).saveConfig('access-1', 'c1', config)

  assert.equal(calls[0].url, '/api/v1/cases/c1/config')
  assert.equal(calls[0].init.method, 'PUT')
  assert.deepEqual(JSON.parse(calls[0].init.body), config)
  assert.deepEqual(result, { _tag: 'Saved', updatedAt: '2026-10-05T10:00:00.000Z' })
})

test('shareCase pide el enlace con POST y distingue si se acaba de generar', async () => {
  for (const [status, generatedNow] of [[201, true], [200, false]]) {
    const { fetch, calls } = fakeFetch(status, { result: { id: 'c1', shareId: 's1', sharePath: '?share=s1', linkGeneratedAt: 'x' } })
    const result = await createApi({ base: '', fetch }).shareCase('access-1', 'c1')

    assert.equal(calls[0].url, '/api/v1/cases/c1/share')
    assert.equal(calls[0].init.method, 'POST')
    assert.deepEqual(result, { _tag: 'Shared', sharePath: '?share=s1', generatedNow })
  }
})

test('shareCase con 409 es un caso sin modelo subido', async () => {
  const { fetch } = fakeFetch(409, { message: 'KO' })

  assert.deepEqual(await createApi({ base: '', fetch }).shareCase('a', 'c1'), { _tag: 'ModelNotUploaded' })
})

test('listCases sin cursor pide la primera pagina y devuelve el cursor de la siguiente', async () => {
  const { fetch, calls } = fakeFetch(200, { result: [], nextCursor: 'abc' })
  const result = await createApi({ base: '', fetch }).listCases('access-1')

  assert.equal(calls[0].url, '/api/v1/cases')
  assert.equal(result.nextCursor, 'abc')
})

test('listCases con cursor pide la pagina siguiente', async () => {
  const { fetch, calls } = fakeFetch(200, { result: [] })
  const result = await createApi({ base: '', fetch }).listCases('access-1', { cursor: 'a+b/c=' })

  assert.equal(calls[0].url, '/api/v1/cases?cursor=a%2Bb%2Fc%3D')
  assert.equal(result.nextCursor, null)
})

test('deleteCase borra el caso con DELETE y el access token', async () => {
  const { fetch, calls } = fakeFetch(204, null)
  const result = await createApi({ base: '', fetch }).deleteCase('access-1', 'c1')

  assert.equal(calls[0].url, '/api/v1/cases/c1')
  assert.equal(calls[0].init.method, 'DELETE')
  assert.equal(calls[0].init.headers.Authorization, 'Bearer access-1')
  assert.deepEqual(result, { _tag: 'Deleted' })
})

test('deleteCase de un caso que ya no existe es NotFound', async () => {
  const { fetch } = fakeFetch(404, { message: 'KO' })

  assert.deepEqual(await createApi({ base: '', fetch }).deleteCase('a', 'c1'), { _tag: 'NotFound' })
})
