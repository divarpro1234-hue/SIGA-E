// Neutralización de texto ajeno (D03). Regla: docs/diseno/texto-ajeno-spec.md.
// Sin dependencias. No detecta homoglifos; la protección frente a eso es estructural (panel separado).

/**
 * @typedef {{ tipo: 'texto', valor: string }} SegmentoTexto
 * @typedef {{ tipo: 'control', codigo: string, nombre: string }} SegmentoControl
 * @typedef {SegmentoTexto | SegmentoControl} Segmento
 * @typedef {{ segmentos: Segmento[], recortado: boolean, controles: number }} ResultadoTextoAjeno
 */

/** Longitud máxima por defecto, en grafemas (titular de OpenAPI: 200). */
export const MAX_GRAFEMAS_POR_DEFECTO = 200;

/** Unidades UTF-16 procesadas como máximo por grafema permitido (cota de coste). */
const UNIDADES_POR_GRAFEMA = 16;

const BIDI = new Map([
  [0x061c, 'Marca de letra árabe'],
  [0x200e, 'Marca de izquierda a derecha'],
  [0x200f, 'Marca de derecha a izquierda'],
  [0x202a, 'Incrustación de izquierda a derecha'],
  [0x202b, 'Incrustación de derecha a izquierda'],
  [0x202c, 'Fin de formato direccional'],
  [0x202d, 'Anulación de izquierda a derecha'],
  [0x202e, 'Anulación de derecha a izquierda'],
  [0x2066, 'Aislante de izquierda a derecha'],
  [0x2067, 'Aislante de derecha a izquierda'],
  [0x2068, 'Aislante de primera letra fuerte'],
  [0x2069, 'Fin de aislante direccional'],
]);

const INVISIBLES = new Map([
  [0x200b, 'Espacio de ancho cero'],
  [0x2060, 'Unión de palabras'],
  [0xfeff, 'Marca de orden de bytes (espacio de ancho cero)'],
]);

const C0 = [
  'Nulo', 'Inicio de encabezado', 'Inicio de texto', 'Fin de texto', 'Fin de transmisión', 'Consulta',
  'Acuse positivo', 'Campana', 'Retroceso', 'Tabulación', 'Salto de línea', 'Tabulación vertical',
  'Avance de página', 'Retorno de carro', 'Salida de código', 'Entrada de código', 'Escape de enlace de datos',
  'Control de dispositivo 1', 'Control de dispositivo 2', 'Control de dispositivo 3', 'Control de dispositivo 4',
  'Acuse negativo', 'Sincronía', 'Fin de bloque', 'Cancelar', 'Fin de medio', 'Sustituir', 'Escape',
  'Separador de archivo', 'Separador de grupo', 'Separador de registro', 'Separador de unidad',
];

/** @param {number} cp */
function codigo(cp) {
  return `U+${cp.toString(16).toUpperCase().padStart(4, '0')}`;
}

/**
 * Nombre del punto de código si debe neutralizarse; null si se conserva.
 * @param {number} cp
 * @returns {string | null}
 */
export function nombreControl(cp) {
  if (cp === 0x0a || cp === 0x09) return null; // salto de línea y tabulación se conservan
  if (cp <= 0x1f) return C0[cp] ?? null;
  if (cp === 0x7f) return 'Suprimir';
  if (cp >= 0x80 && cp <= 0x9f) return `Control C1 ${codigo(cp)}`;
  const bidi = BIDI.get(cp);
  if (bidi) return bidi;
  const inv = INVISIBLES.get(cp);
  if (inv) return inv;
  if (cp >= 0xe0000 && cp <= 0xe007f) {
    const oculto = cp >= 0xe0020 && cp <= 0xe007e ? ` (oculta «${String.fromCharCode(cp - 0xe0000)}»)` : '';
    return `Carácter de etiqueta${oculto}`;
  }
  if (cp >= 0xd800 && cp <= 0xdfff) return 'Mitad de par sustituto sin pareja';
  return null;
}

/** @param {string} t */
function normalizarSaltos(t) {
  return t.replace(/\r\n?/g, '\n');
}

/**
 * Recorta a n unidades UTF-16 sin partir un par sustituto.
 * @param {string} t
 * @param {number} n
 * @returns {string}
 */
