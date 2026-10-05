// SPDX-License-Identifier: GPL-3.0-or-later
import { DEV_API_PREFIX, PRODUCTION_API_BASE } from './api-url.js'

/**
 * Base de la API segun el entorno. En `npm run dev` se pasa por el proxy de
 * Vite porque la API solo acepta el origen de GitHub Pages en CORS; el proxy
 * quita la cabecera Origin y la peticion entra como si no viniera de un
 * navegador.
 */
export const API_BASE = import.meta.env.DEV ? DEV_API_PREFIX : PRODUCTION_API_BASE
