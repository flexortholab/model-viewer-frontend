# dental-viewer

Visor web 3D tipo Autodesk Viewer para compartir diseños dentales con clientes y doctores.
Pensado para **disyuntores sinterizados con anclaje esquelético** diseñados en Blender, pero acepta cualquier modelo 3D estático.

- unidades en **milímetros** con detección automática
- **corte seccional** con plano único y gizmo (mover+rotar), capping sólido por pieza (stencil buffer) con anillo de contorno
-  estilo plano de taller con etiquetas proyectadas
- **anotaciones** exportables como sidecar JSON
- embebible en un **webclip / iframe** vía `postMessage`, o por enlace directo

Estado actual: **v0.3.6** funcional (cámara **ortográfica** — sin perspectiva ni "ojo de pez"—, plano de corte unico con gizmo mover+rotar atenuado, capping por pieza con curva de corte exacta por objeto, lista de objetos con iconos propios y corte por pieza, presentacion con marcadores editables, medidas compactas de una en una en mm con 1 decimal, seleccion y nota de medidas, cubo de vistas clicable en la esquina con las caras bien orientadas, **giro libre sin topes** — ArcballControls, se puede pasar de largo por superior e inferior—, paneles separados Vistas (en cruz) y Herramientas, logo oficial del laboratorio con su teal y gris de marca, titulo del caso sin marco, render bajo demanda). Ver [docs/PLAN.md](docs/PLAN.md) para el plan original y la hoja de ruta. Casos reales verificados: `B1.glb` (8 piezas, mm auto 0.99), `Final1.glb` (7 piezas, mm auto 0.99) y escena FBX (misma que Final1 pero en cm: usar `?units=cm`).

### Cámara y vistas

La cámara es **ortográfica**: no hay perspectiva ni distorsión de ojo de pez, que es lo
que se busca al revisar anatomía. Como la escala no depende de la distancia, el
encuadre se ajusta variando el frustum (`_fitOrtho`) en lugar de alejar la cámara, y
cada vista recalcula su escala para no recortar la pieza.

El botón **Encuadrar** sustituye al anterior *Isométrica*: hacía casi lo mismo.

### Giro de la escena

Por defecto la escena gira **libre**: la cámara se mueve con un trackball virtual
(`ArcballControls`), sin topes, así que se puede pasar por encima y por debajo de la
pieza y seguir dando la vuelta. El modo anterior (`OrbitControls`), que se quedaba
clavado al llegar a superior/inferior, sigue disponible con **`?giro=orbit`**; el
libre se puede forzar con **`?giro=libre`**. En `demo-giro.html` hay un interruptor
en pantalla para comparar ambos modos con la escena real.
> **Demo desplegada (GitHub Pages, rama gh-pages):** https://rms1982.github.io/dental-viewer/
> **Demo cargada con la pieza de ejemplo (visita recomendada):** https://rms1982.github.io/dental-viewer/?model=samples/disyuntor-4-pilares.stl&section=y=0
> La demo sirve el build de la rama `main`; para actualizarla basta rehacer `npm run build` y actualizar `gh-pages`.

---

## Arranque rápido

```bash
npm install        # three + vite
npm run dev        # servidor de desarrollo en http://localhost:5173
```

Probar con la muestra incluida:

```bash
npm run sample     # genera public/samples/*.stl
npm run dev
# abrir http://localhost:5173/?model=samples/disyuntor-4-pilares.stl
```

Producción:

```bash
npm run build      # genera dist/ (target es2022, base './' → desplegable en cualquier subcarpeta)
npm run preview    # sirve dist/ en http://localhost:4173
```

## Comandos npm

| Comando | Qué hace |
|---|---|
| `npm run dev` | Servidor de desarrollo (Vite, puerto 5173) |
| `npm run build` | Build de producción en `dist/` |
| `npm run preview` | Sirve `dist/` en el puerto 4173 |
| `npm run sample` | Genera las STL de muestra en `public/samples/` |
| `npm test` | Tests unitarios (runner nativo de Node, 15 tests) |
| `node scripts/smoke.mjs` | Smoke test headless con Chromium (ver más abajo) |

## Tests

- **Unitarios** (`test/units.test.js`): detección de unidades, formato `formatMm`, y validación del formato de anotaciones. `npm test`.
- **Smoke test** (`scripts/smoke.mjs`): prueba end-to-end headless. Requiere `npm run preview` corriendo en el 4173 y Chromium instalado (`CHROME_PATH` para una ruta no estándar). Carga la muestra STL en un Chromium headless (SwiftShader, sin GPU) y valida carga, unidades, corte con stencil, mediciones, round-trip de anotaciones y estabilidad de la escena. En entornos donde el headless no compone pixeles al canvas, los checks visuales del capping se omiten con aviso. Ultimo resultado: **34/34**.

