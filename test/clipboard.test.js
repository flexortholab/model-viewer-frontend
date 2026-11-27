// SPDX-License-Identifier: GPL-3.0-or-later
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  MEASUREMENTS_KEY,
  SECTION_KEY,
  CASE_KEY,
  cleanMeasurement,
  cleanSection,
  loadBundle,
  loadMeasurements,
  loadSection,
  mergeMeasurements,
  saveBundle,
  saveMeasurements,
  saveSection,
} from '../src/clipboard.js'

function memoria() {
  const datos = new Map()
  return {
    datos,
    getItem: (key) => datos.get(key) ?? null,
    setItem: (key, value) => datos.set(key, String(value)),
  }
}

const medida = (a, b, note = '') => ({ a, b, note })

test('las medidas se guardan y se recuperan del portapapeles', () => {
  const storage = memoria()
  assert.equal(saveMeasurements([medida([1, 2, 3], [4, 5, 6], 'ancho')], storage), true)
  assert.deepEqual(loadMeasurements(storage), [medida([1, 2, 3], [4, 5, 6], 'ancho')])
  assert.ok(storage.datos.has(MEASUREMENTS_KEY))
})

test('sin medidas validas no se guarda nada', () => {
  const storage = memoria()
  assert.equal(saveMeasurements([], storage), false)
  assert.equal(saveMeasurements([{ a: [1, 2], b: [3, 4, 5] }], storage), false)
  assert.equal(loadMeasurements(storage).length, 0)
})

test('un portapapeles corrupto no rompe el visor', () => {
  const storage = memoria()
  storage.setItem(MEASUREMENTS_KEY, '{no es json')
  assert.deepEqual(loadMeasurements(storage), [])
  storage.setItem(SECTION_KEY, 'null')
  assert.equal(loadSection(storage), null)
  assert.equal(saveMeasurements([medida([0, 0, 0], [1, 1, 1])], null), false)
})

test('pegar no duplica cotas, tambien con los extremos invertidos', () => {
  const existentes = [medida([0, 0, 0], [10, 0, 0])]
  const nuevas = [
    medida([0, 0, 0], [10, 0, 0]), // la misma
    medida([10, 0, 0], [0, 0, 0]), // invertida
    medida([0, 0, 0], [10, 0, 0.1]), // otra distinta
    medida([1, 1, 1], [2, 2, 2]),
  ]
  assert.deepEqual(mergeMeasurements(existentes, nuevas), [
    medida([0, 0, 0], [10, 0, 0.1]),
    medida([1, 1, 1], [2, 2, 2]),
  ])
})

test('pegar entre medidas repetidas de la misma copia deja una', () => {
  const nuevas = [medida([1, 2, 3], [4, 5, 6]), medida([1, 2, 3], [4, 5, 6])]
  assert.equal(mergeMeasurements([], nuevas).length, 1)
})

test('las medidas importadas se normalizan y se descartan las invalidas', () => {
  assert.deepEqual(cleanMeasurement(medida([1, 2, 3, 99], [4, 5, 6], 7)), medida([1, 2, 3], [4, 5, 6]))
  assert.equal(cleanMeasurement({ a: ['1', 2, 3], b: [4, 5, 6] }), null)
  assert.equal(cleanMeasurement(null), null)
})

test('el corte se guarda y se recupera normalizando la normal', () => {
  const storage = memoria()
  const corte = {
    enabled: true,
    point: [1, 2, 3],
    normal: [0, 0, 5],
    mode: 'pivot',
    capColor: 'auto',
  }
  assert.equal(saveSection(corte, storage), true)
  assert.deepEqual(loadSection(storage), { ...corte, normal: [0, 0, 1] })
})

test('un corte sin plano no se guarda', () => {
  const storage = memoria()
  assert.equal(saveSection({ enabled: true, point: [0, 0, 0], normal: [0, 0, 0] }, storage), false)
  assert.equal(cleanSection({ point: [0, 0, 0] }), null)
  assert.equal(loadSection(storage), null)
})

const caso = () => ({
  measurements: [medida([1, 2, 3], [4, 5, 6], 'ancho')],
  section: { enabled: true, point: [0, 0, 2], normal: [0, 0, 1], mode: 'pivot', capColor: 'auto' },
  objects: [{ index: 0, visible: false }, { index: 1, visible: true }],
  markers: [
    {
      id: 'k1',
      position: [1, 0, 0],
      text: 'Tornillo derecho',
      kind: 'screw',
      view: { position: [30, 3, 3], target: [1, 2, 0], quaternion: [0.1, 0.2, 0.3, 0.927], zoom: 2.5 },
      section: { enabled: true, point: [0, 2, 0], normal: [0, 1, 0] },
      measurements: [medida([0, 0, 0], [2, 0, 0], 'paso')],
      objects: [{ index: 0, visible: true }, { index: 1, visible: false }],
    },
    { id: 'k2', position: [2, 0, 0], text: 'Revisar', kind: 'note' },
  ],
})

test('el portapapeles del caso guarda medidas, corte, marcadores y objetos', () => {
  const storage = memoria()
  const original = caso()
  assert.equal(saveBundle(original, storage), true)
  assert.ok(storage.datos.has(CASE_KEY))
  const cargado = loadBundle(storage)
  assert.deepEqual(cargado.measurements, original.measurements)
  assert.deepEqual(cargado.section, original.section)
  assert.deepEqual(cargado.objects, original.objects)
  assert.equal(cargado.markers.length, 2)
  assert.equal(cargado.markers[0].text, 'Tornillo derecho')
  assert.equal(cargado.markers[0].kind, 'screw')
  assert.deepEqual(cargado.markers[0].view, original.markers[0].view)
  assert.deepEqual(cargado.markers[0].section, original.markers[0].section)
  assert.deepEqual(cargado.markers[0].measurements, original.markers[0].measurements)
  assert.deepEqual(cargado.markers[0].objects, original.markers[0].objects)
})

test('el paquete del caso descarta marcadores invalidos y repite ids', () => {
  const storage = memoria()
  const bundle = caso()
  bundle.markers[1].id = 'k1'
  bundle.markers.push({ position: [1, 2] }) // sin posicion valida
  saveBundle(bundle, storage)
  const cargado = loadBundle(storage)
  assert.equal(cargado.markers.length, 2)
  assert.notEqual(cargado.markers[0].id, cargado.markers[1].id)
})

test('un paquete corrupto o incompleto no se pega', () => {
  const storage = memoria()
  storage.setItem(CASE_KEY, '{mal')
  assert.equal(loadBundle(storage), null)
  assert.equal(saveBundle({ measurements: [] }, storage), false)
  assert.equal(saveBundle(null, null), false)
})

test('el paquete sin corte valido usa un plano neutro', () => {
  const storage = memoria()
  saveBundle({ measurements: [], markers: [], section: { point: [0, 0, 0], normal: [0, 0, 0] } }, storage)
  assert.deepEqual(loadBundle(storage).section, {
    enabled: false,
    capColor: 'auto',
    point: [0, 0, 0],
    normal: [0, 0, 1],
    mode: 'pivot',
  })
})
