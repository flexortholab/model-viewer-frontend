// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Autoguardado de la configuracion de un caso.
 *
 * `schedule()` tras cada cambio: guarda `delayMs` despues del ultimo (un
 * arrastre de marcador da un solo guardado). Si el guardado falla, reintenta
 * cada `retryMs` hasta que funcione; si el caso ya no existe, para.
 *
 * Sin DOM: `save` y los temporizadores se inyectan para poder probarlo con
 * node --test. `save()` devuelve el `_tag` del resultado de la API.
 *
 * Estados (`onStatus`): 'saved', 'pending', 'saving', 'retrying',
 * 'signed-out' (reintentando hasta que haya sesion) y 'gone'.
 */
export function createAutosave({
  save,
  onStatus = () => {},
  delayMs = 1500,
  retryMs = 5000,
  setTimer = (fn, ms) => setTimeout(fn, ms),
  clearTimer = (id) => clearTimeout(id),
}) {
  let timer = null
  let status = 'saved'
  let running = null
  let dirtyAgain = false

  const setStatus = (next) => {
    status = next
    onStatus(next)
  }

  function arm(ms) {
    if (timer !== null) clearTimer(timer)
    timer = setTimer(() => {
      timer = null
      run()
    }, ms)
  }

  async function run() {
    if (status === 'gone') return
    if (running) {
      dirtyAgain = true
      return running
    }
    setStatus('saving')
    running = (async () => {
      let result
      try {
        result = await save()
      } catch {
        result = 'Unavailable'
      }
      running = null
      if (result === 'Saved') {
        if (dirtyAgain) {
          dirtyAgain = false
          setStatus('pending')
          arm(delayMs)
        } else {
          setStatus('saved')
        }
      } else if (result === 'NotFound') {
        setStatus('gone')
      } else {
        dirtyAgain = false
        setStatus(result === 'SignedOut' ? 'signed-out' : 'retrying')
        arm(retryMs)
      }
    })()
    return running
  }

  return {
    /** Hay un cambio: guardar en cuanto pase `delayMs` sin mas cambios. */
    schedule() {
      if (status === 'gone') return
      if (running) dirtyAgain = true
      else setStatus('pending')
      arm(delayMs)
    },

    /** Guardar ya (boton "Guardar", Ctrl+S, deshacer/rehacer). */
    flush() {
      if (timer !== null) {
        clearTimer(timer)
        timer = null
      }
      return run()
    },

    status: () => status,

    /** Hay algo sin guardar: para avisar antes de cerrar la pagina. */
    hasUnsavedChanges: () => status !== 'saved' && status !== 'gone',
  }
}
