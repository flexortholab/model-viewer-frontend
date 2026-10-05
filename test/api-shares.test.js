// SPDX-License-Identifier: GPL-3.0-or-later
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createApi } from '../src/api.js'

function fakeFetch(status, body) {
  const calls = []
  const fetch = async (url, init) => {
    calls.push({ url, init })
    return { status, json: async () => body }
  }
  return { fetch, calls }
}

test('getShare pide el caso compartido sin token', async () => {
  const shared = { name: 'Caso', config: {}, model: { url: 'https://s3.test/m.glb?X-Amz-Signature=1', expiresAt: 'z' } }
  const { fetch, calls } = fakeFetch(200, { result: shared })
  const result = await createApi({ base: '', fetch }).getShare('s/1')

  assert.equal(calls[0].url, '/api/v1/shares/s%2F1')
  assert.equal(calls[0].init.method, 'GET')
  assert.equal(calls[0].init.headers.Authorization, undefined)
  assert.deepEqual(result, { _tag: 'Found', shared })
})

test('getShare con 404 o un id mal formado es un enlace no valido', async () => {
  for (const status of [400, 404]) {
    const { fetch } = fakeFetch(status, { message: 'KO' })

    assert.deepEqual(await createApi({ base: '', fetch }).getShare('x'), { _tag: 'NotFound' })
  }
})
