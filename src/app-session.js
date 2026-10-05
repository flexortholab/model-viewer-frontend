// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Cliente de la API y sesion del navegador, compartidos por el panel y el
 * editor. La sesion vive en localStorage para que sobreviva entre pestanas
 * y reinicios mientras el refresh token siga vigente (30 dias).
 */
import { createApi } from './api.js'
import { API_BASE } from './config.js'
import { createSession } from './session.js'

export const api = createApi({ base: API_BASE })
export const session = createSession({ storage: window.localStorage, api })
