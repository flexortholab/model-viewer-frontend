// SPDX-License-Identifier: GPL-3.0-or-later
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { authorizedCall } from '../src/authorized.js'

function fakeSession(access) {
  const state = { ended: false }
  return { state, accessToken: async () => access, end: () => { state.ended = true } }
}

test('llama a la API con el access token de la sesion', async () => {
  const session = fakeSession({ _tag: 'Authenticated', token: 'access-1' })
  const seen = []

  const result = await authorizedCall(session, async (token) => {
    seen.push(token)
    return { _tag: 'Cases', cases: [] }
  })

  assert.deepEqual(seen, ['access-1'])
  assert.deepEqual(result, { _tag: 'Cases', cases: [] })
})

test('sin sesion no llama a la API', async () => {
  const session = fakeSession({ _tag: 'SignedOut' })
  let called = false

  const result = await authorizedCall(session, async () => {
    called = true
  })

  assert.deepEqual(result, { _tag: 'SignedOut' })
  assert.equal(called, false)
})

test('un 401 con un token vigente cierra la sesion', async () => {
  const session = fakeSession({ _tag: 'Authenticated', token: 'revocado' })

  const result = await authorizedCall(session, async () => ({ _tag: 'Unauthorized' }))

  assert.deepEqual(result, { _tag: 'SignedOut' })
  assert.equal(session.state.ended, true)
})
