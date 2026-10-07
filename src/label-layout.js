// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Colocacion de las etiquetas de los marcadores fuera del modelo, sin DOM para
 * poder probarla. Todo en pixeles de pantalla: rectangulos {x, y, w, h} con
 * origen arriba a la izquierda.
 *
 * Un marcador es una vista preparada con algo senalado: su etiqueta no debe
 * tapar el modelo ni otra etiqueta. Se coloca justo fuera de la silueta del
 * modelo, por el lado mas cercano a su punto, y una linea guia la une con el.
 */

/** Separacion entre la silueta del modelo y la etiqueta. */
export const SILHOUETTE_GAP = 16
/** Margen con los bordes de la pantalla. */
export const VIEWPORT_PAD = 8
/** Paso al deslizar una etiqueta a lo largo de su lado para esquivar otra. */
const SLIDE_STEP = 12

/** Rectangulo que envuelve una nube de puntos de pantalla, o null si no hay puntos. */
export function boundsOf(points) {
  if (!points.length) return null
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const { x, y } of points) {
    if (x < minX) minX = x
    if (y < minY) minY = y
    if (x > maxX) maxX = x
    if (y > maxY) maxY = y
  }
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY }
}

export function overlaps(a, b) {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h
}

const clamp = (value, min, max) => Math.min(Math.max(value, min), Math.max(min, max))

function insideViewport(rect, viewport) {
  return (
    rect.x >= VIEWPORT_PAD &&
    rect.y >= VIEWPORT_PAD &&
    rect.x + rect.w <= viewport.w - VIEWPORT_PAD &&
    rect.y + rect.h <= viewport.h - VIEWPORT_PAD
  )
}

/**
 * Los cuatro lados de la silueta, del mas cercano al punto al mas lejano.
 * Cada lado da la posicion de la etiqueta pegada a el y el eje por el que se
 * puede deslizar.
 */
function sidesByDistance(anchor, silhouette, size) {
  const { x, y, w, h } = silhouette
  const sides = [
    { name: 'top', distance: anchor.y - y, rect: { x: anchor.x - size.w / 2, y: y - SILHOUETTE_GAP - size.h }, axis: 'x' },
    { name: 'bottom', distance: y + h - anchor.y, rect: { x: anchor.x - size.w / 2, y: y + h + SILHOUETTE_GAP }, axis: 'x' },
    { name: 'left', distance: anchor.x - x, rect: { x: x - SILHOUETTE_GAP - size.w, y: anchor.y - size.h / 2 }, axis: 'y' },
    { name: 'right', distance: x + w - anchor.x, rect: { x: x + w + SILHOUETTE_GAP, y: anchor.y - size.h / 2 }, axis: 'y' },
  ]
  return [...sides].sort((a, b) => a.distance - b.distance)
}

/** Posiciones a lo largo de un lado: la ideal y luego alternando a cada lado. */
function* slides(side, size, viewport) {
  const limit = side.axis === 'x' ? viewport.w - size.w - VIEWPORT_PAD : viewport.h - size.h - VIEWPORT_PAD
  const start = clamp(side.rect[side.axis], VIEWPORT_PAD, limit)
  const steps = Math.ceil(Math.max(viewport.w, viewport.h) / SLIDE_STEP)
  for (let i = 0; i <= steps; i++) {
    for (const sign of i === 0 ? [1] : [1, -1]) {
      const along = start + sign * i * SLIDE_STEP
      if (along < VIEWPORT_PAD || along > limit) continue
      yield { ...side.rect, [side.axis]: along, w: size.w, h: size.h }
    }
  }
}

/** Punto del borde de `rect` mas cercano a `point`: donde termina la linea guia. */
export function nearestPointOnRect(point, rect) {
  return {
    x: clamp(point.x, rect.x, rect.x + rect.w),
    y: clamp(point.y, rect.y, rect.y + rect.h),
  }
}

/**
 * Coloca una etiqueta de tamano `size` para el punto `anchor`, fuera de la
 * `silhouette` del modelo, dentro de la pantalla y sin pisar `obstacles`
 * (otras etiquetas). Si no cabe en ningun sitio libre (el modelo llena la
 * pantalla), la deja sobre el lado mas cercano, metida en la pantalla: tapar
 * algo es mejor que no verla.
 *
 * Devuelve `{ rect, leader: { from, to } }`.
 */
export function placeLabel({ anchor, size, silhouette, viewport, obstacles = [] }) {
  const sides = sidesByDistance(anchor, silhouette, size)
  const blocked = [silhouette, ...obstacles]
  for (const side of sides) {
    for (const rect of slides(side, size, viewport)) {
      if (insideViewport(rect, viewport) && !blocked.some((other) => overlaps(rect, other))) {
        return { rect, leader: { from: anchor, to: nearestPointOnRect(anchor, rect) } }
      }
    }
  }
  const [nearest] = sides
  const rect = {
    x: clamp(nearest.rect.x, VIEWPORT_PAD, viewport.w - size.w - VIEWPORT_PAD),
    y: clamp(nearest.rect.y, VIEWPORT_PAD, viewport.h - size.h - VIEWPORT_PAD),
    w: size.w,
    h: size.h,
  }
  return { rect, leader: { from: anchor, to: nearestPointOnRect(anchor, rect) } }
}
