// SPDX-License-Identifier: GPL-3.0-or-later
// Mediciones: la cota y su chip HTML, el flujo con el raton, la edicion de
// un extremo, las cotas cercanas, los globos con la pieza recortada y la
// seleccion con nota y Supr.
import { test, check, abrirVisor } from './visor.js'

test.beforeEach(async ({ page }) => {
  check('el visor se instancia y carga el modelo', await abrirVisor(page))
  // En el smoke antiguo estas comprobaciones llegaban con la vista superior
  // que dejaba el clic en el cubo. Desde la isometrica de inicio el centro de
  // la pantalla cae en un hueco de la pieza y el flujo con el raton no tiene
  // donde pinchar.
  await page.evaluate(() => window.dentalViewer.setView('superior'))
})

test('crea una medicion con su cota y su chip', async ({ page }) => {
  const measure = await page.evaluate(() => {
    const v = window.dentalViewer
    v.setTool('measure')
    const box = v.model.bounds
    const a = box.getCenter(new (v.model.bounds.min.constructor)())
    const b = a.clone()
    b.x += 12.3456
    const m = v.measure.add(a, b)
    v.renderer.render(v.scene, v.camera)
    v.measure.update()
    return {
      id: m.id,
      label: m.label,
      distance: m.distance,
      count: v.measure.measurements.length,
      nodes: Object.values(m.__nodes).filter(Boolean).length,
      nodeKeys: Object.keys(m.__nodes),
      lineMaterials: v.measure.lineMaterials.size,
      labelEl: v.measure.labels.find((l) => l.id === 'measure:' + v.measure.measurements[0]?.id)?.el?.className,
      labelVisible: v.measure.labels.find((l) => l.id === 'measure:' + v.measure.measurements[0]?.id)?.el?.style.display !== 'none',
    }
  })
  check('crea una medicion', measure.count === 1, measure.id)
  check('la distancia se expresa en mm con 1 decimal', measure.label === '12.3 mm', measure.label)
  // dim, extA, extB, pointA, pointB, value (chip HTML con la cifra). Sin tildes
  // oblicuas: solo confundian.
  check(
    'dibuja linea de cota, extensiones, puntos y cifra',
    measure.nodes === 6,
    `${measure.nodes} elementos (${measure.nodeKeys.join(', ')})`,
  )
  check('sin tildes oblicuas en la medicion',
    !measure.nodeKeys.includes('tickA') && !measure.nodeKeys.includes('tickB'),
    measure.nodeKeys.join(', '))
  check('cada nodo tiene su material', measure.lineMaterials >= 5, `${measure.lineMaterials} materiales`)
  check('la cifra mm aparece como chip HTML visible',
    measure.labelEl?.includes('measure-label') && measure.labelVisible === true,
    `${measure.labelEl}/${measure.labelVisible}`)

  // El globo de las medidas es un chip HTML, no un sprite: tamano fijo en CSS pixels.
  const labelSize = await page.evaluate(() => {
    const v = window.dentalViewer
    const s = v.measure.measurements[0].__nodes.value
    const esHtml = s instanceof HTMLElement
    return { esHtml, altoPx: s.offsetHeight }
  })
  check('el globo de la medida es un chip HTML, no un sprite',
    labelSize.esHtml === true, `esHtml=${labelSize.esHtml}`)
  check('el globo tiene tamano util en pantalla',
    labelSize.altoPx > 18 && labelSize.altoPx < 60, `${labelSize.altoPx}px`)
})

