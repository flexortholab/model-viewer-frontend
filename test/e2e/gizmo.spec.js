// SPDX-License-Identifier: GPL-3.0-or-later
// Gizmo PivotControls del plano de corte: flechas, planos y arcos de un
// cuarto a la vez, sin escala. Por defecto gizmoMode = null: corte activo
// pero gizmo oculto y desadjuntado.
import { test, check, abrirVisor, perfil } from './visor.js'

test.beforeEach(async ({ page }) => {
  check('el visor se instancia y carga el modelo', await abrirVisor(page))
  await page.evaluate(() => {
    const v = window.dentalViewer
    v.setSection({ enabled: true, plane: { point: [0, 0, 0], normal: [1, 0, 0] } })
    v.renderer.render(v.scene, v.camera)
  })
})

test('un solo boton enciende y apaga el gizmo', async ({ page }) => {
  const gizmo = await page.evaluate(() => {
    const v = window.dentalViewer
    const s = v.section
    const snap = () => ({
      mode: s.gizmoMode,
      helper: s._pivotHelper.visible,
      attached: s.pivot.getObject() === s.gizmo,
    })
    const initial = snap()
    s.setGizmoMode('combined')
    const encendido = snap()
    // PivotControls convive con ambas familias: durante un arrastre no se
    // oculta ninguna asa. Basta con comprobar que sigue adjuntado.
    s._dragging = true
    s._dragOwner = 'translate'
    s._applyGizmoMode()
    const arrastrandoFlecha = snap()
    s._dragging = true
    s._dragOwner = 'rotate'
    s._applyGizmoMode()
    const arrastrandoArco = snap()
    s._dragging = false
    s._dragOwner = null
    // Volver a pulsar el mismo lo apaga: escena limpia.
    s.setGizmoMode('combined')
    const apagado = snap()
    s.setGizmoMode(null)
    return { initial, encendido, arrastrandoFlecha, arrastrandoArco, apagado }
  })
  check('el gizmo arranca oculto con el corte activo (gizmoMode null)',
    gizmo.initial.mode === null &&
    gizmo.initial.helper === false && gizmo.initial.attached === false,
    `modo=${gizmo.initial.mode}`)
  check('un solo boton enciende flechas, planos y arcos a la vez',
    gizmo.encendido.mode === 'combined' &&
    gizmo.encendido.helper === true && gizmo.encendido.attached === true)
  check('al arrastrar no se desadjunta ni se oculta ninguna familia',
    gizmo.arrastrandoFlecha.helper === true && gizmo.arrastrandoFlecha.attached === true &&
    gizmo.arrastrandoArco.helper === true && gizmo.arrastrandoArco.attached === true)
  check('volver a pulsar el mismo boton apaga el gizmo',
    gizmo.apagado.mode === null &&
    gizmo.apagado.helper === false && gizmo.apagado.attached === false)
})

