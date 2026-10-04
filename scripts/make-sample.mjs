// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Genera una pieza de prueba: un disyuntor sinterizado tipo barra de Tornillo
 * sobre cuatro pilares, con una geometria sencilla pero cerrada (watertight)
 * para poder probar el capping de los cortes seccionales.
 *
 * Uso: node scripts/make-sample.mjs
 */
import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const outDir = join(here, '..', 'public', 'samples')

/**
 * Construye un solido a partir de una malla de anillos: una seccion transversal
 * 2D recorrida a lo largo de un eje. Cierra los extremos con tapas, de modo que
 * el resultado es un solido cerrado (necesario para que el capping funcione).
 */
function sweepProfile({ sections, closed = true }) {
  const vertices = []
  const indices = []

  for (const section of sections) {
    for (const point of section.points) {
      vertices.push(point)
    }
  }

  const rings = sections.length
  const perRing = sections[0].points.length

  for (let r = 0; r < rings - 1; r++) {
    for (let i = 0; i < perRing; i++) {
      const j = (i + 1) % perRing
      const a = r * perRing + i
      const b = r * perRing + j
      const c = (r + 1) * perRing + j
      const d = (r + 1) * perRing + i
      // Corte diagonal coherente en todos los cuadrilateros. Con el otro
      // criterio (a,b,d / b,c,d) las aristas circunferenciales de los anillos
      // intermedios se recorren dos veces en el mismo sentido y la malla deja
      // de ser estanca, lo que rompe el contador del stencil.
      indices.push(a, b, c, a, c, d)
    }
  }

  // Tapas: un triangulo por segmento alrededor del centro de cada anillo.
  // El extremo inicial cierra con el winding inverso al del propio anillo.
  if (closed) {
    for (const [ringIndex, flip] of [[0, true], [rings - 1, false]]) {
      const base = ringIndex * perRing
      let cx = 0
      let cy = 0
      let cz = 0
      for (let i = 0; i < perRing; i++) {
        cx += vertices[base + i][0]
        cy += vertices[base + i][1]
        cz += vertices[base + i][2]
      }
      const centerIndex = vertices.push([cx / perRing, cy / perRing, cz / perRing]) - 1
      for (let i = 0; i < perRing; i++) {
        const j = (i + 1) % perRing
        if (flip) indices.push(centerIndex, base + j, base + i)
        else indices.push(centerIndex, base + i, base + j)
      }
    }
  }

  const solid = { vertices, indices }
  // El winding depende del perfil y del recorrido; lo corregimos midiendo el
  // volumen con signo para que la malla sea consistente (necesario para el
  // capping de los cortes).
  if (signedVolume(solid) < 0) flipWinding(solid)
  return solid
}

function signedVolume({ vertices, indices }) {
  let total = 0
  for (let i = 0; i < indices.length; i += 3) {
    const [a, b, c] = [indices[i], indices[i + 1], indices[i + 2]]
    const va = vertices[a]
    const vb = vertices[b]
    const vc = vertices[c]
    total +=
      va[0] * (vb[1] * vc[2] - vb[2] * vc[1]) -
      va[1] * (vb[0] * vc[2] - vb[2] * vc[0]) +
      va[2] * (vb[0] * vc[1] - vb[1] * vc[0])
  }
  return total / 6
}

function flipWinding(mesh) {
  for (let i = 0; i < mesh.indices.length; i += 3) {
    const tmp = mesh.indices[i + 1]
    mesh.indices[i + 1] = mesh.indices[i + 2]
    mesh.indices[i + 2] = tmp
  }
}

/**
 * Elimina triangulos degenerados y une vertices coincidentes dentro de un
 * mismo solido. No se aplica entre solidos distintos: los componentes que se
 * tocan (barra y pilares) deben seguir siendo￣solos cada uno, porque el
 * contador del stencil necesita mallas cerradas independientes.
 */
function cleanMesh(mesh, epsilon = 1e-6) {
  const key = (v) => `${v[0].toFixed(6)},${v[1].toFixed(6)},${v[2].toFixed(6)}`
  const map = new Map()
  const vertices = []
  const indices = []
  for (let i = 0; i < mesh.indices.length; i += 3) {
    const tri = mesh.indices.slice(i, i + 3)
    const [a, b, c] = tri.map((index) => {
      const k = key(mesh.vertices[index])
      if (!map.has(k)) map.set(k, vertices.push(mesh.vertices[index]) - 1)
      return map.get(k)
    })
    if (a === b || b === c || a === c) continue
    const va = mesh.vertices[a]
    const vb = mesh.vertices[b]
    const vc = mesh.vertices[c]
    const ux = vb[0] - va[0]
    const uy = vb[1] - va[1]
    const uz = vb[2] - va[2]
    const vx = vc[0] - va[0]
    const vy = vc[1] - va[1]
    const vz = vc[2] - va[2]
    const nx = uy * vz - uz * vy
    const ny = uz * vx - ux * vz
    const nz = ux * vy - uy * vx
    if (Math.hypot(nx, ny, nz) < epsilon) continue
    indices.push(a, b, c)
  }
  return { vertices, indices }
}

