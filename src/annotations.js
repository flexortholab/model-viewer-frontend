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
    section: { enabled: false, capColor: '#c0554a', planes: [] },
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
    if (Array.isArray(section.planes)) {
      doc.section.planes = section.planes
        .filter((p) => p && typeof p.axis === 'string')
        .map((p) => ({
          axis: p.axis.toLowerCase(),
          offset: Number.isFinite(p.offset) ? Number(p.offset) : 0,
          enabled: typeof p.enabled === 'boolean' ? p.enabled : undefined,
          label: typeof p.label === 'string' ? p.label : undefined,
        }))
    }
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
      .map((m, i) => ({
        id: typeof m.id === 'string' && m.id ? m.id : `k${i + 1}`,
        position: m.position.map(Number),
        text: String(m.text ?? ''),
        kind: ['screw', 'note', 'warning'].includes(m.kind) ? m.kind : 'note',
      }))
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
