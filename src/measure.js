import * as THREE from 'three'
import { Line2 } from 'three/addons/lines/Line2.js'
import { LineMaterial } from 'three/addons/lines/LineMaterial.js'
import { LineGeometry } from 'three/addons/lines/LineGeometry.js'

import { formatMm } from './units.js'

const TICK = 0.9
const OFFSET = 2.4

/**
 * Mediciones sobre la superficie del modelo.
 *
 * Cada medicion son dos puntos en mm mas una etiqueta HTML. Las lineas se
 * dibujan con Line2 (LineMaterial) para que el grosor sea constante en
 * pantalla, que es lo que se espera en un plano tecnico.
 */
export class MeasureTool {
  constructor({ container, labelLayer, camera, renderer, section, onChange }) {
    this.container = container
    this.labelLayer = labelLayer
    this.camera = camera
    this.renderer = renderer
    this.section = section
    this.onChange = onChange
    this._onChange = onChange

    this.enabled = false
    /** @type {Array<{id:string, a:THREE.Vector3, b:THREE.Vector3, label:string, distance:number, note:string}>} */
    this.measurements = []
    this.group = new THREE.Group()
    this.group.name = 'measurements'

    this.lineMaterials = new Set()
    this.labels = []
    this._nextId = 1
    this._pending = null
    this._hover = null
    this._tmp = new THREE.Vector3()
  }

  setEnabled(enabled) {
    this.enabled = !!enabled
    this._pending = null
    this.labelLayer.classList.toggle('is-measuring', this.enabled)
    return this.enabled
  }

  setResolution(width, height) {
    for (const material of this.lineMaterials) material.resolution.set(width, height)
  }

  _makeLine(points, { color = 0xf0f0f0, width = 2, dashed = false } = {}) {
    const geometry = new LineGeometry()
    geometry.setPositions(points)
    const material = new LineMaterial({
      color,
      linewidth: width,
      dashed,
      dashSize: 1.2,
      gapSize: 0.6,
      transparent: true,
      depthTest: false,
      alphaToCoverage: false,
    })
    material.resolution.set(this.container.clientWidth || 1, this.container.clientHeight || 1)
    if (dashed) material.defines.USE_DASH = ''
    this.lineMaterials.add(material)
    const line = new Line2(geometry, material)
    line.computeLineDistances()
    line.renderOrder = 999
    line.raycast = () => {}
    return line
  }

  /**
   * @param {THREE.Vector3} a
   * @param {THREE.Vector3} b
   * @param {string} note
   * @param {string} [id] conserva el id del archivo al restaurar
   */
  add(a, b, note = '', id = null) {
    const measurement = {
      id: id ?? `m${this._nextId++}`,
      a: a.clone(),
      b: b.clone(),
      distance: a.distanceTo(b),
      note,
      label: formatMm(a.distanceTo(b)),
    }
    this.measurements.push(measurement)
    this._build(measurement)
    this.onChange?.(this.serialize())
    return measurement
  }

  remove(id) {
    const index = this.measurements.findIndex((m) => m.id === id)
    if (index === -1) return false
    this._dispose(this.measurements[index])
    this.measurements.splice(index, 1)
    this.onChange?.(this.serialize())
    return true
  }

  clear() {
    for (const measurement of this.measurements) this._dispose(measurement)
    this.measurements = []
    this.onChange?.(this.serialize())
  }

  _entry(measurement) {
    if (!measurement.__nodes) {
      measurement.__nodes = {
        dim: null,
        extA: null,
        extB: null,
        tickA: null,
        tickB: null,
        pointA: null,
        pointB: null,
      }
    }
    return measurement.__nodes
  }

  _build(measurement) {
    const nodes = this._entry(measurement)
    const { a, b } = measurement

    // Direccion de la linea de cota: perpendicular al segmento, en el plano
    // que mas se aleja de la camara para que la cifra quede legible.
    const direction = new THREE.Vector3().subVectors(b, a)
    const length = direction.length() || 1
    direction.divideScalar(length)

    const viewDir = new THREE.Vector3()
    this.camera.getWorldDirection(viewDir)

    const candidates = [
      new THREE.Vector3().crossVectors(direction, viewDir),
      new THREE.Vector3(0, 1, 0),
      new THREE.Vector3(1, 0, 0),
    ]
    let best = null
    let bestScore = -Infinity
    for (const candidate of candidates) {
      const score = candidate.lengthSq()
      if (score > 1e-6 && score > bestScore) {
        bestScore = score
        best = candidate.clone()
      }
    }
    if (!best) best = new THREE.Vector3(0, 1, 0)
    best.normalize()

    const offset = best.clone().multiplyScalar(OFFSET)
    const a2 = a.clone().add(offset)
    const b2 = b.clone().add(offset)

    nodes.dim = this._makeLine([a2.x, a2.y, a2.z, b2.x, b2.y, b2.z], { width: 2.5 })
    nodes.extA = this._makeLine([a.x, a.y, a.z, a2.x, a2.y, a2.z], { width: 1.5, color: 0x9a9a9a })
    nodes.extB = this._makeLine([b.x, b.y, b.z, b2.x, b2.y, b2.z], { width: 1.5, color: 0x9a9a9a })

    // Tildes oblicuas en los extremos, estilo plano de taller.
    const tickDir = direction.clone().add(best).normalize().multiplyScalar(TICK)
    nodes.tickA = this._makeLine(
      [a2.x - tickDir.x, a2.y - tickDir.y, a2.z - tickDir.z,
       a2.x + tickDir.x, a2.y + tickDir.y, a2.z + tickDir.z],
      { width: 2.5 },
    )
    nodes.tickB = this._makeLine(
      [b2.x - tickDir.x, b2.y - tickDir.y, b2.z - tickDir.z,
       b2.x + tickDir.x, b2.y + tickDir.y, b2.z + tickDir.z],
      { width: 2.5 },
    )

    nodes.pointA = this._makePoint(a)
    nodes.pointB = this._makePoint(b)
    for (const key of ['dim', 'extA', 'extB', 'tickA', 'tickB', 'pointA', 'pointB']) {
      this.group.add(nodes[key])
    }

    const label = document.createElement('div')
    label.className = 'measure-label'
    label.dataset.id = measurement.id
    label.innerHTML = '<span class="measure-value"></span><span class="measure-note"></span>'
    label.querySelector('.measure-value').textContent = measurement.label
    label.querySelector('.measure-note').textContent = measurement.note ?? ''
    label.addEventListener('pointerdown', (event) => event.stopPropagation())
    label.title = 'Pulsa para eliminar esta medida'
    label.addEventListener('dblclick', () => this.remove(measurement.id))
    this.labels.push({
      el: label,
      id: measurement.id,
      position: new THREE.Vector3().addVectors(a2, b2).multiplyScalar(0.5),
    })
  }

