// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Sesion del panel: guarda el par de tokens y da siempre un access token
 * vigente, renovandolo con el refresh token cuando esta a punto de caducar.
 *
 * Sin DOM: el almacenamiento, el cliente de la API y el cerrojo se inyectan
 * para poder probarlo con node --test.
 *
 * Cada refresh token sirve UNA sola vez (el backend lo consume). Si dos
 * peticiones, o dos pestanas, renovasen a la vez con el mismo token, la
 * segunda recibiria 401 y echaria al usuario. Por eso la renovacion va dentro
 * de un cerrojo comun a todas las pestanas y, una vez dentro, se vuelve a leer
 * el almacenamiento: si otra pestana ya renovo, se usa su par.
 *
 * La contrasena nunca pasa por aqui.
 */

export const SESSION_STORAGE_KEY = 'model-viewer-session'
const REFRESH_LOCK = 'model-viewer-session-refresh'
/** Margen antes de la caducidad del access token para renovarlo. */
const REFRESH_MARGIN_MS = 60_000

const signedOut = { _tag: 'SignedOut' }

/** Cerrojo entre pestanas con la Web Locks API; sin ella, sin cerrojo. */
export function browserLock(name, task) {
  const locks = globalThis.navigator?.locks
  return locks ? locks.request(name, task) : task()
}

export function createSession({ storage, api, withLock = browserLock, now = () => Date.now() }) {
  function read() {
    try {
      const raw = storage.getItem(SESSION_STORAGE_KEY)
      return raw ? JSON.parse(raw) : null
    } catch {
      return null
    }
  }

  const save = (session) => storage.setItem(SESSION_STORAGE_KEY, JSON.stringify(session))
  const clear = () => storage.removeItem(SESSION_STORAGE_KEY)
  const isFresh = (session) => Date.parse(session.accessTokenExpiresAt) - now() > REFRESH_MARGIN_MS
  const canRefresh = (session) => Date.parse(session.refreshTokenExpiresAt) > now()
  const authenticated = (session) => ({ _tag: 'Authenticated', token: session.accessToken })

  async function renew() {
    return withLock(REFRESH_LOCK, async () => {
      const latest = read()
      if (!latest) return signedOut
      if (isFresh(latest)) return authenticated(latest)
      if (!canRefresh(latest)) {
        clear()
        return signedOut
      }
      let result
      try {
        result = await api.refresh(latest.refreshToken)
      } catch {
        return { _tag: 'Unavailable' }
      }
      if (result._tag === 'Refreshed') {
        const renewed = { email: latest.email, ...result.tokens }
        save(renewed)
        return authenticated(renewed)
      }
      if (result._tag === 'Rejected') {
        clear()
        return signedOut
      }
      return { _tag: 'Unavailable' }
    })
  }

  return {
    /** Email del usuario con sesion, o null. */
    email: () => read()?.email ?? null,

    start(email, tokens) {
      save({ email, ...tokens })
    },

    end() {
      clear()
    },

    /**
     * Access token vigente: Authenticated, SignedOut (hay que volver al
     * login) o Unavailable (la API no responde; la sesion se conserva).
     */
    async accessToken() {
      const session = read()
      if (!session) return signedOut
      if (isFresh(session)) return authenticated(session)
      return renew()
    },
  }
}
