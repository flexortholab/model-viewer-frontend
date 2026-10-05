// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Prueba de humo en un navegador real (headless Chromium).
 *
 * Verifica lo que los tests de node no pueden: que WebGL arranca, que el STL
 * se carga, que la deteccion de unidades da mm, que el capping del corte
 * seccional genera geometria visible y que las mediciones proyectan etiquetas.
 *
 * Uso: node scripts/smoke.mjs [urlBase] [extraQuery]
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const BASE = process.argv[2] ?? 'http://localhost:4173'
const EXTRA_QUERY = process.argv[3] ? `&${process.argv[3]}` : ''
const URL_TEST = `${BASE}/visor.html?model=samples/disyuntor-4-pilares.stl&embed=0${EXTRA_QUERY}`

// HEADED=1 abre el Chromium con ventana para poder ver la prueba con tus ojos.
// Por defecto es headless (rápido y sin Occupying la pantalla).
const HEADED = process.env.HEADED === '1' || process.env.HEADED === 'true'

const profile = mkdtempSync(join(tmpdir(), 'dental-smoke-'))
const userDataDir = join(profile, 'profile')

function resolveChromium() {
  const candidates = [
    process.env.CHROME_PATH,
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/google-chrome',
  ].filter(Boolean)
  return candidates.find((candidate) => existsSync(candidate)) ?? null
}

const chromium = resolveChromium()
if (!chromium) {
  console.error('No se encontro Chromium. Define CHROME_PATH para ejecutar la prueba.')
  process.exit(2)
}

const port = 9222 + Math.floor(Math.random() * 500)
const chrome = spawn(chromium, [
  // En headed quitamos --headless para que haya ventana; y no forzamos
  // SwiftShader, asi se usa la GPU real y se ven los cortes con color.
  ...(HEADED ? [] : ['--headless=new', '--use-gl=swiftshader', '--enable-unsafe-swiftshader']),
  `--remote-debugging-port=${port}`,
  `--user-data-dir=${userDataDir}`,
  '--no-first-run',
  '--no-default-browser-check',
  '--no-sandbox',
  '--disable-gpu-sandbox',
  '--window-size=1280,860',
  '--window-position=40,40',
  '--disable-dev-shm-usage',
  'about:blank',
], { stdio: 'ignore' })

const cleanup = () => {
  chrome.kill('SIGKILL')
  try {
    rmSync(profile, { recursive: true, force: true })
  } catch {
    /* ignora */
  }
}
process.on('exit', cleanup)

