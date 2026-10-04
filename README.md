# dental-viewer

Visor web 3D tipo Autodesk Viewer para compartir diseños dentales con clientes y doctores.
Pensado para **disyuntores sinterizados con anclaje esquelético** diseñados en Blender, pero acepta cualquier modelo 3D estático.

- unidades en **milímetros** con detección automática
- **corte seccional** con plano único y gizmo PivotControls (mover+rotar, sin escala), capping sólido por pieza (stencil buffer) con anillo de contorno
-  estilo plano de taller con etiquetas proyectadas
- **anotaciones** exportables como sidecar JSON
- embebible en un **webclip / iframe** vía `postMessage`, o por enlace directo

Estado actual: **v0.3.7** funcional (cámara **ortográfica** — sin perspectiva ni "ojo de pez"—, plano de corte único con gizmo PivotControls de flechas, planos y arcos de rotación a la vez, con un solo botón, capping por pieza con curva de corte exacta por objeto, lista de objetos con iconos propios y corte por pieza, presentación con marcadores editables, medidas compactas de una en una en mm con 1 decimal con globos HTML fijos en pantalla, selección y nota de medidas, cubo de vistas clicable en la esquina con las caras bien orientadas, **giro libre sin topes** — ArcballControls, se puede pasar de largo por superior e inferior—, paneles separados Vistas (en cruz), Herramientas, Corte seccional, Objetos y Presentación con estética unificada, logo oficial del laboratorio con su teal y gris de marca, título del caso sin marco, render bajo demanda). Ver [docs/PLAN.md](docs/PLAN.md) para el plan original y la hoja de ruta. Casos reales verificados: `B1.glb` (8 piezas, mm auto 0.99), `Final1.glb` (7 piezas, mm auto 0.99) y escena FBX (misma que Final1 pero en cm: usar `?units=cm`).

### Cámara y vistas

La cámara es **ortográfica**: no hay perspectiva ni distorsión de ojo de pez, que es lo
que se busca al revisar anatomía. Como la escala no depende de la distancia, el
encuadre se ajusta variando el frustum (`_fitOrtho`) en lugar de alejar la cámara, y
cada vista recalcula su escala para no recortar la pieza.

La barra de **Vistas** incluye las seis caras del cubo más **Isométrica**. El atajo `F` sigue reencuadrando el modelo; el botón *Encuadrar* se ha movido al protocolo `postMessage` y al bridge.

### Mediciones editables

Cualquier medida se puede **retocar en cámara libre**, sin volver al modo
medir: si el cursor se pone sobre un extremo aparece la mano, y al arrastrar
el punto se reajusta la cifra. Al arrastrar se desactiva la cámara, así que la
pieza no se mueve, y el punto se adhiere a la superficie y a los vértices
cercanos para clavar la medida. El doble clic sobre la línea edita la nota.

Los marcadores de presentación también se pueden mover: en cámara libre, si
el cursor pasa por encima del punto aparece la mano y puedes arrastrarlo para
recolocarlo sobre la pieza. Al soltar se adhiere a la superficie más cercana.

El dibujo es deliberadamente sobrio: línea de cota, dos líneas de arranque,
los dos puntos y el globo con la cifra. Sin tildes oblicuas en los extremos,
que solo confundían.

La cota se calcula en el **plano de la vista**: el larguero y los postes se
desplazan perpendicularmente al segmento *en pantalla*, no en 3D, así que la
"portería" no rota con la escena cuando giras la pieza. El larguero se dibuja
más fino (1,6 px) que los postes (3,0 px).

### Giro de la escena

Por defecto la escena gira **libre**: la cámara se mueve con un trackball virtual
(`ArcballControls`), sin topes, así que se puede pasar por encima y por debajo de la
pieza y seguir dando la vuelta. El modo anterior (`OrbitControls`), que se quedaba
clavado al llegar a superior/inferior, sigue disponible con **`?giro=orbit`**; el
libre se puede forzar con **`?giro=libre`**. En `demo-giro.html` hay un interruptor
en pantalla para comparar ambos modos con la escena real.
> **Demo desplegada (GitHub Pages, rama gh-pages):** https://rms1982.github.io/dental-viewer/
> **Demo cargada con la pieza de ejemplo (visita recomendada):** https://rms1982.github.io/dental-viewer/?model=samples/B1-draco.glb
> **Modelo decimado para pruebas móviles:** https://rms1982.github.io/dental-viewer/?model=samples/Test1.glb (~5 MB, ~415 k triángulos)
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
- **Smoke test** (`scripts/smoke.mjs`): prueba end-to-end headless. Requiere `npm run preview` corriendo en el 4173 y Chromium instalado (`CHROME_PATH` para una ruta no estándar). Carga la muestra STL y el GLB decimado `Test1.glb` en un Chromium headless (SwiftShader, sin GPU) y valida carga, unidades, corte con stencil, mediciones, round-trip de anotaciones, estabilidad de la escena y que el modelo decimado tiene menos de 500 k triángulos. En entornos donde el headless no compone pixeles al canvas, los checks visuales del capping se omiten con aviso. Ultimo resultado: **81/81**.

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

