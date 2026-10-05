// SPDX-License-Identifier: GPL-3.0-or-later
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createAutosave } from '../src/autosave.js'

/** Temporizadores manuales: `tick()` dispara los pendientes. */
function manualTimers() {
  const pending = new Map()
  let next = 1
  return {
    setTimer: (fn, ms) => {
      const id = next++
      pending.set(id, { fn, ms })
      return id
    },
    clearTimer: (id) => pending.delete(id),
    delays: () => [...pending.values()].map((t) => t.ms),
    tick: async () => {
      const due = [...pending.entries()]
      pending.clear()
      for (const [, t] of due) await t.fn()
    },
  }
}

function autosaveWith(results) {
  const timers = manualTimers()
  const statuses = []
  let saves = 0
  const autosave = createAutosave({
    save: async () => results[Math.min(saves++, results.length - 1)],
    onStatus: (s) => statuses.push(s),
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
  })
  return { autosave, timers, statuses, saves: () => saves }
}

test('varios cambios seguidos dan un solo guardado', async () => {
  const { autosave, timers, saves } = autosaveWith(['Saved'])
  autosave.schedule()
  autosave.schedule()
  autosave.schedule()

  assert.deepEqual(timers.delays(), [1500])
  await timers.tick()
  assert.equal(saves(), 1)
  assert.equal(autosave.status(), 'saved')
})

test('mientras no se guarda hay cambios pendientes', () => {
  const { autosave, statuses } = autosaveWith(['Saved'])
  autosave.schedule()

  assert.deepEqual(statuses, ['pending'])
  assert.equal(autosave.hasUnsavedChanges(), true)
})

test('si falla, reintenta a los 5 segundos hasta que funciona', async () => {
  const { autosave, timers, statuses } = autosaveWith(['Failed', 'Failed', 'Saved'])
  autosave.schedule()
  await timers.tick()

  assert.equal(autosave.status(), 'retrying')
  assert.deepEqual(timers.delays(), [5000])
  await timers.tick()
  await timers.tick()
  assert.equal(autosave.status(), 'saved')
  assert.deepEqual(statuses, ['pending', 'saving', 'retrying', 'saving', 'retrying', 'saving', 'saved'])
})

test('una excepcion de red cuenta como fallo y se reintenta', async () => {
  const timers = manualTimers()
  const autosave = createAutosave({
    save: async () => {
      throw new TypeError('Failed to fetch')
    },
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
  })
  autosave.schedule()
  await timers.tick()

  assert.equal(autosave.status(), 'retrying')
})

test('sin sesion sigue reintentando, por si se entra en otra pestana', async () => {
  const { autosave, timers } = autosaveWith(['SignedOut', 'Saved'])
  autosave.schedule()
  await timers.tick()

  assert.equal(autosave.status(), 'signed-out')
  await timers.tick()
  assert.equal(autosave.status(), 'saved')
})

test('si el caso ya no existe, deja de intentarlo', async () => {
  const { autosave, timers } = autosaveWith(['NotFound'])
  autosave.schedule()
  await timers.tick()
  autosave.schedule()

  assert.equal(autosave.status(), 'gone')
  assert.deepEqual(timers.delays(), [])
  assert.equal(autosave.hasUnsavedChanges(), false)
})

test('flush guarda ya, sin esperar', async () => {
  const { autosave, timers, saves } = autosaveWith(['Saved'])
  autosave.schedule()
  await autosave.flush()

  assert.equal(saves(), 1)
  assert.deepEqual(timers.delays(), [])
})

test('un cambio durante un guardado provoca otro guardado al terminar', async () => {
  const timers = manualTimers()
  let release
  let saves = 0
  const autosave = createAutosave({
    save: () => {
      saves++
      return saves === 1 ? new Promise((resolve) => (release = () => resolve('Saved'))) : Promise.resolve('Saved')
    },
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
  })
  const first = autosave.flush()
  autosave.schedule()
  release()
  await first
  await timers.tick()

  assert.equal(saves, 2)
  assert.equal(autosave.status(), 'saved')
})
