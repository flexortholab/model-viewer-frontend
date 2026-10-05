// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * URL de la API del visor en produccion: la URL por defecto de API Gateway
 * (no hay dominio propio). No es secreta: cualquiera la ve en el navegador.
 * Sin dependencias para poder importarla tambien desde vite.config.js.
 */
export const PRODUCTION_API_BASE = 'https://3q71pv9ve2.execute-api.eu-south-2.amazonaws.com/prod'

/** Prefijo que el servidor de desarrollo de Vite reenvia a la API (ver vite.config.js). */
export const DEV_API_PREFIX = '/dev-api'