Un plano único anclado al modelo, colocado con un gizmo PivotControls que trae a
la vez las flechas y los planos para mover, y los arcos de un cuarto de círculo
de X, Y y Z para rotar. No incluye escala. Un solo botón **Gizmo** lo enciende y
apaga; no hay botones Mover/Rotar separados. El disco del plano queda oculto y
solo se conserva su anillo de borde. Botones **Alinear con la vista**,
**Girar 90 grados** (eje propio horizontal) y **Rotar 90 grados** (eje propio
vertical): los giros son relativos al gizmo, no a la vista, asi que funcionan
igual los coloque Alinear, las tijeras o el propio gizmo.
La superficie del corte se tapa en solido (stencil) y su perimetro se dibuja con la
curva exacta de interseccion plano↔malla por pieza (calculada en CPU al activar el
corte y al soltar el gizmo; durante el arrastre solo se mueve el capping para no
tironear). La técnica usa:

- `localClippingEnabled` + `clippingPlanes` por material
- **stencil capping**: caras traseras/frente escriben stencil con operaciones opuestas y un quad coplanar tapa el hueco con `stencilFunc NotEqual 0` — el corte se ve **sólido**, no hueco
- cada tapa respeta los otros planos activos (un cruce en L queda correcto)

El borde de corte se pinta un 70% mas oscuro que el color original de cada pieza
para que resalte sobre el modelo. La curva se dibuja **con test de profundidad**
(`depthTest`), asi que cualquier geometria solida por delante la tapa: las piezas
se leen macizas y el contorno solo aparece donde el corte esta a la vista. La tapa
va 0.015 mm por detras del plano, de modo que el contorno nunca desaparece contra
su propia cara de corte. Color de tapa configurable (por defecto
`#c0554a`, terracota). Desactivar el corte conserva las posiciones de los planos.

## Mediciones

Dos clics sobre la superficie (raycast contra las mallas visibles; los puntos ocultos tras un corte se descartan). Con el **corte seccional activo se puede cotar también sobre la cara cortada**: esa cara es el capping por stencil y no tiene malla, así que `SectionPlaneTool.pickCap()` resuelve el rayo contra el plano y acepta el punto solo si cae sobre la sección sólida. El criterio es el mismo que usa el capping en GPU (la primera cara que ve el rayo en el lado conservado debe ser trasera), y como la cara está más cerca que la pared del fondo, el punto del corte gana. Cada cota es geometría 3D en mm con 1 decimal: línea de cota `Line2` (grosor constante en pantalla), líneas de extensión, puntos y globo con la cifra (`20.0 mm`).

- Paleta coherente con los marcadores: puntos y trazos en gris muy oscuro, globo con borde azul y fondo blanco.
- Grosores: larguero 1 px, postes 1,6 px, puntos 0,55 mm de diámetro.
- La cota se desplaza al lado más legible respecto a la cámara; si otra cota cercana ya ocupa ese lado, se dibuja al contrario para no solaparse.
- **Doble clic en la cifra** edita la nota; `Supr` borra la medición seleccionada.
- Los globos de medidas y marcadores siempre se ven, aunque el punto quede tras el modelo o tras un corte activo; solo se ocultan si quedan fuera de cámara.

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

### Marcadores

Un marcador por pulsación del botón **Marcador** (igual que las medidas): tras colocarlo se sale sola del modo marcador. El diálogo pide el texto (obligatorio) y la clase con tres botones seleccionables: **Nota**, **Aviso** y **Tornillo** (`note`, `warning`, `screw`). El cuadro de texto recibe el foco al abrir, así se escribe directo; la clase elegida se contornea en azul. Cada marcador guarda un punto en la pieza, el texto y el tipo elegido.

Visualmente comparten escala y estilo con las medidas: punto pequeño, tallo de 1,6 px y globo con fondo blanco. El contorno del globo indica el tipo:

