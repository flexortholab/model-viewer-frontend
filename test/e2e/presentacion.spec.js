// SPDX-License-Identifier: GPL-3.0-or-later
// Presentacion: dialogo de marcador con sus clases, colores por clase y
// marcadores que guardan y restauran vista, corte y zoom.
import { test, check, abrirVisor, esMovil } from './visor.js'

test.beforeEach(async ({ page }) => {
  check('el visor se instancia y carga el modelo', await abrirVisor(page))
})

test('dialogo de marcador con las clases como botones', async ({ page }) => {
  const markerDialogFlow = await page.evaluate(async () => {
    const v = window.dentalViewer
    const toolButton = document.querySelector('[data-action="add-marker"]')
    if (toolButton.getAttribute('aria-pressed') !== 'true') toolButton.click()
    const canvas = v.renderer.domElement
    const rect = canvas.getBoundingClientRect()
    let picked = null
    // El centro de la caja puede caer en un hueco de la pieza: se busca el
    // primer pixel de una rejilla central que realmente toque modelo.
    for (const nx of [-0.4, -0.2, 0, 0.2, 0.4]) {
      for (const ny of [-0.3, -0.15, 0, 0.15, 0.3]) {
        const x = rect.left + (nx * 0.5 + 0.5) * rect.width
        const y = rect.top + (-ny * 0.5 + 0.5) * rect.height
        v.setPointer({ clientX: x, clientY: y })
        if (v.pick()) {
          picked = { x, y }
          break
        }
      }
      if (picked) break
    }
    const x = picked?.x ?? rect.left + rect.width / 2
    const y = picked?.y ?? rect.top + rect.height / 2
    const pickedModel = picked !== null
    const fire = (type) => canvas.dispatchEvent(
      new PointerEvent(type, { clientX: x, clientY: y, bubbles: true, button: 0 }),
    )
    fire('pointerdown')
    const dialog = document.getElementById('marker-dialog')
    const buttons = [...dialog.querySelectorAll('[data-marker-kind]')]
    const opened = {
      visible: dialog.hidden === false,
      picked: pickedModel,
      kinds: buttons.map((button) => button.dataset.markerKind),
      labels: buttons.map((button) => button.textContent.trim()),
      defaultNote: dialog.querySelector('[data-marker-kind="note"]').getAttribute('aria-pressed'),
    }
    let selected = null
    let selectedOutline = null
    let hidden = dialog.hidden === true
    let created = null
    let focoTexto = false
    let textoObligatorio = null
    if (opened.visible) {
      const input = document.getElementById('marker-dialog-text')
      // El cuadro recibe el foco solo: se puede escribir nada mas abrir.
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
      focoTexto = document.activeElement === input
      // El texto es obligatorio: confirmar en vacio no crea nada y avisa.
      const antes = v.doc.markers.length
      dialog.querySelector('[data-marker-dialog="confirm"]').click()
      textoObligatorio = {
        creados: v.doc.markers.length - antes,
        sigueAbierto: dialog.hidden === false,
        errorVisible: document.getElementById('marker-dialog-error').hidden === false,
      }
      input.value = 'marcador dialogo'
      input.dispatchEvent(new Event('input', { bubbles: true }))
      dialog.querySelector('[data-marker-kind="screw"]').click()
      selected = dialog.querySelector('[data-marker-kind="screw"]').getAttribute('aria-pressed')
      // El estilo se resuelve en el siguiente pintado y el borde lleva una
      // transicion de 120 ms: se ceden frames y se espera a que asiente, igual
      // que lo veria el doctor. En el runner de macOS 250 ms no bastaban (el
      // borde salia a medio camino): se espera ademas a que acabe la transicion.
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
      await new Promise((r) => setTimeout(r, 250))
      const screwButton = dialog.querySelector('[data-marker-kind="screw"]')
      await Promise.all(screwButton.getAnimations().map((a) => a.finished))
      const selectedStyle = getComputedStyle(screwButton)
      selectedOutline = {
        border: selectedStyle.borderColor,
        shadow: selectedStyle.boxShadow,
      }
      dialog.querySelector('[data-marker-dialog="confirm"]').click()
      created = v.doc.markers[v.doc.markers.length - 1]
      hidden = dialog.hidden === true
    }
    fire('pointerup')
    if (toolButton.getAttribute('aria-pressed') === 'true') toolButton.click()
    const result = {
      opened,
      focoTexto,
      textoObligatorio,
      selected,
      selectedOutline,
      hidden,
      toolOff: toolButton.getAttribute('aria-pressed') === 'false',
      text: created?.text,
      kind: created?.kind,
    }
    if (created) v.removeMarker(created.id)
    return result
  })
  check('el dialogo de marcador ofrece las 3 clases como botones',
    markerDialogFlow.opened.visible === true &&
    markerDialogFlow.opened.kinds.join(',') === 'note,warning,screw' &&
    markerDialogFlow.opened.labels.join('/') === 'Nota/Aviso/Tornillo' &&
    markerDialogFlow.opened.defaultNote === 'true',
    `${markerDialogFlow.opened.labels.join('/')} ` +
    `visible=${markerDialogFlow.opened.visible} pieza=${markerDialogFlow.opened.picked}`)
  check('el cuadro de texto recibe el foco al abrir (se escribe directo)',
    markerDialogFlow.focoTexto === true)
  check('el texto es obligatorio: en vacio no crea marcador y avisa',
    markerDialogFlow.textoObligatorio?.creados === 0 &&
    markerDialogFlow.textoObligatorio?.sigueAbierto === true &&
    markerDialogFlow.textoObligatorio?.errorVisible === true)
  check('la clase elegida con boton se guarda en el marcador',
    markerDialogFlow.selected === 'true' &&
    markerDialogFlow.hidden === true && markerDialogFlow.toolOff === true &&
    markerDialogFlow.text === 'marcador dialogo' && markerDialogFlow.kind === 'screw',
    `clase=${markerDialogFlow.kind}`)
  check('la clase seleccionada se contornea en azul',
    markerDialogFlow.selectedOutline?.border === 'rgb(37, 99, 235)' &&
    (markerDialogFlow.selectedOutline?.shadow ?? '').includes('rgba(37, 99, 235, 0.35)'),
    `borde=${markerDialogFlow.selectedOutline?.border}`)
})

