// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Presentacion de los casos del panel, sin DOM para poder probarla.
 */


/** Orden por defecto: lo ultimo tocado, primero. Lista de criterios: principal y secundario. */
export const DEFAULT_SORT = [{ key: 'updatedAt', direction: 'desc' }]

const nameCollator = new Intl.Collator('es', { sensitivity: 'base', numeric: true })

const COMPARATORS = {
  name: (a, b) => nameCollator.compare(a.name, b.name),
  createdAt: (a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt),
  updatedAt: (a, b) => Date.parse(a.updatedAt) - Date.parse(b.updatedAt),
  linkGeneratedAt: (a, b) => Date.parse(a.linkGeneratedAt) - Date.parse(b.linkGeneratedAt),
}

const hasLink = (c) => Number.isFinite(Date.parse(c.linkGeneratedAt))

/** Comparacion por un criterio. Los casos sin enlace van siempre al final al ordenar por enlace. */
function compareBy({ key, direction }, a, b) {
  if (key === 'linkGeneratedAt' && hasLink(a) !== hasLink(b)) return hasLink(a) ? -1 : 1
  if (key === 'linkGeneratedAt' && !hasLink(a)) return 0
  const compare = COMPARATORS[key] ?? COMPARATORS.updatedAt
  return (direction === 'asc' ? 1 : -1) * compare(a, b)
}

/**
 * Casos ordenados por uno o varios criterios `{ key, direction }`: el primero
 * manda y los siguientes desempatan. `key` es 'name', 'createdAt',
 * 'updatedAt' o 'linkGeneratedAt'; `direction`, 'asc' o 'desc'. No toca la
 * lista original.
 */
export function sortCases(cases, sort = DEFAULT_SORT) {
  const criteria = Array.isArray(sort) ? sort : [sort]
  return [...cases].sort((a, b) => {
    for (const criterion of criteria) {
      const result = compareBy(criterion, a, b)
      if (result !== 0) return result
    }
    return 0
  })
}

/**
 * Orden tras pulsar la cabecera `key`. Si ya es la principal, invierte su
 * sentido. Si no, pasa a ser la principal (en su sentido natural: nombre de
 * la A a la Z, fechas de la mas reciente a la mas antigua) y la principal
 * anterior queda como secundaria.
 */
export function nextSort(current, key) {
  const [primary] = current
  if (primary?.key === key) {
    return [{ key, direction: primary.direction === 'asc' ? 'desc' : 'asc' }, ...current.slice(1)]
  }
  const natural = { key, direction: key === 'name' ? 'asc' : 'desc' }
  return primary ? [natural, primary] : [natural]
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

/**
 * Pide paginas seguidas hasta reunir al menos `minResults` casos, quedarse
 * sin paginas o llegar a `maxPages`. Con la busqueda, una pagina puede venir
 * vacia aunque haya resultados mas adelante. Devuelve el primer resultado que
 * no sea una pagina de casos (sesion caducada, error) tal cual.
 */
export async function collectPages(fetchPage, { cursor = null, minResults = 1, maxPages = 10 } = {}) {
  let cases = []
  let next = cursor
  for (let page = 0; page < maxPages; page++) {
    const result = await fetchPage(next)
    if (result._tag !== 'Cases') return result
    cases = [...cases, ...result.cases]
    next = result.nextCursor
    if (!next || cases.length >= minResults) break
  }
  return { _tag: 'Cases', cases, nextCursor: next }
}
