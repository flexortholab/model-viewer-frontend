// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Navegacion entre las paginas del panel, sin DOM para poder probarla.
 */

export const LOGIN_PAGE = 'login.html'
export const PANEL_PAGE = 'panel.html'

/**
 * Pagina a la que volver tras entrar. Solo se acepta una pagina de esta misma
 * web (mismo origen y misma carpeta); cualquier otra cosa lleva al panel,
 * para que nadie pueda usar el login para redirigir a otro sitio.
 */
export function safeNext(next, currentUrl) {
  if (!next) return PANEL_PAGE
  try {
    const current = new URL(currentUrl)
    const target = new URL(next, current)
    const folder = current.pathname.slice(0, current.pathname.lastIndexOf('/') + 1)
    const sameSite = target.origin === current.origin && target.pathname.startsWith(folder)
    return sameSite ? target.pathname.slice(folder.length) + target.search : PANEL_PAGE
  } catch {
    return PANEL_PAGE
  }
}

/** URL del login que, al entrar, vuelve a `next`. `expired` muestra el aviso de sesion caducada. */
export function loginUrl(next, { expired = false } = {}) {
  const params = new URLSearchParams({ next })
  if (expired) params.set('expired', '1')
  return `${LOGIN_PAGE}?${params}`
}