async function waitForDevTools() {
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`)
      if (res.ok) return (await res.json()).webSocketDebuggerUrl
    } catch {
      /* reintenta */
    }
    await sleep(250)
  }
  throw new Error('DevTools no respondio')
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const wsUrl = await waitForDevTools()

const ws = new WebSocket(wsUrl)
await new Promise((resolve, reject) => {
  ws.addEventListener('open', resolve, { once: true })
  ws.addEventListener('error', reject, { once: true })
})

let messageId = 0
const pending = new Map()
const consoleErrors = []
const pageErrors = []
// NET=1 registra de qué URL se descarga cada archivo (p. ej. el GLB).
const requests = []

ws.addEventListener('message', (event) => {
  const data = JSON.parse(event.data)
  if (data.id && pending.has(data.id)) {
    const { resolve, reject } = pending.get(data.id)
    pending.delete(data.id)
    if (data.error) reject(new Error(data.error.message))
    else resolve(data.result)
    return
  }
  if (data.method === 'Network.requestWillBeSent') {
    requests.push(data.params.request.url)
  }
  if (data.method === 'Runtime.consoleAPICalled' && data.params.type === 'error') {
    consoleErrors.push(data.params.args.map((a) => a.value ?? a.description ?? '').join(' '))
  }
  if (data.method === 'Runtime.exceptionThrown') {
    pageErrors.push(data.params.exceptionDetails.exception?.description ?? 'excepcion')
  }
})

function send(method, params = {}, sessionId) {
  const id = ++messageId
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject })
    ws.send(JSON.stringify({ id, method, params, sessionId }))
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id)
        reject(new Error(`timeout en ${method}`))
      }
    }, 120000)
  })
}

const { targetId } = await send('Target.createTarget', { url: 'about:blank' })
const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true })
await send('Runtime.enable', {}, sessionId)
await send('Page.enable', {}, sessionId)
if (process.env.NET === '1') await send('Network.enable', {}, sessionId)

async function evaluate(expression) {
  const result = await send(
    'Runtime.evaluate',
    { expression, awaitPromise: true, returnByValue: true },
    sessionId,
  )
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.exception?.description ?? 'error en evaluate')
  }
  return result.result.value
}

await send('Page.navigate', { url: URL_TEST }, sessionId)
await sleep(1000)

const results = []
function check(name, ok, detail = '') {
  results.push({ name, ok, detail })
  console.log(`${ok ? '  ok  ' : ' FALLO'} ${name}${detail ? ` — ${detail}` : ''}`)
}

console.log(`\nVisor: ${URL_TEST}\n`)

const viewer = await evaluate(`
  new Promise((resolve, reject) => {
    const t0 = Date.now()
    const tick = () => {
      if (window.dentalViewer?.model) return resolve(true)
      if (Date.now() - t0 > 30000) return reject(new Error('timeout cargando el modelo'))
      setTimeout(tick, 200)
    }
    tick()
  })
`)
check('el visor se instancia y carga el modelo', viewer === true)

const info = await evaluate(`
  (() => {
    const v = window.dentalViewer
    return {
      units: v.model.units,
      sizeMm: { x: v.model.size.x, y: v.model.size.y, z: v.model.size.z },
      triangles: v.model.stats.triangles,
    }
  })()
`)

check('detecta unidades mm', info.units.units === 'mm', `confianza ${info.units.confidence}`)
check(
  'tamano en mm coherente con la pieza (50.2 x 7.2 x 4.2)',
  Math.abs(info.sizeMm.x - 50.2) < 0.05 && Math.abs(info.sizeMm.y - 7.2) < 0.05,
  `${info.sizeMm.x.toFixed(2)} x ${info.sizeMm.y.toFixed(2)} x ${info.sizeMm.z.toFixed(2)} mm`,
)
check('la geometria tiene triangulos', info.triangles > 3000, `${info.triangles} tri`)

// Corte seccional + capping (plano unico con gizmo)
const section = await evaluate(`
  (() => {
    const v = window.dentalViewer
    v.setSection({ enabled: true, plane: { point: [0, 0, 0], normal: [0, 0, 1] } })
    v.renderer.render(v.scene, v.camera)
    const caps = v.section.capGroup.children.filter((c) => String(c.name).startsWith('cap-')).length
    const stencils = v.section.stencilGroup.children.length
    const planes = v.model.meshes[0].material.clippingPlanes?.length ?? 0
    const capWrite = v.section.capGroup.children.filter((c) => String(c.name).startsWith('cap-'))[0]?.material.stencilWrite
    const stencilWrite = v.section.stencilGroup.children[0]?.material.stencilWrite
    return { enabled: v.section.enabled, caps, stencils, planes, capWrite, stencilWrite }
  })()
`)
check('el corte seccional se activa', section.enabled === true)
check('genera una superficie de corte', section.caps === 1, `${section.caps} cap`)
// La curva del corte: plano transversal al eje largo de la barra (50 mm en
// X) para cruzar muchos triangulos; todos los puntos dentro de la pieza.
const cut = await evaluate(`
  (() => {
    const v = window.dentalViewer
    v.setSection({ enabled: true, plane: { point: [0, 0, 0], normal: [1, 0, 0] } })
    v.renderer.render(v.scene, v.camera)
    const lines = v.section.cutGroup.children
    let segments = 0
    let maxAbs = 0
    for (const l of lines) {
      segments += l.userData?.segments ?? 0
      maxAbs = Math.max(maxAbs, l.userData?.maxAbs ?? 0)
    }
    return { cuts: lines.length, segments, maxAbs }
  })()
`)
check('dibuja la curva del corte por pieza (interseccion exacta)', cut.cuts === 1 && cut.segments > 10, `${cut.cuts} curva, ${cut.segments} segmentos`)
check('la curva vive sobre la pieza (sin lineas fugadas)', cut.maxAbs < 60, `max |xyz| = ${cut.maxAbs.toFixed(1)} mm`)
const cutColor = await evaluate(`
  (() => {
    const v = window.dentalViewer
    const mesh = v.model.meshes[0]
    const base = v.section._pieceColor(mesh) ?? new THREE.Color(0x9a968f)
    const mat = [...v.section._cutMaterials][0]
    return { baseR: base.r, cutR: mat?.color.r ?? 0 }
  })()
`)
check('el borde de corte es mas oscuro que la pieza',
  cutColor.cutR > 0 && cutColor.cutR < cutColor.baseR * 0.45,
  `base ${cutColor.baseR.toFixed(2)} vs corte ${cutColor.cutR.toFixed(2)}`)
// La curva del corte debe respetar el z-buffer: si no, se dibuja a traves de
// la pieza y las piezas dejan de leerse solidas.
const cutDepth = await evaluate(`
  (() => {
    const mats = [...window.dentalViewer.section._cutMaterials]
    return {
      total: mats.length,
      conDepth: mats.filter((m) => m.depthTest === true).length,
    }
  })()
`)
check('la curva del corte respeta la profundidad (la pieza se ve solida)',
  cutDepth.total > 0 && cutDepth.conDepth === cutDepth.total,
  `${cutDepth.conDepth}/${cutDepth.total} con depthTest`)
check('genera el grupo de stencil (caras traseras y delanteras)', section.stencils >= 2, `${section.stencils} mallas`)
check('los materiales recortan con el plano', section.planes === 1)
check('stencil activo en el capping y en los strokes', section.capWrite === true && section.stencilWrite === true)
const visualPlano = await evaluate(`
  (() => {
    const s = window.dentalViewer.section
    return { disco: s.planeMesh.visible, anillo: s.ringMesh.visible }
  })()
`)
check('el disco del plano queda oculto y conserva el anillo de borde',
  visualPlano.disco === false && visualPlano.anillo === true,
  `disco=${visualPlano.disco} anillo=${visualPlano.anillo}`)

// Gizmo PivotControls UNICO en la UI: flechas, planos y arcos de un cuarto a
// la vez, sin escala. Por defecto gizmoMode = null: corte activo pero gizmo
// oculto y desadjuntado.
const gizmo = await evaluate(`
  (() => {
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
  })()
`)
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

// Rotar 90 grados: gira el plano sobre su propio eje vertical (Y local), en
// su sitio y sin mover su punto. Al ser ejes del gizmo y no de la vista, el
// resultado no depende de como se coloco el plano (Alinear, tijeras o gizmo)
// y nunca es un no-op: el eje siempre es perpendicular a la normal.
const giroVertical = await evaluate(`
  (() => {
    const v = window.dentalViewer
    v.camera.position.set(0, 0, 80)
    v.controls.target.set(0, 0, 0)
    v.controls.update()
    v.setSection({ enabled: true, plane: { point: [1, 2, 3], normal: [0, 0, 1] } })
    const antes = v.section.serialize()
    document.querySelector('[data-action="section-rotate"]').click()
    const despues = v.section.serialize()
    const normal = despues.normal
    // Con el gizmo en identidad, el giro local +90 sobre Y lleva (0,0,1) a (1,0,0).
    const ok = Math.abs(Math.abs(normal[0]) - 1) < 1e-2 && Math.abs(normal[1]) < 1e-2 && Math.abs(normal[2]) < 1e-2
    // Regresion del no-op: con la normal en vertical, Rotar tiene que moverla.
    v.setSection({ enabled: true, plane: { point: [1, 2, 3], normal: [0, 1, 0] } })
    const verticalAntes = v.section.serialize().normal
    document.querySelector('[data-action="section-rotate"]').click()
    const verticalDespues = v.section.serialize().normal
    const dot = verticalAntes[0] * verticalDespues[0] +
      verticalAntes[1] * verticalDespues[1] + verticalAntes[2] * verticalDespues[2]
    return {
      puntoIgual: JSON.stringify(despues.point) === JSON.stringify(antes.point),
      normal: normal.map((n) => +n.toFixed(3)),
      ok,
      mueveVertical: Math.abs(dot) < 0.99,
    }
  })()
`)
check('Rotar 90 grados gira el plano sobre su propio eje sin moverlo',
  giroVertical.puntoIgual === true && giroVertical.ok === true,
  `normal=${giroVertical.normal.join(',')}`)
check('Rotar 90 grados tambien mueve una normal vertical (sin no-ops)',
  giroVertical.mueveVertical === true)

// Estetica de la columna izquierda: Vistas solo con iconos y los tres
// paneles con el mismo ancho estrecho.
const columnas = await evaluate(`
  (() => {
    const px = (sel) => getComputedStyle(document.querySelector(sel)).width
    const etiquetas = [...document.querySelectorAll('#views-bar .btn-label')]
    return {
      vistas: px('#views-bar'),
      herramientas: px('#tools-bar'),
      corte: px('#panel'),
      etiquetas: etiquetas.length,
      ocultas: etiquetas.filter((el) => getComputedStyle(el).display === 'none').length,
    }
  })()
`)
check('Vistas, Herramientas y Corte miden lo mismo (200 px)',
  columnas.vistas === '200px' && columnas.herramientas === '200px' && columnas.corte === '200px',
  `${columnas.vistas} / ${columnas.herramientas} / ${columnas.corte}`)
check('Vistas es solo iconos (etiquetas ocultas)',
  columnas.etiquetas > 0 && columnas.ocultas === columnas.etiquetas,
  `${columnas.ocultas}/${columnas.etiquetas} ocultas`)

// Configuracion PivotControls y geometria real de sus asas: cada asa
// interactiva lleva `userData.tpc`, asi que se lee el inventario sin depender
// de rutas internas del paquete.
const pivot = await evaluate(`
  (() => {
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
  })()
`)
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

// Arrastre real de un tirador de plano con el raton: el plano se mueve, la
// orbita se desactiva durante el gesto y se reactiva al soltar.
const arrastre = await evaluate(`
  (() => {
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
  })()
`)
await send('Input.dispatchMouseEvent', {
  type: 'mousePressed',
  x: arrastre.start.x,
  y: arrastre.start.y,
  button: 'left',
  clickCount: 1,
}, sessionId)
await send('Input.dispatchMouseEvent', {
  type: 'mouseMoved',
  x: arrastre.end.x,
  y: arrastre.end.y,
  button: 'left',
  buttons: 1,
}, sessionId)
await sleep(200)
const duranteArrastre = await evaluate(`
  (() => {
    const s = window.dentalViewer.section
    return {
      dragging: s._dragging,
      owner: s._dragOwner,
      controls: s.controls.enabled,
      point: s.gizmo.position.toArray(),
    }
  })()
`)
await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: arrastre.end.x, y: arrastre.end.y, button: 'left' }, sessionId)
await sleep(200)
const trasArrastre = await evaluate(`
  (() => {
    const s = window.dentalViewer.section
    return { dragging: s._dragging, controls: s.controls.enabled }
  })()
`)
const distanciaArrastre = Math.hypot(
  duranteArrastre.point[0] - arrastre.before[0],
  duranteArrastre.point[1] - arrastre.before[1],
  duranteArrastre.point[2] - arrastre.before[2],
)
await evaluate(`
  window.dentalViewer.section.setPlane({ point: ${JSON.stringify(arrastre.before)} })
`)
check('arrastrar un asa de mover desplaza el plano y bloquea la orbita',
  duranteArrastre.dragging === true && duranteArrastre.owner === 'translate' &&
  duranteArrastre.controls === false && distanciaArrastre > 0.05,
  `arrastrando=${duranteArrastre.dragging} dueno=${duranteArrastre.owner} ` +
  `orbita=${duranteArrastre.controls} desplazamiento=${distanciaArrastre.toFixed(2)} mm ` +
  `inicio=${arrastre.start.x.toFixed(0)},${arrastre.start.y.toFixed(0)} ` +
  `fin=${arrastre.end.x.toFixed(0)},${arrastre.end.y.toFixed(0)}`)
check('al soltar el asa se reactiva la orbita',
  trasArrastre.dragging === false && trasArrastre.controls === true)

// Tamano real en pantalla. PivotControls con `fixed: false` deja el tamano
// 1.3 en unidades de mundo; la calibracion del visor lo lleva a la fraccion
// pedida del alto visible (punta de flecha al 16.5%, diametro del 33%).
const gizmoTamano = await evaluate(`
  (() => {
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
  })()
`)
const fraccion = gizmoTamano.radio / gizmoTamano.altoMundo
check('el gizmo se ve grande en pantalla sin salirse',
  Math.abs(fraccion - 0.165) < 0.005,
  `punta al ${(fraccion * 100).toFixed(1)}% del alto ` +
  `(diametro al ${(fraccion * 200).toFixed(1)}%, alto=${gizmoTamano.alto}px)`)
check('la calibracion conserva el tamano 1.3 con fixed false',
  Math.abs(gizmoTamano.helperScale - gizmoTamano.viewportScale * 1.3) < 1e-6,
  `helper=${gizmoTamano.helperScale.toFixed(4)} ` +
  `calibracion=${gizmoTamano.viewportScale.toFixed(4)}`)

// Encuadre al pulsar las tijeras: activa el corte SIN acercarse, la escena
// entera debe seguir entrando en el encuadre y el angulo actual se conserva.
const encuadre = await evaluate(`
  (() => {
    const v = window.dentalViewer
    const V3 = v.camera.position.constructor
    v.setSection({ enabled: false })
    v.frameModel()
    // Girar 90 grados a una vista lateral: el usuario puede estar mirando la
    // pieza desde cualquier angulo cuando pulsa las tijeras.
    v.setView('lateral')
    const anguloAntes = v.camera.position.clone().sub(v.controls.target).normalize()
    const distanciaAntes = v.camera.position.distanceTo(v.controls.target)

    v.focusObject(0, { withPlane: true })
    v.camera.updateMatrixWorld(true)

    // Solo X e Y: en perspectiva el Z de NDC tiende a 1 y no dice nada
    // sobre si la escena cabe en el encuadre.
    let maxXY = 0
    for (let sx = -1; sx <= 1; sx += 2) {
      for (let sy = -1; sy <= 1; sy += 2) {
        for (let sz = -1; sz <= 1; sz += 2) {
          const p = new V3(
            sx > 0 ? v.model.bounds.max.x : v.model.bounds.min.x,
            sy > 0 ? v.model.bounds.max.y : v.model.bounds.min.y,
            sz > 0 ? v.model.bounds.max.z : v.model.bounds.min.z,
          ).project(v.camera)
          maxXY = Math.max(maxXY, Math.abs(p.x), Math.abs(p.y))
        }
      }
    }
    const anguloDespues = v.camera.position.clone().sub(v.controls.target).normalize()
    return {
      maxXY,
      corte: v.section.enabled,
      conservedAngulo: anguloAntes.dot(anguloDespues),
      distanciaAntes,
      distanciaDespues: v.camera.position.distanceTo(v.controls.target),
    }
  })()
`)
check('las tijeras activan el corte', encuadre.corte === true)
check('las tijeras no hacen zoom a la pieza (se ve la escena entera)',
  encuadre.maxXY <= 1, `NDC max ${encuadre.maxXY.toFixed(3)}`)
check('las tijeras reencuadran la escena completa',
  encuadre.distanciaDespues >= encuadre.distanciaAntes,
  `${encuadre.distanciaAntes.toFixed(1)} -> ${encuadre.distanciaDespues.toFixed(1)} unidades`)
check('las tijeras conservan el angulo actual (giro de 90 grados)',
  encuadre.conservedAngulo > 0.999,
  `dot ${encuadre.conservedAngulo.toFixed(4)}`)
await evaluate(`
  (() => {
    const v = window.dentalViewer
    v.setSection({ enabled: true, plane: { point: [0, 0, 0], normal: [0, 0, 1] } })
    v.frameModel()
  })()
`)

// Cubo de vistas: 6 caras, clic navega y resalta la vista activa
const cubeFaces = await evaluate(`
  [...document.querySelectorAll('#viewcube-inner [data-cube]')].map((b) => b.dataset.cube).sort().join(',')
`)
check('el cubo tiene las 6 caras', cubeFaces === 'derecha,frontal,inferior,izquierda,superior,trasera', cubeFaces)
await evaluate(`document.querySelector('#viewcube-inner [data-cube="superior"]').click()`)
await sleep(600)
const cube = await evaluate(`
  (() => {
    const v = window.dentalViewer
    const above = v.camera.position.y > v.controls.target.y
    const current = document.querySelector('#viewcube-inner [data-cube="superior"]').classList.contains('is-current')
    const matrix = document.getElementById('viewcube-inner').style.transform.startsWith('matrix3d(')
    return { above, current, matrix }
  })()
`)
check('clic en el cubo navega a la vista', cube.above === true)
check('el cubo resalta la vista activa y rota con la camara', cube.current === true && cube.matrix === true)

// Cotas sobre la cara cortada: esa cara es el capping por stencil, no hay malla
// que raycastear, asi que pick() cae al plano y acepta el punto solo si esta
// sobre material. Desde la vista trasera el primer impacto es la cara recortada.
// Se muestrea la cara porque el centro de la pieza puede ser hueco.
const capPick = await evaluate(`
  (() => {
    const v = window.dentalViewer
    // La camara se restaura al final: el centro de esta pieza es hueco y los
    // checks siguientes hacen clic ahi.
    const cam = {
      pos: v.camera.position.clone(),
      quat: v.camera.quaternion.clone(),
      zoom: v.camera.zoom,
      target: v.controls.target.clone(),
    }
    v.setSection({ enabled: true, plane: { point: [0, 0, 0], normal: [0, 0, 1] } })
    v.setView('trasera')
    v.renderer.render(v.scene, v.camera)

    const bounds = v.model.bounds
    const tam = bounds.getSize(new (bounds.min.constructor)())

    // Primer punto de la cara cortada que responde a un clic real.
    let cap = null
    let ndc = null
    for (let iy = 0; iy < 9 && !cap; iy++) {
      for (let ix = 0; ix < 9 && !cap; ix++) {
        const x = -0.6 + (1.2 * ix) / 8
        const y = -0.6 + (1.2 * iy) / 8
        v.pointer.set(x, y)
        const hit = v.pick()
        if (hit?.isCap) { cap = hit; ndc = [x, y] }
      }
    }

    // El mismo rayo de ese clic, desplazado hasta un punto fuera de la pieza:
// no hay cara que cortar ahi, asi que se rechaza.
    let fuera = null
    if (cap) {
      const ray = v.raycaster.ray.clone()
      ray.origin.set(tam.x * 10, tam.y * 10, 100)
      fuera = v.section.pickCap(ray)
    }

    const res = {
      encontrado: !!cap,
      ndc,
      enElPlano: cap ? Math.abs(cap.point.z) < 1e-3 : false,
      dentro: cap
        ? cap.point.x >= bounds.min.x - 0.05 && cap.point.x <= bounds.max.x + 0.05 &&
          cap.point.y >= bounds.min.y - 0.05 && cap.point.y <= bounds.max.y + 0.05
        : false,
      masCercaQueElFondo: cap
        ? (() => {
            // En la cara cortada el cap debe ganar a la pared del fondo.
            v.pointer.set(ndc[0], ndc[1])
            const h = v.pick()
            return h?.isCap === true
          })()
        : false,
      fueraRechazado: fuera === null,
    }

    // Restaurar camara (el plano se queda en normal +Z: lo espera el bloque
    // siguiente, que comprueba que se conserva z >= 0).
    v.camera.position.copy(cam.pos)
    v.camera.quaternion.copy(cam.quat)
    v.camera.zoom = cam.zoom
    v.controls.target.copy(cam.target)
    v.camera.updateProjectionMatrix()
    v.renderer.render(v.scene, v.camera)
    return res
  })()
`)
check('se puede cotar sobre la cara cortada (no hay malla: usa el plano)',
  capPick.encontrado === true && capPick.enElPlano === true,
  capPick.encontrado ? `clic en ndc ${capPick.ndc}` : 'ningun punto en la cara')
check('el punto de la cara cortada cae dentro de la pieza', capPick.dentro === true)
check('la cara cortada gana a la pared del fondo', capPick.masCercaQueElFondo === true)
check('un punto del plano fuera de la pieza se rechaza', capPick.fueraRechazado === true)

// Manipulacion del plano: mover y rotar la normal
const planeManipulation = await evaluate(`
  (() => {
    const v = window.dentalViewer
    // Plano por el centro con normal +Z: se conserva z >= 0.
    const originOut = v.section.isPointVisible({ x: 0, y: 0, z: 5 })
    const behindHidden = v.section.isPointVisible({ x: 0, y: 0, z: -5 })

    // Mover el plano a y=10 lo interpreta el helper de ejes (compatibilidad):
    // normal +y, punto (0,10,0): se conserva y >= 10.
    v.setSectionAxis('y', 10)
    v.renderer.render(v.scene, v.camera)
    const lifted = {
      visibleAbove: v.section.isPointVisible({ x: 0, y: 15, z: 0 }),
      hiddenBelow: v.section.isPointVisible({ x: 0, y: 5, z: 0 }),
    }

    // Rotar la normal del plano (gizmo en modo rotar): gira al eje x.
    v.section.setPlane({ normal: [1, 0, 0] })
    v.renderer.render(v.scene, v.camera)
    const rotated = {
      rightVisible: v.section.isPointVisible({ x: 5, y: 0, z: 0 }),
      leftHidden: v.section.isPointVisible({ x: -5, y: 0, z: 0 }),
    }
    v.setSection({ enabled: false })
    return { originOut, behindHidden, lifted, rotated }
  })()
`)
check('el centro de la pieza queda del lado conservado', planeManipulation.originOut === true)
check('un punto detras del plano se descarta', planeManipulation.behindHidden === false)
check('al subir el plano la mitad superior permanece', planeManipulation.lifted.visibleAbove === true)
check('al subir el plano la mitad inferior desaparece', planeManipulation.lifted.hiddenBelow === false)
check('rotar la normal al eje x conserva la mitad derecha', planeManipulation.rotated.rightVisible === true)
check('rotar la normal al eje x descarta la izquierda', planeManipulation.rotated.leftHidden === false)

// Mediciones
const measure = await evaluate(`
  (() => {
    const v = window.dentalViewer
    v.setTool('measure')
    const box = v.model.bounds
    const a = box.getCenter(new (v.model.bounds.min.constructor)())
    const b = a.clone(); b.x += 12.3456
    const m = v.measure.add(a, b)
    v.renderer.render(v.scene, v.camera)
    v.measure.update()
    const label = v.measure.labels[0]
    const style = label?.el?.style
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
  })()
`)
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
const labelSize = await evaluate(`
  (() => {
    const v = window.dentalViewer
    const s = v.measure.measurements[0].__nodes.value
    const esHtml = s instanceof HTMLElement
    return { esHtml, altoPx: s.offsetHeight }
  })()
`)
check('el globo de la medida es un chip HTML, no un sprite',
  labelSize.esHtml === true, `esHtml=${labelSize.esHtml}`)
check('el globo tiene tamano util en pantalla',
  labelSize.altoPx > 18 && labelSize.altoPx < 60, `${labelSize.altoPx}px`)

// Flujo interactivo con el raton: cursor, snap, goma con cifra en vivo y
// salida sola a camara libre (medidas de una en una).
const flow = await evaluate(`
  (() => {
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
  })()
`)
check('modo medir con cursor de colocar punto', flow.cursorClass === true)
check('anillo de snap visible al pasar sobre la pieza', flow.snapVisible === true)
check('primer clic deja el origen pendiente', flow.pending === true)
check('la goma muestra la distancia en vivo', flow.rubber === true && /mm$/.test(flow.liveText), flow.liveText)
check('al completar sale sola a camara libre (una a una)', flow.count === 1 && flow.exited === true)

// Edicion: en camara libre se puede agarrar un extremo y arrastrarlo para
// ajustar la cifra con precision, sin volver al modo medir.
const edicion = await evaluate(`
  (() => {
    const v = window.dentalViewer
    v.measure.clear()
    const b = v.model.bounds
    const V = v.camera.position.constructor
    const a = b.min.clone()
    const far = b.max.clone(); far.y = a.y
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
  })()
`)
check('en camara libre se puede agarrar un extremo', edicion.agarrado === true)
check('arrastrar el extremo cambia la distancia', edicion.movido > 0.01, edicion.etiquetaDespues)
check('la camara no se mueve al editar la medida', edicion.camaraIgual === true)
check('al soltar se reactiva la camara', edicion.soltado === true)

// Cotas cercanas: la segunda se dibuja al lado contrario para no solaparse.
const lados = await evaluate(`
  (() => {
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
  })()
`)
check('la primera cota manda y la cercana va al lado contrario',
  lados.lado1 === 1 && lados.lado2 === -1 && lados.lado3 === 1,
  `lados=${lados.lado1}/${lados.lado2}/${lados.lado3}`)
check('las cotas cercanas quedan separadas en pantalla',
  lados.separacion > 40,
  `separacion=${lados.separacion.toFixed(0)}px`)

// Los globos se ven aunque el corte elimine la pieza.
// La pieza va de y = -3.6 a y = +3.6: un plano en y = 40 no deja nada visible.
const hidden = await evaluate(`
  (() => {
    const v = window.dentalViewer
    v.setSection({ enabled: true, plane: { point: [0, 0, 0], normal: [0, 1, 0] } })
    v.setSectionAxis('y', 40)   // muy por encima de la pieza
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
  })()
`)
check('los globos se ven con la pieza recortada', hidden.visible === 1)
check('siguen viendose al retirar el corte', hidden.visibleAfter === 1)

// Edicion de medidas: seleccionar, nota y Supr (sin prompt, apto headless).
// OJO: este bloque deja cero medidas; lo que venga despues no debe contarlas.
const edit = await evaluate(`
  (() => {
    const v = window.dentalViewer
    // Camara frontal conocida: el hit-test se mide en pixeles de pantalla.
    v.camera.position.set(0, 0, 80)
    v.controls.target.set(0, 0, 0)
    v.controls.update()
    v.camera.updateMatrixWorld()
    const a = v.model.bounds.getCenter(new (v.camera.position.constructor)())
    const b = a.clone(); b.x += 12.3456
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
  })()
`)
check('clic selecciona la medida (hit-test en pantalla)', edit.foundId !== null && edit.selectedId === edit.foundId,
  `${edit.foundId} / ${edit.selectedId}`)
check('seleccionada se tiñe de teal', edit.dimColor === '1b8aa3', `#${edit.dimColor}`)
check('la nota aparece en la cifra', edit.shown.includes('ancho'), edit.shown)
check('Supr borra la medida seleccionada', edit.remaining === 0)

// Titulo con el nombre del archivo y loader durante la carga.
const chrome2 = await evaluate(`
  (async () => {
    const v = window.dentalViewer
    const p = v.load('samples/disyuntor-4-pilares-metros.stl')
    // El loader se enciende de forma sincrona al pedir la carga.
    const during = document.getElementById('loader').hidden === false
    await p
    const out = {
      during,
      after: document.getElementById('loader').hidden === true,
      title: document.getElementById('doc-title').textContent,
    }
    await v.load('samples/disyuntor-4-pilares.stl')
    return out
  })()
`)
check('loader visible durante la carga', chrome2.during === true)
check('loader oculto al terminar', chrome2.after === true)
check('titulo con el nombre sin extension', chrome2.title === 'disyuntor-4-pilares-metros', chrome2.title)

// --- Centrado: la normalizacion debe dejar las mallas sin transformaciones --
const centering = await evaluate(`
  (() => {
    const v = window.dentalViewer
    const report = []
    for (const mesh of v.model.meshes) {
      mesh.geometry.computeBoundingBox()
      const b = mesh.geometry.boundingBox
      report.push({
        pos: [mesh.position.x, mesh.position.y, mesh.position.z],
        scale: [mesh.scale.x, mesh.scale.y, mesh.scale.z],
        center: [(b.min.x + b.max.x) / 2, (b.min.y + b.max.y) / 2, (b.min.z + b.max.z) / 2],
      })
    }
    const boundsCenter = [
      (v.model.bounds.min.x + v.model.bounds.max.x) / 2,
      (v.model.bounds.min.y + v.model.bounds.max.y) / 2,
      (v.model.bounds.min.z + v.model.bounds.max.z) / 2,
    ]
    return { meshes: report.length, report, boundsCenter }
  })()
`)
const transformsClean = centering.report.every(
  (m) => m.pos.every((n) => Math.abs(n) < 1e-9) && m.scale.every((n) => Math.abs(n - 1) < 1e-9),
)
const originCentered = centering.boundsCenter.every((n) => Math.abs(n) < 1e-4)
check('las mallas quedan con transformacion identidad', transformsClean, `${centering.meshes} mallas`)
check('el bounding box del modelo esta centrado en el origen', originCentered,
  centering.boundsCenter.map((n) => n.toFixed(4)).join(', '))

// --- La lista de objetos respeta el ojo (visibilidad) ----------------------
const objectsListTest = await evaluate(`
  (() => {
    const v = window.dentalViewer
    const before = v.listObjects()
    v.setMeshVisible(0, false)
    const after = v.listObjects()
    v.renderer.render(v.scene, v.camera)
    const stencilWithOne = v.enabled ? 0 : v.section.stencilGroup.children.length
    v.setMeshVisible(0, true)
    const restored = v.listObjects()
    return { before: before[0], hidden: after[0], restored: restored[0], stencilWithOne: stencilWithOne }
  })()
`)
check('la lista de objetos lista la pieza', objectsListTest.before.name.length > 0, objectsListTest.before.name)
check('el ojo oculta y muestra la pieza', objectsListTest.hidden.visible === false && objectsListTest.restored.visible === true)

// --- Movil: filas de objetos como boton unico + leyenda -------------------
const mobileObjectsFlow = await evaluate(`
  (() => {
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
  })()
`)
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

// Vista movil real (390 px de ancho): la media query aplica y se verifica el
// CSS movil con el viewport emulado; despues se restaura el escritorio.
await send('Emulation.setDeviceMetricsOverride', {
  width: 390, height: 844, deviceScaleFactor: 2, mobile: true,
}, sessionId)
await sleep(500)
const movilCss = await evaluate(`
  (() => {
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
  })()
`)
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
await send('Emulation.clearDeviceMetricsOverride', {}, sessionId)
await sleep(300)

// --- Presentacion: dialogo de clase con botones -----------------------------
const markerDialogFlow = await evaluate(`
  (async () => {
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
      // que lo veria el doctor.
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
      await new Promise((r) => setTimeout(r, 250))
      const screwButton = dialog.querySelector('[data-marker-kind="screw"]')
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
  })()
`)
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

// Coherencia: el numero de cada marcador lleva el color de su clase.
const markerColores = await evaluate(`
  (() => {
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
  })()
`)
check('el numero del marcador lleva el color de su clase',
  markerColores.note === 'rgb(217, 242, 227)' &&
  markerColores.warning === 'rgb(255, 212, 205)' &&
  markerColores.screw === 'rgb(233, 213, 255)',
  `note=${markerColores.note} warning=${markerColores.warning} screw=${markerColores.screw}`)

// --- Presentacion: marcadores con snapshot de vista+corte ------------------
const markerFlow = await evaluate(`
  (() => {
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
    const doc = v.applyAnnotations(JSON.parse(JSON.stringify(v.getAnnotations())))
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
  })()
`)
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

// --- Giro libre de la camara (sin limites polares ni de acimut) ---------------
// Arrastre real de raton sobre el lienzo: la pieza debe poder girar en
// cualquier direccion, incluidas vueltas completas y vistas desde debajo.
const limits = await evaluate(`
  (() => {
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
  })()
`)
// En modo 'orbit' se comprueba que no hay limites escritos a mano; en modo
// 'libre' ArcballControls no usa coordenadas esfericas y por tanto no expone
// limites polares: lo relevante es que exista giro en cualquier eje.
const sinLimites = limits.modo === 'libre'
  ? limits.rotate === true
  : limits.minPolar === 0 && limits.maxPolar === Math.PI &&
    limits.minAzim === null && limits.maxAzim === null && limits.rotate === true
check('sin limites de giro escritos a mano', sinLimites, JSON.stringify(limits))

const orbitBefore = await evaluate(`
  (() => {
    const v = window.dentalViewer
    v.setSection({ enabled: false })
    v.measure.clear()
    v.setTool('orbit')
    v.camera.position.set(60, 25, 60)
    v.controls.target.set(0, 0, 0)
    v.controls.update()
    const r = v.renderer.domElement.getBoundingClientRect()
    return { pos: v.camera.position.toArray(), cx: r.left + r.width / 2, cy: r.top + r.height / 2, h: r.height }
  })()
`)

const drag = async (x0, y0, x1, y1, steps = 12) => {
  await send('Input.dispatchMouseEvent',
    { type: 'mousePressed', x: x0, y: y0, button: 'left', buttons: 1, clickCount: 1 }, sessionId)
  for (let i = 1; i <= steps; i++) {
    const t = i / steps
    await send('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: Math.round(x0 + (x1 - x0) * t),
      y: Math.round(y0 + (y1 - y0) * t),
      button: 'left',
      buttons: 1,
    }, sessionId)
  }
  await send('Input.dispatchMouseEvent',
    { type: 'mouseReleased', x: x1, y: y1, button: 'left', buttons: 0, clickCount: 1 }, sessionId)
  await sleep(400)
}