/**
 * Perfil transversal del disyuntor, en el plano YZ (y = altura, z = grosor).
 * Cara lingual plana y cara vestibular ligeramente convexa, con las esquinas
 * superior e inferior redondeadas.
 */
function dProfile(width, height, corner = 0.6, steps = 8) {
  const points = []
  const hw = width / 2
  const hh = height / 2
  const r = Math.min(corner, hw * 0.9, hh * 0.9)

  const arc = (cy, from, to) => {
    for (let i = 0; i <= steps; i++) {
      const a = from + ((to - from) * i) / steps
      points.push([hw - r + r * Math.cos(a), cy + r * Math.sin(a), 0])
    }
  }

  // Cara vestibular (z positiva) con convexidad suave.
  const labial = 6
  for (let i = 0; i <= labial; i++) {
    const t = i / labial
    const z = Math.sin(t * Math.PI) * height * 0.12
    points.push([hw - r - 2 * (hw - r) * t, hh - r + z, 0])
  }
  arc(-hh + r, Math.PI / 2, Math.PI) // inferior
  // Cara lingual (z negativa) recta.
  const lingual = 4
  for (let i = 1; i < lingual; i++) {
    const t = i / lingual
    points.push([-hw + r - 2 * (hw - r) * t, -hh + r + t * 2 * (hh - r), 0])
  }
  arc(hh - r, Math.PI, Math.PI * 1.5) // superior

  // Cierra el contorno sin duplicar el primer punto.
  if (points.length > 1) {
    const first = points[0]
    const last = points[points.length - 1]
    if (Math.hypot(first[0] - last[0], first[1] - last[1]) < 1e-6) points.pop()
  }
  return points
}

/**
 * Concatena varios solidos en una sola malla.
 *
 * No se usan vertices compartidos entre componentes a proposito: los solidos
 * se tocan (la barra pasa por los pilares, el tornillo atraviesa el pilar) y
 * compartir vertices en esas uniones crearia aristas no manifold, que es
 * justo lo que el contador del stencil necesita evitar.
 */
function mergeSolids(solids) {
  const vertices = []
  const indices = []
  for (const { solid, offset = [0, 0, 0] } of solids) {
    const base = vertices.length
    for (const v of solid.vertices) vertices.push([v[0] + offset[0], v[1] + offset[1], v[2] + offset[2]])
    for (const i of solid.indices) indices.push(base + i)
  }
  return { vertices, indices }
}

function computeNormals(mesh) {
  const { vertices, indices } = mesh
  const normals = new Float32Array(vertices.length * 3)
  for (let i = 0; i < indices.length; i += 3) {
    const [a, b, c] = [indices[i], indices[i + 1], indices[i + 2]]
    const ux = vertices[b][0] - vertices[a][0]
    const uy = vertices[b][1] - vertices[a][1]
    const uz = vertices[b][2] - vertices[a][2]
    const vx = vertices[c][0] - vertices[a][0]
    const vy = vertices[c][1] - vertices[a][1]
    const vz = vertices[c][2] - vertices[a][2]
    const nx = uy * vz - uz * vy
    const ny = uz * vx - ux * vz
    const nz = ux * vy - uy * vx
    for (const idx of [a, b, c]) {
      normals[idx * 3] += nx
      normals[idx * 3 + 1] += ny
      normals[idx * 3 + 2] += nz
    }
  }
  for (let i = 0; i < vertices.length; i++) {
    const len = Math.hypot(normals[i * 3], normals[i * 3 + 1], normals[i * 3 + 2]) || 1
    normals[i * 3] /= len
    normals[i * 3 + 1] /= len
    normals[i * 3 + 2] /= len
  }
  return normals
}

function faceNormal(va, vb, vc) {
  const ux = vb[0] - va[0]
  const uy = vb[1] - va[1]
  const uz = vb[2] - va[2]
  const vx = vc[0] - va[0]
  const vy = vc[1] - va[1]
  const vz = vc[2] - va[2]
  const nx = uy * vz - uz * vy
  const ny = uz * vx - ux * vz
  const nz = ux * vy - uy * vx
  const len = Math.hypot(nx, ny, nz)
  return len > 0 ? [nx / len, ny / len, nz / len] : [0, 0, 0]
}

