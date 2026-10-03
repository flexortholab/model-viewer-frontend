import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as THREE from 'three'

import { cutPlaneSegments, PIVOT_GIZMO_OPTIONS } from '../src/section.js'

const box = () => new THREE.BoxGeometry(2, 2, 2)
const planeZ = (constant) => new THREE.Plane(new THREE.Vector3(0, 0, 1), constant)

test('un plano medio corta el cubo en un cuadrado (8 segmentos sobre el plano)', () => {
  const segments = cutPlaneSegments(box(), planeZ(0))
  assert.equal(segments.length % 6, 0)
  const count = segments.length / 6
  assert.equal(count, 8)
  for (let i = 2; i < segments.length; i += 3) {
    assert.ok(Math.abs(segments[i]) < 1e-6, `z=${segments[i]}`)
  }
})

test('un plano lejano no genera segmentos', () => {
  assert.deepEqual(cutPlaneSegments(box(), planeZ(-50)), [])
})

test('plano apoyado en una cara plana: emite el borde sin duplicar', () => {
  const segments = cutPlaneSegments(box(), planeZ(-1))
  const count = segments.length / 6
  assert.equal(count, 4)
  for (let i = 2; i < segments.length; i += 3) {
    assert.ok(Math.abs(segments[i] - 1) < 1e-6, `z=${segments[i]}`)
  }
})

test('funciona con geometria sin indice (como un STL)', () => {
  const segments = cutPlaneSegments(box().toNonIndexed(), planeZ(0))
  assert.equal(segments.length / 6, 8)
})

test('un plano tangente a un vertice no deja segmentos degenerados', () => {
  const segments = cutPlaneSegments(box(), planeZ(1))
  for (let s = 0; s < segments.length; s += 6) {
    const dx = segments[s + 3] - segments[s]
    const dy = segments[s + 4] - segments[s + 1]
    const dz = segments[s + 5] - segments[s + 2]
    assert.ok(dx * dx + dy * dy + dz * dz > 1e-12)
  }
})

test('el gizmo usa la configuracion PivotControls elegida', () => {
  assert.deepEqual(PIVOT_GIZMO_OPTIONS, {
    translate: true,
    rotate: true,
    scale: false,
    space: 'local',
    size: 1.3,
    fixed: false,
    activeAxes: [true, true, true],
    axisColors: { x: 0xff8093, y: 0x80ff80, z: 0x2ecffe },
    thickness: 1.2,
    length: 1,
    rotateArc: 1 / 4,
  })
})
