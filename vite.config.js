import { defineConfig } from 'vite'
import { DEV_API_PREFIX, PRODUCTION_API_BASE } from './src/api-url.js'

const productionApi = new URL(PRODUCTION_API_BASE)

export default defineConfig({
  base: './',
  server: {
    port: 5173,
    fs: { strict: false },
    // La API solo acepta el origen de GitHub Pages: en desarrollo se le
    // reenvian las peticiones sin la cabecera Origin (ver src/config.js).
    proxy: {
      [DEV_API_PREFIX]: {
        target: productionApi.origin,
        changeOrigin: true,
        rewrite: (path) => path.replace(DEV_API_PREFIX, productionApi.pathname),
        configure: (proxy) => {
          proxy.on('proxyReq', (request) => request.removeHeader('origin'))
        },
      },
    },
  },
  build: {
    target: 'es2022',
    assetsInlineLimit: 0,
    chunkSizeWarningLimit: 1200,
    rollupOptions: {
      input: {
        main: 'index.html',
        login: 'login.html',
        panel: 'panel.html',
      },
    },
  },
})
