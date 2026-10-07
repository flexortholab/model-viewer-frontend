// SPDX-License-Identifier: GPL-3.0-or-later
// Carga del STL de ejemplo: WebGL arranca, la deteccion de unidades da mm,
// la normalizacion centra la pieza y la lista de objetos la refleja.
import { test, check, abrirVisor } from './visor.js'

test.beforeEach(async ({ page }) => {
  check('el visor se instancia y carga el modelo', await abrirVisor(page))
})

test('unidades, tamano y triangulos del STL', async ({ page }) => {
  const info = await page.evaluate(() => {
    const v = window.dentalViewer
    return {
      units: v.model.units,
      sizeMm: { x: v.model.size.x, y: v.model.size.y, z: v.model.size.z },
      triangles: v.model.stats.triangles,
    }
  })
  check('detecta unidades mm', info.units.units === 'mm', `confianza ${info.units.confidence}`)
  check(
    'tamano en mm coherente con la pieza (50.2 x 7.2 x 4.2)',
    Math.abs(info.sizeMm.x - 50.2) < 0.05 && Math.abs(info.sizeMm.y - 7.2) < 0.05,
    `${info.sizeMm.x.toFixed(2)} x ${info.sizeMm.y.toFixed(2)} x ${info.sizeMm.z.toFixed(2)} mm`,
  )
  check('la geometria tiene triangulos', info.triangles > 3000, `${info.triangles} tri`)
})

test('titulo con el nombre del archivo y loader durante la carga', async ({ page }) => {
  const chrome2 = await page.evaluate(async () => {
    const v = window.dentalViewer
    const p = v.load('samples/disyuntor-4-pilares-metros.stl')
    // El loader se enciende de forma sincrona al pedir la carga.
    const during = document.getElementById('loader').hidden === false
    await p
    return {
      during,
      after: document.getElementById('loader').hidden === true,
      title: document.getElementById('doc-title').textContent,
    }
  })
  check('loader visible durante la carga', chrome2.during === true)
  check('loader oculto al terminar', chrome2.after === true)
  check('titulo con el nombre sin extension', chrome2.title === 'disyuntor-4-pilares-metros', chrome2.title)
})

test('centrado: la normalizacion deja las mallas sin transformaciones', async ({ page }) => {
  const centering = await page.evaluate(() => {
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
  })
  const transformsClean = centering.report.every(
    (m) => m.pos.every((n) => Math.abs(n) < 1e-9) && m.scale.every((n) => Math.abs(n - 1) < 1e-9),
  )
  const originCentered = centering.boundsCenter.every((n) => Math.abs(n) < 1e-4)
  check('las mallas quedan con transformacion identidad', transformsClean, `${centering.meshes} mallas`)
  check('el bounding box del modelo esta centrado en el origen', originCentered,
    centering.boundsCenter.map((n) => n.toFixed(4)).join(', '))
})

test('la lista de objetos respeta el ojo (visibilidad)', async ({ page }) => {
  const objectsListTest = await page.evaluate(() => {
    const v = window.dentalViewer
    const before = v.listObjects()
    v.setMeshVisible(0, false)
    const after = v.listObjects()
    v.renderer.render(v.scene, v.camera)
    v.setMeshVisible(0, true)
    const restored = v.listObjects()
    return { before: before[0], hidden: after[0], restored: restored[0] }
  })
  check('la lista de objetos lista la pieza', objectsListTest.before.name.length > 0, objectsListTest.before.name)
  check('el ojo oculta y muestra la pieza', objectsListTest.hidden.visible === false && objectsListTest.restored.visible === true)
})
