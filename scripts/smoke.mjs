/**
 * Prueba de humo en un navegador real (headless Chromium).
 *
 * Verifica lo que los tests de node no pueden: que WebGL arranca, que el STL
 * se carga, que la deteccion de unidades da mm, que el capping del corte
 * seccional genera geometria visible y que las mediciones proyectan etiquetas.
 *
 * Uso: node scripts/smoke.mjs [urlBase]
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const BASE = process.argv[2] ?? 'http://localhost:4173'
const URL_TEST = `${BASE}/?model=samples/disyuntor-4-pilares.stl&embed=0`

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
  '--headless=new',
  `--remote-debugging-port=${port}`,
  `--user-data-dir=${userDataDir}`,
  '--no-sandbox',
  '--disable-gpu-sandbox',
  '--use-gl=swiftshader',
  '--enable-unsafe-swiftshader',
  '--window-size=1280,800',
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

ws.addEventListener('message', (event) => {
  const data = JSON.parse(event.data)
  if (data.id && pending.has(data.id)) {
    const { resolve, reject } = pending.get(data.id)
    pending.delete(data.id)
    if (data.error) reject(new Error(data.error.message))
    else resolve(data.result)
    return
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

// Corte seccional + capping
const section = await evaluate(`
  (() => {
    const v = window.dentalViewer
    v.setSection({ enabled: true, planes: [{ axis: 'z', offset: 0, enabled: true }] })
    v.renderer.render(v.scene, v.camera)
    const caps = v.section.capGroup.children.length
    const stencils = v.section.stencilGroup.children.reduce((n, g) => n + g.children.length, 0)
    const planes = v.model.meshes[0].material.clippingPlanes?.length ?? 0
    const capWrite = v.section.capGroup.children[0].material.stencilWrite
    const stencilWrite = v.section.stencilGroup.children[0].children[0].material.stencilWrite
    return { caps, stencils, planes, capWrite, stencilWrite, active: v.section.active.length }
  })()
`)
check('el corte seccional se activa', section.active === 1)
check('genera una superficie de corte por plano', section.caps === 1, `${section.caps} cap`)
check('genera el grupo de stencil (caras traseras y delanteras)', section.stencils >= 2, `${section.stencils} mallas`)
check('los materiales recortan con el plano', section.planes === 1)
check('stencil activo en el capping y en los grupos', section.capWrite === true && section.stencilWrite === true)

// Varios planos a la vez
const multi = await evaluate(`
  (() => {
    const v = window.dentalViewer
    v.setSection({
      enabled: true,
      planes: [
        { axis: 'y', offset: 0, enabled: true },
        { axis: 'z', offset: 0, enabled: true },
      ],
    })
    v.renderer.render(v.scene, v.camera)
    const caps = v.section.capGroup.children.length
    // El lado conservado es +eje en cada plano: el origen esta dentro de ambos.
    const atOrigin = v.section.isPointVisible({ x: 0, y: 0, z: 0 })
    const beyondZ = v.section.isPointVisible({ x: 0, y: 0, z: -5 })
    const beyondY = v.section.isPointVisible({ x: 0, y: -5, z: 0 })
    v.setSection({ enabled: true, planes: [{ axis: 'y', offset: 0, enabled: true }] })
    return { caps, atOrigin, beyondZ, beyondY }
  })()
`)
check('soporta dos planos simultaneos', multi.caps === 2, `${multi.caps} caps`)
check('el origen queda dentro de los dos cortes', multi.atOrigin === true)
check('un punto detras del plano sagital se descarta', multi.beyondZ === false)
check('un punto detras del plano axial se descarta', multi.beyondY === false)

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
      displayed: style?.display,
      transform: style?.transform,
    }
  })()
`)
check('crea una medicion', measure.count === 1, measure.id)
check('la distancia se expresa en mm', measure.label === '12.35 mm', measure.label)
// dim, extA, extB, tickA, tickB, pointA, pointB
check(
  'dibuja linea de cota, extensiones, tildes y puntos',
  measure.nodes === 7,
  `${measure.nodes} elementos (${measure.nodeKeys.join(', ')})`,
)
check('cada nodo tiene su material', measure.lineMaterials >= 7, `${measure.lineMaterials} materiales`)
check('la etiqueta se proyecta en pantalla', Boolean(measure.transform) && measure.displayed !== 'none', measure.transform)

// Las etiquetas se ocultan cuando el corte elimina la pieza.
// La pieza va de y = -3.6 a y = +3.6, asi que un plano axial en y = 40 no
// deja nada visible; el lado conservado es y >= offset.
const hidden = await evaluate(`
  (() => {
    const v = window.dentalViewer
    v.setSection({ enabled: true, planes: [{ axis: 'y', offset: 0, enabled: true }] })
    v.setSectionAxis('y', 40)   // muy por encima de la pieza: no queda nada visible
    v.renderer.render(v.scene, v.camera)
    v.measure.update()
    const visible = v.measure.labels.filter((l) => l.el.style.display !== 'none').length
    v.setSectionAxis('y', 0)
    v.measure.update()
    const visibleAfter = v.measure.labels.filter((l) => l.el.style.display !== 'none').length
    v.measure.clear()
    v.setTool('orbit')
    v.setSection({ enabled: false })
    return { visible, visibleAfter }
  })()
`)
check('las etiquetas se ocultan con la pieza recortada', hidden.visible === 0)
check('vuelven a verse al retirar el corte', hidden.visibleAfter === 1)

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

// --- Ejes independientes: el corte axial no debe activar los otros dos -----
const axisIsolation = await evaluate(`
  (() => {
    const v = window.dentalViewer
    v.setSection({ enabled: true })
    v.setSectionAxis('z', 1.5)
    const state = v.section.serialize()
    const active = v.section.active.length
    const capAxes = v.section.capGroup.children.map((c) => c.name)
    const axialOn = v.section.planes.find((p) => p.axis === 'y').enabled
    const sagittalOn = v.section.planes.find((p) => p.axis === 'z').enabled
    const coronalOn = v.section.planes.find((p) => p.axis === 'x').enabled
    v.setSection({ enabled: false })
    return { state, active, capAxes, axialOn, sagittalOn, coronalOn }
  })()
`)
check('mover un eje no activa los demas', axisIsolation.active === 1, `activos: ${axisIsolation.capAxes.join(', ')}`)
check('el cap corresponde al eje correcto', axisIsolation.capAxes[0] === 'cap-z', axisIsolation.capAxes[0])
check('los interruptores por eje se reflejan en el estado',
  axisIsolation.sagittalOn === true && axisIsolation.axialOn === true && axisIsolation.coronalOn === false,
  `axial=${axisIsolation.axialOn} sagital=${axisIsolation.sagittalOn} coronal=${axisIsolation.coronalOn}`)

// --- Round-trip de anotaciones ---------------------------------------------
const roundTrip = await evaluate(`
  (() => {
    const v = window.dentalViewer
    const box = v.model.bounds
    const a = box.min.clone(), b = box.max.clone()
    v.measure.add(a, b, 'ancho total')
    v.setSection({ enabled: true, planes: [{ axis: 'z', offset: 1.5, enabled: true }] })
    const json = JSON.stringify(v.getAnnotations())
    v.measure.clear()
    v.setSection({ enabled: false })
    const cleared = v.measure.measurements.length
    const doc = v.applyAnnotations(JSON.parse(json))
    return {
      cleared,
      restoredMeasurements: v.measure.measurements.length,
      restoredSection: v.section.enabled,
      offset: v.section.planes.find((p) => p.axis === 'z')?.offset,
      note: doc.measurements[0]?.note,
      units: doc.units,
    }
  })()
`)
check('las anotaciones se pueden borrar', roundTrip.cleared === 0)
check('se restauran las mediciones desde JSON', roundTrip.restoredMeasurements === 1)
check('se restaura el corte seccional', roundTrip.restoredSection === true && roundTrip.offset === 1.5)
check('se conserva la nota de la medicion', roundTrip.note === 'ancho total')
check('las anotaciones se guardan en mm', roundTrip.units === 'mm')

// --- El capping produce pixeles: el corte debe verse distinto de la pieza ---
const capping = await evaluate(`
  (() => {
    const v = window.dentalViewer
    v.measure.clear()
    v.setSection({ enabled: false })
    v.renderer.render(v.scene, v.camera)
    const before = v.renderer.domElement.toDataURL('image/png').length
    v.setSection({ enabled: true, planes: [{ axis: 'z', offset: 0, enabled: true }] })
    v.renderer.render(v.scene, v.camera)
    const after = v.renderer.domElement.toDataURL('image/png').length
    // El buffer de stencil debe quedar limpio entre fotogramas: si el capping
    // no limpiara el stencil, el canvas se ensuciaria al rotar la camara.
    v.setView('lateral')
    v.renderer.render(v.scene, v.camera)
    const rotated = v.renderer.domElement.toDataURL('image/png').length
    v.setSection({ enabled: false })
    return { before, after, rotated }
  })()
`)
check('el canvas cambia al activar el corte', capping.before !== capping.after,
  `${capping.before} -> ${capping.after} bytes`)
check('el canvas se mantiene estable al rotar con el corte activo',
  capping.rotated > 1000, `${capping.rotated} bytes`)

// Sin errores de consola
check('sin errores en consola', consoleErrors.length === 0, consoleErrors.join(' | ') || 'ninguno')
check('sin excepciones sin capturar', pageErrors.length === 0, pageErrors.join(' | ') || 'ninguna')

const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} comprobaciones correctas`)

ws.close()
cleanup()
process.exit(failed.length ? 1 : 0)