---

## Uso por URL

Todos los parámetros son opcionales y combinables:

| Parámetro | Ejemplo | Descripción |
|---|---|---|
| `model` | `?model=samples/pieza.glb` | URL del modelo (relativa o absoluta) |
| `units` | `?units=mm` | Fuerza unidades: `mm\|cm\|m\|um\|in` |
| `annotations` | `?annotations=caso.json` | Sidecar JSON a aplicar tras la carga |
| `section` | `?section=y=2.5` o `?section=z=-1` | Corte inicial por semieje (compatibilidad: se traduce a plano con normal en ese eje) |
| `background` | `?background=dark` o `?background=#1a1d21` | Preset (`light`=blanco por defecto, `dark`, `studio`) o color CSS |
| `material` | `?material=dental` | Por defecto conserva los colores/texturas de la exportacion; `dental` aplica el material neutral clasico |
| `embed` | `?embed=1` | Oculta toolbar y panel (modo iframe para el webclip) |

Sin `?model=`, el visor queda a la espera de un comando `load` por `postMessage`.

## Formatos de modelo

`glb`, `gltf`, `stl`, `obj`, `fbx`, `3mf`.

- **GLB es el formato canónico**: exporta desde Blender como glTF 2.0. Soporta compresión Draco (`public/draco/`), texturas KTX2/Basis (`public/basis/`) y Meshopt.
- **FBX** se acepta como entrada (ThreeFBX de three.js), pero FBX pesado animado pierde animaciones: la normalización hornea transformaciones y conserva solo posición/normal/uv.
- **STL** no lleva unidades; la heurística de `units.js` adivina la escala (ver abajo).

## Unidades (mm)

`src/units.js` no confía en el archivo: mide el bounding box crudo y prueba escalas ×1, ×10, ×1000 (nunca reduce). Un archivo es plausible como está si su dimensión máxima queda entre **4 y 200 mm** (de un pilar ~5 mm a una arcada con cráneo y modelo de escayola, p. ej. 171 mm).

- Falla dentro del rango → se respeta tal cual (`confidence` alta) y se listan `alternatives`.
- Solo plausible tras ×1000 (típico glTF/Blender en metros) → escala ×1000.
- Nada plausible → `confidence < 0.5` y el badge de estado se marca en rojo.
- `?units=` o el comando `load` fuerzan la escala con `confidence 1`.

## Corte seccional

Un plano único anclado al modelo, colocado con gizmo (flechas para mover, anillos para
rotar, ambos visibles a la vez). Botones **Alinear con la vista** y **Girar 90 grados**.
La superficie del corte se tapa en solido (stencil) y su perimetro se dibuja con la
curva exacta de interseccion plano↔malla por pieza (calculada en CPU al activar el
corte y al soltar el gizmo; durante el arrastre solo se mueve el capping para no
tironear). La técnica usa:

- `localClippingEnabled` + `clippingPlanes` por material
- **stencil capping**: caras traseras/frente escriben stencil con operaciones opuestas y un quad coplanar tapa el hueco con `stencilFunc NotEqual 0` — el corte se ve **sólido**, no hueco
- cada tapa respeta los otros planos activos (un cruce en L queda correcto)

Color de tapa configurable (por defecto `#c0554a`, terracota). Desactivar el corte conserva las posiciones de los planos.

## Mediciones

Dos clics sobre la superficie (raycast contra las mallas visibles; los puntos ocultos tras un corte se descartan). Cada cota es geometría 3D en mm con 1 decimal: línea de cota `Line2` (grosor constante en pantalla), líneas de extensión, tildes y puntos, más cifra en sprite 3D (`20.0 mm`).

- La cota se desplaza al lado más legible respecto a la cámara.
- **Doble clic en la cifra** borra la medición.
- Las etiquetas se ocultan si el punto queda tras un corte activo o detrás de la cámara.

## Anotaciones

Todas las anotaciones (mediciones, marcadores, corte) se guardan en un **JSON aparte del mesh** — se puede corregir un texto sin re-exportar desde Blender. Formato `version 1`:

```json
{
  "version": 1,
  "units": "mm",
  "model": "casos/123.glb",
  "meta": { "caseId": "...", "patient": "...", "doctor": "...", "date": "2026-09-29" },
  "section": { "enabled": true, "capColor": "#c0554a", "planes": [{ "axis": "y", "offset": 2.5, "enabled": true }] },
  "measurements": [{ "id": "m1", "a": [x,y,z], "b": [x,y,z], "distance": 12.346, "note": "ancho total" }],
  "markers": [{ "id": "k1", "position": [x,y,z], "text": "...", "kind": "screw|note|warning" }]
}
```

Botón **Exportar** (atajo `E`) descarga `<modelo>.annotations.json`. Los documentos se validan y normalizan al cargar: mediciones sin `a`/`b` válidos se descartan, ids duplicados se renumeran, `kind` desconocido cae a `note`.

## Embebido en webclip (postMessage)

Protocolo entre la plataforma (padre) y el visor (iframe). Detalles completos en `src/bridge.js` (JSDoc).

- **Host → visor**: `{ source: 'dental-viewer-host', action: '...', payload: {...} }`
- **Visor → host**: `{ source: 'dental-viewer', protocol: 1, event: 'ready|loaded|changed|error|log|screenshot|annotations', payload: {...} }`

```js
const iframe = document.querySelector('iframe#visor')
iframe.contentWindow.postMessage(
  { source: 'dental-viewer-host', action: 'load', payload: { model: '/casos/123.glb', annotations: '/casos/123.json' } },
  'https://visor.midominio.com',
)
window.addEventListener('message', (e) => {
  if (e.data?.source === 'dental-viewer') console.log(e.data.event, e.data.payload)
})
```

**Acciones del host**: `load`, `annotations`, `section`, `sectionAxis`, `sectionAxisEnabled`, `tool`, `view`, `background`, `wireframe`, `opacity`, `frame`, `clearMeasurements`, `getAnnotations`, `exportAnnotations`, `screenshot`, `resize`.

**Eventos del visor**: `ready` (al arrancar), `loaded` (info del modelo: unidades, tamaño, triángulos), `changed` (doc de anotaciones tras cada cambio), `error`, `log`, `screenshot` (dataURL PNG), `annotations` (respuesta a `getAnnotations`).

Seguridad: solo se aceptan mensajes de `window.parent`/`window` y con origen en el referrer, el propio, o los de `allowedOrigins`. Si no está embebido, el puente queda silenciado.

## Interfaz

**Toolbar** (izquierda):

| Botón | Acción | Atajo |
|---|---|---|
| Encuadrar | reencuadra la cámara | `F` |
| Frontal / Superior / Lateral | vista predefinida | — |
| Medir | activa modo medición | `M` (sale `Esc`) |
| Borrar medidas | limpia todas las cotas | — |
| Exportar | descarga `annotations.json` | `E` |

**Panel Corte seccional** (derecha, plegable): switch general, botones Alinear con la vista y Girar 90 grados. El plano se mueve/rota con el gizmo sobre la pieza.

**Barra de estado** (abajo): unidades detectadas/forzadas con alerta si la confianza es baja, triángulos y dimensiones en mm.

En pantallas ≤ 640px el panel baja a la parte inferior. Todo el texto está en español.

---

## Arquitectura

```
index.html
└─ src/main.js            arranque, UI, params URL, acciones del host
   ├─ src/viewer.js       clase DentalViewer: escena, cámara, render loop, herramientas
   │  ├─ src/loaders.js   carga por formato, Draco/KTX2/Meshopt, normalización, materiales
   │  │  └─ src/units.js  heurística de unidades (puro, sin three)
   │  ├─ src/section.js   SectionTool: planos + stencil capping
   │  ├─ src/measure.js   MeasureTool: cotas Line2 + etiquetas HTML
   │  ├─ src/annotations.js  formato y validación del sidecar (puro)
   │  └─ src/units.js     formatMm / round
   ├─ src/bridge.js       createBridge: postMessage (sin three)
   ├─ src/annotations.js  download / suggestedFilename
   └─ src/units.js        formatMm
```

`section.js`, `measure.js`, `annotations.js`, `units.js` y `bridge.js` son independientes entre sí. `annotations.js` y `units.js` no importan three — por eso los tests unitarios corren sin navegador.

## Decisiones de diseño relevantes

- **Sin framework SPA**: una vista, tal vez dos; Vite + three.js basta.
- **Materiales**: por defecto se conservan los colores y texturas de la exportacion (`?material=dental` aplica el neutral clasico `0xd9d5cc` si se quiere revisar shape puro). Los materiales por defecto sin color se viran a un gris neutro para que se vean sobre el fondo blanco.