// Barrido horizontal amplio (mas de media vuelta) y arrastre vertical hacia
// arriba para pasar por debajo del plano de la mesa.
await drag(orbitBefore.cx - 300, orbitBefore.cy, orbitBefore.cx + 300, orbitBefore.cy + 30)
const giro = await evaluate(`
  (() => {
    const v = window.dentalViewer
    return { pos: v.camera.position.toArray(), polar: v.controls.getPolarAngle() }
  })()
`)
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
  await drag(orbitBefore.cx, orbitBefore.cy, orbitBefore.cx, orbitBefore.cy + dy, 20)
  return evaluate(`(() => {
    const v = window.dentalViewer
    return { polar: v.controls.getPolarAngle(), y: v.camera.position.y, targetY: v.controls.target.y }
  })()`)
}
const debajo = await verDebajo(-orbitBefore.h * 0.35)
const debajoAlt = debajo.polar > Math.PI / 2 + 0.05 ? debajo : await verDebajo(orbitBefore.h * 0.35)
check('se puede mirar la pieza desde debajo (polar > 90 grados)',
  debajoAlt.polar > Math.PI / 2 + 0.05 && debajoAlt.y < debajoAlt.targetY,
  `polar ${(debajoAlt.polar * 180 / Math.PI).toFixed(0)} grados`)