// Configuracion PivotControls y geometria real de sus asas: cada asa
// interactiva lleva `userData.tpc`, asi que se lee el inventario sin depender
// de rutas internas del paquete.
test('configuracion PivotControls y geometria de las asas', async ({ page }) => {
  const pivot = await page.evaluate(() => {
    const s = window.dentalViewer.section
    const helper = s._pivotHelper
    const handles = []
    helper.traverse((n) => {
      const info = n.userData?.tpc
      if (!info) return
      const materials = Array.isArray(n.material) ? n.material : [n.material]
      for (const material of materials) {
        if (!material?.color) continue
        handles.push({
          mode: info.mode,
          axis: info.axis,
          color: material.color.getHex(),
          geometry: n.geometry?.type,
          params: n.geometry?.parameters,
        })
      }
    })
    const modes = [...new Set(handles.map((h) => h.mode))].sort()
    const axes = (mode, length) => [...new Set(
      handles.filter((h) => h.mode === mode && h.axis.length === length).map((h) => h.axis),
    )].sort()
    const arcValues = [...new Set(
      handles
        .filter((h) => h.mode === 'rotate' && h.geometry === 'TorusGeometry')
        .map((h) => h.params?.arc),
    )]
    const arrowThickness = [...new Set(
      handles
        .filter((h) => h.mode === 'translate' && h.axis.length === 1 && h.geometry === 'CylinderGeometry')
        .map((h) => h.params?.radiusTop),
    )]
    const ringThickness = [...new Set(
      handles
        .filter((h) => h.mode === 'rotate' && h.geometry === 'TorusGeometry')
        .map((h) => h.params?.tube),
    )]
    const arrowLength = [...new Set(
      handles
        .filter((h) => h.mode === 'translate' && h.axis.length === 1 && h.geometry === 'CylinderGeometry')
        .map((h) => h.params?.height),
    )]
    const ringRadius = [...new Set(
      handles
        .filter((h) => h.mode === 'rotate' && h.geometry === 'TorusGeometry')
        .map((h) => h.params?.radius),
    )]
    const colors = [...new Set(handles.map((h) => h.color))].sort((a, b) => a - b)
    const groups = {
      translate: helper.getObjectByName('translate')?.children.length ?? -1,
      rotate: helper.getObjectByName('rotate')?.children.length ?? -1,
      scale: helper.getObjectByName('scale')?.children.length ?? -1,
    }
    return {
      options: {
        translate: s.pivotOptions.translate,
        rotate: s.pivotOptions.rotate,
        scale: s.pivotOptions.scale,
        space: s.pivotOptions.space,
        size: s.pivotOptions.size,
        fixed: s.pivotOptions.fixed,
        activeAxes: [...s.pivotOptions.activeAxes],
        axisColors: { ...s.pivotOptions.axisColors },
        thickness: s.pivotOptions.thickness,
        length: s.pivotOptions.length,
        rotateArc: s.pivotOptions.rotateArc,
      },
      modes,
      translateAxes: axes('translate', 1),
      planes: axes('translate', 2),
      rotateAxes: axes('rotate', 1),
      scaleHandles: handles.filter((h) => h.mode === 'scale').length,
      groups,
      arcs: arcValues,
      colors,
      arrowThickness,
      ringThickness,
      arrowLength,
      ringRadius,
    }
  })
  const pivotEsperado = {
    translate: true,
    rotate: true,
    scale: false,
    space: 'local',
    size: 1.3,
    fixed: false,
    activeAxes: [true, true, true],
    axisColors: { x: 0xff8093, y: 0x80ff80, z: 0x2ecffe },
    thickness: 1.2,
    length: 1,
    rotateArc: 0.25,
  }
  check('el gizmo usa la configuracion PivotControls pedida',
    JSON.stringify(pivot.options) === JSON.stringify(pivotEsperado),
    JSON.stringify(pivot.options))
  check('mover y rotar estan presentes a la vez, sin escala',
    pivot.modes.join(',') === 'rotate,translate' && pivot.scaleHandles === 0 &&
    pivot.groups.translate === 6 && pivot.groups.rotate === 3 && pivot.groups.scale === 0,
    `modos=${pivot.modes.join('+')} grupos=${pivot.groups.translate}/${pivot.groups.rotate}/${pivot.groups.scale}`)
  check('los tres ejes estan activos en flechas, planos y arcos',
    pivot.translateAxes.join(',') === 'x,y,z' &&
    pivot.planes.join(',') === 'xy,yz,zx' &&
    pivot.rotateAxes.join(',') === 'x,y,z',
    `flechas=${pivot.translateAxes.join(',')} planos=${pivot.planes.join(',')} arcos=${pivot.rotateAxes.join(',')}`)
  check('los arcos son de un cuarto de circulo',
    pivot.arcs.length === 1 && Math.abs(pivot.arcs[0] - Math.PI / 2) < 1e-6,
    `arcos=${pivot.arcs.map((a) => a.toFixed(4)).join(',')}`)
  check('los colores de eje son los pedidos',
    pivot.colors.join(',') === [0xff8093, 0x80ff80, 0x2ecffe].sort((a, b) => a - b).join(','),
    `colores=${pivot.colors.map((c) => c.toString(16)).join(',')}`)
  check('el grosor pedido se refleja en la geometria (thickness 1.2)',
    pivot.arrowThickness.length === 1 && Math.abs(pivot.arrowThickness[0] - 0.09) < 1e-6 &&
    pivot.ringThickness.length === 1 && Math.abs(pivot.ringThickness[0] - 0.048) < 1e-6,
    `flecha=${pivot.arrowThickness.join(',')} arco=${pivot.ringThickness.join(',')}`)
  check('el alcance pedido se refleja en la geometria (length 1)',
    pivot.arrowLength.length === 1 && Math.abs(pivot.arrowLength[0] - 0.62) < 1e-6 &&
    pivot.ringRadius.length === 1 && Math.abs(pivot.ringRadius[0] - 0.45) < 1e-6,
    `flecha=${pivot.arrowLength.join(',')} arco=${pivot.ringRadius.join(',')}`)
})

