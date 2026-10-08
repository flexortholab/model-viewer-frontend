@echo off
rem Servidor de desarrollo con los cambios locales (inclusive los no guardados).
rem Espera unos segundos, abre el visor con la escena por defecto y deja la
rem consola con el log de vite. Cerrar la ventana detiene el servidor.
cd /d "%~dp0"
start "" "http://localhost:5173/viewer.html?model=samples/Test1.glb"
npm run dev