/**
 * STL binario: cabecera de 80 bytes + 50 bytes por triangulo
 * (1 normal + 3 vertices + 2 bytes de atributo).
 */
function toSTLBinary(mesh) {
  const { vertices, indices } = mesh
  const triangleCount = indices.length / 3
  const buffer = Buffer.alloc(84 + triangleCount * 50)
  buffer.write('disyuntor sinterizado - muestra de prueba', 0, 'ascii')
  buffer.writeUInt32LE(triangleCount, 80)
  let offset = 84
  for (let i = 0; i < indices.length; i += 3) {
    const tri = [indices[i], indices[i + 1], indices[i + 2]].map((n) => vertices[n])
    const normal = faceNormal(tri[0], tri[1], tri[2])
    for (const value of normal) {
      buffer.writeFloatLE(value, offset)
      offset += 4
    }
    for (const vertex of tri) {
      for (const value of vertex) {
        buffer.writeFloatLE(value, offset)
        offset += 4
      }
    }
    buffer.writeUInt16LE(0, offset)
    offset += 2
  }
  return buffer
}

// --- Construccion de la pieza ---------------------------------------------

const BAR_WIDTH = 2.6 // mm
const BAR_HEIGHT = 2.4 // mm
const SPAN = 46 // mm entre pilares extremos

function buildSplint() {
  const solids = []

  // Barra principal a lo largo del eje X.
  const barSteps = 40
  const sections = []
  for (let i = 0; i <= barSteps; i++) {
    const x = -SPAN / 2 + (SPAN * i) / barSteps
    const taper = 1 - 0.25 * Math.cos((i / barSteps) * Math.PI * 2) ** 2
    sections.push({
      points: dProfile(BAR_WIDTH * taper, BAR_HEIGHT * taper).map(([y, z]) => [x, y, z]),
    })
  }
  solids.push({ solid: sweepProfile({ sections }) })

  // Cuatro pilares (abutments) cilindricos.
  const pillarX = [-SPAN / 2, -SPAN / 6, SPAN / 6, SPAN / 2]
  for (const x of pillarX) {
    const radius = 2.1
    const height = 3.2
    const seg = 24
    const pillarSections = []
    for (let k = 0; k <= 4; k++) {
      const y = BAR_HEIGHT / 2 + (height * k) / 4
      const shrink = k === 4 ? 0.82 : 1
      const pts = []
      for (let i = 0; i < seg; i++) {
        const a = (i / seg) * Math.PI * 2
        pts.push([x + Math.cos(a) * radius * shrink, y, Math.sin(a) * radius * shrink])
      }
      pillarSections.push({ points: pts })
    }
    solids.push({ solid: sweepProfile({ sections: pillarSections }) })
  }

  // Tornillos pasantes (canal de 2.2 mm) que atraviesan los pilares extremos.
  for (const x of [pillarX[0], pillarX[3]]) {
    const radius = 1.1
    const seg = 20
    const bottom = -BAR_HEIGHT / 2 - 1
    const top = BAR_HEIGHT / 2 + 3.2 + 0.6
    const screwSections = []
    for (const y of [bottom, top]) {
      const pts = []
      for (let i = 0; i < seg; i++) {
        const a = (i / seg) * Math.PI * 2
        pts.push([x + Math.cos(a) * radius, y, Math.sin(a) * radius])
      }
      screwSections.push({ points: pts })
    }
    solids.push({ solid: sweepProfile({ sections: screwSections }) })
  }

  return mergeSolids(solids)
}

mkdirSync(outDir, { recursive: true })

const mesh = buildSplint()
const binary = toSTLBinary(mesh)

const stlPath = join(outDir, 'disyuntor-4-pilares.stl')
writeFileSync(stlPath, binary)

// Version en metros, tal y como la exporta el exportador glTF de Blender
// (util para comprobar la deteccion automatica de unidades).
const meters = {
  vertices: mesh.vertices.map(([x, y, z]) => [x / 1000, y / 1000, z / 1000]),
  indices: mesh.indices,
}
writeFileSync(join(outDir, 'disyuntor-4-pilares-metros.stl'), toSTLBinary(meters))

const size = [0, 1, 2].map((i) => {
  const values = mesh.vertices.map((v) => v[i])
  return Math.max(...values) - Math.min(...values)
})

console.log(`Muestra generada en ${stlPath}`)
console.log(`  triangulos : ${mesh.indices.length / 3}`)
console.log(`  vertices   : ${mesh.vertices.length}`)
console.log(`  tamano mm  : ${size.map((s) => s.toFixed(2)).join(' x ')}`)
