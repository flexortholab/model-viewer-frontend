// SPDX-License-Identifier: GPL-3.0-or-later
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { contentKey, createCaseHistory } from '../src/case-history.js'

const config = (...texts) => ({ version: 1, markers: texts.map((text, i) => ({ id: `k${i}`, text })), measurements: [] })

test('deshacer vuelve al paso anterior y rehacer al siguiente', () => {
  const history = createCaseHistory(config())
  history.record(config('a'))
  history.record(config('a', 'b'))

  assert.deepEqual(history.undo(), config('a'))
  assert.deepEqual(history.undo(), config())
  assert.equal(history.undo(), null)
  assert.deepEqual(history.redo(), config('a'))
  assert.deepEqual(history.redo(), config('a', 'b'))
  assert.equal(history.redo(), null)
})

test('no hay limite de pasos', () => {
  const history = createCaseHistory(config())
  for (let i = 1; i <= 200; i++) history.record(config(...Array.from({ length: i }, (_, j) => `m${j}`)))
  let steps = 0
  while (history.undo()) steps++

  assert.equal(steps, 200)
})

test('un cambio nuevo despues de deshacer borra lo que se podia rehacer', () => {
  const history = createCaseHistory(config())
  history.record(config('a'))
  history.undo()
  history.record(config('b'))

  assert.equal(history.canRedo(), false)
  assert.deepEqual(history.undo(), config())
})

test('un cambio solo de vista (corte, piezas) no es un paso', () => {
  const history = createCaseHistory(config('a'))

  assert.equal(history.record({ ...config('a'), section: { enabled: true } }), false)
  assert.equal(history.canUndo(), false)
})

test('los pasos son copias: cambiar el objeto guardado no cambia el historial', () => {
  const history = createCaseHistory(config())
  const step = config('a')
  history.record(step)
  history.record(config('a', 'b'))
  step.markers[0].text = 'cambiado'

  assert.deepEqual(history.undo(), config('a'))
})

test('la clave de contenido ignora todo salvo marcadores y medidas', () => {
  assert.equal(contentKey({ markers: [], measurements: [], section: { enabled: true } }), contentKey({}))
})

test('isCurrent compara solo el contenido con el paso actual', () => {
  const history = createCaseHistory(config('a'))

  assert.equal(history.isCurrent({ ...config('a'), section: { enabled: true } }), true)
  assert.equal(history.isCurrent(config('b')), false)
})