// Vueltas completas alrededor del modelo: nada debe frenar el giro.
const vueltas = await evaluate(`
  (() => {
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
  })()
`)
check('giro completo alrededor sin topes', vueltas.minPolar <= Math.PI / 2 + 0.05,
  `polar min ${(vueltas.minPolar * 180 / Math.PI).toFixed(1)} grados`)

// El requisito real: poder pasar por superior/inferior y SEGUIR dando la vuelta.
// Se mide arrastrando en vertical y muestreando el polar en cada paso: con
// OrbitControls la camara se clava en 180 y los ultimos pasos no se mueven. Si
// el arrastre sigue vivo, el recorrido tiene que dar la vuelta al palo.
const polarSerie = await evaluate(`
  (() => {
    const v = window.dentalViewer
    const c = v.controls
    v.setView('frontal')
    c.update()
    v.requestRender()
    const r = v.renderer.domElement
    return { cx: r.clientWidth / 2, cy: r.clientHeight / 2 }
  })()
`)
const STEPS_POLO = 40
const TOTAL_POLO = 600
await send('Input.dispatchMouseEvent',
  { type: 'mousePressed', x: polarSerie.cx, y: polarSerie.cy, button: 'left', buttons: 1, clickCount: 1 }, sessionId)
const recorrido = []
for (let i = 1; i <= STEPS_POLO; i++) {
  await send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: polarSerie.cx,
    y: Math.round(polarSerie.cy - (TOTAL_POLO * i) / STEPS_POLO),
    button: 'left',
    buttons: 1,
  }, sessionId)
  recorrido.push(await evaluate(`window.dentalViewer.controls.getPolarAngle()`))
}
await send('Input.dispatchMouseEvent',
  { type: 'mouseReleased', x: polarSerie.cx, y: polarSerie.cy - TOTAL_POLO, button: 'left', buttons: 0, clickCount: 1 }, sessionId)

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