// Arrastre real de un tirador de plano con el raton: el plano se mueve, la
// orbita se desactiva durante el gesto y se reactiva al soltar.
test('arrastrar un asa de mover con el raton', async ({ page }, testInfo) => {
  test.skip(['movil', 'tablet'].includes(perfil(testInfo)), 'sin raton en movil y tablet')
  const arrastre = await page.evaluate(() => {
    const v = window.dentalViewer
    const s = v.section
    const el = v.renderer.domElement
    const V3 = v.camera.position.constructor
    // Encuadre conocido antes de calcular donde cae el asa: segun lo que haya
    // pasado antes, la camara podia quedar con el gizmo fuera de pantalla (#12).
    v.resize()
    v.frameModel()
    if (!s.gizmoOn) s.setGizmoMode('combined')
    s.updatePivotGizmo()
    v.scene.updateMatrixWorld(true)
    const helper = s._pivotHelper
    const slider = helper.localToWorld(new V3(0.2, 0.2, 0)).project(v.camera)
    const center = helper.getWorldPosition(new V3()).project(v.camera)
    const rect = el.getBoundingClientRect()
    const toClient = (p) => ({
      x: rect.left + (p.x * 0.5 + 0.5) * rect.width,
      y: rect.top + (-p.y * 0.5 + 0.5) * rect.height,
    })
    const start = toClient(slider)
    const middle = toClient(center)
    const dx = start.x - middle.x
    const dy = start.y - middle.y
    const length = Math.hypot(dx, dy) || 1
    return {
      start,
      end: { x: start.x + (dx / length) * 60, y: start.y + (dy / length) * 60 },
      before: s.gizmo.position.toArray(),
    }
  })
  await page.mouse.move(arrastre.start.x, arrastre.start.y)
  await page.mouse.down()
  await page.mouse.move(arrastre.end.x, arrastre.end.y)
  await page.waitForTimeout(200)
  const duranteArrastre = await page.evaluate(() => {
    const s = window.dentalViewer.section
    return {
      dragging: s._dragging,
      owner: s._dragOwner,
      controls: s.controls.enabled,
      point: s.gizmo.position.toArray(),
    }
  })
  await page.mouse.up()
  await page.waitForTimeout(200)
  const trasArrastre = await page.evaluate(() => {
    const s = window.dentalViewer.section
    return { dragging: s._dragging, controls: s.controls.enabled }
  })
  const distanciaArrastre = Math.hypot(
    duranteArrastre.point[0] - arrastre.before[0],
    duranteArrastre.point[1] - arrastre.before[1],
    duranteArrastre.point[2] - arrastre.before[2],
  )
  check('arrastrar un asa de mover desplaza el plano y bloquea la orbita',
    duranteArrastre.dragging === true && duranteArrastre.owner === 'translate' &&
    duranteArrastre.controls === false && distanciaArrastre > 0.05,
    `arrastrando=${duranteArrastre.dragging} dueno=${duranteArrastre.owner} ` +
    `orbita=${duranteArrastre.controls} desplazamiento=${distanciaArrastre.toFixed(2)} mm ` +
    `inicio=${arrastre.start.x.toFixed(0)},${arrastre.start.y.toFixed(0)} ` +
    `fin=${arrastre.end.x.toFixed(0)},${arrastre.end.y.toFixed(0)}`)
  check('al soltar el asa se reactiva la orbita',
    trasArrastre.dragging === false && trasArrastre.controls === true)
})

// Tamano real en pantalla. PivotControls con `fixed: false` deja el tamano
// 1.3 en unidades de mundo; la calibracion del visor lo lleva a la fraccion
// pedida del alto visible (punta de flecha al 16.5%, diametro del 33%).
test('tamano del gizmo en pantalla', async ({ page }) => {
  const gizmoTamano = await page.evaluate(() => {
    const v = window.dentalViewer
    const s = v.section
    const V3 = v.camera.position.constructor
    const alto = v.renderer.domElement.clientHeight
    const altoMundo = (v.camera.top - v.camera.bottom) / v.camera.zoom

    if (!s.gizmoOn) s.setGizmoMode('combined')
    s.updatePivotGizmo()
    v.scene.updateMatrixWorld(true)

    const escala = new V3()
    let radio = 0
    s._pivotHelper.traverse((n) => {
      const info = n.userData?.tpc
      if (!info || info.mode !== 'translate' || info.axis.length !== 1) return
      if (n.geometry?.type !== 'CylinderGeometry') return
      const pos = n.geometry.getAttribute('position')
      if (!pos) return
      n.updateWorldMatrix(true, false)
      n.getWorldScale(escala)
      const k = Math.max(escala.x, escala.y, escala.z)
      for (let i = 0; i < pos.count; i++) {
        const d = k * Math.hypot(pos.getX(i), pos.getY(i), pos.getZ(i))
        if (d > radio) radio = d
      }
    })
    const helperScale = s._pivotHelper.scale.x
    const viewportScale = s._pivotViewportScale
    s.setGizmoMode(null)
    return { radio, helperScale, viewportScale, alto, altoMundo }
  })
  const fraccion = gizmoTamano.radio / gizmoTamano.altoMundo
  check('el gizmo se ve grande en pantalla sin salirse',
    Math.abs(fraccion - 0.165) < 0.005,
    `punta al ${(fraccion * 100).toFixed(1)}% del alto ` +
    `(diametro al ${(fraccion * 200).toFixed(1)}%, alto=${gizmoTamano.alto}px)`)
  check('la calibracion conserva el tamano 1.3 con fixed false',
    Math.abs(gizmoTamano.helperScale - gizmoTamano.viewportScale * 1.3) < 1e-6,
    `helper=${gizmoTamano.helperScale.toFixed(4)} ` +
    `calibracion=${gizmoTamano.viewportScale.toFixed(4)}`)
})
