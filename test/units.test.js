// SPDX-License-Identifier: GPL-3.0-or-later
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { detectUnits, formatMm, round, PLAUSIBLE_MIN, PLAUSIBLE_MAX } from '../src/units.js'
import { validateDocument, createDocument } from '../src/annotations.js'
import { segSegDistPx } from '../src/measure.js'

test('un STL en mm se detecta como mm', () => {
  const r = detectUnits(50.2)
  assert.equal(r.units, 'mm')
  assert.equal(r.scale, 1)
  assert.ok(r.maxDimMm > 49 && r.maxDimMm < 51)
})

test('un glTF en metros (salida de Blender) se escala x1000', () => {
  const r = detectUnits(0.0502)
  assert.equal(r.units, 'm')
  assert.equal(r.scale, 1000)
  assert.ok(Math.abs(r.maxDimMm - 50.2) < 0.01)
})

test('si el tamano ya es plausible en mm, no se reescala', () => {
  // 5.02 podria ser 5 mm (un abutment) o 50.2 mm en cm. Ante la duda se
  // respeta el archivo: reescalar a la alza una geometria correcta la
  // destruye, mientras que dejarla small solo se nota en la medida.
  const r = detectUnits(5.02)
  assert.equal(r.scale, 1)
  assert.equal(r.maxDimMm, 5.02)
  assert.ok(
    r.alternatives.some((a) => a.units === 'cm'),
    'debe ofrecer cm como alternativa para que el usuario pueda forzarla',
  )
})

test('un archivo solo plausible en centimetros se escala x10', () => {
  // 0.5 no encaja como mm (demasiado pequeno), al multiplicar por 1000 se
  // sale del rango, pero x10 da 5 mm: un abutment.
  const r = detectUnits(0.5)
  assert.equal(r.units, 'cm')
  assert.equal(r.scale, 10)
  assert.equal(r.maxDimMm, 5)
  assert.deepEqual(r.alternatives, [])
})

test('una pieza pequena en mm no se confunde con cm', () => {
  // Un pilar de abutment de 7 mm llega como 7, no como 0.7 cm.
  const r = detectUnits(7)
  assert.equal(r.units, 'mm')
  assert.equal(r.scale, 1)
  assert.equal(r.maxDimMm, 7)
})

test('forzar unidades ignora la deteccion', () => {
  const r = detectUnits(0.0502, 'm')
  assert.equal(r.source, 'forced')
  assert.equal(r.scale, 1000)
  assert.throws(() => detectUnits(1, 'furlongs'), /Unidad desconocida/)
})

test('un tamano absurdo se marca con baja confianza', () => {
  const r = detectUnits(5000)
  assert.ok(r.confidence < 0.5, `confianza ${r.confidence}`)
})

test('los extremos del rango plausible no se reescalan', () => {
  // 4 mm y 160 mm son los limites: dentro del rango, escala 1.
  assert.equal(detectUnits(PLAUSIBLE_MIN).scale, 1)
  assert.equal(detectUnits(PLAUSIBLE_MAX).scale, 1)
  // Justo fuera: 2 mm es demasiado pequeno para una pieza, asi que se
  // interpreta en cm, y 400 mm se queda como esta con baja confianza.
  assert.equal(detectUnits(2).scale, 10)
  const grande = detectUnits(400)
  assert.equal(grande.scale, 1)
  assert.ok(grande.confidence < 0.5)
})

test('formatMm redondea a 1 decimal por defecto (precision 0.1 mm)', () => {
  assert.equal(formatMm(12.3456), '12.3 mm')
  assert.equal(formatMm(12.3456, 2), '12.35 mm')
  assert.equal(formatMm(8, 0), '8 mm')
  assert.equal(round(1.23456, 3), 1.235)
})

test('la pista de formato desempata lecturas ambiguas (FBX de Blender en cm)', () => {
  // 9.27 unidades: 9.27 mm o 92.7 mm. El STL (fresadora) prefiere mm...
  const stl = detectUnits(9.2705, null, 'stl')
  assert.equal(stl.units, 'mm')
  assert.equal(stl.scale, 1)
  assert.ok(stl.confidence < 0.9)
  assert.ok(stl.alternatives.some((a) => a.units === 'cm'))
  // ...y el FBX (exporta Blender en cm) prefiere cm: sale en mm sin ?units=.
  const fbx = detectUnits(9.2705, null, 'fbx')
  assert.equal(fbx.units, 'cm')
  assert.equal(fbx.scale, 10)
  assert.ok(Math.abs(fbx.maxDimMm - 92.7) < 0.01)
  // ?units= sigue mandando sobre la pista.
  assert.equal(detectUnits(9.2705, 'mm', 'fbx').scale, 1)
})

