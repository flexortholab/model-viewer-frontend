// SPDX-License-Identifier: GPL-3.0-or-later
// Editor de un caso (?case=) con la API simulada: el modelo carga, un cambio
// se autoguarda con PUT de la configuracion y deshacer lo revierte.
import { test, expect, esperarModelo, esMovil } from './visor.js'
import { iniciarSesion, simularApi, simularS3, MODELO_FIRMADO } from './api-simulada.js'

const CASO = 'caso-de-prueba'

async function abrirCaso(page) {
  await iniciarSesion(page)
  await simularS3(page)
  const api = await simularApi(page, [
    {
      metodo: 'GET',
      ruta: `/cases/${CASO}`,
      responder: () => ({
        result: {
          id: CASO,
          name: 'Caso de prueba',
          status: 'draft',
          config: {},
          model: { url: MODELO_FIRMADO },
        },
      }),
    },
    {
      metodo: 'PUT',
      ruta: `/cases/${CASO}/config`,
      responder: () => ({ result: { updatedAt: new Date().toISOString() } }),
    },
  ])
  await page.goto(`/viewer.html?case=${CASO}`)
  expect(await esperarModelo(page)).toBe(true)
  return api
}

const guardados = (api) => api.peticiones.filter((p) => p.metodo === 'PUT')

test('el editor abre el caso con su modelo y lo marca como guardado', async ({ page }) => {
  const api = await abrirCaso(page)
  const triangulos = await page.evaluate(() => window.dentalViewer.model.stats.triangles)
  expect(triangulos, 'el GLB de la URL firmada se carga').toBe(3416)
  expect(api.peticiones.map((p) => `${p.metodo} ${p.ruta}`)).toEqual([`GET /cases/${CASO}`])
  await expect(page.locator('#save-status')).toHaveText('Guardado')
  expect(api.noSimuladas).toEqual([])
})

test('un marcador nuevo se autoguarda con PUT de la configuracion', async ({ page }) => {
  const api = await abrirCaso(page)
  await page.evaluate(() => {
    window.dentalViewer.addMarker({ position: [0, 0, 0], text: 'nota de prueba', kind: 'note', snapshot: false })
  })
  await expect.poll(() => guardados(api).length, { message: 'llega un PUT de la configuracion' }).toBe(1)
  const [guardado] = guardados(api)
  expect(guardado.body.markers.map((m) => m.text)).toEqual(['nota de prueba'])
  expect(guardado.body.model, 'la configuracion guardada no lleva la URL del modelo').toBeUndefined()
  await expect(page.locator('#save-status')).toHaveText('Guardado')
  expect(api.noSimuladas).toEqual([])
})

test('deshacer quita el marcador y guarda la configuracion anterior', async ({ page }, testInfo) => {
  test.skip(esMovil(testInfo), 'en movil los botones de deshacer van en el panel lateral, que no se muestra')
  const api = await abrirCaso(page)
  await page.evaluate(() => {
    window.dentalViewer.addMarker({ position: [0, 0, 0], text: 'nota de prueba', kind: 'note', snapshot: false })
  })
  await expect.poll(() => guardados(api).length).toBe(1)
  const deshacer = page.locator('[data-action="undo-case"]')
  await expect(deshacer).toBeEnabled()
  await deshacer.click()
  await expect.poll(() => guardados(api).length, { message: 'deshacer guarda en el acto' }).toBe(2)
  expect(guardados(api)[1].body.markers).toEqual([])
  expect(await page.evaluate(() => window.dentalViewer.doc.markers.length)).toBe(0)
  await expect(page.locator('[data-action="redo-case"]')).toBeEnabled()
  expect(api.noSimuladas).toEqual([])
})
