// SPDX-License-Identifier: GPL-3.0-or-later
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { formatDate, sortCases, statusLabel } from '../src/cases.js'

test('los estados de la API se muestran en espanol', () => {
  assert.equal(statusLabel('draft'), 'Borrador')
  assert.equal(statusLabel('linked'), 'Enlace generado')
})

test('los casos se ordenan por ultima actualizacion, sin tocar la lista original', () => {
  const cases = [
    { id: 'viejo', updatedAt: '2026-10-01T10:00:00.000Z' },
    { id: 'nuevo', updatedAt: '2026-10-05T10:00:00.000Z' },
  ]
  const original = structuredClone(cases)

  assert.deepEqual(sortCases(cases).map((c) => c.id), ['nuevo', 'viejo'])
  assert.deepEqual(cases, original)
})

test('las fechas se muestran en hora de Madrid', () => {
  assert.equal(formatDate('2026-10-05T10:30:00.000Z'), '05/10/2026, 12:30')
})

test('una fecha invalida no rompe la lista', () => {
  assert.equal(formatDate('no-es-fecha'), '')
})
