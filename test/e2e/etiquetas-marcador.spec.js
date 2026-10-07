// SPDX-License-Identifier: GPL-3.0-or-later
// La etiqueta de un marcador va fuera del modelo, unida a su punto por una
// linea guia. La silueta se calcula aqui proyectando todos los vertices, sin
// usar el codigo que coloca la etiqueta.
import { test, expect, abrirVisor } from './visor.js'

async function enfocarMarcador(page, texto) {
  await page.evaluate((text) => {
    const v = window.dentalViewer
    // En el centro de la pieza: el peor caso, con el modelo alrededor.
    const marker = v.addMarker({ position: [0, 0, 0], text, kind: 'warning', snapshot: false })
    v.focusMarker(marker.id)
  }, texto)
  // Un par de frames para que el bucle coloque la etiqueta.
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))))
}

/** Rectangulos en pantalla de la etiqueta, la silueta exacta del modelo y la linea guia. */
function medir(page) {
  return page.evaluate(() => {
    const v = window.dentalViewer
    const capa = v.labelLayer.getBoundingClientRect()
    const w = v.container.clientWidth
    const h = v.container.clientHeight
    const p = v.camera.position.clone()
    let minX = Infinity
    let minY = Infinity
    let maxX = -Infinity
    let maxY = -Infinity
    for (const mesh of v.model.meshes) {
      const pos = mesh.geometry.getAttribute('position')
      for (let i = 0; i < pos.count; i++) {
        p.set(pos.getX(i), pos.getY(i), pos.getZ(i)).applyMatrix4(mesh.matrixWorld).project(v.camera)
        const x = (p.x * 0.5 + 0.5) * w
        const y = (-p.y * 0.5 + 0.5) * h
        minX = Math.min(minX, x)
        minY = Math.min(minY, y)
        maxX = Math.max(maxX, x)
        maxY = Math.max(maxY, y)
      }
    }
    const etiqueta = document.querySelector('.marker-label').getBoundingClientRect()
    const linea = document.querySelector('.marker-leader')
    return {
      etiqueta: { x: etiqueta.left - capa.left, y: etiqueta.top - capa.top, w: etiqueta.width, h: etiqueta.height },
      silueta: { x: minX, y: minY, w: maxX - minX, h: maxY - minY },
      pantalla: { w, h },
      linea: linea && { x1: +linea.getAttribute('x1'), y1: +linea.getAttribute('y1') },
      punto: (() => {
        const q = v.camera.position.clone().set(0, 0, 0).project(v.camera)
        return { x: (q.x * 0.5 + 0.5) * w, y: (-q.y * 0.5 + 0.5) * h }
      })(),
    }
  })
}

const solapan = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h

test('la etiqueta de un marcador no tapa el modelo y queda dentro de la pantalla', async ({ page }) => {
  await abrirVisor(page)
  await enfocarMarcador(page, 'tornillo en el pilar')
  const m = await medir(page)
  expect(solapan(m.etiqueta, m.silueta), `etiqueta ${JSON.stringify(m.etiqueta)} y silueta ${JSON.stringify(m.silueta)}`).toBe(false)
  expect(m.etiqueta.x).toBeGreaterThanOrEqual(0)
  expect(m.etiqueta.y).toBeGreaterThanOrEqual(0)
  expect(m.etiqueta.x + m.etiqueta.w).toBeLessThanOrEqual(m.pantalla.w)
  expect(m.etiqueta.y + m.etiqueta.h).toBeLessThanOrEqual(m.pantalla.h)
})

test('una linea guia une la etiqueta del marcador con su punto', async ({ page }) => {
  await abrirVisor(page)
  await enfocarMarcador(page, 'tornillo en el pilar')
  const m = await medir(page)
  expect(m.linea, 'hay linea guia').not.toBeNull()
  expect(Math.hypot(m.linea.x1 - m.punto.x, m.linea.y1 - m.punto.y)).toBeLessThan(1)
})