- **Normalización agresiva** (`normalizeModel`): hornea transformaciones, recentra en el origen, fusiona mallas opcionales, descarta atributos no posicionales. Simplifica el corte y la medición.
- **Anotaciones fuera del mesh**: decisión clave para el flujo de trabajo Blender→web (editable sin reexportar).
- **WASM en `public/`**: decodificadores Draco/Basis servidos estáticos junto al bundle, referenciados con `document.baseURI`. `assetsInlineLimit: 0` en Vite para que no los inlinee.

## Limitaciones conocidas

Detectadas y corregidas en la sesion del 29/09/2026 (smoke **34/34** con Chromium headless sobre SwiftShader):

**Corregido esta noche:**

1. `setSectionAxis` ahora activa el eje por defecto (`enable: true`) en `viewer.js`; el ramal `?section=` de `main.js` lo hereda y el panel de UI sigue funcionando igual.
2. `screenshot(scale)` respeta el parametro: renderiza a mayor resolucion (hasta x4) y devuelve el canvas a su tamano original (el smoke lo comprueba).
3. `markerGroup` se re-adjunta tras `modelRoot.clear()` en cada carga: marcadores y cotas sobreviven recargas sucesivas.
4. El listener `controls change` se desregistra antes de cada `load()` (sin acumulacion).
5. Botones **Lingual** e **Isometrica** en la toolbar (ya existian en `setView`).
6. Aviso en pantalla cuando un corte cae fuera de la geometria (`planeIntersectsBounds` cableado en el evento `section`).
7. `npm test` arreglado para Windows: `node --test test/*.test.js` (el comodin no resuelve la carpeta en Node 22).
8. CI con GitHub Actions (tests + build + smoke en cada push/PR) y LICENSE MIT.

**Sesión del 30/09–01/10/2026 (smoke 42/42, unitarios 18/18):**

1. Fusionado el trabajo de la sesión paralela (plano único con gizmo mover+rotar,
   capping por pieza con anillo de contorno, medidas con drag + snap + sprite 3D,
   foco de objetos con corte por pieza, botón Girar 90°, vistas Izquierda/Derecha/Inferior).
2. `units.js`: rango plausible [4, 200] mm (los casos reales traen cráneo y escayola).
3. Marcadores editables: renombrar con doble clic + comando bridge `updateMarker`;
   corregido `activePopupId` (quedaba el paso sin resaltar).
4. GLB/FBX reales de Blender verificados en navegador (B1, Final1, Mario FBX).
5. Limpieza de carpetas duplicadas accidentales (`src/src`, `scripts/scripts`, …).

**Sesión del 01/10/2026 (mediodía-3; smoke 53/53, unitarios 24/24):**

1. Medir estilo Autodesk: cursor propio de colocar punto, anillo de snap
   (teal = vértice exacto, gris = superficie) y goma elástica con la cifra en
   vivo antes del segundo clic (solo repinta al cambiar la décima).
2. Corte por pieza (tijeras) también arranca girado 90° por defecto.
3. `setTool` gestiona la clase del cursor (antes solo la UI).

**Sesión del 01/10/2026 (mediodía-2; smoke 48/48, unitarios 24/24):**

1. Cubo a la esquina inferior izquierda; caras izquierda/derecha anatómicas
   (FDI: derecha −X, izquierda +X) y panel Vistas en cruz con Frontal al centro.
2. Materiales mate y sólidos (metalness 0, rugosidad ≥0.8, mismos colores).
3. Gizmo atenuado al 15% sin el ratón encima (vuelve solo al pasar o arrastrar;
   respeta el `_opacity` interno de TransformControls).
4. Medidas de una en una: al completar vuelve a cámara libre (hay que pulsar
   Medir para la siguiente).
5. Smoke robusto al readback congelado de SwiftShader (salta, no falla).

**Sesión del 01/10/2026 (tarde; smoke 48/48, unitarios 24/24):**

1. Panel **Objetos desplegado por defecto**; panel **Vistas** con wrap corregido y
   **cubo de navegación** (6 caras clicables, rota con la cámara, resalta la vista
   activa; verificado cara por cara).
2. Logo más pequeño (72 px) y acento corporativo teal (botones,
   checkbox, iconos, bordes de cifra, marcador de tornillo).
3. Medidas compactas (~1/3 menos): cifra 3D, líneas y puntos reducidos.
4. **Precisión 0.1 mm** (`formatMm` a 1 decimal por defecto).
5. **Mm siempre sin `?units=`**: pista por formato (FBX→cm como sale de Blender,
   resto→mm); la salida sigue siendo mm y `?units=` mantiene prioridad.
