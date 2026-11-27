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

// En las vistas cenitales la camara mira en vertical. ArcballControls guarda
// `camera.up` como arriba LOCAL y lo rota con el cuaternion completo: si se
// cambia a Z para "arreglar" el balanceo, el primer pixel de arrastre mete un
// giro de ~180 grados y el modelo se vuelve loco. Aqui se vigila que el primer
// arrastre sea pequeno y que el arriba siga perpendicular a la mirada.
test('vistas superior e inferior: el primer arrastre no da un salto', async ({ page }) => {
  const esperarFrames = () => page.evaluate(() => new Promise((r) => {
    requestAnimationFrame(() => requestAnimationFrame(r))
  }))
  const estado = () => page.evaluate(() => {
    const v = window.dentalViewer
    const c = v.camera
    const direction = new c.position.constructor()
    c.getWorldDirection(direction)
    const r = v.renderer.domElement.getBoundingClientRect()
    return {
      up: c.up.toArray(),
      forward: direction.toArray(),
      quaternion: c.quaternion.toArray(),
      zoom: c.zoom,
      center: { x: r.left + r.width / 2, y: r.top + r.height / 2 },
    }
  })
  const dot = (a, b) => a.reduce((sum, value, index) => sum + value * b[index], 0)
  const grados = (a, b) => 2 * Math.acos(Math.min(1, Math.abs(dot(a, b)))) * 180 / Math.PI

  for (const vista of ['superior', 'inferior']) {
    await page.evaluate((name) => window.dentalViewer.setView(name), vista)
    await esperarFrames()
    const antes = await estado()

    // Arrastre horizontal corto (8 px), como el primer gesto al mover el modelo.
    await page.mouse.move(antes.center.x, antes.center.y)
    await page.mouse.down()
    await page.mouse.move(antes.center.x + 8, antes.center.y)
    await esperarFrames()
    await page.mouse.up()
    await page.waitForTimeout(500)
    const trasArrastre = await estado()
    const giro = grados(antes.quaternion, trasArrastre.quaternion)

    check(`${vista}: el primer arrastre no pega un salto`, giro < 20,
      `${giro.toFixed(1)} grados por 8 px`)
    check(`${vista}: el arriba sigue perpendicular a la mirada`,
      Math.abs(dot(trasArrastre.up, trasArrastre.forward)) < 0.05,
      `up=${trasArrastre.up.map((n) => n.toFixed(2))} mirada=${trasArrastre.forward.map((n) => n.toFixed(2))}`)

    // El zoom no debe cambiar la orientacion.
    await page.mouse.move(trasArrastre.center.x, trasArrastre.center.y)
    await page.mouse.wheel(0, -240)
    await page.waitForTimeout(500)
    const trasZoom = await estado()
    check(`${vista}: el zoom acerca sin cambiar la orientacion`,
      trasZoom.zoom > trasArrastre.zoom &&
      Math.abs(dot(trasArrastre.quaternion, trasZoom.quaternion)) > 1 - 1e-4,
      `zoom ${trasArrastre.zoom.toFixed(2)} -> ${trasZoom.zoom.toFixed(2)}`)
  }
})
