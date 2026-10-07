// SPDX-License-Identifier: GPL-3.0-or-later
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { boundsOf, overlaps, placeLabel, VIEWPORT_PAD } from '../src/label-layout.js'

const viewport = { w: 1000, h: 800 }
const silhouette = { x: 300, y: 250, w: 400, h: 300 }
const size = { w: 120, h: 30 }

const inside = (rect) =>
  rect.x >= VIEWPORT_PAD && rect.y >= VIEWPORT_PAD &&
  rect.x + rect.w <= viewport.w - VIEWPORT_PAD && rect.y + rect.h <= viewport.h - VIEWPORT_PAD

test('la etiqueta queda fuera de la silueta, por el lado mas cercano a su punto', () => {
  const { rect } = placeLabel({ anchor: { x: 500, y: 270 }, size, silhouette, viewport })
  assert.equal(overlaps(rect, silhouette), false)
  assert.ok(rect.y + rect.h <= silhouette.y, 'el punto esta cerca del borde superior: va encima')
  assert.ok(inside(rect))
})

test('un punto cerca del borde izquierdo lleva la etiqueta a la izquierda', () => {
  const { rect } = placeLabel({ anchor: { x: 310, y: 400 }, size, silhouette, viewport })
  assert.ok(rect.x + rect.w <= silhouette.x)
})

test('la etiqueta esquiva otra etiqueta que ocupa su sitio', () => {
  const libre = placeLabel({ anchor: { x: 500, y: 270 }, size, silhouette, viewport }).rect
  const { rect } = placeLabel({ anchor: { x: 500, y: 270 }, size, silhouette, viewport, obstacles: [libre] })
  assert.equal(overlaps(rect, libre), false)
  assert.equal(overlaps(rect, silhouette), false)
})

test('si el lado mas cercano no cabe en pantalla, usa otro', () => {
  const pegadaArriba = { x: 300, y: 20, w: 400, h: 500 }
  const { rect } = placeLabel({ anchor: { x: 500, y: 30 }, size, silhouette: pegadaArriba, viewport })
  assert.equal(overlaps(rect, pegadaArriba), false)
  assert.ok(inside(rect))
})

test('si el modelo llena la pantalla, la etiqueta se queda dentro de la pantalla', () => {
  const todo = { x: 0, y: 0, w: viewport.w, h: viewport.h }
  const { rect } = placeLabel({ anchor: { x: 500, y: 400 }, size, silhouette: todo, viewport })
  assert.ok(inside(rect))
})

test('la linea guia une el punto con el borde mas cercano de la etiqueta', () => {
  const anchor = { x: 500, y: 270 }
  const { rect, leader } = placeLabel({ anchor, size, silhouette, viewport })
  assert.deepEqual(leader.from, anchor)
  assert.equal(leader.to.y, rect.y + rect.h)
  assert.equal(leader.to.x, 500)
})

test('boundsOf envuelve todos los puntos', () => {
  assert.deepEqual(boundsOf([{ x: 3, y: 9 }, { x: -1, y: 4 }, { x: 7, y: 5 }]), { x: -1, y: 4, w: 8, h: 5 })
  assert.equal(boundsOf([]), null)
})
