# Plan y decisiones del proyecto

Origen del proyecto, decisiones de diseño tomadas al inicio y hoja de ruta.
Sesión original: 2026-09-29. Autor: Rober (protésico dental) con opencode.

---

## Planteamiento original

> *"Quiero una web o servicio parecido a Autodesk Viewer para compartir con mis clientes los
> diseños 3D de mis trabajos. Soy protésico dental y en ocasiones me piden disyuntores
> sinterizados con anclaje esquelético, los cuales diseño con Blender y suelo exportar toda la
> escena en .fbx... me interesa que el visor tenga mediciones en mm y cortes seccionales para
> que los docciones revisen los diseños. Lo embebería en un webclip de mi plataforma de pedidos,
> o bien enviaría el enlace directamente al doctor."*

Contexto de partida:

- El flujo de trabajo es **Blender → export FBX** (escena completa).
- La plataforma de pedidos ya existe; solo falta el visor.
- Requisitos clínicos: **unidades en mm fiables**, cortes con superficie sólida, mediciones,
  comentarios por parte del doctor.
- El plan gratuito de opencode era suficiente para el ritmo del proyecto (así ha sido).

## Arquitectura decidida al inicio

1. **Formato canónico GLB (glTF 2.0), no FBX.** Blender exporta glTF nativamente y soporta
   compresión Draco/Meshopt; FBX es pesado y mal soportado en web. FBXLoader se mantiene para
   *aceptar* `.fbx`, pero el camino de mejora del flujo es migrar la exportación de Blender a glTF.
   STL como input adicional (fresadoras/CAD lo usan).
2. **Unidades con auto-chequeo.** glTF define metros y STL no declara unidades: mide el bounding
   box y prueba ×1/×10/×1000 con ventana de plausibilidad [4, 160] mm. `?units=` para forzar.
   El badge de estado avisa con confianza baja.
3. **Cortes con stencil capping.** `localClippingEnabled` + `clippingPlanes` por material, con
   escritura de stencil y quad coplanar para tapar el interior. Sin capping, el doctor ve la
   pieza hueca y no sirve.
4. **Mediciones con Line2** (grosor constante en pantalla) + etiquetas HTML proyectadas.
5. **Anotaciones en sidecar JSON**, nunca horneadas en el mesh: se puede corregir un comentario
   sin reexportar desde Blender. Un `.glb` + un `.annotations.json` por caso.
6. **Embebido por `<iframe>` + `postMessage`** para que la plataforma controle el visor
   (abrir caso, fijar corte) y reciba eventos (`ready`, `loaded`, `changed`…).
7. **Sin backend** en esta fase: CDN/estático + storage de objetos (free tier). Auth solo si
   algún día se quiere que los doctores comenten en línea.
8. **Sin framework SPA** — una sola vista; Vite + three.js.

Estado del plan: **implementado en su totalidad**; la interfaz se ha pulido en la sesión del 02/10/2026. Lo restante está en la hoja de ruta.

## Hoja de ruta

### Corto plazo (correctivo)

- [x] `setSectionAxis(axis, offset)` debe activar el eje (`enable: true` por defecto en
      `viewer.js` y en el ramal `?section=` de `main.js`) — elimina 2/3 fallos del smoke test
- [x] Reattach de `markerGroup` tras `modelRoot.clear()` en `DentalViewer.load()`
- [x] `screenshot(scale)` que respete realmente el `scale` (multiplicar el tamaño del canvas)
- [x] Desregistrar el listener `controls change` en cada `_setupTools()` (fuga leve)
- [x] Actualizar `scripts/smoke.mjs` si cambia la semántica de activación por eje

### Medio plazo (flujo Blender real)

- [x] Probar GLB real exportado de Blender y FBX de escena completa (01/10/2026:
      `B1.glb` 8 piezas mm auto 0.99, `Final1.glb` 7 piezas mm auto 0.99, FBX de la
      misma escena en cm — usar `?units=cm`, como ya hace `Iniciar-Visor.bat`.
      Rango plausible ampliado a [4, 200] mm por cráneo + modelo de escayola.)
- [x] Avisar cuando el corte cae fuera de la geometría (`planeIntersectsBounds` ya existe,
      falta cablear el aviso)
- [x] Botones para vistas `lingual` y `isometrica`
- [x] Marcadores editables con UI (toolbar + `K`, renombrar con doble clic,
      comando bridge `updateMarker`, foco con `marker-unfocus`)
- [ ] Limpieza de decodificadores Draco/Basis duplicados en el bundle

### Más adelante (distribución)