// Coherencia: el numero de cada marcador lleva el color de su clase.
test('el numero del marcador lleva el color de su clase', async ({ page }) => {
  const markerColores = await page.evaluate(() => {
    const v = window.dentalViewer
    const ids = [
      v.addMarker({ position: [0, 0, 0], text: 'a', kind: 'note', snapshot: false }),
      v.addMarker({ position: [0, 0, 0], text: 'b', kind: 'warning', snapshot: false }),
      v.addMarker({ position: [0, 0, 0], text: 'c', kind: 'screw', snapshot: false }),
    ].map((m) => m.id)
    const lee = (kind) => {
      const el = document.querySelector('#markers-list .marker-item[data-kind="' + kind + '"] .marker-idx')
      return el ? getComputedStyle(el).backgroundColor : null
    }
    const colores = { note: lee('note'), warning: lee('warning'), screw: lee('screw') }
    for (const id of ids) v.removeMarker(id)
    return colores
  })
  check('el numero del marcador lleva el color de su clase',
    markerColores.note === 'rgb(217, 242, 227)' &&
    markerColores.warning === 'rgb(255, 212, 205)' &&
    markerColores.screw === 'rgb(233, 213, 255)',
    `note=${markerColores.note} warning=${markerColores.warning} screw=${markerColores.screw}`)
})

