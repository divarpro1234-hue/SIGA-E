// Lógica pura del enrutador propio. Sin DOM ni history: eso vive en ruta.ts.
// El estado de verificación nunca viaja en la URL: solo hay rutas fijas, sin parámetros ni query.

// Portal interno (D08A): rutas fijas bajo /interno. Ni el desafío ni la sesión viajan en la URL;
// la ruta solo elige la pantalla, y lo que se muestra depende de lo que confirme el servidor.

/**
 * @typedef {'inicio' | 'verificar' | 'resultado' | 'pasaporte'} RutaCiudadana
 * @typedef {'acceso' | 'codigo' | 'portal' | 'portal-alertas' | 'portal-revision' | 'portal-administracion'} RutaInterna
 * @typedef {RutaCiudadana | RutaInterna | 'no-existe'} NombreRuta
 * @typedef {{ nombre: NombreRuta, ruta: string, conocida: boolean, id?: string }} RutaResuelta
 */

/** @type {Readonly<Record<RutaCiudadana | RutaInterna, string>>} */
export const RUTAS = Object.freeze({
  inicio: '/',
  verificar: '/verificar',
  resultado: '/verificar/resultado',
  pasaporte: '/alerta',
  acceso: '/interno/acceso',
  codigo: '/interno/acceso/codigo',
  portal: '/interno',
  'portal-alertas': '/interno/alertas',
  'portal-revision': '/interno/revision',
  'portal-administracion': '/interno/administracion',
});

/** @type {ReadonlyArray<RutaInterna>} */
const INTERNAS = ['acceso', 'codigo', 'portal', 'portal-alertas', 'portal-revision', 'portal-administracion'];

/**
 * @param {NombreRuta} nombre
 * @returns {nombre is RutaInterna}
 */
export function esRutaInterna(nombre) {
  return /** @type {ReadonlyArray<string>} */ (INTERNAS).includes(nombre);
}

/** Títulos de pantalla (también el h1 y el nombre anunciado). PROVISIONALES (P3). */
export const TITULOS = Object.freeze({
  inicio: 'Alertas de simulacro',
  verificar: 'Verificar un mensaje',
  resultado: 'Resultado',
  pasaporte: 'Pasaporte digital de alerta',
  acceso: 'Acceso interno',
  codigo: 'Código de verificación',
  portal: 'Portal interno',
  'portal-alertas': 'Mis alertas',
  'portal-revision': 'Revisión',
  'portal-administracion': 'Administración',
  'no-existe': 'No existe esa pantalla',
});

/**
 * Deja solo la ruta: sin query ni fragmento, con una barra inicial, sin barras repetidas ni final.
 * No decodifica porcentajes ni cambia mayúsculas: lo que no coincide exactamente no existe.
 * @param {unknown} entrada
 * @returns {string}
 */
export function normalizarRuta(entrada) {
  if (typeof entrada !== 'string') return '/';
  let r = entrada;
  const corte = r.search(/[?#]/);
  if (corte !== -1) r = r.slice(0, corte);
  r = r.replace(/\/{2,}/g, '/');
  if (!r.startsWith('/')) r = `/${r}`;
  if (r.length > 1) r = r.replace(/\/+$/, '');
  return r === '' ? '/' : r;
}

/**
 * @param {unknown} entrada
 * @returns {RutaResuelta}
 */
export function resolverRuta(entrada) {
  const ruta = normalizarRuta(entrada);
  for (const nombre of /** @type {Array<keyof typeof RUTAS>} */ (Object.keys(RUTAS))) {
    if (RUTAS[nombre] === ruta) return { nombre, ruta, conocida: true };
  }
  const pasaporte = ruta.match(/^\/alerta\/([^/]+)$/);
  if (pasaporte) return { nombre: 'pasaporte', ruta, conocida: true, id: pasaporte[1] };
  return { nombre: 'no-existe', ruta, conocida: false };
}

/**
 * Ruta a la que hay que redirigir (reemplazando la entrada del historial) o null.
 * Resultado sin resultado en memoria vuelve a Verificar. El código TOTP sin desafío en memoria
 * vuelve al acceso: el desafío nunca se reconstruye desde la URL ni desde almacenamiento.
 * @param {NombreRuta} nombre
 * @param {boolean} hayResultado
 * @param {boolean} [hayDesafio]
 * @returns {string | null}
 */
export function redireccion(nombre, hayResultado, hayDesafio = false) {
  if (nombre === 'resultado' && !hayResultado) return RUTAS.verificar;
  if (nombre === 'codigo' && !hayDesafio) return RUTAS.acceso;
  return null;
}

/**
 * @param {NombreRuta} nombre
 * @returns {string}
 */
export function tituloDocumento(nombre) {
  return `${TITULOS[nombre]} · SIGA-E`;
}
