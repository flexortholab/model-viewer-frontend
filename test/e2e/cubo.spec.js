// SPDX-License-Identifier: GPL-3.0-or-later
// Cubo de vistas y columna izquierda (Vistas, Herramientas y Corte).
import { test, check, abrirVisor, esMovil } from './visor.js'

test.beforeEach(async ({ page }) => {
  check('el visor se instancia y carga el modelo', await abrirVisor(page))
})

// Cubo de vistas: 6 caras, clic navega y resalta la vista activa.
test('cubo de vistas', async ({ page }) => {
  await page.evaluate(() => {
    const v = window.dentalViewer
    v.setSection({ enabled: true, plane: { point: [0, 0, 0], normal: [0, 0, 1] } })
    v.frameModel()
  })
  const cubeFaces = await page.evaluate(() =>
    [...document.querySelectorAll('#viewcube-inner [data-cube]')].map((b) => b.dataset.cube).sort().join(','))
  check('el cubo tiene las 6 caras', cubeFaces === 'derecha,frontal,inferior,izquierda,superior,trasera', cubeFaces)
  await page.evaluate(() => document.querySelector('#viewcube-inner [data-cube="superior"]').click())
  await page.waitForTimeout(600)
  const cube = await page.evaluate(() => {
    const v = window.dentalViewer
    const above = v.camera.position.y > v.controls.target.y
    const current = document.querySelector('#viewcube-inner [data-cube="superior"]').classList.contains('is-current')
    const matrix = document.getElementById('viewcube-inner').style.transform.startsWith('matrix3d(')
    return { above, current, matrix }
  })
  check('clic en el cubo navega a la vista', cube.above === true)
  check('el cubo resalta la vista activa y rota con la camara', cube.current === true && cube.matrix === true)
})

// Estetica de la columna izquierda: Vistas solo con iconos y los tres
// paneles con el mismo ancho estrecho.
test('columna izquierda: Vistas, Herramientas y Corte', async ({ page }, testInfo) => {
  test.skip(esMovil(testInfo), 'en movil la columna izquierda no se muestra')
  const columnas = await page.evaluate(() => {
    const px = (sel) => getComputedStyle(document.querySelector(sel)).width
    const etiquetas = [...document.querySelectorAll('#views-bar .btn-label')]
    return {
      vistas: px('#views-bar'),
      herramientas: px('#tools-bar'),
      corte: px('#panel'),
      etiquetas: etiquetas.length,
      ocultas: etiquetas.filter((el) => getComputedStyle(el).display === 'none').length,
    }
  })
  check('Vistas, Herramientas y Corte miden lo mismo (200 px)',
    columnas.vistas === '200px' && columnas.herramientas === '200px' && columnas.corte === '200px',
    `${columnas.vistas} / ${columnas.herramientas} / ${columnas.corte}`)
  check('Vistas es solo iconos (etiquetas ocultas)',
    columnas.etiquetas > 0 && columnas.ocultas === columnas.etiquetas,
    `${columnas.ocultas}/${columnas.etiquetas} ocultas`)
})