test('marcadores con snapshot de vista y corte', async ({ page }) => {
  const markerFlow = await page.evaluate(() => {
    const v = window.dentalViewer
    v.setSection({ enabled: false })
    v.measure.clear()
    // Estado "preparado": camara en (30, 3, 3) mirando a (1, 2, 0) y corte en y=2.
    v.camera.position.set(30, 3, 3)
    v.controls.target.set(1, 2, 0)
    v.controls.update()
    v.setSection({ enabled: true, plane: { point: [0, 2, 0], normal: [0, 1, 0] } })
    // Zoom del paso: en ortografica es camera.zoom (la distancia no magnifica).
    v.camera.zoom = 2.5
    v.camera.updateProjectionMatrix()
    // Balanceo: rodar la camara sobre su eje de mirada, como tras un arrastre.
    const axis = new (v.camera.position.constructor)()
    v.camera.getWorldDirection(axis)
    v.camera.quaternion.premultiply(
      new (v.camera.quaternion.constructor)().setFromAxisAngle(axis, (75 * Math.PI) / 180),
    )
    v.camera.updateMatrixWorld()
    v.controls.syncPose?.()
    const quaternionAntes = v.camera.quaternion.toArray()
    const marker = v.addMarker({ position: [2, 0, 0], text: 'marcador test', kind: 'warning' })
    const saved = {
      hasView: !!marker.view,
      hasSection: !!marker.section,
      sectionEnabled: marker.section?.enabled,
      viewCaptured:
        marker.view &&
        Math.abs(marker.view.position[0] - 30) < 1e-2 &&
        Math.abs(marker.view.target[1] - 2) < 1e-2,
      zoomSaved: Math.abs((marker.view?.zoom ?? 0) - 2.5) < 1e-4,
      quaternionSaved: Array.isArray(marker.view?.quaternion),
    }
    // Cambiar el estado y restaurar como haria el doctor al pulsar el paso.
    v.camera.position.set(80, 80, 80)
    v.controls.target.set(0, 0, 0)
    v.camera.zoom = 0.8
    v.camera.updateProjectionMatrix()
    v.controls.update()
    v.setSection({ enabled: false })
    v.applyAnnotations(JSON.parse(JSON.stringify(v.getAnnotations())))
    v.focusMarker(marker.id)
    const restored = {
      cameraRestored: Math.abs(v.camera.position.x - 30) < 1e-1,
      targetRestored: Math.abs(v.controls.target.y - 2) < 1e-1,
      zoomRestored: Math.abs(v.camera.zoom - 2.5) < 1e-4,
      sectionRestored: v.section.enabled,
      planoRestoredPosicion: Math.abs(v.section.gizmo.position.y - 2) < 1e-1,
      quaternionRestored: Math.abs(
        quaternionAntes.reduce((sum, value, i) => sum + value * v.camera.quaternion.toArray()[i], 0),
      ),
      markerLabels: v.measure.labels.filter((l) => String(l.id).startsWith('marker:')).length,
    }
    // Sin zoom en el JSON (paso viejo): se conserva el actual, no se rompe.
    v.camera.zoom = 1.75
    v.camera.updateProjectionMatrix()
    const viejo = JSON.parse(JSON.stringify(v.getAnnotations()))
    for (const m of viejo.markers) delete m.view.zoom
    v.applyAnnotations(viejo)
    v.focusMarker(marker.id)
    const zoomLegacy = Math.abs(v.camera.zoom - 1.75) < 1e-4
    v.removeMarker(marker.id)
    v.camera.zoom = 1
    v.camera.updateProjectionMatrix()
    v.setSection({ enabled: false })
    v.exitMarkerFocus()
    return { saved, restored, zoomLegacy, markersAfterRemove: v.doc.markers.length }
  })
  check('el marcador guarda vista, corte y zoom del momento',
    markerFlow.saved.hasView && markerFlow.saved.hasSection && markerFlow.saved.sectionEnabled &&
    markerFlow.saved.viewCaptured && markerFlow.saved.zoomSaved && markerFlow.saved.quaternionSaved)
  check('pulsar el marcador restaura vista, objetivo, zoom y corte',
    markerFlow.restored.cameraRestored && markerFlow.restored.targetRestored &&
    markerFlow.restored.zoomRestored && markerFlow.restored.sectionRestored &&
    markerFlow.restored.planoRestoredPosicion)
  check('pulsar el marcador restaura tambien el balanceo de la camara',
    markerFlow.restored.quaternionRestored > 1 - 1e-6,
    `dot ${markerFlow.restored.quaternionRestored}`)
  check('un paso sin zoom en el JSON conserva el zoom actual', markerFlow.zoomLegacy === true)
  check('el marcador restaura su etiqueta en la pieza', markerFlow.restored.markerLabels >= 1)
  check('los marcadores se pueden borrar', markerFlow.markersAfterRemove === 0)
})

