// SPDX-License-Identifier: GPL-3.0-or-later
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { formatDate, formatSize, sortCases, statusLabel, validateNewCase } from '../src/cases.js'

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

const glb = (size, name = 'modelo.glb') => ({ name, size })

test('un caso nuevo valido devuelve el nombre recortado y el tamano exacto', () => {
  assert.deepEqual(validateNewCase({ name: '  García  ', file: glb(14_000_000) }), {
    _tag: 'Valid',
    name: 'García',
    sizeBytes: 14_000_000,
  })
})

test('un caso nuevo exige nombre, dentro del limite', () => {
  assert.equal(validateNewCase({ name: '   ', file: glb(1) })._tag, 'Invalid')
  assert.equal(validateNewCase({ name: 'x'.repeat(201), file: glb(1) })._tag, 'Invalid')
  assert.equal(validateNewCase({ name: 'x'.repeat(200), file: glb(1) })._tag, 'Valid')
})

test('un caso nuevo exige un .glb no vacio de hasta 500 MB', () => {
  assert.equal(validateNewCase({ name: 'Caso', file: undefined })._tag, 'Invalid')
  assert.equal(validateNewCase({ name: 'Caso', file: glb(1, 'modelo.stl') })._tag, 'Invalid')
  assert.equal(validateNewCase({ name: 'Caso', file: glb(0) })._tag, 'Invalid')
  assert.equal(validateNewCase({ name: 'Caso', file: glb(500 * 1024 * 1024 + 1) })._tag, 'Invalid')
  assert.equal(validateNewCase({ name: 'Caso', file: glb(500 * 1024 * 1024, 'MODELO.GLB') })._tag, 'Valid')
})

test('los tamanos se muestran en MB con coma decimal', () => {
  assert.equal(formatSize(14.2 * 1024 * 1024), '14,2 MB')
})