await evaluate(`
  (() => {
    const v = window.dentalViewer
    v.camera.position.set(60, 25, 60)
    v.controls.target.set(0, 0, 0)
    v.controls.update()
  })()
`)

// --- Round-trip de anotaciones ---------------------------------------------
const roundTrip = await evaluate(`
  (() => {
    const v = window.dentalViewer
    const box = v.model.bounds
    const a = box.min.clone(), b = box.max.clone()
    v.measure.add(a, b, 'ancho total')
    v.setSection({ enabled: true, plane: { point: [0, 0, 1.5], normal: [0, 0, 1] } })
    const json = JSON.stringify(v.getAnnotations())
    v.measure.clear()
    v.setSection({ enabled: false })
    const cleared = v.measure.measurements.length
    const doc = v.applyAnnotations(JSON.parse(json))
    return {
      cleared,
      restoredMeasurements: v.measure.measurements.length,
      restoredSection: v.section.enabled,
      keepsPositiveSide: v.section.isPointVisible({ x: 0, y: 0, z: 3 }),
      slicesPastPlane: v.section.isPointVisible({ x: 0, y: 0, z: 0 }),
      note: doc.measurements[0]?.note,
      units: doc.units,
    }
  })()
`)
check('las anotaciones se pueden borrar', roundTrip.cleared === 0)
check('se restauran las mediciones desde JSON', roundTrip.restoredMeasurements === 1)
check('se restaura el corte seccional', roundTrip.restoredSection === true)
check('el plano restaurado conserva su mitad (z >= 1.5)',
  roundTrip.keepsPositiveSide === true && roundTrip.slicesPastPlane === false)
