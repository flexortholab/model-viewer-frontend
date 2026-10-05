// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Llamada a la API con el access token de la sesion.
 *
 * Devuelve el resultado de la llamada, o SignedOut / Unavailable si no hay
 * token. Si la API responde 401 con un token que la sesion daba por bueno
 * (por ejemplo, tras cambiar la contrasena o rotar las claves), la sesion se
 * cierra para volver al login en vez de reintentar sin fin.
 */
export async function authorizedCall(session, call) {
  const access = await session.accessToken()
  if (access._tag !== 'Authenticated') return access
  const result = await call(access.token)
  if (result._tag === 'Unauthorized') {
    session.end()
    return { _tag: 'SignedOut' }
  }
  return result
}
