// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Cache de modelos en el navegador (Cache Storage) durante 5 minutos.
 *
 * El GLB de un caso no cambia nunca, pero la API da una URL firmada distinta
 * cada vez que se abre el caso, asi que la cache HTTP del navegador no sirve:
 * aqui la clave es el caso (`case/<id>`) o el enlace (`share/<id>`). Son
 * datos de salud: la copia caduca a los 5 minutos y las caducadas se borran
 * en cada apertura.
 *
 * Sin DOM: Cache Storage y fetch se inyectan para poder probarlo con
 * node --test.
 */

export const MODEL_CACHE_NAME = 'model-viewer-models'
export const MODEL_CACHE_TTL_MS = 5 * 60_000
const CACHED_AT_HEADER = 'x-model-viewer-cached-at'

/** URL ficticia que hace de clave: Cache Storage solo indexa por peticion. */
const keyUrl = (key) => `https://model-cache.invalid/${encodeURIComponent(key)}`

/**
 * Lee la descarga por trozos para poder informar del progreso (0 a 1) con
 * el tamano de Content-Length; sin el, o sin `onProgress`, se lee de golpe.
 */
async function readBlob(response, onProgress) {
  const total = Number(response.headers.get('content-length')) || 0
  if (!onProgress || !total || !response.body) return response.blob()
  const reader = response.body.getReader()
  const chunks = []
  let loaded = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    chunks.push(value)
    loaded += value.length
    onProgress(Math.min(loaded / total, 1))
  }
  return new Blob(chunks, { type: response.headers.get('content-type') ?? '' })
}

export function createModelCache({
  cacheStorage,
  fetch: doFetch = (...args) => globalThis.fetch(...args),
  now = () => Date.now(),
  ttlMs = MODEL_CACHE_TTL_MS,
}) {
  const isFresh = (response) => now() - Number(response.headers.get(CACHED_AT_HEADER)) < ttlMs

  async function purgeExpired(cache) {
    for (const request of await cache.keys()) {
      const response = await cache.match(request)
      if (!response || !isFresh(response)) await cache.delete(request)
    }
  }

  return {
    /**
     * Modelo del caso o del enlace `key`: de la cache si la copia tiene menos
     * de 5 minutos; si no, se descarga de `url` (la URL firmada) y se guarda.
     * `onProgress(fraccion)` informa de la descarga.
     */
    async getModel(key, url, { onProgress } = {}) {
      const cache = await cacheStorage.open(MODEL_CACHE_NAME)
      await purgeExpired(cache)
      const cached = await cache.match(keyUrl(key))
      if (cached) return { _tag: 'Cached', blob: await cached.blob() }
      const response = await doFetch(url)
      if (!response.ok) return { _tag: 'Failed', status: response.status }
      const blob = await readBlob(response, onProgress)
      await cache.put(
        keyUrl(key),
        new Response(blob, { headers: { [CACHED_AT_HEADER]: String(now()) } }),
      )
      return { _tag: 'Downloaded', blob }
    },

    /** Quita la copia de un caso (por ejemplo, al borrarlo). */
    async remove(key) {
      const cache = await cacheStorage.open(MODEL_CACHE_NAME)
      await cache.delete(keyUrl(key))
    },

    /** Borra todos los modelos guardados (al cerrar sesion). */
    async clear() {
      await cacheStorage.delete(MODEL_CACHE_NAME)
    },
  }
}
