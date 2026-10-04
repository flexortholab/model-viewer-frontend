// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Marca del visor en UN solo sitio.
 *
 * Para adaptarlo a otro laboratorio basta con editar el objeto BRAND de
 * abajo: nombre, logo y color de acento. El resto (tonos derivados, titulo
 * del documento y cursor de medicion) se aplica solo al arrancar.
 *
 * Si cambias `accent`, los tonos `accentSoft`, `accentStrong` y `accentInk`
 * se recalculan solos, salvo que los fijes a mano en este mismo objeto.
 */
export const BRAND = {
  /** Nombre corto: titulo por defecto y textos de reserva. */
  name: 'Visor dental',
  /** Titulo de la pestana del navegador. */
  title: 'Visor de disyuntores sinterizados',
  /** Logo de la esquina inferior derecha (ruta desde la raiz servida). */
  logo: './logo.svg',
  /** Texto alternativo del logo (accesibilidad). */
  logoAlt: 'Flex Ortholab, laboratorio digital',
  /** Color de acento de toda la interfaz (botones, iconos, resaltados). */
  accent: '#63bbd4',
  /** Tonos actuales: se conservan para no cambiar la estetica. */
  accentSoft: 'rgba(99, 187, 212, 0.18)',
  accentStrong: '#1b8aa3',
  accentInk: '#0f6b80',
}

function hexToRgb(hex) {
  const clean = String(hex).trim().replace('#', '')
  const full = clean.length === 3 ? clean.split('').map((c) => c + c).join('') : clean
  const num = Number.parseInt(full, 16)
  if (!Number.isFinite(num) || full.length !== 6) return null
  return [(num >> 16) & 255, (num >> 8) & 255, num & 255]
}

/** Mezcla un color con otro (t de 0 a 1 hacia `to`). */
function mix(hex, to, t) {
  const from = hexToRgb(hex)
  if (!from) return null
  const mixed = from.map((v, i) => Math.round(v + (to[i] - v) * t))
  return '#' + mixed.map((v) => v.toString(16).padStart(2, '0')).join('')
}

/** Tonos derivados del acento cuando no se fijan a mano en BRAND. */
export function brandShades(accent) {
  const rgb = hexToRgb(accent)
  return {
    accent,
    accentSoft: rgb ? `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, 0.18)` : 'rgba(99, 187, 212, 0.18)',
    accentStrong: mix(accent, [0, 0, 0], 0.45) ?? '#1b8aa3',
    accentInk: mix(accent, [0, 0, 0], 0.6) ?? '#0f6b80',
  }
}

/** Cursor de medicion con el color de acento (el CSS no admite var() en data-URIs). */
function accentCursor(accent) {
  const hex = String(accent).trim().replace('#', '')
  const svg = `<svg xmlns='http://www.w3.org/2000/svg' width='26' height='26'><g stroke='%23${hex}' stroke-width='1.8'><path d='M13 1v8M13 17v8M1 13h8M17 13h8'/></g><circle cx='13' cy='13' r='4' fill='none' stroke='%23${hex}' stroke-width='1.8'/><circle cx='13' cy='13' r='1.4' fill='%23${hex}'/></svg>`
  return `url("data:image/svg+xml,${svg}") 13 13, crosshair`
}

/**
 * Aplica la marca al documento: variables CSS, titulo, logo y cursor.
 * Idempotente y sin dependencias: llamarla una vez al arrancar.
 */
export function applyBrand(brand = BRAND) {
  const shades = brandShades(brand.accent)
  const root = document.documentElement.style
  root.setProperty('--accent', shades.accent)
  root.setProperty('--accent-soft', brand.accentSoft ?? shades.accentSoft)
  root.setProperty('--accent-strong', brand.accentStrong ?? shades.accentStrong)
  root.setProperty('--accent-ink', brand.accentInk ?? shades.accentInk)

  if (brand.title) document.title = brand.title
  const logo = document.getElementById('brand-logo')
  if (logo) {
    if (brand.logo) logo.src = brand.logo
    if (brand.logoAlt) logo.alt = brand.logoAlt
  }

  let style = document.getElementById('brand-style')
  if (!style) {
    style = document.createElement('style')
    style.id = 'brand-style'
    document.head.appendChild(style)
  }
  style.textContent =
    '#viewport.is-measuring canvas,#viewport.is-marking canvas{' +
    `cursor:${accentCursor(shades.accent)}}`
  return shades
}
