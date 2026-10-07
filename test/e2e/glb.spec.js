// SPDX-License-Identifier: GPL-3.0-or-later
// Modelo GLB decimado: carga sin errores y con un numero de triangulos que
// un movil aguanta.
import { test, check, esperarModelo, GLB } from './visor.js'

test('Test1.glb', async ({ page, consola }) => {
  await page.goto(`/viewer.html?model=${GLB}&embed=0`)
  check('Test1.glb carga correctamente', await esperarModelo(page, 60_000))
  const glbInfo = await page.evaluate(() => {
    const v = window.dentalViewer
    return { triangles: v.model.stats.triangles }
  })
  check('Test1.glb tiene menos de 500k triangulos', glbInfo.triangles < 500000, `${glbInfo.triangles} tri`)
  check('Test1.glb sin errores en consola', consola.errores.length === 0, consola.errores.join(' | ') || 'ninguno')
  check('Test1.glb sin excepciones sin capturar', consola.excepciones.length === 0, consola.excepciones.join(' | ') || 'ninguna')
})
