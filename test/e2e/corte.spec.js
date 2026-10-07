// SPDX-License-Identifier: GPL-3.0-or-later
// Corte seccional con capping: la curva del corte, el stencil, las tijeras,
// cotar sobre la cara cortada, mover y rotar el plano y el round-trip de las
// anotaciones. Cada prueba parte de un visor recien cargado.
import { test, check, abrirVisor } from './visor.js'

test.beforeEach(async ({ page }) => {
  check('el visor se instancia y carga el modelo', await abrirVisor(page))
})

test('corte seccional y capping', async ({ page }) => {
  const section = await page.evaluate(() => {
    const v = window.dentalViewer
    v.setSection({ enabled: true, plane: { point: [0, 0, 0], normal: [0, 0, 1] } })
    v.renderer.render(v.scene, v.camera)
    const caps = v.section.capGroup.children.filter((c) => String(c.name).startsWith('cap-')).length
    const stencils = v.section.stencilGroup.children.length
    const planes = v.model.meshes[0].material.clippingPlanes?.length ?? 0
    const capWrite = v.section.capGroup.children.filter((c) => String(c.name).startsWith('cap-'))[0]?.material.stencilWrite
    const stencilWrite = v.section.stencilGroup.children[0]?.material.stencilWrite
    return { enabled: v.section.enabled, caps, stencils, planes, capWrite, stencilWrite }
  })
  check('el corte seccional se activa', section.enabled === true)
  check('genera una superficie de corte', section.caps === 1, `${section.caps} cap`)
  // La curva del corte: plano transversal al eje largo de la barra (50 mm en
  // X) para cruzar muchos triangulos; todos los puntos dentro de la pieza.
  const cut = await page.evaluate(() => {
    const v = window.dentalViewer
    v.setSection({ enabled: true, plane: { point: [0, 0, 0], normal: [1, 0, 0] } })
    v.renderer.render(v.scene, v.camera)
    const lines = v.section.cutGroup.children
    let segments = 0
    let maxAbs = 0
    for (const l of lines) {
      segments += l.userData?.segments ?? 0
      maxAbs = Math.max(maxAbs, l.userData?.maxAbs ?? 0)
    }
    return { cuts: lines.length, segments, maxAbs }
  })
  check('dibuja la curva del corte por pieza (interseccion exacta)', cut.cuts === 1 && cut.segments > 10, `${cut.cuts} curva, ${cut.segments} segmentos`)
  check('la curva vive sobre la pieza (sin lineas fugadas)', cut.maxAbs < 60, `max |xyz| = ${cut.maxAbs.toFixed(1)} mm`)
  const cutColor = await page.evaluate(() => {
    const v = window.dentalViewer
    const mesh = v.model.meshes[0]
    const base = v.section._pieceColor(mesh) ?? new THREE.Color(0x9a968f)
    const mat = [...v.section._cutMaterials][0]
    return { baseR: base.r, cutR: mat?.color.r ?? 0 }
  })
  check('el borde de corte es mas oscuro que la pieza',
    cutColor.cutR > 0 && cutColor.cutR < cutColor.baseR * 0.45,
    `base ${cutColor.baseR.toFixed(2)} vs corte ${cutColor.cutR.toFixed(2)}`)
  // La curva del corte debe respetar el z-buffer: si no, se dibuja a traves de
  // la pieza y las piezas dejan de leerse solidas.
  const cutDepth = await page.evaluate(() => {
    const mats = [...window.dentalViewer.section._cutMaterials]
    return {
      total: mats.length,
      conDepth: mats.filter((m) => m.depthTest === true).length,
    }
  })
  check('la curva del corte respeta la profundidad (la pieza se ve solida)',
    cutDepth.total > 0 && cutDepth.conDepth === cutDepth.total,
    `${cutDepth.conDepth}/${cutDepth.total} con depthTest`)
  check('genera el grupo de stencil (caras traseras y delanteras)', section.stencils >= 2, `${section.stencils} mallas`)
  check('los materiales recortan con el plano', section.planes === 1)
  check('stencil activo en el capping y en los strokes', section.capWrite === true && section.stencilWrite === true)
  const visualPlano = await page.evaluate(() => {
    const s = window.dentalViewer.section
    return { disco: s.planeMesh.visible, anillo: s.ringMesh.visible }
  })
  check('el disco del plano queda oculto y conserva el anillo de borde',
    visualPlano.disco === false && visualPlano.anillo === true,
    `disco=${visualPlano.disco} anillo=${visualPlano.anillo}`)
})

