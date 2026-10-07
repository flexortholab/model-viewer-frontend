// SPDX-License-Identifier: GPL-3.0-or-later
// El lienzo WebGL pinta de verdad en este navegador: si no, el resto de
// pruebas de pixeles no significan nada.
import { test, expect, abrirVisor, pixelesPintados } from './visor.js'

test('el lienzo WebGL pinta la pieza (pixeles distintos del fondo)', async ({ page }) => {
  expect(1, 'fallo a proposito para probar la cola de merge').toBe(2)
  expect(await abrirVisor(page)).toBe(true)
  // La rejilla tambien pinta: lo que cuenta es la diferencia con la pieza oculta.
  const conPieza = await pixelesPintados(page)
  await page.evaluate(() => { window.dentalViewer.modelRoot.visible = false })
  const sinPieza = await pixelesPintados(page)
  await page.evaluate(() => { window.dentalViewer.modelRoot.visible = true })
  const pieza = conPieza.pintados - sinPieza.pintados
  expect(pieza, `${conPieza.pintados} con pieza, ${sinPieza.pintados} sin ella`).toBeGreaterThan(conPieza.total * 0.002)
})