// Flujo interactivo con el raton: cursor, snap, goma con cifra en vivo y
// salida sola a camara libre (medidas de una en una).
test('flujo interactivo de medir', async ({ page }) => {
  const flow = await page.evaluate(() => {
    const v = window.dentalViewer
    v.setSection({ enabled: false })
    v.measure.clear()
    v.setTool('measure')
    const canvas = v.renderer.domElement
    const rect = canvas.getBoundingClientRect()
    const cx = rect.left + rect.width / 2
    const cy = rect.top + rect.height / 2
    const fire = (type, x, y) => canvas.dispatchEvent(
      new PointerEvent(type, { clientX: x, clientY: y, bubbles: true }),
    )
    const cursorClass = v.container.classList.contains('is-measuring')
    fire('pointermove', cx, cy)
    const snapVisible = v.measure._snap?.visible === true
    fire('pointerdown', cx, cy)
    const pending = !!v.measure._preview
    fire('pointermove', cx + 40, cy)
    const rubber = !!v.measure._preview?.line
    const liveText = v.measure._preview?.lastText ?? ''
    fire('pointerdown', cx + 40, cy)
    return {
      cursorClass,
      snapVisible,
      pending,
      rubber,
      liveText,
      count: v.measure.measurements.length,
      exited: v.measure.enabled === false && v.controls.enabled === true,
    }
  })
  check('modo medir con cursor de colocar punto', flow.cursorClass === true)
  check('anillo de snap visible al pasar sobre la pieza', flow.snapVisible === true)
  check('primer clic deja el origen pendiente', flow.pending === true)
  check('la goma muestra la distancia en vivo', flow.rubber === true && /mm$/.test(flow.liveText), flow.liveText)
  check('al completar sale sola a camara libre (una a una)', flow.count === 1 && flow.exited === true)
})

test('editar un extremo, cotas cercanas y globos con la pieza recortada', async ({ page }) => {
  // Edicion: en camara libre se puede agarrar un extremo y arrastrarlo para
  // ajustar la cifra con precision, sin volver al modo medir.
  const edicion = await page.evaluate(() => {
    const v = window.dentalViewer
    v.measure.clear()
    const b = v.model.bounds
    const V = v.camera.position.constructor
    const a = b.min.clone()
    const far = b.max.clone()
    far.y = a.y
    const m = v.measure.add(a, far)
    const canvas = v.renderer.domElement
    const p = a.clone().project(v.camera)
    const cx = canvas.getBoundingClientRect().left + (p.x * 0.5 + 0.5) * canvas.clientWidth
    const cy = canvas.getBoundingClientRect().top + (-p.y * 0.5 + 0.5) * canvas.clientHeight
    const camara = v.camera.position.toArray().map((n) => +n.toFixed(3))
    const fire = (type, x, y) => canvas.dispatchEvent(
      new PointerEvent(type, { clientX: x, clientY: y, bubbles: true, button: 0 }),
    )
    fire('pointerdown', cx, cy)
    const agarrado = !!v._dragMeasure
    fire('pointermove', cx + 30, cy - 30)
    fire('pointerup', cx + 30, cy - 30)
    const resultado = {
      agarrado,
      movido: +a.distanceTo(far).toFixed(2),
      etiquetaDespues: m.label,
      camaraIgual: JSON.stringify(camara) === JSON.stringify(v.camera.position.toArray().map((n) => +n.toFixed(3))),
      soltado: v._dragMeasure === null && v.controls.enabled === true,
    }
    // Deja el estado como estaba: una sola medida en la parte superior de la
    // pieza (y > 0), que es lo que espera el bloque de corte siguiente.
    v.measure.clear()
    const centro = b.getCenter(new V())
    const a2 = centro.clone().setY(centro.y + 3)
    v.measure.add(a2, a2.clone().setX(a2.x + 12.3456))
    return resultado
  })
  check('en camara libre se puede agarrar un extremo', edicion.agarrado === true)
  check('arrastrar el extremo cambia la distancia', edicion.movido > 0.01, edicion.etiquetaDespues)
  check('la camara no se mueve al editar la medida', edicion.camaraIgual === true)
  check('al soltar se reactiva la camara', edicion.soltado === true)

  // Cotas cercanas: la segunda se dibuja al lado contrario para no solaparse.
  const lados = await page.evaluate(() => {
    const v = window.dentalViewer
    const V = v.camera.position.constructor
    const camAntes = {
      position: v.camera.position.toArray(),
      target: v.controls.target.toArray(),
      zoom: v.camera.zoom,
    }
    const previas = v.measure.serialize()
    v.measure.clear()
    v.camera.position.set(0, 0, 80)
    v.controls.target.set(0, 0, 0)
    v.camera.zoom = 1
    v.camera.updateProjectionMatrix()
    v.controls.update()
    const m1 = v.measure.add(new V(0, 0, 0), new V(12, 0, 0))
    const m2 = v.measure.add(new V(0, 1, 0), new V(12, 1, 0))
    const m3 = v.measure.add(new V(0, 30, 0), new V(12, 30, 0))
    const rect = v.renderer.domElement.getBoundingClientRect()
    const px = (p) => {
      const q = p.clone().project(v.camera)
      return [(q.x * 0.5 + 0.5) * rect.width, (-q.y * 0.5 + 0.5) * rect.height]
    }
    const mid = (m) => {
      const a = px(m._seg.a)
      const b = px(m._seg.b)
      return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]
    }
    const c1 = mid(m1)
    const c2 = mid(m2)
    const separacion = Math.hypot(c2[0] - c1[0], c2[1] - c1[1])
    const salida = { lado1: m1._side, lado2: m2._side, lado3: m3._side, separacion }
    v.measure.restore(previas)
    v.camera.position.fromArray(camAntes.position)
    v.controls.target.fromArray(camAntes.target)
    v.camera.zoom = camAntes.zoom
    v.camera.updateProjectionMatrix()
    v.controls.update()
    return salida
  })
  check('la primera cota manda y la cercana va al lado contrario',
    lados.lado1 === 1 && lados.lado2 === -1 && lados.lado3 === 1,
    `lados=${lados.lado1}/${lados.lado2}/${lados.lado3}`)
  check('las cotas cercanas quedan separadas en pantalla',
    lados.separacion > 40,
    `separacion=${lados.separacion.toFixed(0)}px`)

  // Los globos se ven aunque el corte elimine la pieza.
  // La pieza va de y = -3.6 a y = +3.6: un plano en y = 40 no deja nada visible.
  const hidden = await page.evaluate(() => {
    const v = window.dentalViewer
    v.setSection({ enabled: true, plane: { point: [0, 0, 0], normal: [0, 1, 0] } })
    v.setSectionAxis('y', 40) // muy por encima de la pieza
    v.renderer.render(v.scene, v.camera)
    v.measure.update()
    const countVisible = () => v.measure.labels.filter((l) => {
      if (l.spriteKey) {
        const sprite = v.measure.measurements.find((m) => m.id === l.id)?.__nodes?.value
        return sprite?.visible !== false
      }
      return !l.el || l.el.style.display !== 'none'
    }).length
    const visible = countVisible()
    v.setSectionAxis('y', 0)
    v.measure.update()
    const visibleAfter = countVisible()
    v.measure.clear()
    v.setTool('orbit')
    v.setSection({ enabled: false })
    return { visible, visibleAfter }
  })
  check('los globos se ven con la pieza recortada', hidden.visible === 1)
  check('siguen viendose al retirar el corte', hidden.visibleAfter === 1)
})