6. Render bajo demanda ya activo (la GPU descansa en reposo).

**Sesión del 01/10/2026 (tarde-2; smoke 48/48, unitarios 24/24):**

1. Cotas reequilibradas: globo más pequeño, líneas/tildes/puntos más visibles.
2. Frontal sin destacar en Vistas; Herramientas en columna vertical.
3. Al activar el corte sin posición guardada arranca girado 90° (de perfil).
4. "Activar corte" es un botón con estado (resaltado = activo).
5. Mate en todos los materiales (Standard/Phong/FBX/clearcoat) + luz suavizada.

**Sesión del 01/10/2026 (smoke 43/43, unitarios 23/23):**

1. Curva de corte exacta por pieza (`cutPlaneSegments` en `section.js`, con tests):
   sustituye al anillo por hull, que pintaba tambien la silueta exterior y dejaba
   hueco. Solo el perimetro del corte, pegado a la superficie por construccion.
2. Paneles separados **Vistas** y **Herramientas** (antes una sola toolbar).
3. Logo del laboratorio en la esquina inferior derecha (el fichero en `public/logo.svg`
   se sustituyo mas adelante por el lockup horizontal oficial).
4. Render bajo demanda: la GPU descansa en reposo (bucle con `controls.update()`,
   cola de 30 frames y pintado al mover el raton). Sin cambios de materiales,
   sombras ni pipeline: el mismo render de siempre, solo menos veces.
5. `loaded` incluye la GPU detectada (`WEBGL_debug_renderer_info`) para
   diagnosticar integrada vs dedicada en cada equipo.

**Sesión del 01/10/2026 (noche; smoke 64/64, unitarios 24/24):**

1. **Logo oficial** (`public/logo.svg`, lockup horizontal `flex ortholab` +
   LABORATORIO DIGITAL): sale el PNG circular. Se quitan el perfil ICC y el resto de
   metadatos de Inkscape que inflaban el fichero a 1 MB, y se ajusta el `viewBox` al
   contenido real con 8 unidades de margen (la proporción es 1.66:1, no la del
   lienzo original). Halo blanco suave para que se lea sobre la pieza.
2. **Acento de interfaz = el del logo**: `--accent: #63bbd4` exacto para iconos,
   bordes, relleno del cubo activo y anillo del loader. Se añaden `--accent-strong`
   (`#1b8aa3`) y `--accent-ink` (`#0f6b80`) para los puntos donde el teal claro no
   tenga contraste (texto pequeño, checkbox, cifras 3D sobre la pieza) y
   `--brand-ink` (`#666767`), el gris de la tipografía del logo.
3. **Título del caso** sin globo: 22 px, peso 700, en `--brand-ink`, solo con sombra
   blanca de legibilidad.
4. **Iconos de la lista de objetos** en SVG con el mismo trazo (1.5 px) que las barras:
   ojo, ojo tachado y tijeras. Se sustituyen los emojis 👁/✂, que cambiaban de aspecto
   según el sistema. Los botones ya no llevan pastilla de "pulsado".
5. **Cubo de vistas corregido**: la matriz era una conjugación espejada, así que el
   cubo se veía del revés y las caras laterales salían intercambiadas. Ahora es la
   rotación inversa de la cámara, sin espejar, y cada cara mira hacia donde se sitúa
   la cámara en esa vista (`izquierda` = +X, `superior` = +Y). Verificado cara por cara
   en las seis vistas.
6. **Giro libre garantizado**: los controles no fijan `min/maxPolarAngle` ni
   `min/maxAzimuthAngle`. Se añade cobertura en el smoke con arrastre real de ratón
   (bandeja horizontal, vista desde debajo con polar 180° y vueltas completas) para
   que nadie reintroduzca topes.
7. Loader y título: el loader se enciende de forma síncrona al pedir la carga (ya no
   dependía de un `setTimeout` para detectarlo en headless).

**Pendiente:**

1. Decodificadores Draco/Basis duplicados entre el bundle de Vite y `public/` — optimizacion, no bloqueante.
2. Sin backend ni despliegue productivo: la demo es estatica (Pages).

Nota sobre el smoke: en un Chromium headless con SwiftShader los triángulos se emiten (3418, sin errores GL) pero los pixeles no llegan al canvas compuesto; por eso los checks visuales del capping se basan en conteo de pixeles y se omiten si el entorno no rasteriza.

## Próximos pasos

Ver [docs/PLAN.md](docs/PLAN.md) — incluye el plan original del proyecto, las decisiones de diseño y la hoja de ruta con próximos hitos.