- `note`: verde (`#22c55e`)
- `screw`: morado (`#a855f7`)
- `warning`: rojo (`#ef4444`)

En cámara libre se pueden arrastrar para recolocarlos sobre la superficie.

Cada marcador es un **elemento guardado de la presentación**: guarda el snapshot del momento (posición y objetivo de cámara, **zoom**, plano de corte, mediciones y visibilidad de objetos) y lo restaura al pulsarlo. El zoom se guarda como `camera.zoom`, que es donde lo deja `ArcballControls` en cámara ortográfica (allá la distancia no magnifica nada), y se restaura *antes* de colocar la cámara para que el control no imponga su valor cacheado. En el JSON es opcional: los marcadores guardados antes de este cambio se siguen restaurando, conservando el zoom que haya en ese momento.

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

**Columna izquierda**:

- **Vistas** (280 px): rejilla con Superior, Izquierda, Frontal, Derecha, Inferior e **Isométrica**.
- **Herramientas** (248 px): Medir, Borrar última, Marcador, Exportar.
- **Corte seccional** (248 px, plegable): Activar corte, Alinear con la vista, Girar 90 grados, Rotar 90 grados, y el interruptor **Gizmo** (flechas, planos y arcos a la vez, sin escala; apagado = gizmo oculto, el corte sigue visible).

**Columna derecha**:

- **Objetos** (248 px, plegable): lista de piezas con ojo visible/oculto y tijera para centrar el corte.
- **Presentación** (248 px, plegable): marcadores de la presentación con vista libre.

| Atajo | Acción |
|---|---|
| `F` | reencuadra la cámara |
| `M` | activa/desactiva modo medición (sale con `Esc`) |
| `K` | activa/desactiva modo marcador |
| `E` | exporta `annotations.json` |
| `Supr` | borra la medición seleccionada |

**Cubo de vistas** (abajo-izquierda) y **logo** (abajo-derecha). La barra de estado muestra unidades detectadas/forzadas, triángulos y dimensiones en mm.

En pantallas ≤ 640 px los paneles bajan a la parte inferior. Todo el texto está en español.

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
3. Gizmo atenuado sin el ratón encima (45 %; vuelve solo al pasar o arrastrar;
   respeta el `_opacity` interno de TransformControls). Antes era 15 %, casi
   invisible, porque no había forma de apagarlo del todo del gizmo.
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

**Sesión del 02/10/2026 (smoke 77/77, unitarios 24/24):**

1. **Globos de medidas en HTML**: mismo comportamiento que los marcadores (tamaño fijo en px, no escalan con el zoom), texto centrado verticalmente y ligeramente más grande (15 px) sin crecer el globo.
2. **Logo y cubo reajustados**: logo a 220 px con márgenes de 36 px; cubo a 36 px de margen.
3. **Paneles reorganizados**: Corte seccional pasa a la columna izquierda; Objetos y Presentación quedan a la derecha. Todos los paneles comparten estética con Herramientas (fondo, borde, sombra, título en mayúsculas, botones con fondo blanco).
4. **Barra de Vistas más ancha** (300 px) para no cortar los botones; el botón *Encuadrar* se sustituye por **Isométrica** en la UI (el reencuadre sigue disponible por `F` y bridge).
5. **Demo de GitHub Pages** apunta a `samples/B1-draco.glb` (misma pieza B1 comprimida con Draco, ~4 MB) y se despliega actualizada; `Final1.glb` y `Mario Rodriguez1.fbx` no se publican en Pages.

**Sesión del 02/10/2026 (tarde; smoke 81/81):**

