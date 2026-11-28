// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * Portapapeles local para reutilizar trabajo entre casos.
 *
 * El visor se abre por paginas completas (panel -> visor -> otro caso), asi
 * que un portapapeles en memoria se perderia. Se guarda en localStorage del
 * navegador, nunca en el servidor: son coordenadas del modelo, no datos del
 * paciente, pero tampoco hace falta compartirlas.
 *
 * La logica es pura salvo el Storage inyectable, para poder probarla con
 * `node --test`.
 */

export const MEASUREMENTS_KEY = 'visor:portapapeles:medidas'
export const SECTION_KEY = 'visor:portapapeles:corte'
/** Todo el trabajo editable del caso: medidas, corte, marcadores y objetos. */
export const CASE_KEY = 'visor:portapapeles:caso'

const VERSION = 1

function isPoint(value) {
  return Array.isArray(value) &&
    value.length >= 3 &&
    value.slice(0, 3).every((number) => Number.isFinite(number))
}

/** Normaliza una medida importada; null si no es valida. */
export function cleanMeasurement(item) {
  if (!item || !isPoint(item.a) || !isPoint(item.b)) return null
  return {
    a: item.a.slice(0, 3).map(Number),
    b: item.b.slice(0, 3).map(Number),
    note: typeof item.note === 'string' ? item.note : '',
  }
}

/** Normaliza un corte importado; null si no tiene plano valido. */
export function cleanSection(value) {
  if (!value || !isPoint(value.point) || !isPoint(value.normal)) return null
  const normal = value.normal.slice(0, 3).map(Number)
  const length = Math.hypot(...normal)
  if (!length) return null
  return {
    enabled: value.enabled !== false,
    point: value.point.slice(0, 3).map(Number),
    normal: normal.map((number) => number / length),
    mode: typeof value.mode === 'string' ? value.mode : 'pivot',
    capColor: typeof value.capColor === 'string' || typeof value.capColor === 'number'
      ? value.capColor
      : 'auto',
  }
}

function write(key, payload, storage) {
  if (!storage) return false
  try {
    storage.setItem(key, JSON.stringify(payload))
    return true
  } catch {
    return false
  }
}

function read(key, storage) {
  if (!storage) return null
  try {
    const raw = storage.getItem(key)
    return raw ? JSON.parse(raw) : null
  } catch {
    return null
  }
}

/** Guarda las medidas actuales. Devuelve false si no hay ninguna valida. */
export function saveMeasurements(list, storage = globalThis.localStorage) {
  const measurements = (list ?? []).map(cleanMeasurement).filter(Boolean)
  if (!measurements.length) return false
  return write(MEASUREMENTS_KEY, {
    version: VERSION,
    type: 'measurements',
    savedAt: new Date().toISOString(),
    measurements,
  }, storage)
}

/** Medidas copiadas ([] si no hay o el portapapeles esta corrupto). */
export function loadMeasurements(storage = globalThis.localStorage) {
  const data = read(MEASUREMENTS_KEY, storage)
  if (data?.type !== 'measurements' || !Array.isArray(data.measurements)) return []
  return data.measurements.map(cleanMeasurement).filter(Boolean)
}

/** Guarda el corte actual. Devuelve false si no tiene plano valido. */
export function saveSection(section, storage = globalThis.localStorage) {
  const clean = cleanSection(section)
  if (!clean) return false
  return write(SECTION_KEY, {
    version: VERSION,
    type: 'section',
    savedAt: new Date().toISOString(),
    section: clean,
  }, storage)
}

/** Corte copiado, o null si no hay o el portapapeles esta corrupto. */
export function loadSection(storage = globalThis.localStorage) {
  const data = read(SECTION_KEY, storage)
  if (data?.type !== 'section') return null
  return cleanSection(data.section)
}

// Un marcador copiado debe conservar el texto, la clase y su snapshot
// completo (vista, corte, medidas y visibilidad de piezas) tal cual.
const MARKER_KINDS = new Set(['note', 'warning', 'screw'])
const DEFAULT_SECTION = {
  enabled: false,
  capColor: 'auto',
  point: [0, 0, 0],
  normal: [0, 0, 1],
  mode: 'pivot',
}

const vector = (value) => (isPoint(value) ? value.slice(0, 3).map(Number) : null)

function cleanObjects(list) {
  if (!Array.isArray(list)) return []
  const seen = new Set()
  return list
    .filter((item) => item && Number.isInteger(item.index) && item.index >= 0 && !seen.has(item.index))
    .map((item) => {
      seen.add(item.index)
      return { index: item.index, visible: item.visible !== false }
    })
}

