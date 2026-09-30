/**
 * Formato del sidecar de anotaciones.
 *
 * Se guarda aparte del .glb/.stl para que puedas editar textos y rehacer
 * mediciones sin volver a exportar desde Blender, y para que el visor
 * funcione con un unico archivo binario que el CDN sirve bien.
 */
export const ANNOTATION_VERSION = 1

export function createDocument({ model = '', meta = {} } = {}) {
  return {
    version: ANNOTATION_VERSION,
    units: 'mm',
    model,
    meta: {
      caseId: meta.caseId ?? '',
      patient: meta.patient ?? '',
      doctor: meta.doctor ?? '',
      date: meta.date ?? new Date().toISOString().slice(0, 10),
      ...meta,
    },
    // Plano unico de corte: punto y normal en mm, coordenadas del modelo
    // normalizado (centro en el origen).
    section: { enabled: false, capColor: '#c0554a', point: [0, 0, 0], normal: [0, 0, 1] },
    measurements: [],
    markers: [],
  }
}

const isVec3 = (v) => Array.isArray(v) && v.length === 3 && v.every((n) => Number.isFinite(n))

/** Valida y normaliza un documento. Lanza si esta corrupto. */
export function validateDocument(raw) {
  if (!raw || typeof raw !== 'object') throw new Error('Anotaciones: documento vacio o invalido.')
  const doc = createDocument({ model: String(raw.model ?? '') })
  doc.version = Number(raw.version ?? 1)
  doc.units = String(raw.units ?? 'mm')
  if (doc.units !== 'mm') {
    // Las anotaciones se guardan siempre en mm; si llega en otra unidad es
    // un archivo antiguo o de otro flujo.
    doc.units = 'mm'
  }
  if (raw.meta && typeof raw.meta === 'object') Object.assign(doc.meta, raw.meta)

  if (raw.section && typeof raw.section === 'object') {
    const section = raw.section
    doc.section.enabled = !!section.enabled
    if (typeof section.capColor === 'string') doc.section.capColor = section.capColor

    if (isVec3(section.point) && isVec3(section.normal)) {
      // Esquema nuevo: un plano unico (punto + normal).
      doc.section.point = section.point.map(Number)
      doc.section.normal = section.normal.map(Number)
    } else if (Array.isArray(section.planes) && section.planes.length) {
      // Compatibilidad: esquema antiguo por ejes. Se traduce el primer eje
      // activo (o el primero) a punto+normal conservando la mitad positiva.
      const legacy = section.planes.find((p) => p?.enabled) ?? section.planes[0]
      const axis = String(legacy.axis ?? 'y').toLowerCase()
      const axisVec = axis === 'x' ? [1, 0, 0] : axis === 'z' ? [0, 0, 1] : [0, 1, 0]
      const offset = Number.isFinite(legacy.offset) ? Number(legacy.offset) : 0
      doc.section.point = axisVec.map((n) => n * offset)
      doc.section.normal = axisVec
    }
    if (typeof section.mode === 'string') doc.section.mode = section.mode
  }

  if (Array.isArray(raw.measurements)) {
    const seen = new Set()
    doc.measurements = raw.measurements
      .filter((m) => m && isVec3(m.a) && isVec3(m.b))
      .map((m, i) => {
        let id = typeof m.id === 'string' && m.id && !seen.has(m.id) ? m.id : `m${i + 1}`
        while (seen.has(id)) id = `m${i + 1}_${seen.size}`
        seen.add(id)
        return {
          id,
          a: m.a.map(Number),
          b: m.b.map(Number),
          note: typeof m.note === 'string' ? m.note : '',
        }
      })
  }

  if (Array.isArray(raw.markers)) {
    doc.markers = raw.markers
      .filter((m) => m && isVec3(m.position))
      .map((m, i) => {
        const marker = {
          id: typeof m.id === 'string' && m.id ? m.id : `k${i + 1}`,
          position: m.position.map(Number),
          text: String(m.text ?? ''),
          kind: ['screw', 'note', 'warning'].includes(m.kind) ? m.kind : 'note',
        }
        if (m.view && isVec3(m.view.position) && isVec3(m.view.target)) {
          marker.view = { position: m.view.position.map(Number), target: m.view.target.map(Number) }
        }
        if (m.section && typeof m.section === 'object') {
          const s = m.section
          const snap = { enabled: !!s.enabled }
          if (typeof s.capColor === 'string') snap.capColor = s.capColor
          if (isVec3(s.point)) snap.point = s.point.map(Number)
          if (isVec3(s.normal)) snap.normal = s.normal.map(Number)
          marker.section = snap
        }
        return marker
      })
  }

  return doc
}

export function serialize(doc) {
  return JSON.stringify(doc, null, 2)
}

export function download(doc, filename = `${doc.meta?.caseId || 'caso'}.annotations.json`) {
  const blob = new Blob([serialize(doc)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  link.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

export function suggestedFilename(modelUrl) {
  const base = String(modelUrl || 'modelo').split('?')[0].split('/').pop() || 'modelo'
  return `${base.replace(/\.[^.]+$/, '')}.annotations.json`
}
