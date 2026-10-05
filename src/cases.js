// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Presentacion de los casos del panel, sin DOM para poder probarla.
 */

const STATUS_LABELS = {
  draft: 'Borrador',
  linked: 'Enlace generado',
}

export function statusLabel(status) {
  return STATUS_LABELS[status] ?? status
}

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
