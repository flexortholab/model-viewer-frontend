// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Presentacion de los casos del panel, sin DOM para poder probarla.
 */


/** Lo ultimo tocado, primero. */
export function sortCases(cases) {
  return [...cases].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
}

const dateFormat = new Intl.DateTimeFormat('es-ES', {
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  timeZone: 'Europe/Madrid',
})

/** Fecha ISO de la API en hora de Madrid, p. ej. "05/10/2026, 12:30". */
export function formatDate(iso) {
  const time = Date.parse(iso)
  return Number.isFinite(time) ? dateFormat.format(time) : ''
}

export const MAX_CASE_NAME_LENGTH = 200
export const MAX_MODEL_SIZE_BYTES = 500 * 1024 * 1024

/** Tamano legible en MB con coma decimal, p. ej. "14,2 MB". */
export function formatSize(bytes) {
  return `${(bytes / (1024 * 1024)).toLocaleString('es-ES', { maximumFractionDigits: 1 })} MB`
}

/**
 * Comprueba el formulario de caso nuevo antes de llamar a la API, con los
 * mismos limites que el backend. `file` solo necesita `name` y `size`.
 */
export function validateNewCase({ name, file }) {
  const trimmed = String(name ?? '').trim()
  if (!trimmed) return { _tag: 'Invalid', message: 'Escribe el nombre del caso.' }
  if (trimmed.length > MAX_CASE_NAME_LENGTH)
    return { _tag: 'Invalid', message: `El nombre no puede pasar de ${MAX_CASE_NAME_LENGTH} caracteres.` }
  if (!file) return { _tag: 'Invalid', message: 'Elige el modelo GLB.' }
  if (!/\.glb$/i.test(file.name)) return { _tag: 'Invalid', message: 'El modelo tiene que ser un fichero .glb.' }
  if (!(file.size > 0)) return { _tag: 'Invalid', message: 'El fichero está vacío.' }
  if (file.size > MAX_MODEL_SIZE_BYTES)
    return { _tag: 'Invalid', message: `El modelo pesa ${formatSize(file.size)}; el máximo es ${formatSize(MAX_MODEL_SIZE_BYTES)}.` }
  return { _tag: 'Valid', name: trimmed, sizeBytes: file.size }
}

/** Limite de la configuracion de un caso en la API, en bytes de JSON en UTF-8. */
export const MAX_CONFIG_BYTES = 350_000

export function configBytes(config) {
  return new TextEncoder().encode(JSON.stringify(config)).length
}

/** Pagina del visor que abre un caso del panel para editarlo. */
export function caseEditorUrl(caseId) {
  return `viewer.html?case=${encodeURIComponent(caseId)}`
}

/**
 * URL completa del enlace del doctor. La API devuelve `sharePath` relativo a
 * la carpeta del frontend (`?share=<id>`); se resuelve contra la pagina
 * actual para que funcione igual en GitHub Pages que en local.
 */
export function doctorLinkUrl(sharePath, pageUrl) {
  return new URL(sharePath, new URL('./', pageUrl)).href
}

/** Texto del boton de enlace segun el estado del caso. */
export function shareActionLabel(status) {
  return status === 'linked' ? 'Copiar enlace' : 'Generar enlace'
}
