// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Utilidades comunes de las pruebas del visor en navegador.
 *
 * `test` anade a cada prueba la recogida de errores de consola y de
 * excepciones sin capturar (al final se comprueba que no hay ninguna) y, en
 * el perfil de portatil tactil, fija navigator.maxTouchPoints = 10 antes de
 * que cargue la pagina, como en un portatil Windows con pantalla tactil.
 */
import { test as base, expect } from '@playwright/test'

export { expect }

export const STL = 'samples/disyuntor-4-pilares.stl'
export const GLB = 'samples/Test1.glb'

export const test = base.extend({
  consola: [
    async ({ page }, use, testInfo) => {
      if (perfil(testInfo) === 'portatil-tactil') {
        await page.addInitScript(() => {
          Object.defineProperty(Navigator.prototype, 'maxTouchPoints', { get: () => 10 })
        })
      }
      const consola = { errores: [], excepciones: [] }
      page.on('console', (message) => {
        if (message.type() === 'error') consola.errores.push(`${message.text()} [${message.location().url}]`)
      })
      page.on('pageerror', (error) => consola.excepciones.push(error.message))
      await use(consola)
      check('sin errores en consola', consola.errores.length === 0, consola.errores.join(' | ') || 'ninguno')
      check('sin excepciones sin capturar', consola.excepciones.length === 0, consola.excepciones.join(' | ') || 'ninguna')
    },
    { auto: true },
  ],
})

/** Perfil del proyecto: escritorio, portatil-tactil, tablet o movil. */
export function perfil(testInfo) {
  return testInfo.project.metadata.perfil
}

export const esMovil = (testInfo) => perfil(testInfo) === 'movil'

/**
 * Una comprobacion del smoke antiguo (scripts/smoke.mjs), con el mismo
 * nombre para poder compararlas. Es blanda: si falla, la prueba sigue y
 * informa de todas las que fallen, como hacia el smoke.
 */
export function check(name, ok, detail = '') {
  expect.soft(ok, detail ? `${name} — ${detail}` : name).toBe(true)
}

/** Espera a que el visor tenga un modelo cargado (hasta `ms`). */
export async function esperarModelo(page, ms = 60_000) {
  return page.waitForFunction(() => !!window.dentalViewer?.model, null, { timeout: ms, polling: 200 })
    .then(() => true)
}

/** Abre el visor con un modelo de ejemplo y espera a que cargue. */
export async function abrirVisor(page, modelo = STL) {
  await page.goto(`/viewer.html?model=${modelo}&embed=0`)
  return esperarModelo(page)
}

/**
 * Pixeles del lienzo WebGL que no son el fondo blanco. El renderer usa
 * preserveDrawingBuffer, asi que el lienzo se puede leer tras pintar.
 */
export function pixelesPintados(page) {
  return page.evaluate(() => {
    const v = window.dentalViewer
    v.renderer.render(v.scene, v.camera)
    const src = v.renderer.domElement
    const copia = document.createElement('canvas')
    copia.width = src.width
    copia.height = src.height
    const ctx = copia.getContext('2d')
    ctx.drawImage(src, 0, 0)
    const px = ctx.getImageData(0, 0, copia.width, copia.height).data
    let pintados = 0
    for (let i = 0; i < px.length; i += 4) {
      if (px[i] < 235 || px[i + 1] < 235 || px[i + 2] < 235) pintados++
    }
    return { pintados, total: px.length / 4 }
  })
}
