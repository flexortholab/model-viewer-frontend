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