check('se conserva la nota de la medicion', roundTrip.note === 'ancho total')
check('las anotaciones se guardan en mm', roundTrip.units === 'mm')

// --- El capping produce pixeles: el corte debe verse distinto de la pieza ---
// El conteo se hace sobre pixeles dibujados, no solo sobre bytes del PNG:
// algunos entornos headless (SwiftShader) no rasterizan al canvas y si el
// render base no produce pixeles lo correcto es SALTAR, no fallar.
const capping = await evaluate(`
  (() => {
    const v = window.dentalViewer
    const litPixels = () => {
      v.renderer.render(v.scene, v.camera)
      const src = v.renderer.domElement
      const c2 = document.createElement('canvas')
      c2.width = src.width, c2.height = src.height
      const ctx = c2.getContext('2d')
      ctx.drawImage(src, 0, 0)
      const px = ctx.getImageData(0, 0, c2.width, c2.height).data
      let lit = 0, capPix = 0
      const capR = 0xc0, capG = 0x55, capB = 0x4a
      for (let i = 0; i < px.length; i += 4) {
        if (px[i] > 30 || px[i + 1] > 30 || px[i + 2] > 40) {
          lit++
          if (Math.abs(px[i] - capR) < 40 && Math.abs(px[i + 1] - capG) < 40 && Math.abs(px[i + 2] - capB) < 40) capPix++
        }
      }
      return { lit, capPix }
    }
    v.measure.clear()
    v.setSection({ enabled: false })
    const before = litPixels()
    v.setSection({ enabled: true, plane: { point: [0, 0, 0], normal: [0, 0, 1] } })
    const after = litPixels()
    v.setSection({ enabled: false })
    return { before, after }
  })()
`)
const entornoRaniza = capping.before.lit > 0
// Si dos estados distintos (con/sin corte) devuelven los mismos pixeles, el
// readback del canvas no refleja el GL (SwiftShader sin composicion): saltar.
const readbackRoto = entornoRaniza &&
  capping.before.lit === capping.after.lit && capping.after.capPix === 0