function recortarUnidades(t, n) {
  if (t.length <= n) return t;
  let fin = n;
  const antes = t.charCodeAt(fin - 1);
  const despues = t.charCodeAt(fin);
  if (antes >= 0xd800 && antes <= 0xdbff && despues >= 0xdc00 && despues <= 0xdfff) fin -= 1;
  return t.slice(0, fin);
}

const SEGMENTADOR =
  typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function'
    ? new Intl.Segmenter('es', { granularity: 'grapheme' })
    : null;

/** @param {string} t @returns {string[]} */
function grafemas(t) {
  if (SEGMENTADOR) {
    return Array.from(SEGMENTADOR.segment(t), (s) => s.segment);
  }
  return Array.from(t); // respaldo: por punto de código
}

/**
 * Convierte un texto ajeno en segmentos seguros.
 * Cada punto de código a neutralizar se vuelve un segmento de control y cuenta como una unidad de
 * longitud; el resto del texto se cuenta por grafemas. Los cortes caen siempre entre grafemas.
 * @param {unknown} entrada
 * @param {{ maxGrafemas?: number }} [opciones]
 * @returns {ResultadoTextoAjeno}
 */
export function segmentarTextoAjeno(entrada, opciones = {}) {
  const pedido = opciones.maxGrafemas;
  const max = typeof pedido === 'number' && Number.isInteger(pedido) && pedido >= 0
    ? pedido
    : MAX_GRAFEMAS_POR_DEFECTO;
  if (typeof entrada !== 'string' || entrada === '') {
    return { segmentos: [], recortado: false, controles: 0 };
  }

  const tope = max * UNIDADES_POR_GRAFEMA;
  let recortado = entrada.length > tope;
  const texto = normalizarSaltos(recortarUnidades(entrada, tope));

  /** @type {Segmento[]} */
  const segmentos = [];
  let controles = 0;
  let usadas = 0;
  let corrida = '';

  const cerrarCorrida = () => {
    if (corrida) segmentos.push({ tipo: 'texto', valor: corrida });
    corrida = '';
  };

  /** Procesa una corrida de texto sin puntos de código a neutralizar. */
  const volcar = (/** @type {string} */ trozo) => {
    for (const g of grafemas(trozo)) {
      if (usadas >= max) {
        recortado = true;
        return false;
      }
      corrida += g;
      usadas += 1;
    }
    return true;
  };

  let limpio = '';
  const puntos = Array.from(texto);
  for (let i = 0; i < puntos.length; i += 1) {
    const punto = /** @type {string} */ (puntos[i]);
    const cp = /** @type {number} */ (punto.codePointAt(0));
    const nombre = nombreControl(cp);
    if (nombre === null) {
      limpio += punto;
      continue;
    }
    if (limpio) {
      if (!volcar(limpio)) {
        cerrarCorrida();
        return { segmentos, recortado: true, controles };
      }
      limpio = '';
    }
    if (usadas >= max) {
      cerrarCorrida();
      return { segmentos, recortado: true, controles };
    }
    cerrarCorrida();
    segmentos.push({ tipo: 'control', codigo: codigo(cp), nombre });
    controles += 1;
    usadas += 1;
  }
  if (limpio) volcar(limpio);
  cerrarCorrida();
  return { segmentos, recortado, controles };
}

/**
 * Construye nodos del DOM sin interpretar nunca el texto como marcado: createElement,
 * textContent y createTextNode. No usa innerHTML.
 * @param {ResultadoTextoAjeno} resultado
 * @param {Document} [doc]
 * @returns {DocumentFragment}
 */
export function aNodos(resultado, doc = globalThis.document) {
  const frag = doc.createDocumentFragment();
  for (const s of resultado.segmentos) {
    if (s.tipo === 'texto') {
      frag.append(doc.createTextNode(s.valor));
    } else {
      const marca = doc.createElement('span');
      marca.className = 'ctl-marca';
      marca.textContent = s.codigo;
      marca.setAttribute('role', 'img');
      marca.setAttribute('aria-label', `carácter de control ${s.codigo}: ${s.nombre}`);
      frag.append(marca);
    }
  }
  if (resultado.recortado) {
    const r = doc.createElement('span');
    r.className = 'ctl-recorte';
    r.textContent = '… recortado';
    frag.append(r);
  }
  return frag;
}
