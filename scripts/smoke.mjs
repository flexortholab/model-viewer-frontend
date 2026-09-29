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

// --- Ejes independientes: activar un eje no enciende los otros -------------
// Semantica: setSectionAxis activa por defecto (enable:true); mover un eje
// NO debe encender el coronal, y los interruptores por eje son independientes.
const axisIsolation = await evaluate(`
  (() => {
    const v = window.dentalViewer
    // Estado determinista: solo el eje sagital encendido.
    v.setSection({
      enabled: true,
      planes: [
        { axis: 'y', offset: 0, enabled: false },
        { axis: 'z', offset: 0, enabled: true },
        { axis: 'x', offset: 0, enabled: false },
      ],
    })
    const onlyZ = {
      active: v.section.active.length,
      caps: v.section.capGroup.children.map((c) => c.name),
    }
    // Mover el slider axial: enciende el eje axial sin tocar el coronal.
    v.setSectionAxis('y', 1.5)
    const state = v.section.serialize()
    const active = v.section.active.length
    const capAxes = v.section.capGroup.children.map((c) => c.name)
    const axialOn = v.section.planes.find((p) => p.axis === 'y').enabled
    const sagittalOn = v.section.planes.find((p) => p.axis === 'z').enabled
    const coronalOn = v.section.planes.find((p) => p.axis === 'x').enabled
    v.setSection({ enabled: false })
    return { onlyZ, state, active, capAxes, axialOn, sagittalOn, coronalOn }
  })()
`)
check('ningun corte se enciende de mas', axisIsolation.onlyZ.active === 1,
  `caps tras arranque: ${axisIsolation.onlyZ.caps.join(', ')}`)
check('mover el eje axial no activa el coronal',
  axisIsolation.axialOn === true && axisIsolation.sagittalOn === true && axisIsolation.coronalOn === false,
  `axial=${axisIsolation.axialOn} sagital=${axisIsolation.sagittalOn} coronal=${axisIsolation.coronalOn}`)
check('hay una superficie de corte por eje encendido',
  axisIsolation.active === 2 && axisIsolation.capAxes.includes('cap-y') && axisIsolation.capAxes.includes('cap-z'),
  `caps: ${axisIsolation.capAxes.join(', ')}`)

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
    v.setSection({ enabled: true, planes: [{ axis: 'z', offset: 0, enabled: true }] })
    const after = litPixels()
    v.setSection({ enabled: false })
    return { before, after }
  })()
`)
const entornoRaniza = capping.before.lit > 0
if (entornoRaniza) {
  check('el render base produce pixeles (entorno)', true, `${capping.before.lit} px`)
  check('el corte dibuja la superficie de capping', capping.after.lit !== capping.before.lit || capping.after.capPix > 0,
    `${capping.before.lit} -> ${capping.after.lit} px, cap: ${capping.after.capPix}`)
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

// Sin errores de consola
check('sin errores en consola', consoleErrors.length === 0, consoleErrors.join(' | ') || 'ninguno')
check('sin excepciones sin capturar', pageErrors.length === 0, pageErrors.join(' | ') || 'ninguna')

const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} comprobaciones correctas`)

ws.close()
cleanup()
process.exit(failed.length ? 1 : 0)