// Rotar 90 grados: gira el plano sobre su propio eje vertical (Y local), en
// su sitio y sin mover su punto. Al ser ejes del gizmo y no de la vista, el
// resultado no depende de como se coloco el plano (Alinear, tijeras o gizmo)
// y nunca es un no-op: el eje siempre es perpendicular a la normal.
test('Rotar 90 grados', async ({ page }) => {
  const giroVertical = await page.evaluate(() => {
    const v = window.dentalViewer
    v.camera.position.set(0, 0, 80)
    v.controls.target.set(0, 0, 0)
    v.controls.update()
    v.setSection({ enabled: true, plane: { point: [1, 2, 3], normal: [0, 0, 1] } })
    const antes = v.section.serialize()
    document.querySelector('[data-action="section-rotate"]').click()
    const despues = v.section.serialize()
    const normal = despues.normal
    // Con el gizmo en identidad, el giro local +90 sobre Y lleva (0,0,1) a (1,0,0).
    const ok = Math.abs(Math.abs(normal[0]) - 1) < 1e-2 && Math.abs(normal[1]) < 1e-2 && Math.abs(normal[2]) < 1e-2
    // Regresion del no-op: con la normal en vertical, Rotar tiene que moverla.
    v.setSection({ enabled: true, plane: { point: [1, 2, 3], normal: [0, 1, 0] } })
    const verticalAntes = v.section.serialize().normal
    document.querySelector('[data-action="section-rotate"]').click()
    const verticalDespues = v.section.serialize().normal
    const dot = verticalAntes[0] * verticalDespues[0] +
      verticalAntes[1] * verticalDespues[1] + verticalAntes[2] * verticalDespues[2]
    return {
      puntoIgual: JSON.stringify(despues.point) === JSON.stringify(antes.point),
      normal: normal.map((n) => +n.toFixed(3)),
      ok,
      mueveVertical: Math.abs(dot) < 0.99,
    }
  })
  check('Rotar 90 grados gira el plano sobre su propio eje sin moverlo',
    giroVertical.puntoIgual === true && giroVertical.ok === true,
    `normal=${giroVertical.normal.join(',')}`)
  check('Rotar 90 grados tambien mueve una normal vertical (sin no-ops)',
    giroVertical.mueveVertical === true)
})