// Portapapeles local entre casos: se copian medidas y corte de un caso y se
// pegan en otro. Pegar dos veces no duplica las mismas cotas.
test('copiar y pegar TODO el caso entre casos', async ({ page }) => {
  const portapapeles = await page.evaluate(() => {
    const v = window.dentalViewer
    const V = v.camera.position.constructor
    localStorage.clear()
    v.clearMarkers()
    v.measure.clear()
    v.model.meshes.forEach((_, index) => v.setMeshVisible(index, true))
    v.setSection({ enabled: false })

    // Estado "preparado": medida, corte, vista con zoom y piezas visibles.
    v.measure.add(new V(1, 2, 3), new V(4, 5, 6), 'ancho')
    v.setSection({ enabled: true, plane: { point: [0, 0, 2], normal: [0, 0, 1] } })
    v.camera.position.set(30, 3, 3)
    v.controls.target.set(1, 2, 0)
    v.camera.zoom = 2.5
    v.camera.updateProjectionMatrix()
    v.controls.update()
    const marcador = v.addMarker({ position: [2, 0, 0], text: 'Paso completo', kind: 'warning' })
    // El estado actual difiere del guardado en el paso: al pegar deben
    // restaurarse por separado.
    v.setMeshVisible(0, false)

    document.querySelector('[data-action="copy-case"]').click()
    const guardado = localStorage.getItem('visor:portapapeles:caso') !== null
    const original = {
      medida: v.measure.serialize()[0],
      corte: v.section.serialize(),
      marcador: JSON.parse(JSON.stringify(marcador)),
      objetos: v.listObjects().map(({ index, visible }) => ({ index, visible })),
    }

    // "Otro caso": se borra todo y se cambia hasta la meta del destino.
    v.doc.meta.caseId = 'caso-destino'
    v.measure.clear()
    v.clearMarkers()
    v.setSection({ enabled: false, plane: { point: [0, 0, 0], normal: [0, 1, 0] } })
    v.model.meshes.forEach((_, index) => v.setMeshVisible(index, true))
    document.querySelector('[data-action="paste-case"]').click()

    const pegado = {
      medidas: v.doc.measurements.length,
      nota: v.doc.measurements[0]?.note ?? '',
      corteActivo: v.section.enabled,
      cortePunto: v.section.gizmo.position.toArray().map((n) => +n.toFixed(2)),
      marcadores: v.doc.markers.length,
      texto: v.doc.markers[0]?.text ?? '',
      clase: v.doc.markers[0]?.kind ?? '',
      posicion: v.doc.markers[0]?.position ?? [],
      vista: v.doc.markers[0]?.view ?? null,
      cortePaso: v.doc.markers[0]?.section ?? null,
      medidasPaso: v.doc.markers[0]?.measurements ?? [],
      objetosPaso: v.doc.markers[0]?.objects ?? [],
      objetosActuales: v.listObjects().map(({ index, visible }) => ({ index, visible })),
      meta: v.doc.meta.caseId,
    }

    localStorage.clear()
    v.clearMarkers()
    v.measure.clear()
    v.setSection({ enabled: false })
    v.model.meshes.forEach((_, index) => v.setMeshVisible(index, true))
    return { guardado, original, pegado }
  })
  check('un solo Copiar guarda el paquete completo en local', portapapeles.guardado === true)
  check('Pegar recupera medidas y corte',
    portapapeles.pegado.medidas === 1 &&
    portapapeles.pegado.nota === 'ancho' &&
    portapapeles.pegado.corteActivo === true &&
    portapapeles.pegado.cortePunto[2] === 2,
    JSON.stringify(portapapeles.pegado))
  check('Pegar recupera el marcador con su nombre, clase y posicion',
    portapapeles.pegado.marcadores === 1 &&
    portapapeles.pegado.texto === 'Paso completo' &&
    portapapeles.pegado.clase === 'warning' &&
    JSON.stringify(portapapeles.pegado.posicion) === JSON.stringify(portapapeles.original.marcador.position),
    `${portapapeles.pegado.texto} / ${portapapeles.pegado.clase}`)
  check('Pegar recupera la vista y el zoom guardados en el marcador',
    Math.abs((portapapeles.pegado.vista?.position?.[0] ?? 0) - 30) < 0.1 &&
    Math.abs((portapapeles.pegado.vista?.zoom ?? 0) - 2.5) < 1e-4,
    JSON.stringify(portapapeles.pegado.vista))
  check('Pegar recupera el corte, medidas y piezas de cada paso',
    portapapeles.pegado.cortePaso?.enabled === true &&
    portapapeles.pegado.medidasPaso?.length === 1 &&
    portapapeles.pegado.medidasPaso[0].note === 'ancho' &&
    portapapeles.pegado.objetosPaso?.length > 0,
    JSON.stringify({ corte: portapapeles.pegado.cortePaso, medidas: portapapeles.pegado.medidasPaso }))
  check('Pegar recupera la visibilidad actual sin mezclarla con la del paso',
    portapapeles.pegado.objetosActuales[0]?.visible === false &&
    portapapeles.pegado.objetosPaso[0]?.visible === true,
    `actual=${JSON.stringify(portapapeles.pegado.objetosActuales[0])} paso=${JSON.stringify(portapapeles.pegado.objetosPaso[0])}`)
  check('Pegar conserva la meta del caso de destino', portapapeles.pegado.meta === 'caso-destino',
    `meta=${JSON.stringify(portapapeles.pegado.meta)}`)
})

