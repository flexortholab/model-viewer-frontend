// SPDX-License-Identifier: GPL-3.0-or-later
// Portatil tactil: el gizmo se ve al pulsar el boton.
//
// Un portatil Windows con pantalla tactil da maxTouchPoints 10. Se pulsa el
// boton de verdad (sin pasar el raton por el lienzo, que pediria frame) y se
// cuentan en lo ultimo pintado los pixeles con los colores de los ejes del
// gizmo: asi se ve lo mismo que veria Roberto, no el estado interno.
import { test, check, abrirVisor, perfil } from './visor.js'

/** Pixeles del ultimo frame pintado con el color de algun eje del gizmo. */
const pixelesGizmo = (page) => page.evaluate(() => {
  const v = window.dentalViewer
  const lienzo = v.renderer.domElement
  const copia = document.createElement('canvas')
  copia.width = lienzo.width
  copia.height = lienzo.height
  const ctx = copia.getContext('2d')
  ctx.drawImage(lienzo, 0, 0)
  const datos = ctx.getImageData(0, 0, copia.width, copia.height).data
  const colores = Object.values(v.section.pivotOptions.axisColors)
    .map((c) => [(c >> 16) & 255, (c >> 8) & 255, c & 255])
  let n = 0
  for (let i = 0; i < datos.length; i += 4) {
    for (const [r, g, b] of colores) {
      if (Math.hypot(datos[i] - r, datos[i + 1] - g, datos[i + 2] - b) < 40) { n++; break }
    }
  }
  return n
})

// Mas que la cola de 30 frames del render bajo demanda: lo que no se haya
// pedido explicitamente ya no se pinta.
const reposo = (page) => page.waitForTimeout(1500)

test('el gizmo se ve al pulsar el boton en un portatil tactil', async ({ page }, testInfo) => {
  test.skip(perfil(testInfo) !== 'portatil-tactil', 'solo en el perfil de portatil tactil')
  check('el visor se instancia y carga el modelo', await abrirVisor(page))
  check('perfil tactil: el navegador anuncia 10 puntos tactiles',
    (await page.evaluate(() => navigator.maxTouchPoints)) === 10)

  const boton = page.locator('#gizmo-toggle')
  await reposo(page)
  const tactilBase = await pixelesGizmo(page)
  await boton.click()
  await reposo(page)
  const tactilCorteApagado = {
    pixeles: await pixelesGizmo(page),
    corte: await page.evaluate(() => window.dentalViewer.section.enabled),
  }
  check('perfil tactil: con el corte apagado, pulsar Gizmo activa el corte y el gizmo se ve',
    tactilCorteApagado.corte && tactilCorteApagado.pixeles - tactilBase > 300,
    `${tactilBase} -> ${tactilCorteApagado.pixeles} px de color de eje`)

  await boton.click()
  await reposo(page)
  const tactilApagado = await pixelesGizmo(page)
  check('perfil tactil: volver a pulsar Gizmo lo quita de la pantalla',
    tactilApagado - tactilBase < 50,
    `${tactilBase} -> ${tactilApagado} px de color de eje`)

  await boton.click()
  await reposo(page)
  const tactilCorteActivo = await pixelesGizmo(page)
  check('perfil tactil: con el corte ya activo, pulsar Gizmo lo pinta sin tocar el lienzo',
    tactilCorteActivo - tactilApagado > 300,
    `${tactilApagado} -> ${tactilCorteActivo} px de color de eje`)

  // Tamano en pantalla tras acercar y alejar: la punta de la flecha sigue al
  // 16.5% del alto visible, sin volver a activar el corte.
  const tactilTamanos = await page.evaluate(async () => {
    const v = window.dentalViewer
    const s = v.section
    const espera = () => new Promise((r) => setTimeout(r, 300))
    const fraccion = () => {
      const altoMundo = (v.camera.top - v.camera.bottom) / v.camera.zoom
      return s._pivotHelper.scale.x * 0.62 / altoMundo
    }
    const zoom0 = v.camera.zoom
    const fracciones = {}
    v.camera.zoom = zoom0 * 4
    v.camera.updateProjectionMatrix()
    v.requestRender()
    await espera()
    fracciones.acercado = fraccion()
    v.camera.zoom = zoom0 / 4
    v.camera.updateProjectionMatrix()
    v.requestRender()
    await espera()
    fracciones.alejado = fraccion()
    v.camera.zoom = zoom0
    v.camera.updateProjectionMatrix()
    v.requestRender()
    await espera()
    return fracciones
  })
  check('perfil tactil: el gizmo conserva su tamano en pantalla al acercar y alejar',
    Math.abs(tactilTamanos.acercado - 0.165) < 0.005 && Math.abs(tactilTamanos.alejado - 0.165) < 0.005,
    `acercado ${(tactilTamanos.acercado * 100).toFixed(1)}%, alejado ${(tactilTamanos.alejado * 100).toFixed(1)}%`)
})