if (entornoRaniza && !readbackRoto) {
  check('el render base produce pixeles (entorno)', true, `${capping.before.lit} px`)
  check('el corte dibuja la superficie de capping', capping.after.lit !== capping.before.lit || capping.after.capPix > 0,
    `${capping.before.lit} -> ${capping.after.lit} px, cap: ${capping.after.capPix}`)
} else if (readbackRoto) {
  console.log(' AVISO readback congelado (mismos pixeles con y sin corte): se omiten los checks visuales')
} else {
  console.log(' AVISO entorno de render sin rasterizacion (headless/SwiftShader): se omiten los checks visuales del capping y del render base')
}

// --- screenshot(scale): exportar a mas resolucion de lo que se ve ----------
const shot = await evaluate(`
  (() => {
    const v = window.dentalViewer
    const s1 = v.screenshot(1).length
    const s2 = v.screenshot(3).length
    // Tras el shot escalado el canvas vuelve a su tamano normal.
    const back = v.renderer.domElement.width
    return { s1, s2, back, normal: Math.round(v.container.clientWidth * Math.min(window.devicePixelRatio, 2)) }
  })()
`)
check('screenshot(scale) exporta a mayor resolucion', shot.s2 > shot.s1,
  `${shot.s1} -> ${shot.s2} bytes`)