test('un documento de anotaciones valido se conserva', () => {
  const doc = validateDocument({
    version: 1,
    model: '/casos/1/disyuntor.glb',
    units: 'mm',
    meta: { caseId: 'C-001', doctor: 'Dra. Perez' },
    section: { enabled: true, capColor: '#ff0000', planes: [{ axis: 'Y', offset: 2.5 }] },
    measurements: [{ id: 'm1', a: [0, 0, 0], b: [3, 0, 4], note: 'ancho' }],
    markers: [{ id: 'k1', position: [1, 2, 3], text: 'Tornillo', kind: 'screw' }],
  })
  assert.equal(doc.model, '/casos/1/disyuntor.glb')
  assert.equal(doc.meta.doctor, 'Dra. Perez')
  assert.equal(doc.section.enabled, true)
  // El bloque legacy por ejes se traduce a punto + normal (mitad positiva).
  assert.deepEqual(doc.section.normal, [0, 1, 0])
  assert.deepEqual(
    doc.section.point,
    [0, 2.5, 0],
    'el offset legacy se traduce a posicion del plano',
  )
  assert.equal(doc.measurements[0].note, 'ancho')
  assert.equal(doc.markers[0].kind, 'screw')
})

test('el nuevo esquema de corte (punto + normal) se conserva', () => {
  const doc = validateDocument({
    section: { enabled: true, point: [1, -2, 3], normal: [0.7, 0.7, 0] },
  })
  assert.deepEqual(doc.section.point, [1, -2, 3])
  assert.deepEqual(doc.section.normal, [0.7, 0.7, 0])
})

test('los marcadores conservan el snapshot de presentacion', () => {
  const doc = validateDocument({
    markers: [
      {
        position: [1, 2, 3],
        text: 'paso 1',
        view: { position: [10, 5, 30], target: [0, 0, 0], zoom: 2.5 },
        section: { enabled: true, point: [0, 0, 1], normal: [0, 0, 1] },
      },
    ],
  })
  assert.deepEqual(doc.markers[0].view, {
    position: [10, 5, 30],
    target: [0, 0, 0],
    zoom: 2.5,
  })
  assert.equal(doc.markers[0].section.enabled, true)
  assert.deepEqual(doc.markers[0].section.point, [0, 0, 1])
})

test('un paso sin zoom sigue siendo valido (JSON anterior)', () => {
  const doc = validateDocument({
    markers: [{ position: [0, 0, 0], view: { position: [1, 1, 1], target: [0, 0, 0] } }],
  })
  assert.deepEqual(doc.markers[0].view, { position: [1, 1, 1], target: [0, 0, 0] })
  assert.equal(doc.markers[0].view.zoom, undefined)
})

test('un zoom invalido se descarta y no rompe el paso', () => {
  for (const zoom of [0, -3, 'mucho', null]) {
    const doc = validateDocument({
      markers: [{ position: [0, 0, 0], view: { position: [1, 1, 1], target: [0, 0, 0], zoom } }],
    })
    assert.equal(doc.markers[0].view.zoom, undefined, `zoom=${zoom}`)
  }
})

test('un documento sin snapshot de marcador sigue siendo valido', () => {
  const doc = validateDocument({ markers: [{ position: [0, 0, 0] }] })
  assert.equal(doc.markers[0].view, undefined)
  assert.equal(doc.markers[0].section, undefined)
})

test('las mediciones invalidas se descartan sin romper el resto', () => {
  const doc = validateDocument({
    measurements: [
      { id: 'ok', a: [0, 0, 0], b: [1, 0, 0] },
      { id: 'malo', a: [0, 0], b: [1, 0, 0] },
      null,
      { a: ['x', 0, 0], b: [1, 0, 0] },
    ],
  })
  assert.equal(doc.measurements.length, 1)
  assert.equal(doc.measurements[0].id, 'ok')
})

test('los ids de medicion duplicados se renumeran', () => {
  const doc = validateDocument({
    measurements: [
      { id: 'm1', a: [0, 0, 0], b: [1, 0, 0] },
      { id: 'm1', a: [0, 0, 0], b: [1, 0, 0] },
    ],
  })
  assert.equal(doc.measurements.length, 2)
  assert.notEqual(doc.measurements[0].id, doc.measurements[1].id)
})

test('un kind de marcador desconocido cae a nota', () => {
  const doc = validateDocument({
    markers: [{ position: [0, 0, 0], text: 'x', kind: 'inventado' }],
  })
  assert.equal(doc.markers[0].kind, 'note')
})

test('un documento corrupto lanza un error claro', () => {
  assert.throws(() => validateDocument(null), /invalido/)
  assert.throws(() => validateDocument('texto'), /invalido/)
})

test('createDocument genera un documento vacio coherente', () => {
  const doc = createDocument({ model: 'a.stl' })
  assert.equal(doc.units, 'mm')
  assert.equal(doc.version, 1)
  assert.deepEqual(doc.measurements, [])
  assert.equal(doc.section.enabled, false)
})

test('segSegDistPx mide la separacion entre cotas', () => {
  // Paralelas a 10 px: la distancia es el hueco entre ellas.
  assert.equal(segSegDistPx([0, 0], [10, 0], [0, 10], [10, 10]), 10)
  // Cruzadas: distancia cero.
  assert.equal(segSegDistPx([0, 0], [10, 10], [0, 10], [10, 0]), 0)
  // Lejanas en x: la distancia entre extremos.
  assert.equal(segSegDistPx([0, 0], [0, 10], [30, 0], [30, 10]), 30)
})