// Presentacion editable: subir/bajar cada paso y borrar uno solo, tanto en la
// lista de escritorio como en la del movil.
test('reordenar y borrar marcadores de uno en uno', async ({ page }) => {
  const marcadores = await page.evaluate(() => {
    const v = window.dentalViewer
    v.clearMarkers()
    for (const text of ['a', 'b', 'c']) {
      v.addMarker({ position: [0, 0, 0], text, snapshot: false })
    }
    const leer = () => v.doc.markers.map((m) => m.text).join('')
    const filas = () => [...document.querySelectorAll('#markers-list .marker-item')]

    const inicial = leer()
    filas()[0].querySelector('[aria-label="Bajar este marcador"]').click()
    const trasBajar = leer()
    filas()[2].querySelector('[aria-label="Subir este marcador"]').click()
    const trasSubir = leer()
    filas()[1].querySelector('[aria-label="Eliminar este marcador"]').click()
    const trasBorrar = leer()
    const restantes = v.doc.markers.length
    const accionesPorFila = document.querySelectorAll('#markers-list .marker-item .marker-action').length
    const accionesEnMovil = document.querySelectorAll('#mobile-markers-list .marker-item .marker-action').length
    const deshabilitados = [...document.querySelectorAll('#markers-list .marker-item')].map((fila) => ({
      subir: fila.querySelector('[aria-label="Subir este marcador"]').disabled,
      bajar: fila.querySelector('[aria-label="Bajar este marcador"]').disabled,
    }))
    v.clearMarkers()
    return {
      inicial,
      trasBajar,
      trasSubir,
      trasBorrar,
      restantes,
      accionesPorFila,
      accionesEnMovil,
      deshabilitados,
    }
  })
  check('los pasos empiezan en orden', marcadores.inicial === 'abc', marcadores.inicial)
  check('bajar un paso cambia el orden', marcadores.trasBajar === 'bac', marcadores.trasBajar)
  check('subir un paso cambia el orden', marcadores.trasSubir === 'bca', marcadores.trasSubir)
  check('borrar un paso solo quita ese', marcadores.trasBorrar === 'ba' && marcadores.restantes === 2,
    `${marcadores.trasBorrar} (${marcadores.restantes})`)
  check('cada fila tiene subir, bajar y borrar',
    marcadores.accionesPorFila === 6 && marcadores.accionesEnMovil === 6,
    `escritorio=${marcadores.accionesPorFila} movil=${marcadores.accionesEnMovil}`)
  check('en los extremos se desactiva la flecha que no aplica',
    marcadores.deshabilitados[0].subir === true && marcadores.deshabilitados[0].bajar === false &&
    marcadores.deshabilitados[1].bajar === true,
    JSON.stringify(marcadores.deshabilitados))
})

// El panel de la derecha se adapta al texto: con marcadores cortos se queda
// en el ancho minimo y con uno largo crece (hasta el maximo) y reparte el
// texto en varias lineas en vez de recortarlo con puntos suspensivos.
test('el panel de presentacion se ensancha con los textos largos', async ({ page }, testInfo) => {
  test.skip(esMovil(testInfo), 'en movil la presentacion es un modal aparte')
  const anchos = await page.evaluate(() => {
    const v = window.dentalViewer
    v.clearMarkers()
    const ancho = () => document.getElementById('markers-panel').getBoundingClientRect().width
    const corto = ancho()
    v.addMarker({
      position: [0, 0, 0],
      text: 'Guía quirúrgica: comprobar que el anillo no toque la encía y que el eje del implante coincida con el del diente vecino',
      kind: 'note',
      snapshot: false,
    })
    const largo = ancho()
    const texto = document.querySelector('#markers-list .marker-text')
    const altoTexto = texto.getBoundingClientRect().height
    v.clearMarkers()
    return { corto, largo, altoTexto }
  })
  check('el panel parte del ancho minimo con textos cortos',
    anchos.corto >= 248 && anchos.corto < 300, `${anchos.corto}px`)
  check('el panel crece con un texto largo sin pasar del maximo',
    anchos.largo > 300 && anchos.largo <= 420, `${anchos.largo}px`)
  check('el texto largo se reparte en varias lineas, no se recorta',
    anchos.altoTexto > 30, `${anchos.altoTexto.toFixed(0)}px de alto`)
})
