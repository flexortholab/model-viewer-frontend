// SPDX-License-Identifier: GPL-3.0-or-later
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { caseEditorUrl, configBytes, doctorLinkUrl, formatDate, formatSize, nextSort, shareActionLabel, sortCases, validateNewCase } from '../src/cases.js'

test('los casos se ordenan por ultima actualizacion, sin tocar la lista original', () => {
  const cases = [
    { id: 'viejo', updatedAt: '2026-10-01T10:00:00.000Z' },
    { id: 'nuevo', updatedAt: '2026-10-05T10:00:00.000Z' },
  ]
  const original = structuredClone(cases)

  assert.deepEqual(sortCases(cases).map((c) => c.id), ['nuevo', 'viejo'])
  assert.deepEqual(cases, original)
})

test('las fechas se muestran en la zona horaria pedida', () => {
  assert.equal(formatDate('2026-10-05T10:30:00.000Z', { timeZone: 'Europe/Madrid' }), '05/10/2026, 12:30')
  assert.equal(formatDate('2026-10-05T10:30:00.000Z', { timeZone: 'Europe/London' }), '05/10/2026, 11:30')
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

test('el tamano de la configuracion se mide en bytes UTF-8, como en la API', () => {
  assert.equal(configBytes({ a: 'ñ' }), JSON.stringify({ a: 'ñ' }).length + 1)
})

test('la URL del editor lleva el id del caso codificado', () => {
  assert.equal(caseEditorUrl('2f0c4b9e-1c7a'), 'viewer.html?case=2f0c4b9e-1c7a')
  assert.equal(caseEditorUrl('a&b'), 'viewer.html?case=a%26b')
})

test('el enlace del doctor se resuelve contra la carpeta del frontend', () => {
  assert.equal(
    doctorLinkUrl('?share=abc', 'https://flexortholab.github.io/model-viewer-frontend/'),
    'https://flexortholab.github.io/model-viewer-frontend/?share=abc',
  )
  assert.equal(doctorLinkUrl('?share=abc', 'http://localhost:5173/'), 'http://localhost:5173/?share=abc')
})

test('el boton de enlace genera en un borrador y copia si ya lo hay', () => {
  assert.equal(shareActionLabel('draft'), 'Generar enlace')
  assert.equal(shareActionLabel('linked'), 'Copiar enlace')
})

const sample = [
  { id: 'b', name: 'Óscar', updatedAt: '2026-10-02T10:00:00.000Z', linkGeneratedAt: '2026-10-02T09:00:00.000Z' },
  { id: 'a', name: 'alba', updatedAt: '2026-10-03T10:00:00.000Z' },
  { id: 'c', name: 'Caso 10', updatedAt: '2026-10-01T10:00:00.000Z', linkGeneratedAt: '2026-10-04T09:00:00.000Z' },
  { id: 'd', name: 'Caso 9', updatedAt: '2026-10-04T10:00:00.000Z' },
]
const ids = (cases) => cases.map((c) => c.id)

test('por nombre ignora tildes y mayusculas y ordena los numeros como numeros', () => {
  assert.deepEqual(ids(sortCases(sample, { key: 'name', direction: 'asc' })), ['a', 'd', 'c', 'b'])
})

test('por nombre descendente invierte el orden', () => {
  assert.deepEqual(ids(sortCases(sample, { key: 'name', direction: 'desc' })), ['b', 'c', 'd', 'a'])
})

test('por enlace, los casos sin enlace van al final en los dos sentidos', () => {
  assert.deepEqual(ids(sortCases(sample, { key: 'linkGeneratedAt', direction: 'desc' })), ['c', 'b', 'a', 'd'])
  assert.deepEqual(ids(sortCases(sample, { key: 'linkGeneratedAt', direction: 'asc' })), ['b', 'c', 'a', 'd'])
})

test('pulsar la cabecera principal invierte su sentido y conserva la secundaria', () => {
  const current = [{ key: 'name', direction: 'asc' }, { key: 'createdAt', direction: 'desc' }]

  assert.deepEqual(nextSort(current, 'name'), [{ key: 'name', direction: 'desc' }, { key: 'createdAt', direction: 'desc' }])
})

test('pulsar otra cabecera la hace principal en su sentido natural y la anterior pasa a secundaria', () => {
  assert.deepEqual(nextSort([{ key: 'createdAt', direction: 'desc' }], 'name'), [
    { key: 'name', direction: 'asc' },
    { key: 'createdAt', direction: 'desc' },
  ])
  assert.deepEqual(nextSort([{ key: 'name', direction: 'asc' }, { key: 'createdAt', direction: 'desc' }], 'linkGeneratedAt'), [
    { key: 'linkGeneratedAt', direction: 'desc' },
    { key: 'name', direction: 'asc' },
  ])
})

test('el criterio secundario desempata al principal', () => {
  const sameName = [
    { id: 'viejo', name: 'García', createdAt: '2026-10-01T10:00:00.000Z' },
    { id: 'nuevo', name: 'garcia', createdAt: '2026-10-05T10:00:00.000Z' },
    { id: 'otro', name: 'Alba', createdAt: '2026-10-03T10:00:00.000Z' },
  ]

  assert.deepEqual(ids(sortCases(sameName, [{ key: 'name', direction: 'asc' }, { key: 'createdAt', direction: 'desc' }])), ['otro', 'nuevo', 'viejo'])
  assert.deepEqual(ids(sortCases(sameName, [{ key: 'name', direction: 'asc' }, { key: 'createdAt', direction: 'asc' }])), ['otro', 'viejo', 'nuevo'])
})
