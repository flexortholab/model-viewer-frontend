// SPDX-License-Identifier: GPL-3.0-or-later
// Presentacion: dialogo de marcador con sus clases, colores por clase y
// marcadores que guardan y restauran vista, corte y zoom.
import { test, check, abrirVisor } from './visor.js'

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
    markerFlow.saved.viewCaptured && markerFlow.saved.zoomSaved)
  check('pulsar el marcador restaura vista, objetivo, zoom y corte',
    markerFlow.restored.cameraRestored && markerFlow.restored.targetRestored &&
    markerFlow.restored.zoomRestored && markerFlow.restored.sectionRestored &&
    markerFlow.restored.planoRestoredPosicion)
  check('un paso sin zoom en el JSON conserva el zoom actual', markerFlow.zoomLegacy === true)
  check('el marcador restaura su etiqueta en la pieza', markerFlow.restored.markerLabels >= 1)
  check('los marcadores se pueden borrar', markerFlow.markersAfterRemove === 0)
})
