// SPDX-License-Identifier: GPL-3.0-or-later
import { defineConfig, devices } from '@playwright/test'

/**
 * Pruebas del visor en navegadores reales (test/e2e/*.spec.js).
 *
 * Cada proyecto es un navegador con un perfil de equipo. E2E_NAVEGADOR
 * (chromium, firefox, webkit o msedge) deja solo los proyectos de ese
 * navegador: el CI lanza un job por navegador en paralelo.
 *
 * Sin reintentos: un test inestable tiene que dejar el CI en rojo, no pasar
 * a la segunda (en las PR se repite cada test con --repeat-each).
 */

// Mismo tamano de ventana que el smoke antiguo: con 720 px o menos de alto
// se aplica la media query de pantallas cortas y los paneles se compactan.
const ESCRITORIO = { viewport: { width: 1280, height: 860 } }

// Portatil con pantalla tactil (tipico Windows con Edge): raton y dedo a la
// vez. navigator.maxTouchPoints = 10, que es lo que mira el visor, lo pone
// test/e2e/visor.js con addInitScript: Playwright no tiene opcion para ello.
const TACTIL = { ...ESCRITORIO, hasTouch: true }

const proyectos = [
  { name: 'escritorio-chromium', navegador: 'chromium', perfil: 'escritorio', use: { ...devices['Desktop Chrome'], ...ESCRITORIO } },
  { name: 'escritorio-firefox', navegador: 'firefox', perfil: 'escritorio', use: { ...devices['Desktop Firefox'], ...ESCRITORIO } },
  { name: 'escritorio-webkit', navegador: 'webkit', perfil: 'escritorio', use: { ...devices['Desktop Safari'], ...ESCRITORIO } },
  { name: 'escritorio-msedge', navegador: 'msedge', perfil: 'escritorio', use: { ...devices['Desktop Edge'], ...ESCRITORIO, channel: 'msedge' } },
  { name: 'portatil-tactil-chromium', navegador: 'chromium', perfil: 'portatil-tactil', use: { ...devices['Desktop Chrome'], ...TACTIL } },
  { name: 'portatil-tactil-msedge', navegador: 'msedge', perfil: 'portatil-tactil', use: { ...devices['Desktop Edge'], ...TACTIL, channel: 'msedge' } },
  { name: 'portatil-tactil-firefox', navegador: 'firefox', perfil: 'portatil-tactil', use: { ...devices['Desktop Firefox'], ...TACTIL } },
  { name: 'tablet-webkit', navegador: 'webkit', perfil: 'tablet', use: { ...devices['iPad (gen 7)'] } },
  { name: 'movil-webkit', navegador: 'webkit', perfil: 'movil', use: { ...devices['iPhone 13'] } },
  { name: 'movil-chromium', navegador: 'chromium', perfil: 'movil', use: { ...devices['Pixel 7'] } },
]

const navegador = process.env.E2E_NAVEGADOR

export default defineConfig({
  testDir: 'test/e2e',
  testMatch: '*.spec.js',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: 0,
  // WebGL por software (SwiftShader, llvmpipe) satura la CPU del runner: con
  // mas workers los tiempos se disparan y aparecen falsos fallos.
  workers: process.env.CI ? 2 : undefined,
  timeout: 90_000,
  expect: { timeout: 15_000 },
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: 'http://localhost:4173',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: proyectos
    .filter((p) => !navegador || p.navegador === navegador)
    .map(({ name, perfil, use }) => ({ name, use, metadata: { perfil } })),
  webServer: {
    command: 'npm run build && npx vite preview --port 4173 --strictPort',
    url: 'http://localhost:4173/viewer.html',
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
})
