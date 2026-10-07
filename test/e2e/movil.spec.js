// SPDX-License-Identifier: GPL-3.0-or-later
// Interfaz movil: filas de objetos como boton unico, leyenda y CSS de la
// barra flotante.
import { test, check, abrirVisor, esMovil } from './visor.js'

test.beforeEach(async ({ page }) => {
  check('el visor se instancia y carga el modelo', await abrirVisor(page))
})

// La lista movil existe en el DOM en cualquier pantalla: el smoke antiguo la
// probaba en escritorio, asi que corre en todos los perfiles.
test('filas de objetos como boton unico y leyenda', async ({ page }) => {
  const mobileObjectsFlow = await page.evaluate(() => {
    const v = window.dentalViewer
    const rows = [...document.querySelectorAll('#mobile-objects-list .obj-item')]
    const toggles = [...document.querySelectorAll('#mobile-objects-list .obj-toggle')]
    const first = toggles[0]
    const ojo = first?.querySelector('.obj-eye')
    const nombre = first?.querySelector('.obj-name')
    const antes = v.listObjects()[0]?.visible
    first?.click()
    const despues = v.listObjects()[0]?.visible
    // El clic re-renderiza la lista: hay que releer el boton antes de pulsar.
    const releido = document.querySelector('#mobile-objects-list .obj-toggle')
    releido?.click()
    const restaurado = v.listObjects()[0]?.visible
    const leyenda = document.querySelector('#mobile-objects .panel-note')?.textContent.trim() ?? ''
    return {
      filas: rows.length,
      botones: toggles.length,
      compuesto: !!ojo && !!nombre,
      antes,
      despues,
      restaurado,
      leyenda,
    }
  })
  check('cada fila movil es un unico boton ojo+nombre',
    mobileObjectsFlow.filas > 0 &&
    mobileObjectsFlow.botones === mobileObjectsFlow.filas &&
    mobileObjectsFlow.compuesto === true,
    `${mobileObjectsFlow.botones}/${mobileObjectsFlow.filas} botones`)
  check('el boton de fila conmuta la pieza',
    mobileObjectsFlow.antes === true && mobileObjectsFlow.despues === false &&
    mobileObjectsFlow.restaurado === true,
    `visible=${mobileObjectsFlow.antes}->${mobileObjectsFlow.despues}->${mobileObjectsFlow.restaurado}`)
  check('la leyenda explica el gesto',
    mobileObjectsFlow.leyenda === 'Toca un objeto para mostrarlo u ocultarlo.',
    mobileObjectsFlow.leyenda)
})

// Vista movil real: la media query (max-width: 640px) aplica y se verifica el
// CSS movil. En los perfiles de movil es la pantalla del dispositivo; en el
// resto se estrecha la ventana a 390 x 844, como hacia el smoke antiguo.
test('CSS movil de la barra flotante', async ({ page }, testInfo) => {
  if (!esMovil(testInfo)) {
    await page.setViewportSize({ width: 390, height: 844 })
    await page.waitForTimeout(500)
  }
  const movilCss = await page.evaluate(() => {
    // La leyenda vive en el modal: hay que abrirlo para medir visibilidad.
    document.querySelector('#mobile-toolbar [data-mobile="objects"]').click()
    const barra = document.querySelector('#mobile-toolbar')
    const barraCss = getComputedStyle(barra)
    const botonBarra = barra.querySelector('button')
    const botonBarraCss = botonBarra ? getComputedStyle(botonBarra) : null
    const titulo = document.getElementById('mobile-title')
    const tituloCss = titulo ? getComputedStyle(titulo) : null
    const boton = document.querySelector('#mobile-objects-list .obj-toggle')
    const botonCss = boton ? getComputedStyle(boton) : null
    const leyenda = document.querySelector('#mobile-objects .panel-note')
    const salida = {
      barraVisible: barra.offsetParent !== null,
      barraFondo: barraCss.backgroundColor,
      barraBorde: barraCss.borderTopWidth,
      barraSombra: barraCss.boxShadow,
      botonSombra: botonBarraCss ? botonBarraCss.boxShadow : null,
      botonTexto: botonBarraCss ? botonBarraCss.color : null,
      tituloFondo: tituloCss ? tituloCss.backgroundColor : null,
      tituloSombra: tituloCss ? tituloCss.boxShadow : null,
      tituloTexto: tituloCss ? tituloCss.color : null,
      alturaMinima: botonCss ? botonCss.minHeight : null,
      leyendaVisible: leyenda && leyenda.offsetParent !== null,
    }
    document.querySelector('#mobile-objects .mobile-close').click()
    return salida
  })
  check('sin panel: la barra movil es transparente y sin borde',
    movilCss.barraVisible === true &&
    movilCss.barraFondo === 'rgba(0, 0, 0, 0)' &&
    movilCss.barraBorde === '0px' && movilCss.barraSombra === 'none',
    `fondo=${movilCss.barraFondo} borde=${movilCss.barraBorde} sombra=${movilCss.barraSombra}`)
  check('botones y titulo flotantes en gris, y fila tactil (>=44px) en movil',
    movilCss.botonSombra !== null && movilCss.botonSombra !== 'none' &&
    movilCss.botonTexto === 'rgb(90, 96, 104)' &&
    movilCss.tituloFondo === 'rgb(255, 255, 255)' &&
    movilCss.tituloSombra === movilCss.botonSombra &&
    movilCss.tituloTexto === 'rgb(90, 96, 104)' &&
    movilCss.alturaMinima === '44px' && movilCss.leyendaVisible === true,
    `texto=${movilCss.botonTexto} sombra=${movilCss.botonSombra} titulo=${movilCss.tituloFondo}/${movilCss.tituloTexto} min-height=${movilCss.alturaMinima}`)
})
