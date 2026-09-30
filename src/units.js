/**
 * Deteccion y normalizacion de unidades a milimetros.
 *
 * El problema: STL no lleva unidades, y el exportador glTF de Blender
 * convierte a metros (la spec de glTF dice metros). Un arco mandibular de
 * ~50 mm llega como 0.05 en un .glb y como 50 en un .stl.
 *
 * Este modulo es puro (no importa three) para poder testearlo en node.
 */

export const UNIT_FACTORS = { mm: 1, cm: 10, m: 1000, um: 0.001, in: 25.4 }

// Dimensiones plausibles en mm para una pieza de protesis dental: desde un
// abutment (~5 mm) hasta una arcada completa con anclaje esqueletico (~130 mm).
// El margen llega a 200 mm porque los casos reales traen craneo y modelo de
// escayola junto a la arcada (p. ej. Final1.glb: 171 mm).
export const PLAUSIBLE_MIN = 4
export const PLAUSIBLE_MAX = 200

// Solo se consideran escalas >= 1. Un archivo que llega mas pequeno que 4 mm
// viene en metros (es lo que produce el exportador glTF de Blender); uno que
// llega mas grande de 200 mm viene mal exportado, y reescalar a la baja solo
// aria danar una geometria que ya era correcta.
const CANDIDATES = [
  { units: 'mm', scale: 1 },
  { units: 'cm', scale: 10 },
  { units: 'm', scale: 1000 },
]

function evaluate(maxDimRaw) {
  return CANDIDATES.map((candidate) => {
    const maxDimMm = maxDimRaw * candidate.scale
    return {
      ...candidate,
      maxDimMm,
      plausible: maxDimMm >= PLAUSIBLE_MIN && maxDimMm <= PLAUSIBLE_MAX,
    }
  }).sort((a, b) => a.scale - b.scale) // el mas conservador primero
}

/**
 * @param {number} maxDimRaw dimension maxima del bounding box en unidades del archivo
 * @param {string|null} [forced] 'mm' | 'cm' | 'm' | 'um' | 'in' para forzar
 * @returns {{scale:number, units:string, source:string, confidence:number,
 *            maxDimRaw:number, maxDimMm:number, alternatives:Array}}
 */
export function detectUnits(maxDimRaw, forced = null) {
  if (forced) {
    const key = String(forced).toLowerCase()
    const scale = UNIT_FACTORS[key]
    if (!scale) {
      throw new Error(`Unidad desconocida: "${forced}". Usa ${Object.keys(UNIT_FACTORS).join(', ')}.`)
    }
    return {
      scale,
      units: key,
      source: 'forced',
      confidence: 1,
      maxDimRaw,
      maxDimMm: maxDimRaw * scale,
      alternatives: [],
    }
  }

  if (!Number.isFinite(maxDimRaw) || maxDimRaw <= 0) {
    return {
      scale: 1,
      units: 'mm',
      source: 'fallback',
      confidence: 0,
      maxDimRaw,
      maxDimMm: maxDimRaw,
      alternatives: [],
    }
  }

  const ranked = evaluate(maxDimRaw)
  const plausible = ranked.filter((c) => c.plausible)
  const best = plausible[0] ?? ranked[0]

  // Si el tamano en mm ya cae dentro del rango, no tocamos nada y estamos
  // seguros. Si no, escalamos y la confianza baja segun quantas lecturas
  // competes fueran plausibles.
  let confidence = 0.2
  if (best.plausible) {
    const margin = Math.min(best.maxDimMm - PLAUSIBLE_MIN, PLAUSIBLE_MAX - best.maxDimMm)
    if (plausible.length === 1) confidence = 0.9 + Math.min(margin / 80, 0.09)
    else confidence = 0.65
  }

  return {
    scale: best.scale,
    units: best.units,
    source: 'auto',
    confidence: round(confidence, 2),
    maxDimRaw,
    maxDimMm: best.maxDimMm,
    alternatives: plausible
      .slice(1)
      .map((c) => ({ units: c.units, scale: c.scale, maxDimMm: round(c.maxDimMm) })),
  }
}

export function round(n, decimals = 3) {
  const f = 10 ** decimals
  return Math.round(n * f) / f
}

/** Formatea un valor en mm con el formato habitual de diseno dental. */
export function formatMm(value, decimals = 2) {
  const v = round(value, decimals)
  return `${decimals === 0 ? v.toFixed(0) : v.toFixed(decimals)} mm`
}