// Encuadre al pulsar las tijeras: activa el corte SIN acercarse, la escena
// entera debe seguir entrando en el encuadre y el angulo actual se conserva.
test('las tijeras activan el corte sin hacer zoom', async ({ page }) => {
  const encuadre = await page.evaluate(() => {
    const v = window.dentalViewer
    const V3 = v.camera.position.constructor
    v.setSection({ enabled: false })
    v.frameModel()
    // Girar 90 grados a una vista lateral: el usuario puede estar mirando la
    // pieza desde cualquier angulo cuando pulsa las tijeras.
    v.setView('lateral')
    const anguloAntes = v.camera.position.clone().sub(v.controls.target).normalize()
    const distanciaAntes = v.camera.position.distanceTo(v.controls.target)

    v.focusObject(0, { withPlane: true })
    v.camera.updateMatrixWorld(true)

    // Solo X e Y: en perspectiva el Z de NDC tiende a 1 y no dice nada
    // sobre si la escena cabe en el encuadre.
    let maxXY = 0
    for (let sx = -1; sx <= 1; sx += 2) {
      for (let sy = -1; sy <= 1; sy += 2) {
        for (let sz = -1; sz <= 1; sz += 2) {
          const p = new V3(
            sx > 0 ? v.model.bounds.max.x : v.model.bounds.min.x,
            sy > 0 ? v.model.bounds.max.y : v.model.bounds.min.y,
            sz > 0 ? v.model.bounds.max.z : v.model.bounds.min.z,
          ).project(v.camera)
          maxXY = Math.max(maxXY, Math.abs(p.x), Math.abs(p.y))
        }
      }
    }
    const anguloDespues = v.camera.position.clone().sub(v.controls.target).normalize()
    return {
      maxXY,
      corte: v.section.enabled,
      conservedAngulo: anguloAntes.dot(anguloDespues),
      distanciaAntes,
      distanciaDespues: v.camera.position.distanceTo(v.controls.target),
    }
  })
  check('las tijeras activan el corte', encuadre.corte === true)
  check('las tijeras no hacen zoom a la pieza (se ve la escena entera)',
    encuadre.maxXY <= 1, `NDC max ${encuadre.maxXY.toFixed(3)}`)
  check('las tijeras reencuadran la escena completa',
    encuadre.distanciaDespues >= encuadre.distanciaAntes,
    `${encuadre.distanciaAntes.toFixed(1)} -> ${encuadre.distanciaDespues.toFixed(1)} unidades`)
  check('las tijeras conservan el angulo actual (giro de 90 grados)',
    encuadre.conservedAngulo > 0.999,
    `dot ${encuadre.conservedAngulo.toFixed(4)}`)
})

// Cotas sobre la cara cortada: esa cara es el capping por stencil, no hay malla
// que raycastear, asi que pick() cae al plano y acepta el punto solo si esta
// sobre material. Desde la vista trasera el primer impacto es la cara recortada.
// Se muestrea la cara porque el centro de la pieza puede ser hueco.
test('cotar sobre la cara cortada', async ({ page }) => {
  const capPick = await page.evaluate(() => {
    const v = window.dentalViewer
    v.setSection({ enabled: true, plane: { point: [0, 0, 0], normal: [0, 0, 1] } })
    v.frameModel()
    v.setView('trasera')
    v.renderer.render(v.scene, v.camera)

    const bounds = v.model.bounds
    const tam = bounds.getSize(new (bounds.min.constructor)())

    // Primer punto de la cara cortada que responde a un clic real.
    let cap = null
    let ndc = null
    for (let iy = 0; iy < 9 && !cap; iy++) {
      for (let ix = 0; ix < 9 && !cap; ix++) {
        const x = -0.6 + (1.2 * ix) / 8
        const y = -0.6 + (1.2 * iy) / 8
        v.pointer.set(x, y)
        const hit = v.pick()
        if (hit?.isCap) { cap = hit; ndc = [x, y] }
      }
    }

    // El mismo rayo de ese clic, desplazado hasta un punto fuera de la pieza:
    // no hay cara que cortar ahi, asi que se rechaza.
    let fuera = null
    if (cap) {
      const ray = v.raycaster.ray.clone()
      ray.origin.set(tam.x * 10, tam.y * 10, 100)
      fuera = v.section.pickCap(ray)
    }

    return {
      encontrado: !!cap,
      ndc,
      enElPlano: cap ? Math.abs(cap.point.z) < 1e-3 : false,
      dentro: cap
        ? cap.point.x >= bounds.min.x - 0.05 && cap.point.x <= bounds.max.x + 0.05 &&
          cap.point.y >= bounds.min.y - 0.05 && cap.point.y <= bounds.max.y + 0.05
        : false,
      masCercaQueElFondo: cap
        ? (() => {
            // En la cara cortada el cap debe ganar a la pared del fondo.
            v.pointer.set(ndc[0], ndc[1])
            const h = v.pick()
            return h?.isCap === true
          })()
        : false,
      fueraRechazado: fuera === null,
    }
  })
  check('se puede cotar sobre la cara cortada (no hay malla: usa el plano)',
    capPick.encontrado === true && capPick.enElPlano === true,
    capPick.encontrado ? `clic en ndc ${capPick.ndc}` : 'ningun punto en la cara')
  check('el punto de la cara cortada cae dentro de la pieza', capPick.dentro === true)
  check('la cara cortada gana a la pared del fondo', capPick.masCercaQueElFondo === true)
  check('un punto del plano fuera de la pieza se rechaza', capPick.fueraRechazado === true)
})