// Edicion de medidas: seleccionar, nota y Supr (sin prompt, apto headless).
test('seleccionar una medida, anotarla y borrarla con Supr', async ({ page }) => {
  const edit = await page.evaluate(() => {
    const v = window.dentalViewer
    // Camara frontal conocida: el hit-test se mide en pixeles de pantalla.
    v.camera.position.set(0, 0, 80)
    v.controls.target.set(0, 0, 0)
    v.controls.update()
    v.camera.updateMatrixWorld()
    const a = v.model.bounds.getCenter(new (v.camera.position.constructor)())
    const b = a.clone()
    b.x += 12.3456
    const m = v.measure.add(a, b)
    const mid = m._seg.a.clone().add(m._seg.b).multiplyScalar(0.5).project(v.camera)
    const rect = v.renderer.domElement.getBoundingClientRect()
    const x = (mid.x * 0.5 + 0.5) * rect.width + rect.left
    const y = (-mid.y * 0.5 + 0.5) * rect.height + rect.top
    const found = v.measure.findMeasurement(x, y)
    v.measure.select(found?.id ?? null)
    // Estado de la seleccion ANTES de borrar la medida.
    const selectedId = v.measure.selected()?.id ?? null
    const dimColor = m.__nodes.dim.material.color.getHexString()
    v.measure.setNote(m.id, 'ancho')
    const shown = v.measure.displayLabel(m)
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true }))
    return {
      foundId: found?.id ?? null,
      selectedId,
      dimColor,
      shown,
      remaining: v.measure.measurements.length,
    }
  })
  check('clic selecciona la medida (hit-test en pantalla)', edit.foundId !== null && edit.selectedId === edit.foundId,
    `${edit.foundId} / ${edit.selectedId}`)
  check('seleccionada se tiñe de teal', edit.dimColor === '1b8aa3', `#${edit.dimColor}`)
  check('la nota aparece en la cifra', edit.shown.includes('ancho'), edit.shown)
  check('Supr borra la medida seleccionada', edit.remaining === 0)
})
