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
    return { status: response.status, result: data?.result }
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
  }
}