test('manipulacion del plano: mover y rotar la normal', async ({ page }) => {
  const planeManipulation = await page.evaluate(() => {
    const v = window.dentalViewer
    // Plano por el centro con normal +Z: se conserva z >= 0.
    v.setSection({ enabled: true, plane: { point: [0, 0, 0], normal: [0, 0, 1] } })
    const originOut = v.section.isPointVisible({ x: 0, y: 0, z: 5 })
    const behindHidden = v.section.isPointVisible({ x: 0, y: 0, z: -5 })

    // Mover el plano a y=10 lo interpreta el helper de ejes (compatibilidad):
    // normal +y, punto (0,10,0): se conserva y >= 10.
    v.setSectionAxis('y', 10)
    v.renderer.render(v.scene, v.camera)
    const lifted = {
      visibleAbove: v.section.isPointVisible({ x: 0, y: 15, z: 0 }),
      hiddenBelow: v.section.isPointVisible({ x: 0, y: 5, z: 0 }),
    }

    // Rotar la normal del plano (gizmo en modo rotar): gira al eje x.
    v.section.setPlane({ normal: [1, 0, 0] })
    v.renderer.render(v.scene, v.camera)
    const rotated = {
      rightVisible: v.section.isPointVisible({ x: 5, y: 0, z: 0 }),
      leftHidden: v.section.isPointVisible({ x: -5, y: 0, z: 0 }),
    }
    return { originOut, behindHidden, lifted, rotated }
  })
  check('el centro de la pieza queda del lado conservado', planeManipulation.originOut === true)
  check('un punto detras del plano se descarta', planeManipulation.behindHidden === false)
  check('al subir el plano la mitad superior permanece', planeManipulation.lifted.visibleAbove === true)
  check('al subir el plano la mitad inferior desaparece', planeManipulation.lifted.hiddenBelow === false)
  check('rotar la normal al eje x conserva la mitad derecha', planeManipulation.rotated.rightVisible === true)
  check('rotar la normal al eje x descarta la izquierda', planeManipulation.rotated.leftHidden === false)
})

test('round-trip de anotaciones', async ({ page }) => {
  const roundTrip = await page.evaluate(() => {
    const v = window.dentalViewer
    const box = v.model.bounds
    const a = box.min.clone()
    const b = box.max.clone()
    v.measure.add(a, b, 'ancho total')
    v.setSection({ enabled: true, plane: { point: [0, 0, 1.5], normal: [0, 0, 1] } })
    const json = JSON.stringify(v.getAnnotations())
    v.measure.clear()
    v.setSection({ enabled: false })
    const cleared = v.measure.measurements.length
    const doc = v.applyAnnotations(JSON.parse(json))
    return {
      cleared,
      restoredMeasurements: v.measure.measurements.length,
      restoredSection: v.section.enabled,
      keepsPositiveSide: v.section.isPointVisible({ x: 0, y: 0, z: 3 }),
      slicesPastPlane: v.section.isPointVisible({ x: 0, y: 0, z: 0 }),
      note: doc.measurements[0]?.note,
      units: doc.units,
    }
  })
  check('las anotaciones se pueden borrar', roundTrip.cleared === 0)
  check('se restauran las mediciones desde JSON', roundTrip.restoredMeasurements === 1)
  check('se restaura el corte seccional', roundTrip.restoredSection === true)
  check('el plano restaurado conserva su mitad (z >= 1.5)',
    roundTrip.keepsPositiveSide === true && roundTrip.slicesPastPlane === false)
  check('se conserva la nota de la medicion', roundTrip.note === 'ancho total')
  check('las anotaciones se guardan en mm', roundTrip.units === 'mm')
})