function cleanMarker(raw, index) {
  const position = vector(raw?.position)
  if (!position) return null
  const marker = {
    id: typeof raw.id === 'string' && raw.id ? raw.id : `k${index + 1}`,
    position,
    text: String(raw.text ?? ''),
    kind: MARKER_KINDS.has(raw.kind) ? raw.kind : 'note',
  }
  if (raw.view && isPoint(raw.view.position) && isPoint(raw.view.target)) {
    marker.view = {
      position: vector(raw.view.position),
      target: vector(raw.view.target),
    }
    const zoom = Number(raw.view.zoom)
    if (Number.isFinite(zoom) && zoom > 0) marker.view.zoom = zoom
    // Balanceo exacto del paso, si lo trae (los copiados antiguos no).
    const q = raw.view.quaternion
    if (Array.isArray(q) && q.length === 4 && q.every((n) => Number.isFinite(n))) {
      marker.view.quaternion = q.slice(0, 4).map(Number)
    }
  }
  if (raw.section && typeof raw.section === 'object') {
    const snap = { enabled: !!raw.section.enabled }
    if (typeof raw.section.capColor === 'string') snap.capColor = raw.section.capColor
    const point = vector(raw.section.point)
    if (point) snap.point = point
    const normal = vector(raw.section.normal)
    if (normal && Math.hypot(...normal)) snap.normal = normal
    marker.section = snap
  }
  if (Array.isArray(raw.measurements)) {
    marker.measurements = raw.measurements.map(cleanMeasurement).filter(Boolean)
  }
  if (Array.isArray(raw.objects)) marker.objects = cleanObjects(raw.objects)
  return marker
}

/** Normaliza el paquete completo; null si no tiene medidas y marcadores. */
export function cleanBundle(raw) {
  if (!raw || typeof raw !== 'object' ||
      !Array.isArray(raw.measurements) || !Array.isArray(raw.markers)) return null

  const seenIds = new Set()
  const markers = []
  raw.markers.forEach((item, index) => {
    const marker = cleanMarker(item, index)
    if (!marker) return
    if (seenIds.has(marker.id)) marker.id = `${marker.id}_${index + 1}`
    seenIds.add(marker.id)
    markers.push(marker)
  })
  return {
    version: VERSION,
    measurements: raw.measurements.map(cleanMeasurement).filter(Boolean),
    section: cleanSection(raw.section) ?? { ...DEFAULT_SECTION },
    markers,
    objects: cleanObjects(raw.objects),
  }
}

/** Guarda medidas, corte, marcadores y objetos en un solo portapapeles. */
export function saveBundle(bundle, storage = globalThis.localStorage) {
  const clean = cleanBundle(bundle)
  if (!clean) return false
  return write(CASE_KEY, {
    version: VERSION,
    type: 'case',
    savedAt: new Date().toISOString(),
    ...clean,
  }, storage)
}

/** El paquete completo copiado, o null si no hay o esta corrupto. */
export function loadBundle(storage = globalThis.localStorage) {
  const data = read(CASE_KEY, storage)
  if (data?.type !== 'case') return null
  return cleanBundle(data)
}

/**
 * Medidas de `incoming` que no estan ya en `existing`. Considera la misma
 * cota tambien con los extremos invertidos, que es como puede quedar tras
 * editar un extremo en el otro caso.
 *
 * @param {Array<{a:number[],b:number[]}>} existing
 * @param {Array<{a:number[],b:number[]}>} incoming
 * @param {number} tolerance mm
 */
export function mergeMeasurements(existing, incoming, tolerance = 1e-4) {
  const samePoint = (p, q) =>
    Math.abs(p[0] - q[0]) <= tolerance &&
    Math.abs(p[1] - q[1]) <= tolerance &&
    Math.abs(p[2] - q[2]) <= tolerance
  const sameMeasurement = (known, item) =>
    (samePoint(known.a, item.a) && samePoint(known.b, item.b)) ||
    (samePoint(known.a, item.b) && samePoint(known.b, item.a))

  const known = (existing ?? []).map(cleanMeasurement).filter(Boolean)
  const added = []
  for (const raw of incoming ?? []) {
    const item = cleanMeasurement(raw)
    if (!item) continue
    if (known.some((other) => sameMeasurement(other, item))) continue
    if (added.some((other) => sameMeasurement(other, item))) continue
    added.push(item)
  }
  return added
}
