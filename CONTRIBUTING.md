<!-- SPDX-License-Identifier: GPL-3.0-or-later -->
# Cómo trabajamos en este repo

Prácticas comunes de los repos de `flexortholab`, las mismas que en `model-viewer-backend`. La especificación del visor, las decisiones tomadas y el registro de operaciones manuales viven en el repo privado [flexortholab/docs](https://github.com/flexortholab/docs).

## Compatibilidad del visor

- Los cambios para integrarse con el backend **añaden, no sustituyen**. El visor tiene que seguir funcionando como hasta ahora, incluido `?model=samples/…` con los modelos del bundle, hasta que se decida retirar algo en una PR aparte.
- Las pruebas en navegador del CI (`test/e2e/`, Playwright) son la red de seguridad: tienen que seguir en verde en todos los navegadores y perfiles sin tocarlas para que un cambio pase.

## Commits y pull requests

- Commits y títulos de PR con [Conventional Commits](https://www.conventionalcommits.org/es/): `tipo(ámbito opcional): descripción`, en español. Tipos: `feat`, `fix`, `docs`, `refactor`, `test`, `chore`, `ci`, `build`, `perf`, `style`, `revert`. El CI rechaza una PR cuyo título no lo cumpla.
- Un cambio que rompe algo que ya se usaba (por ejemplo, el protocolo `postMessage` con las páginas que incrustan el visor) se marca con `!` (`feat!: …`) y una línea `BREAKING CHANGE: …`, según [SemVer](https://semver.org/lang/es/).
- Una PR por cambio, siempre contra `main`. **Nunca PRs apiladas** (una PR contra la rama de otra): el CI solo corre en las PR contra `main` y GitHub no las rebasea al mergear la de abajo.
- Las PR las revisa y mergea una persona (Sergio o Roberto), nunca un agente.
- La descripción de la PR sigue **Problema → Solución → Contexto y trade-offs**. Cada referencia a código lleva un enlace permanente a un commit (`…/blob/<sha>/<ruta>#L10-20`), no a una rama.

## Tickets

- Se escriben en español.
- Cada ticket de negocio describe valor para Roberto o para el doctor (por ejemplo, "Roberto crea un caso subiendo un GLB"). El trabajo técnico va en sub-issues.
- Los tickets de negocio viven en el repo privado [flexortholab/docs](https://github.com/flexortholab/docs/issues), y sus sub-issues del frontend, en este repo.
- GitHub no deja trasladar issues de un repo privado a uno público: un ticket de `docs` o del backend que pase aquí se recrea.
- Seguimiento: [Project "Visor de modelos 3D"](https://github.com/orgs/flexortholab/projects/1).

## Operaciones manuales

- Se minimizan todo lo posible: si un paso se puede automatizar en un tiempo razonable, se automatiza.
- Lo que siga siendo manual (ajustes del repo o de GitHub Pages, por ejemplo) se anota en [docs/model-viewer/operaciones-manuales.md](https://github.com/flexortholab/docs/blob/main/model-viewer/operaciones-manuales.md): quién, cuándo, qué y cómo comprobarlo.

## Datos de salud y privacidad

- **Nunca** se sube al repo un modelo o un dato de un paciente: el repo es público. Los casos reales van al bucket privado de S3 a través de la API.
- El nombre del caso puede llevar datos del paciente: nunca va en la URL, en `<title>` ni en las etiquetas Open Graph (lo ve la vista previa de WhatsApp).
- Las contraseñas no se guardan en el navegador, y ni las contraseñas ni los tokens se escriben en la consola.

## Código

- ES modules, sin punto y coma, comillas simples, 2 espacios y la cabecera `// SPDX-License-Identifier: GPL-3.0-or-later` en cada fichero.
- Clases solo para las piezas con estado del visor (`DentalViewer`, herramientas de corte y medida); el resto, funciones exportadas.
- Los textos de la interfaz, en español con tildes. Los comentarios, en español, explicando el porqué.
- La lógica sin DOM (unidades, anotaciones, cliente de la API) va en módulos propios para poder probarla con `node --test` (`npm test`). Lo que depende del navegador lo cubren las pruebas de Playwright (`test/e2e/*.spec.js`).

## Comprobar un cambio antes de abrir la PR

```sh
npm test
npx playwright install        # la primera vez: descarga Chromium, Firefox y WebKit
npm run test:e2e              # build, vite preview en el 4173 y todas las pruebas
```

- Un solo navegador o perfil: `npm run test:e2e -- --project=escritorio-chromium` (los nombres están en `playwright.config.js`: `escritorio-*`, `portatil-tactil-*`, `tablet-webkit`, `movil-webkit` y `movil-chromium`). `E2E_NAVEGADOR=webkit npm run test:e2e` deja todos los perfiles de un navegador, como hace el CI.
- Para ver la prueba en pantalla: `--headed`. Para depurar paso a paso: `--debug` o `--ui`.
- Los proyectos `*-msedge` usan el Edge instalado en el equipo; si no lo tienes, sáltalos con `--project`.
- Si ya hay un `vite preview` en el 4173, se reutiliza: recuerda hacer `npm run build` tras cambiar el código.
- Tras un fallo, `npx playwright show-report` abre el informe con la traza de cada prueba.

En cada push a una PR, el CI solo corre los tests unitarios y el build. Las pruebas en navegador corren al integrar: la PR se mergea con *Merge when ready*, entra en la cola de merge y se prueba sobre `main` con el cambio encima; si pasan, se mergea sola, y si fallan, sale de la cola sin tocar `main`. Vuelven a correr en el push a `main`, antes de publicar. Lanzan un job por navegador, sin reintentos y repitiendo cada prueba dos veces (`--repeat-each=2`), así que una prueba inestable lo deja en rojo.

Una prueba que falla por un defecto conocido de la app se marca con `test.fail` y un comentario con el issue. Cuando se arregla, la prueba empieza a pasar y `test.fail` la pone en rojo: hay que quitar la marca en la misma PR del arreglo.
