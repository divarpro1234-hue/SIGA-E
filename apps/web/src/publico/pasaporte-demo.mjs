const ORIGEN_RENDER = 'https://siga-e-web.onrender.com';
const HOSTS_HTTP_LOCAL = new Set(['localhost', '127.0.0.1', '[::1]']);
const RUTA_DEMO = '/demo/pasaporte';

/** @typedef {{ slug: string, identificador: string, titulo: string, severidad: string, area: string, descripcion: string, estado: string, firmaDigital: string, anclajeBlockchain: string }} PasaporteDemostrativo */

export const PASAPORTES_DEMO = Object.freeze([
  Object.freeze({
    slug: 'crecida-rio-ficticio',
    identificador: 'DEMO-001',
    titulo: 'SIMULACRO: Crecida del río Ficticio',
    severidad: 'ALTA',
    area: 'Cuenca ficticia de La Paz',
    descripcion: 'Aumento simulado del caudal y recomendaciones preventivas en un escenario académico.',
    estado: 'NO PUBLICADA',
    firmaDigital: 'NO DISPONIBLE',
    anclajeBlockchain: 'NO DISPONIBLE',
  }),
  Object.freeze({
    slug: 'deslizamiento-ficticio',
    identificador: 'DEMO-002',
    titulo: 'SIMULACRO: Deslizamiento en ladera ficticia',
    severidad: 'EXTREMA',
    area: 'Ladera ficticia de La Paz',
    descripcion: 'Simulación de riesgo de deslizamiento y medidas preventivas de evacuación.',
    estado: 'NO PUBLICADA',
    firmaDigital: 'NO DISPONIBLE',
    anclajeBlockchain: 'NO DISPONIBLE',
  }),
  Object.freeze({
    slug: 'interrupcion-vial',
    identificador: 'DEMO-003',
    titulo: 'SIMULACRO: Interrupción vial',
    severidad: 'MEDIA',
    area: 'Vía urbana ficticia de La Paz',
    descripcion: 'Simulación de cierre preventivo de una vía y recomendaciones generales de circulación.',
    estado: 'NO PUBLICADA',
    firmaDigital: 'NO DISPONIBLE',
    anclajeBlockchain: 'NO DISPONIBLE',
  }),
]);

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
 * @param {unknown} slug
 * @returns {PasaporteDemostrativo | undefined}
 */
export function obtenerPasaporteDemo(slug) {
  if (typeof slug !== 'string') return undefined;
  return PASAPORTES_DEMO.find((pasaporte) => pasaporte.slug === slug);
}

/**
 * @param {unknown} slug
 * @returns {string}
 */
export function rutaPasaporteDemo(slug) {
  if (!obtenerPasaporteDemo(slug)) throw new TypeError('Simulacro de demostración desconocido');
  return `${RUTA_DEMO}/${slug}`;
}

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

/**
 * @param {string} slug
 * @param {string} origen
 * @param {boolean} [produccion]
 * @returns {string}
 */
export function construirUrlPasaporteDemo(slug, origen, produccion = true) {
  const base = origenSeguro(origen, produccion);
  const ruta = rutaPasaporteDemo(slug);
  if (!base) throw new TypeError('El origen no es seguro para la demostración pública');
  const url = new URL(ruta, base.origin);
  if (!esUrlPasaporteDemoSegura(url.href, base.origin, slug, produccion)) {
    throw new TypeError('No se pudo validar la URL de demostración');
  }
  return url.href;
}

/**
 * @param {string} enlace
 * @param {string} origen
 * @param {string} slug
 * @param {boolean} [produccion]
 * @returns {boolean}
 */
export function esUrlPasaporteDemoSegura(enlace, origen, slug, produccion = true) {
  const base = origenSeguro(origen, produccion);
  if (!base || !obtenerPasaporteDemo(slug)) return false;
  try {
    const url = new URL(enlace);
    return url.origin === base.origin &&
      url.protocol === base.protocol &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      url.pathname === rutaPasaporteDemo(slug);
  } catch {
    return false;
  }
}

/**
 * @param {string} enlace
 * @param {string} origen
 * @param {string} slug
 * @param {{ writeText: (value: string) => Promise<void> } | undefined} portapapeles
 * @param {boolean} [produccion]
 * @returns {Promise<void>}
 */
export async function copiarEnlacePasaporteDemo(enlace, origen, slug, portapapeles, produccion = true) {
  if (!esUrlPasaporteDemoSegura(enlace, origen, slug, produccion)) {
    throw new TypeError('Enlace de demostración inválido');
  }
  if (!portapapeles || typeof portapapeles.writeText !== 'function') {
    throw new Error('Portapapeles no disponible');
  }
  await portapapeles.writeText(enlace);
}
