// SPDX-License-Identifier: GPL-3.0-or-later
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { loginUrl, safeNext } from '../src/navigation.js'

const current = 'https://flexortholab.github.io/model-viewer-frontend/login.html?next=x'

test('sin next se vuelve al panel', () => {
  assert.equal(safeNext(null, current), 'panel.html')
})

test('acepta una pagina de la propia web, con su query', () => {
  assert.equal(safeNext('index.html?case=abc', current), 'index.html?case=abc')
})

test('rechaza otro sitio y lleva al panel', () => {
  for (const next of ['https://evil.example.com/', '//evil.example.com/panel.html', 'javascript:alert(1)']) {
    assert.equal(safeNext(next, current), 'panel.html', next)
  }
})

test('rechaza otra carpeta del mismo dominio', () => {
  assert.equal(safeNext('/otro-repo/panel.html', current), 'panel.html')
})

test('la URL del login lleva a donde volver y, si toca, el aviso de sesion caducada', () => {
  assert.equal(loginUrl('panel.html'), 'login.html?next=panel.html')
  assert.equal(loginUrl('index.html?case=abc', { expired: true }), 'login.html?next=index.html%3Fcase%3Dabc&expired=1')
})