1. **UI móvil para doctores**: toolbar inferior con **Inicio**, **Objetos** y **Presentación**; `Inicio` limpia la vista (mediciones, marcadores, corte, marcador activo) y reencuadra. Los tres botones superiores y el título son flotantes (sin panel) en gris oscuro. En la lista de objetos cada fila es un único botón grande (ojo + nombre) con una leyenda que explica el gesto.
2. **Presentación por marcadores**: cada marcador guarda y restaura su vista, corte, mediciones, visibilidad de objetos y visibilidad de su propio marcador; al salir del marcador se oculta todo.
3. **Gizmo de corte oculto en móvil**: se fuerza a invisible e inutilizable en pantallas táctiles.
4. **Modales móviles más legibles**: tipografía, botones y aspa de cierre agrandados.
5. **Modelo decimado `Test1.glb`**: copiado a `public/samples/Test1.glb` (~5 MB, ~415 k triángulos, menos del 40 % de B1); `Iniciar-Visor.bat` ahora abre `Test1.glb`; el smoke lo carga y verifica que no supere 500 k triángulos.
6. **Herramientas de medida**: nuevo botón **Borrar última** (borra la seleccionada o la última creada).
7. **Palitos de medidas y marcadores**: anchos de línea duplicados (3,2 px para extensiones y tallos; 2,0 px para el larguero).
8. **Gizmo**: `three-pivot-controls` con mover y rotar a la vez, sin escala. Incluye las tres flechas, los tres tiradores de plano y los tres arcos de un cuarto de círculo de X, Y y Z en espacio local. Un **único** botón **Gizmo** lo enciende y apaga; apagado, el corte sigue visible pero el gizmo no se dibuja (escena limpia). La librería ya reparte el ratón entre sus asas, así que no hacen falta dos controles ni zonas manuales de preferencia.
9. **Botón Vista trasera** en el panel Vistas.
10. **Ajustes exactos del gizmo**: tamaño 1.3, `fixed: false`, grosor 1.2, alcance 1, arcos de 1/4 y colores `ff8093`, `80ff80` y `2ecffe`. Como el visor es ortográfico y trabaja en milímetros, se conserva `fixed: false` y se aplica una calibración de viewport para que el tamaño 1.3 se lea como en la demo; el zoom posterior sigue cambiando el tamaño aparente.
11. **Pruebas del gizmo**: el smoke comprueba el inventario real de asas (`translate` + `rotate`, ningún modo `scale`), los ejes activos, los arcos de un cuarto, los colores, el grosor/alcance pedidos y el tamaño calibrado en pantalla.
12. **Curva de corte con profundidad**: el perímetro del corte pasa a `depthTest: true`, así que la geometría sólida por delante lo tapa y las piezas se leen macizas en vez de transparentar las líneas del corte.
13. **Cotas sobre la cara cortada**: `pickCap()` permite medir directamente en la superficie del corte (el capping por stencil no es malla, así que el rayo se resuelve contra el plano y se valida el punto). `pick()` elige el punto más cercano, de modo que la cara cortada prevalece sobre la pared del fondo. `isPointVisible()` admite una tolerancia mínima para que las etiquetas de esas cotas no se oculten por estar en el plano.
14. **Fuera el botón "Borrar marcadores"** del panel Herramientas (redundante: se borran con `Supr` sobre el marcador).
15. **Los marcadores guardan el zoom**: `marker.view.zoom` (`camera.zoom`) se guarda al crear el marcador y se restaura al pulsarlo, antes de colocar la cámara. Opcional en el JSON, compatible con los marcadores ya guardados.
16. **Disco del plano oculto**: al activar el corte no aparece la superficie gris del plano; solo se conserva su anillo de borde junto con el capping, las curvas y el gizmo.
17. **Clase de marcador con botones**: el diálogo de nuevo marcador sustituye los prompts por cuadro de texto con foco directo y tres botones seleccionables (**Nota**, **Aviso** y **Tornillo**), con **Nota** por defecto y confirmación/cancelación explícitas. El texto es obligatorio: en vacío no crea el marcador y avisa en el propio diálogo.
18. **Globos siempre visibles y selección azul**: los globos de medidas y marcadores ya no se ocultan tras el modelo ni tras el corte; el botón de clase elegido lleva contorno azul.
19. **Cotas cercanas en lados opuestos**: al dibujar una cota, si su línea quedaría a menos de 64 px de otra ya dibujada, se coloca al lado contrario; la primera manda y el criterio se reevalúa al mover la cámara.
20. **Giros de 90° relativos al gizmo**: **Girar** y **Rotar** rotan sobre los ejes propios del plano (X e Y locales), no sobre los de la vista; valen igual tras Alinear, las tijeras o el gizmo, y nunca son un no-op.

**Pendiente:**

1. Decodificadores Draco/Basis duplicados entre el bundle de Vite y `public/` — optimizacion, no bloqueante.
2. Sin backend ni despliegue productivo: la demo es estatica (Pages).

Nota sobre el smoke: en un Chromium headless con SwiftShader los triángulos se emiten (sin errores GL) pero los pixeles no llegan al canvas compuesto; por eso los checks visuales del capping se basan en conteo de pixeles y se omiten si el entorno no rasteriza.

## Próximos pasos

Ver [docs/PLAN.md](docs/PLAN.md) — incluye el plan original del proyecto, las decisiones de diseño y la hoja de ruta con próximos hitos.
