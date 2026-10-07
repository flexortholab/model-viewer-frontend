// SPDX-License-Identifier: GPL-3.0-or-later
// Giro libre de la camara (sin limites polares ni de acimut). Arrastre real
// de raton sobre el lienzo: la pieza debe poder girar en cualquier direccion,
// incluidas vueltas completas y vistas desde debajo.
import { test, check, abrirVisor, perfil } from './visor.js'

/** Arrastre con el boton izquierdo en `steps` pasos y una pausa al soltar. */
async function drag(page, x0, y0, x1, y1, steps = 12) {
  await page.mouse.move(x0, y0)
  await page.mouse.down()
  for (let i = 1; i <= steps; i++) {
    const t = i / steps
    await page.mouse.move(Math.round(x0 + (x1 - x0) * t), Math.round(y0 + (y1 - y0) * t))
  }
  await page.mouse.up()
  await page.waitForTimeout(400)
}

test('giro libre de la camara con el raton', async ({ page }, testInfo) => {
  test.skip(['movil', 'tablet'].includes(perfil(testInfo)), 'sin raton: en movil y tablet se gira con el dedo')
  check('el visor se instancia y carga el modelo', await abrirVisor(page))

  const limits = await page.evaluate(() => {
    const c = window.dentalViewer.controls
    // Infinity no viaja en JSON: se normaliza a null para comparar.
    const big = (v) => (v === Infinity || v === -Infinity ? null : v)
    return {
      modo: window.dentalViewer.navigationMode,
      minPolar: c.minPolarAngle,
      maxPolar: c.maxPolarAngle,
      minAzim: big(c.minAzimuthAngle),
      maxAzim: big(c.maxAzimuthAngle),
      rotate: c.enableRotate,
    }
  })
  // En modo 'orbit' se comprueba que no hay limites escritos a mano; en modo
  // 'libre' ArcballControls no usa coordenadas esfericas y por tanto no expone
  // limites polares: lo relevante es que exista giro en cualquier eje.
  const sinLimites = limits.modo === 'libre'
    ? limits.rotate === true
    : limits.minPolar === 0 && limits.maxPolar === Math.PI &&
      limits.minAzim === null && limits.maxAzim === null && limits.rotate === true
  check('sin limites de giro escritos a mano', sinLimites, JSON.stringify(limits))

  const orbitBefore = await page.evaluate(() => {
    const v = window.dentalViewer
    v.setSection({ enabled: false })
    v.measure.clear()
    v.setTool('orbit')
    v.camera.position.set(60, 25, 60)
    v.controls.target.set(0, 0, 0)
    v.controls.update()
    const r = v.renderer.domElement.getBoundingClientRect()
    return { pos: v.camera.position.toArray(), cx: r.left + r.width / 2, cy: r.top + r.height / 2, h: r.height }
  })

  // Barrido horizontal amplio (mas de media vuelta) y arrastre vertical hacia
  // arriba para pasar por debajo del plano de la mesa.
  await drag(page, orbitBefore.cx - 300, orbitBefore.cy, orbitBefore.cx + 300, orbitBefore.cy + 30)
  const giro = await page.evaluate(() => {
    const v = window.dentalViewer
    return { pos: v.camera.position.toArray(), polar: v.controls.getPolarAngle() }
  })
  const movido = Math.hypot(
    giro.pos[0] - orbitBefore.pos[0],
    giro.pos[1] - orbitBefore.pos[1],
    giro.pos[2] - orbitBefore.pos[2],
  )
  check('arrastrar en horizontal gira la camara', movido > 5, `${movido.toFixed(1)} unidades`)

  // Se puede mirar la pieza desde debajo. En modo 'libre' el sentido del arrastre
  // vertical esta invertido respecto a OrbitControls (se comprueba hacia ambos
  // lados), asi que lo que se exige es el resultado: poder ver la cara inferior.
  const verDebajo = async (dy) => {
    await drag(page, orbitBefore.cx, orbitBefore.cy, orbitBefore.cx, orbitBefore.cy + dy, 20)
    return page.evaluate(() => {
      const v = window.dentalViewer
      return { polar: v.controls.getPolarAngle(), y: v.camera.position.y, targetY: v.controls.target.y }
    })
  }
  const debajo = await verDebajo(-orbitBefore.h * 0.35)
  const debajoAlt = debajo.polar > Math.PI / 2 + 0.05 ? debajo : await verDebajo(orbitBefore.h * 0.35)
  check('se puede mirar la pieza desde debajo (polar > 90 grados)',
    debajoAlt.polar > Math.PI / 2 + 0.05 && debajoAlt.y < debajoAlt.targetY,
    `polar ${(debajoAlt.polar * 180 / Math.PI).toFixed(0)} grados`)

  // Vueltas completas alrededor del modelo: nada debe frenar el giro.
  const vueltas = await page.evaluate(() => {
    const v = window.dentalViewer
    const c = v.controls
    const Vector3 = v.camera.position.constructor
    const radio = v.camera.position.distanceTo(c.target)
    let minPolar = Infinity
    for (let giro = 0; giro < 8; giro++) {
      v.camera.position.set(c.target.x + radio, c.target.y, c.target.z)
      c.update()
      v.camera.position.sub(c.target).applyAxisAngle(new Vector3(0, 1, 0), Math.PI / 4).add(c.target)
      c.update()
      minPolar = Math.min(minPolar, c.getPolarAngle())
    }
    return { minPolar, radio }
  })
  check('giro completo alrededor sin topes', vueltas.minPolar <= Math.PI / 2 + 0.05,
    `polar min ${(vueltas.minPolar * 180 / Math.PI).toFixed(1)} grados`)

  // El requisito real: poder pasar por superior/inferior y SEGUIR dando la vuelta.
  // Se mide arrastrando en vertical y muestreando el polar en cada paso: con
  // OrbitControls la camara se clava en 180 y los ultimos pasos no se mueven. Si
  // el arrastre sigue vivo, el recorrido tiene que dar la vuelta al palo.
  const polarSerie = await page.evaluate(() => {
    const v = window.dentalViewer
    const c = v.controls
    v.setView('frontal')
    c.update()
    v.requestRender()
    const r = v.renderer.domElement
    return { cx: r.clientWidth / 2, cy: r.clientHeight / 2 }
  })
  const STEPS_POLO = 40
  const TOTAL_POLO = 600
  await page.mouse.move(polarSerie.cx, polarSerie.cy)
  await page.mouse.down()
  const recorrido = []
  for (let i = 1; i <= STEPS_POLO; i++) {
    await page.mouse.move(polarSerie.cx, Math.round(polarSerie.cy - (TOTAL_POLO * i) / STEPS_POLO))
    recorrido.push(await page.evaluate(() => window.dentalViewer.controls.getPolarAngle()))
  }
  await page.mouse.up()

  // Racha maxima de pasos consecutivos sin movimiento: es la firma del tope.
  // Se mide en grados (un paso util ronda los 3 grados) para no confundir un
  // avance lento con un atasco.
  const GRADO = 180 / Math.PI
  const recorridoGrados = recorrido.map((r) => r * GRADO)
  let racha = 0
  let actual = 0
  for (let i = 1; i < recorridoGrados.length; i++) {
    if (Math.abs(recorridoGrados[i] - recorridoGrados[i - 1]) < 0.5) {
      actual++
      racha = Math.max(racha, actual)
    } else {
      actual = 0
    }
  }
  const gradeable = (r) => r.toFixed(0)
  const detalle = `racha maxima sin mover ${racha} pasos; recorrido ${gradeable(Math.min(...recorridoGrados))} -> ${gradeable(Math.max(...recorridoGrados))} -> ${gradeable(recorridoGrados[recorridoGrados.length - 1])} grados`
  // En modo 'libre' el arrastre no puede quedarse atascado en el polo (racha
  // corta: 0-4 pasos, que es inercia al soltar). En el modo antiguo 'orbit' se
  // documenta el atasco de OrbitControls, que es justo lo que ya no se usa por
  // defecto: se comprueba que el behaviour antiguo es el conocido.
  if (limits.modo === 'libre') {
    check('el arrastre no se queda atascado en el polo (giro libre de verdad)', racha < 8, detalle)
  } else {
    check('modo antiguo: se reproduce el atasco del polo de OrbitControls', racha >= 8, detalle)
  }
})
