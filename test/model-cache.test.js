// SPDX-License-Identifier: GPL-3.0-or-later
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createModelCache, MODEL_CACHE_TTL_MS } from '../src/model-cache.js'

/** Cache Storage en memoria con la misma interfaz que la del navegador. */
function memoryCacheStorage() {
  const caches = new Map()
  const open = async (name) => {
    if (!caches.has(name)) caches.set(name, new Map())
    const entries = caches.get(name)
    return {
      keys: async () => [...entries.keys()],
      match: async (url) => entries.get(url)?.clone(),
      put: async (url, response) => {
        entries.set(url, response)
      },
      delete: async (url) => entries.delete(url),
    }
  }
  return { open, delete: async (name) => caches.delete(name), size: (name) => caches.get(name)?.size ?? 0 }
}

function countingFetch(body = 'glb-bytes', status = 200) {
  const calls = []
  const fetch = async (url) => {
    calls.push(url)
    return new Response(body, { status })
  }
  return { fetch, calls }
}

function cacheAt(clock, cacheStorage, fetch) {
  return createModelCache({ cacheStorage, fetch, now: () => clock.time })
}

test('la primera apertura descarga el modelo de la URL firmada', async () => {
  const { fetch, calls } = countingFetch()
  const cache = cacheAt({ time: 0 }, memoryCacheStorage(), fetch)

  const result = await cache.getModel('case/c1', 'https://s3.test/m.glb?X-Amz-Signature=1')

  assert.equal(result._tag, 'Downloaded')
  assert.equal(await result.blob.text(), 'glb-bytes')
  assert.deepEqual(calls, ['https://s3.test/m.glb?X-Amz-Signature=1'])
})

test('reabrir antes de 5 minutos no vuelve a descargar, aunque la URL firmada sea otra', async () => {
  const clock = { time: 0 }
  const { fetch, calls } = countingFetch()
  const cache = cacheAt(clock, memoryCacheStorage(), fetch)
  await cache.getModel('case/c1', 'https://s3.test/m.glb?X-Amz-Signature=1')

  clock.time = MODEL_CACHE_TTL_MS - 1
  const result = await cache.getModel('case/c1', 'https://s3.test/m.glb?X-Amz-Signature=2')

  assert.equal(result._tag, 'Cached')
  assert.equal(await result.blob.text(), 'glb-bytes')
  assert.equal(calls.length, 1)
})

test('pasados 5 minutos se descarga otra vez', async () => {
  const clock = { time: 0 }
  const { fetch, calls } = countingFetch()
  const cache = cacheAt(clock, memoryCacheStorage(), fetch)
  await cache.getModel('case/c1', 'u1')

  clock.time = MODEL_CACHE_TTL_MS
  const result = await cache.getModel('case/c1', 'u2')

  assert.equal(result._tag, 'Downloaded')
  assert.deepEqual(calls, ['u1', 'u2'])
})

test('cada apertura borra las copias caducadas de otros casos', async () => {
  const clock = { time: 0 }
  const storage = memoryCacheStorage()
  const cache = cacheAt(clock, storage, countingFetch().fetch)
  await cache.getModel('case/viejo', 'u1')

  clock.time = MODEL_CACHE_TTL_MS + 1
  await cache.getModel('case/nuevo', 'u2')

  assert.equal(storage.size('model-viewer-models'), 1)
})

test('cada caso tiene su propia copia', async () => {
  const { fetch, calls } = countingFetch()
  const cache = cacheAt({ time: 0 }, memoryCacheStorage(), fetch)

  await cache.getModel('case/c1', 'u1')
  await cache.getModel('case/c2', 'u2')

  assert.deepEqual(calls, ['u1', 'u2'])
})

test('una descarga fallida no se guarda', async () => {
  const storage = memoryCacheStorage()
  const cache = cacheAt({ time: 0 }, storage, countingFetch('', 403).fetch)

  assert.deepEqual(await cache.getModel('case/c1', 'u1'), { _tag: 'Failed', status: 403 })
  assert.equal(storage.size('model-viewer-models'), 0)
})

test('remove quita la copia de un caso y clear las borra todas', async () => {
  const storage = memoryCacheStorage()
  const { fetch, calls } = countingFetch()
  const cache = cacheAt({ time: 0 }, storage, fetch)
  await cache.getModel('case/c1', 'u1')
  await cache.getModel('case/c2', 'u2')

  await cache.remove('case/c1')
  await cache.getModel('case/c1', 'u3')
  assert.deepEqual(calls, ['u1', 'u2', 'u3'])

  await cache.clear()
  assert.equal(storage.size('model-viewer-models'), 0)
})
