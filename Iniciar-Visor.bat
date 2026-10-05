@echo off
rem Abre el visor dental en tu navegador con la escena por defecto.
rem Cambia la URL de abajo para cargar otra escena (p.ej. samples/Final1.glb).
cd /d "%~dp0"
start "" "http://localhost:5173/visor.html?model=samples/Test1.glb"
npm run dev