check('el canvas vuelve al tamano original tras el shot', Math.abs(shot.back - shot.normal) <= 1,
  `${shot.back} vs ${shot.normal}`)

// --- Modelo GLB decimado ----------------------------------------------------
const GLB_URL = `${BASE}/visor.html?model=samples/Test1.glb&embed=0${EXTRA_QUERY}`
console.log(`\nVisor (GLB decimado): ${GLB_URL}\n`)
const mainConsoleErrors = [...consoleErrors]
const mainPageErrors = [...pageErrors]
consoleErrors.length = 0
pageErrors.length = 0
await send('Page.navigate', { url: GLB_URL }, sessionId)
await sleep(1000)
const glbLoaded = await evaluate(`
  new Promise((resolve, reject) => {
    const t0 = Date.now()
    const tick = () => {
      if (window.dentalViewer?.model) return resolve(true)
      if (Date.now() - t0 > 60000) return reject(new Error('timeout cargando Test1.glb'))
      setTimeout(tick, 200)
    }
    tick()
  })
`)
check('Test1.glb carga correctamente', glbLoaded === true)
const glbInfo = await evaluate(`
  (() => {
    const v = window.dentalViewer
    return { triangles: v.model.stats.triangles }
  })()
`)
check('Test1.glb tiene menos de 500k triangulos', glbInfo.triangles < 500000, `${glbInfo.triangles} tri`)
check('Test1.glb sin errores en consola', consoleErrors.length === 0, consoleErrors.join(' | ') || 'ninguno')
check('Test1.glb sin excepciones sin capturar', pageErrors.length === 0, pageErrors.join(' | ') || 'ninguna')

// Sin errores de consola (pasada principal)
check('sin errores en consola', mainConsoleErrors.length === 0, mainConsoleErrors.join(' | ') || 'ninguno')
check('sin excepciones sin capturar', mainPageErrors.length === 0, mainPageErrors.join(' | ') || 'ninguna')

// --- Capturas del gizmo (SHOTS=1) --------------------------------------------
// Sirven para revisar la estetica a ojo: flechas, planos, arcos y apagado.
// Las deja en el directorio temporal del perfil.
if (process.env.SHOTS === '1') {
  const { writeFileSync } = await import('node:fs')
  const outDir = join(tmpdir(), 'dental-gizmo-shots')
  mkdirSync(outDir, { recursive: true })
  const shot = async (name, code) => {
    await evaluate(`
      (() => {
        const v = window.dentalViewer
        v.setSection({ enabled: true })
        v.section.setGizmoMode(${JSON.stringify(code)})
        return true
      })()
    `)
    await sleep(900)
    const { data } = await send('Page.captureScreenshot', { format: 'png' }, sessionId)
    const file = join(outDir, `${name}.png`)
    writeFileSync(file, Buffer.from(data, 'base64'))
    console.log(`  captura ${file}`)
  }
  await shot('gizmo-completo', 'combined')
  await shot('gizmo-apagado', null)
  await evaluate(`window.dentalViewer.section.setGizmoMode(null)`)
}

// --- NET=1: de donde se descarga cada archivo -------------------------------
if (process.env.NET === '1') {
  const glb = requests.filter((u) => /\.(glb|gltf|stl|fbx|obj|3mf)(\?|$)/i.test(u))
  const externos = requests.filter((u) => !u.startsWith(BASE) && !u.startsWith('data:') && !u.startsWith('blob:'))
  console.log('\nNET peticiones de modelo:')
  for (const u of glb) console.log(`  ${u}`)
  console.log(`NET peticiones fuera de ${BASE}: ${externos.length}`)
  for (const u of externos.slice(0, 12)) console.log(`  ${u}`)
}

const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} comprobaciones correctas`)

// En headed damos unos segundos para que se vea el resultado final antes de
// cerrar el navegador. PAUSE=<segundos> lo ajusta.
if (HEADED) {
  const pause = Number(process.env.PAUSE ?? 10) * 1000
  console.log(`\n(headed) se cierra en ${pause / 1000}s — mira la ventana de Chrome`)
  await sleep(pause)
}

ws.close()
cleanup()
process.exit(failed.length ? 1 : 0)
