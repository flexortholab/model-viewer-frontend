// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Presentacion de los casos del panel, sin DOM para poder probarla.
 */


/** Orden por defecto: lo ultimo tocado, primero. */
export const DEFAULT_SORT = { key: 'updatedAt', direction: 'desc' }

const nameCollator = new Intl.Collator('es', { sensitivity: 'base', numeric: true })

const COMPARATORS = {
  name: (a, b) => nameCollator.compare(a.name, b.name),
  updatedAt: (a, b) => Date.parse(a.updatedAt) - Date.parse(b.updatedAt),
  linkGeneratedAt: (a, b) => Date.parse(a.linkGeneratedAt) - Date.parse(b.linkGeneratedAt),
}

/**
 * Casos ordenados por `key` ('name', 'updatedAt' o 'linkGeneratedAt') en
 * `direction` ('asc' o 'desc'), sin tocar la lista original. Los casos sin
 * enlace van siempre al final al ordenar por enlace.
 */
export function sortCases(cases, { key, direction } = DEFAULT_SORT) {
  const compare = COMPARATORS[key] ?? COMPARATORS.updatedAt
  const sign = direction === 'asc' ? 1 : -1
  const hasLink = (c) => Number.isFinite(Date.parse(c.linkGeneratedAt))
  return [...cases].sort((a, b) => {
    if (key === 'linkGeneratedAt' && hasLink(a) !== hasLink(b)) return hasLink(a) ? -1 : 1
    return sign * compare(a, b)
  })
}

/** Siguiente orden al pulsar la cabecera `key`: la misma invierte; otra empieza en su sentido natural. */
export function nextSort(current, key) {
  if (current.key === key) return { key, direction: current.direction === 'asc' ? 'desc' : 'asc' }
  return { key, direction: key === 'name' ? 'asc' : 'desc' }
}

const DATE_OPTIONS = {
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
}

/**
 * Fecha ISO de la API en la zona horaria del navegador, p. ej. "05/10/2026, 12:30".
 * `timeZone` solo para fijarla en los tests.
 */
export function formatDate(iso, { timeZone } = {}) {
  const time = Date.parse(iso)
  return Number.isFinite(time) ? new Intl.DateTimeFormat('es-ES', { ...DATE_OPTIONS, timeZone }).format(time) : ''
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
