// Lógica pura del precaché del service worker (D05). Solo se ejecuta en el build (Node), nunca en el
// navegador. Calcula la lista de recursos, su versión y la plantilla final de sw.js; no toca el disco.
import { createHash } from 'node:crypto';

/** Marcadores que sw.js (plantilla) deja para el build. */
export const MARCADOR_VERSION = '__VERSION__';
export const MARCADOR_PRECACHE = '__PRECACHE__';
export const MARCADOR_RUTAS = '__RUTAS__';

/** Caracteres admitidos en una ruta de precaché: no hay nada que escapar ni que interpretar. */
const RUTA_VALIDA = /^[A-Za-z0-9._\-/]+$/;

/**
 * @typedef {{ ruta: string, sha256: string }} Archivo  Ruta relativa a dist/ con «/», y SHA-256 en hexadecimal.
 * @typedef {{ url: string, integridad: string }} Entrada  URL absoluta del mismo origen e integridad SRI.
 */

/**
 * Una ruta es segura si es relativa, normalizada y sin «..», sin «.» ni barras repetidas.
 * @param {string} ruta
 * @returns {boolean}
 */
export function rutaSegura(ruta) {
  if (typeof ruta !== 'string' || ruta === '' || !RUTA_VALIDA.test(ruta)) return false;
  if (ruta.startsWith('/') || ruta.endsWith('/')) return false;
  return ruta.split('/').every((parte) => parte !== '' && parte !== '.' && parte !== '..' && !/^\.{2,}$/.test(parte));
}

/**
 * Archivos que nunca entran al precaché: el propio sw.js, los mapas de fuentes, los marcadores .gitkeep
 * y los textos de licencia (se sirven, pero el shell no los necesita sin conexión).
 * @param {string} ruta
 * @returns {boolean}
 */
export function excluir(ruta) {
  const nombre = ruta.split('/').pop() ?? '';
  return ruta === 'sw.js' || nombre.endsWith('.map') || nombre === '.gitkeep' || nombre.startsWith('LICENSE');
}

/**
 * @param {string} sha256Hex
 * @returns {string} Integridad SRI («sha256-<base64>»).
 */
export function integridadSri(sha256Hex) {
  return `sha256-${Buffer.from(sha256Hex, 'hex').toString('base64')}`;
}

/**
 * Lista ordenada y determinista de entradas. Lanza si una ruta no es segura o si se repite.
 * @param {Archivo[]} archivos
 * @returns {Entrada[]}
 */
export function construirPrecache(archivos) {
  const vistas = new Set();
  const entradas = [];
  for (const { ruta, sha256 } of archivos) {
    if (!rutaSegura(ruta)) throw new Error(`Ruta no admitida en el precaché: ${JSON.stringify(ruta)}`);
    if (excluir(ruta)) continue;
    if (!/^[0-9a-f]{64}$/.test(sha256)) throw new Error(`SHA-256 no válido para ${ruta}`);
    if (vistas.has(ruta)) throw new Error(`Ruta repetida en el precaché: ${ruta}`);
    vistas.add(ruta);
    entradas.push({ url: `/${ruta}`, integridad: integridadSri(sha256) });
  }
  // Orden por unidades de código, no por configuración regional: la salida no depende del equipo.
  entradas.sort((a, b) => (a.url < b.url ? -1 : a.url > b.url ? 1 : 0));
  return entradas;
}

/**
 * Versión derivada de la lista (URL + integridad): cambia si y solo si cambia el contenido del build.
 * @param {Entrada[]} entradas
 * @returns {string} 12 caracteres hexadecimales.
 */
export function calcularVersion(entradas) {
  const texto = entradas.map((e) => `${e.url}\t${e.integridad}\n`).join('');
  return createHash('sha256').update(texto).digest('hex').slice(0, 12);
}

/**
 * Sustituye los marcadores de la plantilla. Exige que cada marcador aparezca exactamente una vez.
 * @param {string} plantilla
 * @param {string} version
 * @param {Entrada[]} entradas
 * @param {string[]} rutas Rutas de la SPA que el service worker sirve con el shell guardado.
 * @returns {string}
 */
export function renderizarSw(plantilla, version, entradas, rutas) {
  if (!/^[0-9a-f]{12}$/.test(version)) throw new Error('Versión no válida');
  if (!Array.isArray(rutas) || rutas.length === 0 || !rutas.every((r) => r === '/' || rutaSegura(r.slice(1)))) {
    throw new Error('Rutas de la aplicación no válidas');
  }
  for (const marcador of [MARCADOR_VERSION, MARCADOR_PRECACHE, MARCADOR_RUTAS]) {
    const veces = plantilla.split(marcador).length - 1;
    if (veces !== 1) throw new Error(`El marcador ${marcador} debe aparecer una vez; aparece ${veces}`);
  }
  // Pares [url, integridad]. Las rutas están validadas: no contienen comillas ni barras invertidas.
  const lista = JSON.stringify(entradas.map((e) => [e.url, e.integridad]));
  return plantilla
    .replace(MARCADOR_VERSION, () => version)
    .replace(MARCADOR_PRECACHE, () => lista)
    .replace(MARCADOR_RUTAS, () => JSON.stringify(rutas));
}
