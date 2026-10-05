// SPDX-License-Identifier: GPL-3.0-or-later
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { loginUrl, safeNext, viewerRedirectUrl } from '../src/navigation.js'

const current = 'https://flexortholab.github.io/model-viewer-frontend/login.html?next=x'

test('sin next se vuelve al panel, en la raiz', () => {
  assert.equal(safeNext(null, current), './')
})

test('acepta una pagina de la propia web, con su query', () => {
  assert.equal(safeNext('visor.html?case=abc', current), 'visor.html?case=abc')
})

test('rechaza otro sitio y lleva al panel', () => {
  for (const next of ['https://evil.example.com/', '//evil.example.com/panel.html', 'javascript:alert(1)']) {
    assert.equal(safeNext(next, current), './', next)
  }
})

test('rechaza otra carpeta del mismo dominio', () => {
  assert.equal(safeNext('/otro-repo/panel.html', current), './')
})

test('la URL del login lleva a donde volver y, si toca, el aviso de sesion caducada', () => {
  assert.equal(loginUrl('./'), 'login.html?next=.%2F')
  assert.equal(loginUrl('visor.html?case=abc', { expired: true }), 'login.html?next=visor.html%3Fcase%3Dabc&expired=1')
})

test('volver a la raiz despues de entrar lleva al panel', () => {
  assert.equal(safeNext('./', current), './')
})

test('los enlaces antiguos a la raiz con parametros del visor van al visor con la misma query', () => {
  for (const search of ['?model=samples/Test1.glb', '?share=abc', '?case=c1', '?annotations=a.json&units=mm']) {
    assert.equal(viewerRedirectUrl(search), `visor.html${search}`, search)
  }
})

test('la raiz sin parametros del visor es el panel', () => {
  assert.equal(viewerRedirectUrl(''), null)
  assert.equal(viewerRedirectUrl('?next=algo'), null)
})