- [x] Deploy estático (Cloudflare Pages / Vercel; `base './'` ya soporta subcarpeta)
- [ ] Manifiesto con casos para el enlace directo al doctor
- [x] CI: `npm test` + build + smoke en cada PR
- [x] LICENSE (GPL-3.0-or-later desde 2026-10-04; antes MIT)
- [x] Marca centralizada en `src/brand.js` para que otro laboratorio lo adapte
- [ ] (Si acaso) i18n — todo el texto está en español

Fuera de alcance por decisión: comentarios en línea/login (requeriría backend), edición del
mesh, animaciones FBX (se conservan en estado estático a propósito).

## Lecciones y decisiones registradas

- **STL de prueba procedural** (`scripts/make-sample.mjs`) dado que los STL del fresado no
  siempre están disponibles: la muestra genera dos variantes (mm y metros) para demostrar la
  detección de unidades. Ventaja: sin dependencias de datos con licencia.
- **Confianza de unidades visible:** el visor nunca escala silenciosamente sin estar seguro;
  siempre existe el badge con `confidence` y `alternatives`, y `?units=` como escape.
- **Conservador con reducción de escala:** si el archivo dice ser "50 unidades", se asume mm;
  nunca se interpreta que fueran pulgadas para reducir. Un visor clínico prefiere el error
  "no detecté unidades" al "encogí la pieza".
- **`normalizeModel` hornea todo a identidad + centro en origen.** Simplifica corte, raycast y
  medición. Coste: se pierden animaciones/skinning y texturas ajenas a `position/normal/uv` en el
  merge — aceptado a propósito (piezas estáticas).
- **Material único denta uniforme** (`0xd9d5cc`): el objetivo es revisión clínica, no beauty
  shots; sobreescribe los materiales del GLB a propósito.
- **Tests sin navegador:** `units.js` y `annotations.js` no importan three precisamente para
  poder testear la lógica pura (unidades, validación) en cualquier terminal.
- **Smoke test como red real:** los últimos cambios de axes revisaron la semántica de encendido
  por eje y el smoke test revisó — valedero para detectar regresiones antes de cada push.
- **OpenCode Zen plan gratuito** dio abasto para este proyecto (Big Pickle / free tiers);
  la conversación original sugirió OpenCode Go ($10) para modelos top si hiciera falta, y que
  Mistral Vibe Pro no da acceso a GLM-5.3 (se accede vía OpenCode/Zen).

### Pulido UI y demo (02/10/2026)

- [x] Unificar estética de paneles con la barra de Herramientas.
- [x] Mover Corte seccional a la columna izquierda; Objetos y Presentación a la derecha.
- [x] Convertir globos de medidas a chips HTML (mismo comportamiento que marcadores).
- [x] Ajustar tamaño/posición de logo y cubo.
- [x] Sustituir botón *Encuadrar* por **Isométrica** en Vistas; ensanchar Vistas para los botones.
- [x] Demo de GitHub Pages con `B1.glb` como caso de ejemplo.

Pendiente de sesiones anteriores (no bloqueante):

- [ ] Limpieza de decodificadores Draco/Basis duplicados en el bundle.
- [ ] Manifiesto con casos para el enlace directo al doctor.
- [ ] (Si acaso) i18n — todo el texto sigue en español.

---

## Sesión del 29/09/2026 (noche) — registro

- Corto plazo completado al 100%: `setSectionAxis` activa por defecto, reattach de
  `markerGroup`, `screenshot(scale)` real, listener fuga cerrada y smoke actualizado.
- Medio plazo: aviso de corte fuera de geometría cableado (evento `section` en `main.js`)
  y botones Lingual/Isométrica en la toolbar.
- Distribución: CI (GitHub Actions: unit tests + build + smoke) y LICENSE MIT añadidos.
- Smoke test pasa 34/34. En Chromium headless + SwiftShader los píxeles no llegan al
  canvas compuesto (los draw calls sí se emiten, sin errores GL): los checks visuales
  del capping se omiten con aviso en ese entorno, y comprueban conteo de píxeles cuando
  hay rasterización.
- `npm test` corregido en Windows por el glob `test/*.test.js` (Node 22 no resolvía
  `node --test test/`).
- Pendiente para otra sesión: UI de marcadores editables, deduplicar Draco/Basis,
  probar GLB/FBX reales de Blender.

- Deploy grayscale completado (GitHub Pages, rama `gh-pages`): demo en https://rms1982.github.io/dental-viewer/

- Hallazgo de la noche (a investigar cuando lleguen GLB reales):
- ABIERTO (investigacion): en la demo de Pages (mismo bundle que el local) una combinacion
  concreta de Chromium headless + SwiftShader lanza TypeError reading "x" en Vector3.copy
  durante el primer render con clipping planes. El mismo bundle pasa 34/34 en preview local
  y CI (Ubuntu): especifico de un estado GL del entorno; vigilar con GLB reales.
