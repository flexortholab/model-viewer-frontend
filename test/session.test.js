// SPDX-License-Identifier: GPL-3.0-or-later
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createSession, SESSION_STORAGE_KEY } from '../src/session.js'

const NOW = Date.parse('2026-10-05T10:00:00.000Z')
const inMinutes = (minutes) => new Date(NOW + minutes * 60_000).toISOString()

function memoryStorage(initial) {
  const values = new Map(initial ? [[SESSION_STORAGE_KEY, JSON.stringify(initial)]] : [])
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
    stored: () => JSON.parse(values.get(SESSION_STORAGE_KEY) ?? 'null'),
  }
}

/** Cerrojo real en memoria: las tareas se ejecutan de una en una. */
function memoryLock() {
  let tail = Promise.resolve()
  return (name, task) => {
    const run = tail.then(task)
    tail = run.catch(() => {})
    return run
  }
}

const freshSession = {
  email: 'roberto@lab.es',
  accessToken: 'access-1',
  accessTokenExpiresAt: inMinutes(10),
  refreshToken: 'refresh-1',
  refreshTokenExpiresAt: inMinutes(60 * 24),
}
const expiringSession = { ...freshSession, accessTokenExpiresAt: inMinutes(0.5) }
const renewedTokens = {
  accessToken: 'access-2',
  accessTokenExpiresAt: inMinutes(15),
  refreshToken: 'refresh-2',
  refreshTokenExpiresAt: inMinutes(60 * 24 * 30),
}

function refreshingApi(result = { _tag: 'Refreshed', tokens: renewedTokens }) {
  const calls = []
  return {
    calls,
    refresh: async (token) => {
      calls.push(token)
      await new Promise((resolve) => setTimeout(resolve, 5))
      return result
    },
  }
}

function sessionWith(storage, api) {
  return createSession({ storage, api, withLock: memoryLock(), now: () => NOW })
}

test('sin sesion guardada pide volver al login', async () => {
  const session = sessionWith(memoryStorage(), refreshingApi())

  assert.deepEqual(await session.accessToken(), { _tag: 'SignedOut' })
})

test('start guarda el email y los tokens, nunca una contrasena', () => {
  const storage = memoryStorage()
  sessionWith(storage, refreshingApi()).start('roberto@lab.es', renewedTokens)

  assert.deepEqual(storage.stored(), { email: 'roberto@lab.es', ...renewedTokens })
})

test('un access token vigente se usa sin renovar', async () => {
  const api = refreshingApi()
  const session = sessionWith(memoryStorage(freshSession), api)

  assert.deepEqual(await session.accessToken(), { _tag: 'Authenticated', token: 'access-1' })
  assert.equal(api.calls.length, 0)
})

test('un access token a punto de caducar se renueva y se guarda el par nuevo', async () => {
  const storage = memoryStorage(expiringSession)
  const api = refreshingApi()

  const access = await sessionWith(storage, api).accessToken()

  assert.deepEqual(access, { _tag: 'Authenticated', token: 'access-2' })
  assert.deepEqual(api.calls, ['refresh-1'])
  assert.deepEqual(storage.stored(), { email: 'roberto@lab.es', ...renewedTokens })
})

test('dos peticiones a la vez gastan el refresh token una sola vez', async () => {
  const api = refreshingApi()
  const session = sessionWith(memoryStorage(expiringSession), api)

  const [first, second] = await Promise.all([session.accessToken(), session.accessToken()])

  assert.deepEqual(api.calls, ['refresh-1'])
  assert.equal(first.token, 'access-2')
  assert.equal(second.token, 'access-2')
})

test('si otra pestana ya renovo, se usa su par sin gastar el refresh token', async () => {
  const storage = memoryStorage(expiringSession)
  const api = refreshingApi()
  const otherTabLock = (name, task) => {
    storage.setItem(SESSION_STORAGE_KEY, JSON.stringify({ email: 'roberto@lab.es', ...renewedTokens }))
    return task()
  }
  const session = createSession({ storage, api, withLock: otherTabLock, now: () => NOW })

  assert.deepEqual(await session.accessToken(), { _tag: 'Authenticated', token: 'access-2' })
  assert.equal(api.calls.length, 0)
})

test('un refresh token rechazado cierra la sesion', async () => {
  const storage = memoryStorage(expiringSession)

  const access = await sessionWith(storage, refreshingApi({ _tag: 'Rejected' })).accessToken()

  assert.deepEqual(access, { _tag: 'SignedOut' })
  assert.equal(storage.stored(), null)
})

test('un refresh token caducado cierra la sesion sin llamar a la API', async () => {
  const storage = memoryStorage({ ...expiringSession, refreshTokenExpiresAt: inMinutes(-1) })
  const api = refreshingApi()

  assert.deepEqual(await sessionWith(storage, api).accessToken(), { _tag: 'SignedOut' })
  assert.equal(api.calls.length, 0)
  assert.equal(storage.stored(), null)
})

test('si la API no responde, la sesion se conserva', async () => {
  const storage = memoryStorage(expiringSession)
  const api = { refresh: async () => { throw new TypeError('Failed to fetch') } }

  assert.deepEqual(await sessionWith(storage, api).accessToken(), { _tag: 'Unavailable' })
  assert.deepEqual(storage.stored(), expiringSession)
})

test('end borra la sesion', () => {
  const storage = memoryStorage(freshSession)
  sessionWith(storage, refreshingApi()).end()

  assert.equal(storage.stored(), null)
})
