// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Historial de deshacer/rehacer de la configuracion de un caso, solo durante
 * la sesion: el servidor guarda unicamente la ultima version (sin historial),
 * asi que al recargar la pagina se empieza de cero.
 *
 * Sin DOM ni limite de pasos. Guarda copias (JSON) para que nadie pueda
 * cambiar un paso desde fuera.
 */

/** Lo que cuenta como contenido del caso: marcadores y medidas. Ver la vista no cuenta. */
export function contentKey(config) {
  return JSON.stringify({ markers: config?.markers ?? [], measurements: config?.measurements ?? [] })
}

export function createCaseHistory(initialConfig) {
  let past = []
  let current = JSON.stringify(initialConfig)
  let future = []

  return {
    /** Nuevo paso si el contenido cambio respecto al actual. Borra lo que se pudiera rehacer. */
    record(config) {
      if (contentKey(config) === contentKey(JSON.parse(current))) return false
      past = [...past, current]
      current = JSON.stringify(config)
      future = []
      return true
    },

    /** Configuracion anterior, o null si no hay. */
    undo() {
      if (past.length === 0) return null
      future = [current, ...future]
      current = past.at(-1)
      past = past.slice(0, -1)
      return JSON.parse(current)
    },

    /** Configuracion deshecha mas reciente, o null si no hay. */
    redo() {
      if (future.length === 0) return null
      past = [...past, current]
      current = future[0]
      future = future.slice(1)
      return JSON.parse(current)
    },

    /** El contenido de `config` es el del paso actual (no hay nada nuevo que guardar). */
    isCurrent: (config) => contentKey(config) === contentKey(JSON.parse(current)),

    canUndo: () => past.length > 0,
    canRedo: () => future.length > 0,
  }
}