  _makePoint(point) {
    const geometry = new THREE.BufferGeometry().setFromPoints([point, point])
    const material = new THREE.PointsMaterial({
      color: 0xffd479,
      size: 5,
      sizeAttenuation: false,
      depthTest: false,
    })
    this.lineMaterials.add(material)
    const points = new THREE.Points(geometry, material)
    points.renderOrder = 1000
    points.raycast = () => {}
    return points
  }

  _dispose(measurement) {
    const nodes = measurement.__nodes
    if (!nodes) return
    for (const key of Object.keys(nodes)) {
      const node = nodes[key]
      if (!node) continue
      this.group.remove(node)
      node.geometry?.dispose()
      if (node.material && this.lineMaterials.has(node.material)) {
        node.material.dispose()
        this.lineMaterials.delete(node.material)
      }
    }
    delete measurement.__nodes

    const index = this.labels.findIndex((l) => l.id === measurement.id)
    if (index !== -1) {
      this.labels[index].el.remove()
      this.labels.splice(index, 1)
    }
  }

  /** Reconstruye todo (tras cambiar la camara no hace falta, solo al restaurar). */
  rebuild() {
    for (const measurement of this.measurements) this._dispose(measurement)
    for (const measurement of this.measurements) this._build(measurement)
  }

  /** Proyecta las etiquetas a pantalla y oculta las que quedan tras el corte. */
  update() {
    if (!this.labels.length) return
    const width = this.container.clientWidth
    const height = this.container.clientHeight
    for (const entry of this.labels) {
      const mid = entry.position
      const visible = !this.section || this.section.isPointVisible(mid)
      this._tmp.copy(mid).project(this.camera)
      if (!visible || this._tmp.z > 1) {
        entry.el.style.display = 'none'
        continue
      }
      const x = (this._tmp.x * 0.5 + 0.5) * width
      const y = (-this._tmp.y * 0.5 + 0.5) * height
      entry.el.style.display = ''
      entry.el.style.transform = `translate(-50%, -100%) translate(${x.toFixed(1)}px, ${y.toFixed(1)}px)`
    }
  }

  /** Etiqueta libre, no ligada a una medicion (marcadores, notas). */
  addOverlay(id, el, position) {
    this.removeOverlay(id)
    this.labelLayer.appendChild(el)
    this.labels.push({ el, id, position: position.clone() })
  }

  removeOverlay(id) {
    const index = this.labels.findIndex((l) => l.id === id)
    if (index === -1) return false
    this.labels[index].el.remove()
    this.labels.splice(index, 1)
    return true
  }

  setPending(point) {
    this._pending = point
  }

  serialize() {
    return this.measurements.map((m) => ({
      id: m.id,
      a: [round(m.a.x), round(m.a.y), round(m.a.z)],
      b: [round(m.b.x), round(m.b.y), round(m.b.z)],
      distance: round(m.distance),
      note: m.note ?? '',
    }))
  }

  restore(list) {
    this.onChange = null
    this.clear()
    for (const item of list ?? []) {
      if (!Array.isArray(item?.a) || !Array.isArray(item?.b)) continue
      const measurement = this.add(
        new THREE.Vector3(...item.a),
        new THREE.Vector3(...item.b),
        item.note ?? '',
        item.id ?? undefined,
      )
      if (item.distance && Math.abs(measurement.distance - item.distance) > 1e-6) {
        measurement.label = formatMm(measurement.distance)
      }
    }
    this.onChange = this._onChange
    this.onChange?.(this.serialize())
  }

  dispose() {
    this.clear()
    this.group.clear()
  }
}

function round(n, decimals = 4) {
  const f = 10 ** decimals
  return Math.round(n * f) / f
}
