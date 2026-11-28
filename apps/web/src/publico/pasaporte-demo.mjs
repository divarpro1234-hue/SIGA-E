const ORIGEN_RENDER = 'https://siga-e-web.onrender.com';
const HOSTS_HTTP_LOCAL = new Set(['localhost', '127.0.0.1', '[::1]']);
const RUTA_DEMO = '/demo/pasaporte';

export const PASAPORTE_DEMO = Object.freeze({
  identificador: 'DEMO-PASAPORTE-001',
  titulo: 'SIMULACRO: Crecida del río Ficticio',
  tipo: 'Simulacro académico',
  severidad: 'ALTA',
  area: 'Sector ficticio de La Paz',
  estado: 'DEMOSTRACIÓN — NO PUBLICADA',
  firmaDigital: 'NO DISPONIBLE',
  anclajeBlockchain: 'NO DISPONIBLE',
});

/**
 * @param {string} origen
 * @param {boolean} produccion
 * @returns {URL | null}
 */
function origenSeguro(origen, produccion) {
  try {
    const url = new URL(origen);
    if (url.origin !== origen || url.username || url.password || url.search || url.hash) return null;
    if (produccion) return url.origin === ORIGEN_RENDER && url.protocol === 'https:' ? url : null;
    if (url.protocol === 'https:') return url;
    if (url.protocol === 'http:' && HOSTS_HTTP_LOCAL.has(url.hostname)) return url;
    return null;
  } catch {
    return null;
  }
}

/**
 * @param {string} origen
 * @param {boolean} [produccion]
 * @returns {string}
 */
export function construirUrlDemoPasaporte(origen, produccion = true) {
  const base = origenSeguro(origen, produccion);
  if (!base) throw new TypeError('El origen no es seguro para la demostración pública');
  const url = new URL(RUTA_DEMO, base.origin);
  if (!esUrlDemoPasaporteSegura(url.href, base.origin, produccion)) {
    throw new TypeError('No se pudo validar la URL de demostración');
  }
  return url.href;
}

/**
 * @param {string} enlace
 * @param {string} origen
 * @param {boolean} [produccion]
 * @returns {boolean}
 */
export function esUrlDemoPasaporteSegura(enlace, origen, produccion = true) {
  const base = origenSeguro(origen, produccion);
  if (!base) return false;
  try {
    const url = new URL(enlace);
    return url.origin === base.origin &&
      url.protocol === base.protocol &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      url.pathname === RUTA_DEMO;
  } catch {
    return false;
  }
}

/**
 * @param {string} enlace
 * @param {string} origen
 * @param {{ writeText: (value: string) => Promise<void> } | undefined} portapapeles
 * @param {boolean} [produccion]
 * @returns {Promise<void>}
 */
export async function copiarEnlaceDemoPasaporte(enlace, origen, portapapeles, produccion = true) {
  if (!esUrlDemoPasaporteSegura(enlace, origen, produccion)) {
    throw new TypeError('Enlace de demostración inválido');
  }
  if (!portapapeles || typeof portapapeles.writeText !== 'function') {
    throw new Error('Portapapeles no disponible');
  }
  await portapapeles.writeText(enlace);
}
