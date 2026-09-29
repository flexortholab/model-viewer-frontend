/**
 * Puente postMessage para embeber el visor en un webclip.
 *
 * Protocolo (ventana padre -> visor):
 *   { source: 'dental-viewer-host', action: 'load'|'section'|'measure'|..., payload: {} }
 *
 * Protocolo (visor -> ventana padre):
 *   { source: 'dental-viewer', protocol: 1, event: 'ready'|'loaded'|'changed'|'error', payload: {} }
 *
 * Uso desde la plataforma:
 *   iframe.contentWindow.postMessage(
 *     { source: 'dental-viewer-host', action: 'load', payload: { model: '/casos/123.glb' } },
 *     'https://visor.midominio.com',
 *   )
 */

export const HOST_SOURCE = 'dental-viewer-host'
export const VIEWER_SOURCE = 'dental-viewer'
export const PROTOCOL_VERSION = 1

function originOf(url) {
  try {
    return new URL(url, window.location.href).origin
  } catch {
    return null
  }
}

export function createBridge({
  target = window.parent,
  targetOrigin = '*',
  allowedOrigins = [],
  onCommand,
} = {}) {
  const isEmbedded = window.parent !== window

  // Por defecto solo aceptamos mensajes de la pagina que nos embebio
  // (referrer) o de la misma pagina. Anade origenes con allowedOrigins.
  const parentOrigin = document.referrer ? originOf(document.referrer) : null
  const selfOrigin = window.location.origin
  const accepted = new Set(
    [parentOrigin, selfOrigin, ...allowedOrigins].filter(Boolean),
  )
  const strict = isEmbedded && accepted.size > 0

  const post = (event, payload = {}) => {
    if (!isEmbedded) return
    const destination = targetOrigin !== '*' ? targetOrigin : parentOrigin || '*'
    target.postMessage({ source: VIEWER_SOURCE, protocol: PROTOCOL_VERSION, event, payload }, destination)
  }

  function handleMessage(event) {
    if (event.source !== window.parent && event.source !== window) return
    if (strict && !accepted.has(event.origin)) return
    const data = event.data
    if (!data || typeof data !== 'object') return
    if (data.source !== HOST_SOURCE) return
    onCommand?.(data.action, data.payload ?? {}, { origin: event.origin })
  }

  window.addEventListener('message', handleMessage)

  return {
    isEmbedded,
    post,
    ready: () => post('ready', { version: PROTOCOL_VERSION, embedded: isEmbedded }),
    loaded: (info) => post('loaded', info),
    changed: (doc) => post('changed', { annotations: doc }),
    error: (error) => post('error', { message: String(error?.message ?? error) }),
    log: (level, message) => post('log', { level, message }),
    dispose: () => window.removeEventListener('message', handleMessage),
  }
}
