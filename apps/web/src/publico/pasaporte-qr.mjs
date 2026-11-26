import { esUuidPublico } from './uuid-publico.mjs';

const HOSTS_HTTP_LOCAL = new Set(['localhost', '127.0.0.1', '[::1]']);
const RUTA_PASAPORTE = /^\/alerta\/([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i;

/** @param {string} origen */
function origenSeguro(origen) {
  try {
    const url = new URL(origen);
    if (url.origin !== origen || url.username || url.password) return null;
    if (url.protocol === 'https:') return url;
    if (url.protocol === 'http:' && HOSTS_HTTP_LOCAL.has(url.hostname)) return url;
    return null;
  } catch {
    return null;
  }
}

/**
 * Construye únicamente una URL de pasaporte con el origen de la aplicación.
 * @param {unknown} id
 * @param {string} origen
 * @returns {string}
 */
export function construirUrlPasaporte(id, origen) {
  const base = origenSeguro(origen);
  if (!esUuidPublico(id)) throw new TypeError('Identificador de alerta inválido');
  if (!base) throw new TypeError('El origen no es HTTPS ni localhost de desarrollo');
  const url = new URL(`/alerta/${id}`, base.origin);
  if (!esUrlPasaporteSegura(url.href, base.origin)) throw new TypeError('No se pudo validar la URL pública');
  return url.href;
}

/**
 * Comprueba que un enlace sea exactamente un pasaporte del mismo origen, sin query ni fragmento.
 * @param {string} enlace
 * @param {string} origen
 * @returns {boolean}
 */
export function esUrlPasaporteSegura(enlace, origen) {
  const base = origenSeguro(origen);
  if (!base) return false;
  try {
    const url = new URL(enlace);
    return url.origin === base.origin &&
      url.protocol === base.protocol &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      RUTA_PASAPORTE.test(url.pathname);
  } catch {
    return false;
  }
}

/**
 * @param {unknown} id
 * @returns {string}
 */
export function rutaPasaporteAlerta(id) {
  if (!esUuidPublico(id)) throw new TypeError('Identificador de alerta inválido');
  return `/alerta/${id}`;
}

/**
 * @param {string} enlace
 * @param {string} origen
 * @param {{ writeText: (value: string) => Promise<void> } | undefined} portapapeles
 * @returns {Promise<void>}
 */
export async function copiarEnlacePasaporte(enlace, origen, portapapeles) {
  if (!esUrlPasaporteSegura(enlace, origen)) throw new TypeError('Enlace público inválido');
  if (!portapapeles || typeof portapapeles.writeText !== 'function') {
    throw new Error('Portapapeles no disponible');
  }
  await portapapeles.writeText(enlace);
}

/**
 * @param {{ open: boolean, showModal: () => void }} dialogo
 * @param {{ focus: () => void }} botonCerrar
 */
export function abrirDialogoQr(dialogo, botonCerrar) {
  if (!dialogo.open) dialogo.showModal();
  botonCerrar.focus();
}

/**
 * @param {{ open: boolean, close: () => void }} dialogo
 * @param {(() => void) | undefined} [alCerrar]
 * @param {{ focus: () => void } | null} [disparador]
 */
export function cerrarDialogoQr(dialogo, alCerrar, disparador) {
  if (dialogo.open) dialogo.close();
  alCerrar?.();
  restaurarFocoQr(disparador ?? null);
}

/**
 * @param {{ focus: () => void } | null} disparador
 */
export function restaurarFocoQr(disparador) {
  disparador?.focus();
}

/**
 * Cierra el diálogo antes de navegar a una ruta fija generada desde un UUID validado.
 * @param {unknown} id
 * @param {() => void} cerrar
 * @param {(ruta: string) => void} navegar
 */
export function abrirPasaporteDesdeQr(id, cerrar, navegar) {
  const ruta = rutaPasaporteAlerta(id);
  cerrar();
  navegar(ruta);
}
