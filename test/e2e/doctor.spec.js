// SPDX-License-Identifier: GPL-3.0-or-later
// Enlace del doctor (?share=) con la API simulada: el caso se ve en solo
// lectura, sin controles de edicion y sin guardar nada.
import { test, expect, esperarModelo } from './visor.js'
import { simularApi, modeloFirmado } from './api-simulada.js'

const ENLACE = 'enlace-de-prueba'
const NOMBRE = 'Caso de prueba'

async function abrirEnlace(page, baseURL) {
  const api = await simularApi(page, [
    {
      metodo: 'GET',
      ruta: `/shares/${ENLACE}`,
      responder: () => ({
        result: {
          name: NOMBRE,
          config: {
            markers: [{ id: 'k1', position: [0, 0, 0], text: 'paso del laboratorio', kind: 'note' }],
          },
          model: { url: modeloFirmado(baseURL) },
        },
      }),
    },
  ])
  await page.goto(`/viewer.html?share=${ENLACE}`)
  expect(await esperarModelo(page)).toBe(true)
  return api
}

test('el doctor ve el caso con sus marcadores y la leyenda de bienvenida', async ({ page, baseURL }) => {
  const api = await abrirEnlace(page, baseURL)
  expect(await page.evaluate(() => window.dentalViewer.doc.markers.map((m) => m.text))).toEqual(['paso del laboratorio'])
  await expect(page.locator('#share-welcome')).toBeVisible()
  expect(api.noSimuladas).toEqual([])
})

test('el enlace del doctor es de solo lectura, sin controles de edicion', async ({ page, baseURL }) => {
  const api = await abrirEnlace(page, baseURL)
  await page.locator('#share-welcome [data-action="close-share-welcome"]').first().click()
  await expect(page.locator('#share-welcome')).toBeHidden()

  for (const boton of await page.locator('[data-action="add-marker"]').all()) {
    await expect(boton, 'el boton de anadir marcador no se muestra').toBeHidden()
  }
  await expect(page.locator('[data-action="save-case"]')).toBeHidden()
  await expect(page.locator('[data-action="undo-case"]')).toBeHidden()
  await expect(page.locator('#save-status')).toBeHidden()

  // El atajo de teclado tampoco abre el dialogo de marcador.
  await page.locator('canvas').first().click({ position: { x: 5, y: 5 }, force: true })
  await page.keyboard.press('k')
  await expect(page.locator('#marker-dialog')).toBeHidden()

  // Un cambio de vista o de corte no se guarda: la API solo recibe la lectura.
  await page.evaluate(() => window.dentalViewer.setSection({ enabled: true }))
  await page.waitForTimeout(2_000)
  expect(api.peticiones.map((p) => `${p.metodo} ${p.ruta}`)).toEqual([`GET /shares/${ENLACE}`])
  expect(api.noSimuladas).toEqual([])
})

test('el nombre del caso no va en el titulo de la pagina', async ({ page, baseURL }) => {
  await abrirEnlace(page, baseURL)
  expect(await page.title()).not.toContain(NOMBRE)
  expect(page.url()).not.toContain(encodeURIComponent(NOMBRE))
})
