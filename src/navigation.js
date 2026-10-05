// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Navegacion entre las paginas del panel, sin DOM para poder probarla.
 */

export const LOGIN_PAGE = 'login.html'
export const PANEL_PAGE = './'
export const VIEWER_PAGE = 'visor.html'

/** Parametros que son del visor: si llegan al panel, la URL es del visor. */
const VIEWER_PARAMS = ['model', 'case', 'share', 'annotations']

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
    const page = target.pathname.slice(folder.length) || PANEL_PAGE
    return sameSite ? page + target.search : PANEL_PAGE
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

/**
 * El visor estuvo en la raiz hasta que el panel ocupo su sitio. Los enlaces
 * antiguos (demo con ?model=, enlaces de doctor con ?share=...) siguen
 * llegando a la raiz: se mandan al visor con la misma query.
 */
export function viewerRedirectUrl(search) {
  const params = new URLSearchParams(search)
  return VIEWER_PARAMS.some((name) => params.has(name)) ? `${VIEWER_PAGE}${search}` : null
}
