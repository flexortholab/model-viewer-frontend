// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Cliente de la API del visor (model-viewer-backend).
 *
 * Sin DOM ni estado: recibe `fetch` y la URL base para poder probarlo con
 * node --test. Cada llamada devuelve un objeto con `_tag` para los casos
 * esperados (credenciales malas, sesion caducada...) en vez de lanzar; solo
 * lanza si falla la red.
 */

function toTokens(result) {
  return {
    accessToken: result.accessToken,
    accessTokenExpiresAt: result.accessTokenExpiresAt,
    refreshToken: result.refreshToken,
    refreshTokenExpiresAt: result.refreshTokenExpiresAt,
  }
}

export function createApi({ base, fetch: doFetch = (...args) => globalThis.fetch(...args) }) {
  async function call(path, { method = 'GET', body, token } = {}) {
    const headers = {}
    if (body !== undefined) headers['Content-Type'] = 'application/json'
    if (token) headers.Authorization = `Bearer ${token}`
    const response = await doFetch(`${base}/api/v1${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    const data = await response.json().catch(() => null)
    return { status: response.status, result: data?.result, nextCursor: data?.nextCursor }
  }

  return {
    /** Email y contraseña a cambio del par de tokens. 400 y 401 son lo mismo para el usuario. */
    async login(email, password) {
      const { status, result } = await call('/auth/login', {
        method: 'POST',
        body: { email, password },
      })
      if (status === 200) return { _tag: 'LoggedIn', tokens: toTokens(result) }
      if (status === 400 || status === 401) return { _tag: 'InvalidCredentials' }
      return { _tag: 'Failed', status }
    },

    /**
     * Una pagina de casos, lo modificado mas recientemente primero. Con
     * `cursor` (el `nextCursor` de la pagina anterior) trae la siguiente;
     * `nextCursor` falta en la ultima pagina. Exige access token.
     */
    async listCases(token, { cursor } = {}) {
      const query = cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''
      const { status, result, nextCursor } = await call(`/cases${query}`, { token })
      if (status === 200) return { _tag: 'Cases', cases: result, nextCursor: nextCursor ?? null }
      if (status === 401) return { _tag: 'Unauthorized' }
      return { _tag: 'Failed', status }
    },

    /** Un caso con su configuracion y una URL firmada (5 min) para descargar su GLB. */
    async getCase(token, caseId) {
      const { status, result } = await call(`/cases/${encodeURIComponent(caseId)}`, { token })
      if (status === 200) return { _tag: 'Found', case: result }
      if (status === 400 || status === 404) return { _tag: 'NotFound' }
      if (status === 401) return { _tag: 'Unauthorized' }
      return { _tag: 'Failed', status }
    },

    /**
     * Enlace del doctor. Si el caso ya lo tenia, devuelve el mismo (200); si
     * no, lo genera (201). Exige que el GLB ya este subido (409 si no).
     */
    async shareCase(token, caseId) {
      const { status, result } = await call(`/cases/${encodeURIComponent(caseId)}/share`, {
        method: 'POST',
        token,
      })
      if (status === 200 || status === 201)
        return { _tag: 'Shared', sharePath: result.sharePath, generatedNow: status === 201 }
      if (status === 409) return { _tag: 'ModelNotUploaded' }
      if (status === 400 || status === 404) return { _tag: 'NotFound' }
      if (status === 401) return { _tag: 'Unauthorized' }
      return { _tag: 'Failed', status }
    },

    /**
     * Borra el caso: su GLB en S3 y su registro. El enlace del doctor deja de
     * funcionar. Un caso que ya no existe cuenta como borrado (NotFound).
     */
    async deleteCase(token, caseId) {
      const { status } = await call(`/cases/${encodeURIComponent(caseId)}`, { method: 'DELETE', token })
      if (status === 204) return { _tag: 'Deleted' }
      if (status === 400 || status === 404) return { _tag: 'NotFound' }
      if (status === 401) return { _tag: 'Unauthorized' }
      return { _tag: 'Failed', status }
    },

    /** Sustituye la configuracion entera del caso (marcadores, medidas, corte). */
    async saveConfig(token, caseId, config) {
      const { status, result } = await call(`/cases/${encodeURIComponent(caseId)}/config`, {
        method: 'PUT',
        token,
        body: config,
      })
      if (status === 200) return { _tag: 'Saved', updatedAt: result.updatedAt }
      if (status === 400) return { _tag: 'Invalid' }
      if (status === 404) return { _tag: 'NotFound' }
      if (status === 401) return { _tag: 'Unauthorized' }
      return { _tag: 'Failed', status }
    },

    /**
     * Crea un caso en borrador y devuelve la subida firmada de su GLB.
     * `sizeBytes` tiene que ser el tamano exacto del fichero: va firmado.
     */
    async createCase(token, { name, sizeBytes }) {
      const { status, result } = await call('/cases', {
        method: 'POST',
        token,
        body: { name, sizeBytes },
      })
      if (status === 201) return { _tag: 'Created', caseId: result.id, upload: result.upload }
      if (status === 400) return { _tag: 'Invalid' }
      if (status === 401) return { _tag: 'Unauthorized' }
      return { _tag: 'Failed', status }
    },

    /**
     * Sube el GLB directamente a S3 con la URL firmada de `createCase`, con
     * las cabeceras exactas que devolvio la API. No pasa por la API: la URL
     * firmada ya lleva el permiso.
     */
    async uploadModel(upload, file) {
      const response = await doFetch(upload.url, {
        method: upload.method,
        headers: upload.headers,
        body: file,
      })
      if (response.ok) return { _tag: 'Uploaded' }
      // 403: la URL firmada caduco (5 minutos). 412: ya habia un modelo.
      if (response.status === 403) return { _tag: 'Expired' }
      if (response.status === 412) return { _tag: 'AlreadyUploaded' }
      return { _tag: 'Failed', status: response.status }
    },

    /** Cambia el refresh token por un par nuevo. El refresh token usado deja de valer. */
    async refresh(refreshToken) {
      const { status, result } = await call('/auth/refresh', {
        method: 'POST',
        body: { refreshToken },
      })
      if (status === 200) return { _tag: 'Refreshed', tokens: toTokens(result) }
      if (status === 400 || status === 401) return { _tag: 'Rejected' }
      return { _tag: 'Failed', status }
    },

    /**
     * Caso compartido con el doctor: nombre, configuracion y URL firmada del
     * GLB. Ruta publica, sin token: el enlace es el permiso.
     */
    async getShare(shareId) {
      const { status, result } = await call(`/shares/${encodeURIComponent(shareId)}`)
      if (status === 200) return { _tag: 'Found', shared: result }
      if (status === 400 || status === 404) return { _tag: 'NotFound' }
      return { _tag: 'Failed', status }
    },
  }
}