// El capping produce pixeles: el corte debe verse distinto de la pieza.
//
// El smoke antiguo contaba pixeles "encendidos" (mas claros que un fondo
// oscuro) y buscaba el color 0xc0554a del capping. Con el fondo blanco
// actual todos los pixeles cuentan como encendidos y el capping ya no tiene
// ese color, asi que los dos estados daban el mismo numero y el smoke saltaba
// estas comprobaciones como "readback congelado" en todas las pasadas. Aqui se
// mide lo que se queria ver: la pieza pinta pixeles distintos del fondo, y al
// ocultar solo las tapas del corte cambian pixeles, es decir, el capping se
// dibuja de verdad.
test('el capping produce pixeles: el corte se ve distinto de la pieza', async ({ page }) => {
  const capping = await page.evaluate(() => {
    const v = window.dentalViewer
    const leer = () => {
      v.renderer.render(v.scene, v.camera)
      const src = v.renderer.domElement
      const c2 = document.createElement('canvas')
      c2.width = src.width
      c2.height = src.height
      const ctx = c2.getContext('2d')
      ctx.drawImage(src, 0, 0)
      return ctx.getImageData(0, 0, c2.width, c2.height).data
    }
    const pintados = (px) => {
      let n = 0
      for (let i = 0; i < px.length; i += 4) {
        if (px[i] < 235 || px[i + 1] < 235 || px[i + 2] < 235) n++
      }
      return n
    }
    const distintos = (a, b) => {
      let n = 0
      for (let i = 0; i < a.length; i += 4) {
        if (Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]) > 30) n++
      }
      return n
    }
    v.measure.clear()
    v.setSection({ enabled: false })
    v.setView('superior')
    const base = pintados(leer())
    // Se conserva y <= 0: desde arriba se ve de frente la cara cortada.
    v.setSection({ enabled: true, plane: { point: [0, 0, 0], normal: [0, -1, 0] } })
    const conTapas = leer()
    v.section.capGroup.visible = false
    const sinTapas = leer()
    v.section.capGroup.visible = true
    v.setSection({ enabled: false })
    return { base, tapas: distintos(conTapas, sinTapas) }
  })
  check('el render base produce pixeles (entorno)', capping.base > 0, `${capping.base} px`)
  check('el corte dibuja la superficie de capping', capping.tapas > 0, `${capping.tapas} px de tapa`)
})

test('screenshot(scale) exporta a mas resolucion de lo que se ve', async ({ page }) => {
  const shot = await page.evaluate(() => {
    const v = window.dentalViewer
    const s1 = v.screenshot(1).length
    const s2 = v.screenshot(3).length
    // Tras el shot escalado el canvas vuelve a su tamano normal. En movil y
    // tablet el visor fija el pixel ratio a 1 (src/viewer.js).
    const back = v.renderer.domElement.width
    const ratio = v._isMobile ? 1 : Math.min(window.devicePixelRatio, 2)
    return { s1, s2, back, normal: Math.round(v.container.clientWidth * ratio) }
  })
  check('screenshot(scale) exporta a mayor resolucion', shot.s2 > shot.s1,
    `${shot.s1} -> ${shot.s2} bytes`)
  check('el canvas vuelve al tamano original tras el shot', Math.abs(shot.back - shot.normal) <= 1,
    `${shot.back} vs ${shot.normal}`)
})
