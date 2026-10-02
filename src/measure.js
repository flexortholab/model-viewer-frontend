import * as THREE from 'three'
import { Line2 } from 'three/addons/lines/Line2.js'
import { LineMaterial } from 'three/addons/lines/LineMaterial.js'
import { LineGeometry } from 'three/addons/lines/LineGeometry.js'

import { formatMm } from './units.js'

const OFFSET_PX = 36
const DARK_GREY = 0x333333
const MEASURE_BLUE = 0x1b8aa3
const BALLOON_HEIGHT = 0.027

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
    this._selectedId = null
    this._preview = null
    this._snap = null
    this._hover = null
    this._tmp = new THREE.Vector3()
  }

  setEnabled(enabled) {
    this.enabled = !!enabled
    this._pending = null
    this.clearPreview()
    this.setHover(null)
    this.labelLayer.classList.toggle('is-measuring', this.enabled)
    return this.enabled
  }

  setResolution(width, height) {
    for (const material of this.lineMaterials) material.resolution.set(width, height)
  }

  _makeLine(points, { color = 0x111111, width = 2, dashed = false } = {}) {
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
    // Las Line2 pueden calcular bounding boxes erroneas con coordenadas
    // universales → el frustum culling las oculta en GPUs reales. Fuera.
    line.frustumCulled = false
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
    if (this._selectedId === id) this._selectedId = null
    this._dispose(this.measurements[index])
    this.measurements.splice(index, 1)
    this.onChange?.(this.serialize())
    return true
  }

  clear() {
    for (const measurement of this.measurements) this._dispose(measurement)
    this.measurements = []
    this._selectedId = null
    this.clearPreview()
    this.onChange?.(this.serialize())
  }

  _entry(measurement) {
    if (!measurement.__nodes) {
      measurement.__nodes = {
        dim: null,
        extA: null,
        extB: null,
        pointA: null,
        pointB: null,
        value: null,
      }
    }
    return measurement.__nodes
  }

  _build(measurement) {
    const nodes = this._entry(measurement)
    const { a, b } = measurement
    const selected = measurement.id === this._selectedId

    // El offset se calcula en pixeles de pantalla y luego se convierte a
    // unidades de mundo, de modo que la cota siempre se dibuja "plana" en el
    // plano de la vista, como una porteria de futbol pegada a la pantalla.
    const lengthPx = this._segmentLengthPx(a, b)
    const offsetPx = Math.min(Math.max(OFFSET_PX, lengthPx * 0.04), 120)
    const { a2, b2 } = this._screenSpaceOffset(a, b, offsetPx)

    nodes.dim = this._makeLine([a2.x, a2.y, a2.z, b2.x, b2.y, b2.z], { width: 1.0, color: selected ? MEASURE_BLUE : DARK_GREY })
    nodes.extA = this._makeLine([a.x, a.y, a.z, a2.x, a2.y, a2.z], { width: 1.6, color: selected ? MEASURE_BLUE : DARK_GREY })
    nodes.extB = this._makeLine([b.x, b.y, b.z, b2.x, b2.y, b2.z], { width: 1.6, color: selected ? MEASURE_BLUE : DARK_GREY })

    nodes.pointA = this._makePoint(a)
    nodes.pointB = this._makePoint(b)
    for (const key of ['dim', 'extA', 'extB', 'pointA', 'pointB', 'value']) {
      if (nodes[key]) this.group.add(nodes[key])
    }

    // Segmento visible (linea de cota) para el hit-test de seleccion.
    measurement._seg = { a: a2.clone(), b: b2.clone() }

    // La cifra en mm es un sprite 3D con el texto horneado en canvas: se ve
    // SIEMPRE en cualquier navegador (independiente del z-order del DOM).
    nodes.value = this._makeValueSprite(this.displayLabel(measurement))
    this.group.add(nodes.value)
    nodes.value.position.copy(new THREE.Vector3().addVectors(a2, b2).multiplyScalar(0.5))

    // Chip HTML retirado: la cifra via como sprite 3D (nodes.value), que se
    // dibuja siempre por encima de la escena en cualquier navegador.
    this.labels.push({
      el: null,
      id: measurement.id,
      spriteKey: 'value',
      position: new THREE.Vector3().addVectors(a2, b2).multiplyScalar(0.5),
    })
  }

  _makePoint(point, color = DARK_GREY) {
    const geometry = new THREE.SphereGeometry(0.275, 12, 8)
    const material = new THREE.MeshBasicMaterial({ color, depthTest: false })
    this.lineMaterials.add(material)
    const dot = new THREE.Mesh(geometry, material)
    dot.renderOrder = 1000
    dot.raycast = () => {}
    dot.frustumCulled = false
    dot.position.copy(point)
    return dot
  }

  /** Texto "12.3 mm" horneado en una textura de canvas (sprite siempre visible). */
  _makeValueSprite(text) {
    const { texture, width, height } = this._valueTexture(text)
    const material = new THREE.SpriteMaterial({
      map: texture,
      transparent: true,
      depthTest: false,
      sizeAttenuation: false,
    })
    const sprite = new THREE.Sprite(material)
    this._applySpriteSize(sprite, BALLOON_HEIGHT, width / height)
    sprite.center.set(0.5, -0.35)
    sprite.renderOrder = 1001
    sprite.raycast = () => {}
    sprite.frustumCulled = false
    return sprite
  }

  /**
   * Tamano de un sprite NO atenuado, en fraccion de la altura del lienzo.
   * Con camara ortografica el shader no compensa la distancia, asi que el
   * scale es en unidades de mundo: hay que escalarlo con el alto del frustum
   * para que el globo conserve su tamano en pantalla (3.6% del alto).
   */
  _applySpriteSize(sprite, heightFraction, aspect = 1) {
    const frustumHeight = (this.camera.top - this.camera.bottom) || 120
    sprite.scale.set(heightFraction * frustumHeight * aspect, heightFraction * frustumHeight, 1)
  }

  /**
   * Devuelve la longitud en pixeles de pantalla del segmento a-b.
   */
  _segmentLengthPx(a, b) {
    const width = this.container.clientWidth || 1
    const height = this.container.clientHeight || 1
    this._tmp.copy(a).project(this.camera)
    const ax = (this._tmp.x * 0.5 + 0.5) * width
    const ay = (-this._tmp.y * 0.5 + 0.5) * height
    this._tmp.copy(b).project(this.camera)
    const bx = (this._tmp.x * 0.5 + 0.5) * width
    const by = (-this._tmp.y * 0.5 + 0.5) * height
    return Math.hypot(bx - ax, by - ay)
  }

  /**
   * Offset perpendicular al segmento proyectado en pantalla, expresado en
   * pixeles y convertido a unidades de mundo. Asi la cota siempre se ve
   * paralela al plano de la vista, sin rotar con la escena.
   */
  _screenSpaceOffset(a, b, offsetPx) {
    const cam = this.camera
    cam.updateMatrixWorld()
    const width = this.container.clientWidth || 1
    const height = this.container.clientHeight || 1
    const w = cam.right - cam.left
    const h = cam.top - cam.bottom

    // Ejes de la camara en espacio mundo.
    const right = new THREE.Vector3(cam.matrixWorld.elements[0], cam.matrixWorld.elements[1], cam.matrixWorld.elements[2])
    const up = new THREE.Vector3(cam.matrixWorld.elements[4], cam.matrixWorld.elements[5], cam.matrixWorld.elements[6])

    this._tmp.copy(a).project(cam)
    const ax = (this._tmp.x * 0.5 + 0.5) * width
    const ay = (-this._tmp.y * 0.5 + 0.5) * height
    this._tmp.copy(b).project(cam)
    const bx = (this._tmp.x * 0.5 + 0.5) * width
    const by = (-this._tmp.y * 0.5 + 0.5) * height

    const sx = bx - ax
    const sy = by - ay
    const len = Math.hypot(sx, sy) || 1
    // Perpendicular en pantalla (sentido arbitrario; da igual).
    const px = (-sy / len) * offsetPx
    const py = (sx / len) * offsetPx

    // Para una camara ortografica, pasar de pixeles a unidades de mundo.
    // El eje Y de la pantalla esta invertido respecto al eje Y de la camara.
    const ox = px * (w / width)
    const oy = py * (h / height)
    const offset = new THREE.Vector3().addScaledVector(right, ox).addScaledVector(up, -oy)
    return { a2: a.clone().add(offset), b2: b.clone().add(offset) }
  }

  /** Reajusta todos los sprites a la resolucion actual (zoom, resize, encuadre). */
  syncSpriteSizes() {
    for (const measurement of this.measurements) {
      const sprite = this._entry(measurement).value
      if (!sprite) continue
      const image = sprite.material.map?.image
      const aspect = image ? image.width / image.height : 1
      this._applySpriteSize(sprite, BALLOON_HEIGHT, aspect)
    }
    if (this._snap) this._applySpriteSize(this._snap, BALLOON_HEIGHT)
    if (this._preview?.sprite) {
      const image = this._preview.sprite.material.map?.image
      this._applySpriteSize(this._preview.sprite, BALLOON_HEIGHT, image ? image.width / image.height : 1)
    }
  }

  /** Repinta el sprite de valor tras editar una medida. */
  _refreshValueSprite(measurement) {
    const nodes = this._entry(measurement)
    if (nodes.value) {
      this.group.remove(nodes.value)
      nodes.value.material.map?.dispose()
      nodes.value.material.dispose()
    }
    nodes.value = this._makeValueSprite(this.displayLabel(measurement))
    this.group.add(nodes.value)
  }

  /** Texto del sprite: cifra + nota opcional en la misma pastilla. */
  displayLabel(measurement) {
    const note = (measurement.note ?? '').trim()
    return note ? `${measurement.label} · ${note}` : measurement.label
  }

  /** Cambia la nota de una medida y repinta su cifra. */
  setNote(id, note) {
    const measurement = this.measurements.find((m) => m.id === id)
    if (!measurement) return null
    measurement.note = String(note ?? '')
    this._refreshValueSprite(measurement)
    this.onChange?.(this.serialize())
    return measurement
  }

  /** Selecciona una medida (resalta en teal) o null para soltar. */
  select(id) {
    const next = id ?? null
    if (this._selectedId === next) return this.selected()
    const prevId = this._selectedId
    this._selectedId = next
    for (const measurement of this.measurements) {
      if (measurement.id === prevId || measurement.id === next) {
        this._dispose(measurement)
        this._build(measurement)
      }
    }
    return this.selected()
  }

  selected() {
    return this.measurements.find((m) => m.id === this._selectedId) ?? null
  }

  /**
   * Medida bajo el cursor (linea de cota o extremos), para seleccionar,
   * editar la nota o borrar con Supr. Radio en px de pantalla.
   */
  findMeasurement(clientX, clientY, tolerance = 10) {
    const rect = this.container.getBoundingClientRect()
    const px = clientX - rect.left
    const py = clientY - rect.top
    const width = this.container.clientWidth || 1
    const height = this.container.clientHeight || 1
    const toPx = (v) => {
      this._tmp.copy(v).project(this.camera)
      if (this._tmp.z > 1) return null
      return [(this._tmp.x * 0.5 + 0.5) * width, (-this._tmp.y * 0.5 + 0.5) * height]
    }
    const distSeg = (p, q) => {
      if (!p || !q) return Infinity
      const dx = q[0] - p[0]
      const dy = q[1] - p[1]
      const lenSq = dx * dx + dy * dy
      let t = lenSq > 0 ? ((px - p[0]) * dx + (py - p[1]) * dy) / lenSq : 0
      t = Math.max(0, Math.min(1, t))
      return Math.hypot(px - (p[0] + dx * t), py - (p[1] + dy * t))
    }
    let best = null
    let bestDist = tolerance
    for (const measurement of this.measurements) {
      const seg = measurement._seg
      const a = toPx(seg?.a ?? measurement.a)
      const b = toPx(seg?.b ?? measurement.b)
      const dist = Math.min(distSeg(a, b), distSeg(a, a), distSeg(b, b))
      if (dist < bestDist) {
        bestDist = dist
        best = measurement
      }
    }
    return best
  }

  _dispose(measurement) {
    const nodes = measurement.__nodes
    if (!nodes) return
    for (const key of Object.keys(nodes)) {
      const node = nodes[key]
      if (!node) continue
      this.group.remove(node)
      node.geometry?.dispose()
      node.material?.map?.dispose()
      if (node.material && this.lineMaterials.has(node.material)) {
        node.material.dispose()
        this.lineMaterials.delete(node.material)
      } else if (node.material) {
        node.material.dispose()
      }
    }
    delete measurement.__nodes

    const index = this.labels.findIndex((l) => l.id === measurement.id)
    if (index !== -1) {
      this.labels[index].el?.remove()
      this.labels.splice(index, 1)
    }
  }

  /** Reconstruye todo (tras cambiar la camara o al restaurar). */
  rebuild() {
    for (const measurement of this.measurements) this._dispose(measurement)
    for (const measurement of this.measurements) this._build(measurement)
  }

  _cameraChanged() {
    const sig = `${this.camera.matrixWorld.elements.join(',')}|${this.camera.projectionMatrix.elements.join(',')}`
    if (this._lastCameraSig === sig) return false
    this._lastCameraSig = sig
    return true
  }

  /** Oculta lo que el corte o la camara dejan fuera. Sprites + overlays HTML. */
  update() {
    // Si la camara giro o hizo zoom, la cota hay que reconstruirla porque el
    // offset se calcula en el plano de la vista.
    const hasAny = this.measurements.length || this._preview || this._snap
    if (hasAny && this._cameraChanged()) this.rebuild()
    // Los sprites miden en unidades de mundo: con el frustum ortografico
    // hay que reajustarlos en cada frame para que no cambien de tamano.
    this.syncSpriteSizes()
    if (!this.labels.length) return
    for (const entry of this.labels) {
      const mid = entry.position
      const visible = !this.section || this.section.isPointVisible(mid)
      this._tmp.copy(mid).project(this.camera)
      const offscreen = this._tmp.z > 1
      const shown = visible && !offscreen

      if (entry.spriteKey) {
        // Sprite 3D de valor: controla su visibilidad con flag three.
        const sprite = this.measurements.find((m) => m.id === entry.id)?.__nodes?.value
        if (sprite) sprite.visible = shown
      } else if (entry.el) {
        entry.el.style.display = shown ? '' : 'none'
        if (shown) {
          const width = this.container.clientWidth
          const height = this.container.clientHeight
          const x = (this._tmp.x * 0.5 + 0.5) * width
          const y = (-this._tmp.y * 0.5 + 0.5) * height
          entry.el.style.transform = `translate(-50%, -100%) translate(${x.toFixed(1)}px, ${y.toFixed(1)}px)`
        }
      }
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

  /** Destello visual sobre una etiqueta concreta (p.ej. al pulsar un marcador). */
  pulse(id) {
    const entry = this.labels.find((l) => l.id === id)
    if (!entry?.el) return
    entry.el.classList.remove('is-pulse')
    // Forzar reinicio de la animacion.
    void entry.el.offsetWidth
    entry.el.classList.add('is-pulse')
    clearTimeout(entry.__pulseTimer)
    entry.__pulseTimer = setTimeout(() => entry.el.classList.remove('is-pulse'), 1200)
  }

  setPending(point) {
    this._pending = point ? point.clone() : null
    this.clearPreview()
    if (this._pending) {
      // Punto de origen: pastilla teal (en curso, no amarilla de medida hecha).
      const dot = this._makePoint(this._pending, 0x1b8aa3)
      dot.renderOrder = 1002
      this.group.add(dot)
      this._preview = { a: this._pending.clone(), dot, line: null, sprite: null, lastText: '' }
    }
  }

  /**
   * Puntero sobre la pieza mientras se mide: anillo de snap en el cursor y,
   * si ya hay primer punto, goma elastica con la distancia en vivo.
   * @param {THREE.Vector3|null} point punto bajo el cursor (ya con snap)
   * @param {boolean} snapped true si cayo en un vertice (adherencia exacta)
   */
  setHover(point, snapped = false) {
    if (!this.enabled || !point) {
      if (this._snap) this._snap.visible = false
      return
    }
    if (!this._snap) {
      this._snap = this._makeSnapRing()
      this.group.add(this._snap)
    }
    this._snap.visible = true
    this._snap.position.copy(point)
    this._snap.material.color.setHex(snapped ? 0x1b8aa3 : 0x9aa2b1)
    if (this._pending) this._updatePreview(point)
  }

  /** Anillo + punto central para el cursor de medicion (tamano fijo en px). */
  _makeSnapRing() {
    const canvas = document.createElement('canvas')
    canvas.width = canvas.height = 64
    const ctx = canvas.getContext('2d')
    ctx.strokeStyle = '#ffffff'
    ctx.lineWidth = 5
    ctx.beginPath()
    ctx.arc(32, 32, 22, 0, Math.PI * 2)
    ctx.stroke()
    ctx.fillStyle = '#ffffff'
    ctx.beginPath()
    ctx.arc(32, 32, 5, 0, Math.PI * 2)
    ctx.fill()
    const texture = new THREE.CanvasTexture(canvas)
    texture.colorSpace = THREE.SRGBColorSpace
    const material = new THREE.SpriteMaterial({
      map: texture,
      transparent: true,
      depthTest: false,
      sizeAttenuation: false,
    })
    const sprite = new THREE.Sprite(material)
    this._applySpriteSize(sprite, BALLOON_HEIGHT)
    sprite.renderOrder = 1002
    sprite.raycast = () => {}
    sprite.frustumCulled = false
    sprite.visible = false
    return sprite
  }

  /** Goma elastica del primer punto al cursor, con cifra en vivo. */
  _updatePreview(point) {
    if (!this._preview) return
    const { a } = this._preview
    if (!this._preview.line) {
      this._preview.line = this._makeLine(
        [a.x, a.y, a.z, point.x, point.y, point.z],
        { width: 2, color: 0x1b8aa3, dashed: true },
      )
      this._preview.line.renderOrder = 1002
      this.group.add(this._preview.line)
    } else {
      this._preview.line.geometry.setPositions([a.x, a.y, a.z, point.x, point.y, point.z])
    }
    const text = formatMm(a.distanceTo(point))
    const mid = new THREE.Vector3().addVectors(a, point).multiplyScalar(0.5)
    const shown = (!this.section || this.section.isPointVisible(mid)) && this._inFront(mid)
    if (!this._preview.sprite) {
      this._preview.sprite = this._makeValueSprite(text)
      this._preview.sprite.renderOrder = 1002
      this._preview.lastText = text
      this.group.add(this._preview.sprite)
    } else if (text !== this._preview.lastText) {
      // Solo se repinta el canvas cuando cambia la decima.
      this._preview.sprite.material.map?.dispose()
      const nueva = this._valueTexture(text)
      this._preview.sprite.material.map = nueva.texture
      this._preview.lastText = text
      this._applySpriteSize(this._preview.sprite, BALLOON_HEIGHT, nueva.width / nueva.height)
    }
    this._preview.sprite.position.copy(mid)
    this._preview.sprite.visible = shown
    this._preview.line.visible = shown
  }

  /** Canvas + textura de una cifra con la estetica corporativa. */
  _valueTexture(text) {
    const canvas = document.createElement('canvas')
    const font = '600 15px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif'
    const ctx = canvas.getContext('2d')
    ctx.font = font
    canvas.width = Math.ceil(ctx.measureText(text).width) + 18
    canvas.height = 32
    const c = canvas.getContext('2d')
    c.fillStyle = 'rgba(255,255,255,0.98)'
    c.beginPath()
    c.roundRect(2, 2, canvas.width - 4, canvas.height - 4, 8)
    c.fill()
    c.strokeStyle = '#1b8aa3'
    c.lineWidth = 2.2
    c.stroke()
    c.fillStyle = '#1f2937'
    c.font = font
    c.textAlign = 'center'
    c.textBaseline = 'middle'
    c.fillText(text, canvas.width / 2, canvas.height / 2 + 1)
    const texture = new THREE.CanvasTexture(canvas)
    texture.colorSpace = THREE.SRGBColorSpace
    texture.anisotropy = 4
    return { texture, width: canvas.width, height: canvas.height }
  }

  _inFront(point) {
    this._tmp.copy(point).project(this.camera)
    return this._tmp.z <= 1
  }

  clearPreview() {
    if (!this._preview) return
    for (const node of [this._preview.dot, this._preview.line, this._preview.sprite]) {
      if (!node) continue
      this.group.remove(node)
      node.geometry?.dispose()
      if (node.material) {
        node.material.map?.dispose()
        if (this.lineMaterials.has(node.material)) this.lineMaterials.delete(node.material)
        node.material.dispose?.()
      }
    }
    this._preview = null
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

  /**
   * Medidas EDITABLES: ¿el cursor está sobre un extremo de alguna medida?
   * Devuelve {measurement, key} listo para arrastrarlo (tolerancia en px).
   */
  findEndpoint(clientX, clientY, tolerance = 14) {
    const rect = this.container.getBoundingClientRect()
    const px = clientX - rect.left
    const py = clientY - rect.top
    const width = this.container.clientWidth || 1
    const height = this.container.clientHeight || 1
    let best = null
    let bestDist = tolerance
    for (const measurement of this.measurements) {
      for (const [key, point] of [['a', measurement.a], ['b', measurement.b]]) {
        this._tmp.copy(point).project(this.camera)
        if (this._tmp.z > 1) continue
        const x = (this._tmp.x * 0.5 + 0.5) * width
        const y = (-this._tmp.y * 0.5 + 0.5) * height
        const dist = Math.hypot(x - px, y - py)
        if (dist < bestDist) {
          bestDist = dist
          best = { measurement, key }
        }
      }
    }
    return best
  }

  /**
   * Reubica un extremo a un punto y refresca linea/etiqueta/distancia.
   * Devuelve la medicion actualizada.
   */
  moveEndpoint(measurement, key, point) {
    measurement[key].copy(point)
    measurement.distance = measurement.a.distanceTo(measurement.b)
    measurement.label = formatMm(measurement.distance)
    this._dispose(measurement)
    measurement.__notes = undefined
    this._build(measurement)
    this.onChange?.(this.serialize())
    return measurement
  }

  /**
   * Ajusta a superficie/borde: con el hit del raycast, devuelve el vertice
   * mas cercano de la cara impactada si esta a tiro (adherencia exacta).
   */
  snapToSurface(hit, toleranceRatio = 0.004) {
    if (!hit?.face || !hit.point) return hit.point
    const mesh = hit.object
    const pos = mesh.geometry.getAttribute('position')
    if (!pos) return hit.point
    const tolerance = this.section?.radius ? this.section.radius * toleranceRatio : 0.8
    let best = null
    let bestDist = tolerance
    const candidate = new THREE.Vector3()
    for (const index of [hit.face.a, hit.face.b, hit.face.c]) {
      candidate.set(pos.getX(index), pos.getY(index), pos.getZ(index))
      const distance = candidate.distanceTo(hit.point)
      if (distance <= bestDist) {
        bestDist = distance
        best = candidate.clone()
      }
    }
    return best ?? hit.point
  }

  /**
   * Puntero sobre un extremo: — tras restaurar, los nodos se reconstruyen y
   * los sprites/lineas siguen el punto movido.
   */
  syncDoc() {
    this.onChange?.(this.serialize())
    this.update()
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
