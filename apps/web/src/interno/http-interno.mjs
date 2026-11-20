// Núcleo HTTP del portal interno (D09-1, extraído sin cambios de comportamiento de cliente-auth D08A).
// Lo comparten los adaptadores de la API interna. No conoce ninguna operación concreta.
//
// Reglas:
// - Mismo origen, cookie HttpOnly gestionada por el navegador (credentials: 'same-origin'). La
//   interfaz nunca lee ni guarda la cookie de sesión.
// - Sin redirecciones, sin caché, con tiempo de espera. El token CSRF, si se pasa, va solo en la
//   cabecera X-CSRF-Token; el Origin lo pone el navegador.
// - Una respuesta que no es JSON no viene de la API: un 5xx o un 429 de un proxy se dicen como tales;
//   cualquier otra (el index.html de un servidor estático, un 404…) es «API no disponible», nunca éxito.
// - Del cuerpo de error solo se toma `code` si tiene forma de código; `detail` no se muestra nunca.

export const BASE_API = '/api/v1';
const CODIGO_PROBLEMA = /^[A-Z][A-Z0-9_]{0,63}$/;
const MAX_ESPERA_MS = 15000;
const MAX_REINTENTO_S = 86400;

/**
 * @typedef {{ tipo: 'no-disponible' } | { tipo: 'error-red' } | { tipo: 'error-servidor' } | { tipo: 'respuesta-invalida' }} FalloComun
 * @typedef {{ tipo: 'limitado', reintentarEn: number | null }} Limitado
 * @typedef {{ tipo: 'prohibido', codigo: string | null }} Prohibido
 * @typedef {(url: string, init: RequestInit) => Promise<Response>} Fetch
 * @typedef {{ r: Response, cuerpo: unknown }} RespuestaApi
 * @typedef {RespuestaApi | { tipo: 'error-red' } | { tipo: 'no-disponible' } | { tipo: 'error-servidor' } | Limitado} ResultadoLlamada
 */

/** @param {Response} r */
export function esJson(r) {
  const tipo = (r.headers.get('content-type') ?? '').toLowerCase();
  return tipo.startsWith('application/json') || tipo.startsWith('application/problem+json');
}

/** @param {Response} r */
async function leerJson(r) {
  try {
    return /** @type {unknown} */ (await r.json());
  } catch {
    return undefined;
  }
}

/**
 * `code` de un Problem (RFC 9457) solo si tiene forma de código estable; si no, null.
 * @param {unknown} cuerpo
 */
export function codigoProblema(cuerpo) {
  if (typeof cuerpo !== 'object' || cuerpo === null) return null;
  const code = /** @type {Record<string, unknown>} */ (cuerpo).code;
  return typeof code === 'string' && CODIGO_PROBLEMA.test(code) ? code : null;
}

/**
 * Retry-After en segundos enteros (forma que usa el backend). Una fecha HTTP también se acepta.
 * @param {string | null} valor
 * @param {number} ahora
 */
export function segundosReintento(valor, ahora = Date.now()) {
  if (valor === null) return null;
  const v = valor.trim();
  if (/^[0-9]{1,6}$/.test(v)) {
    const s = Number(v);
    return s <= MAX_REINTENTO_S ? s : MAX_REINTENTO_S;
  }
  // Fecha HTTP («Mon, 19 Oct 2026 10:15:00 GMT»): lleva letras; «-5» u otros números no lo son.
  if (!/[A-Za-z]/.test(v)) return null;
  const fecha = Date.parse(v);
  if (Number.isNaN(fecha)) return null;
  return Math.min(MAX_REINTENTO_S, Math.max(0, Math.ceil((fecha - ahora) / 1000)));
}

/**
 * Clasificación común de lo que no es un éxito. null: el llamador decide (2xx, 401 y lo propio de
 * cada operación). Nota para M2: aquí un 404 es «no disponible»; las operaciones de alertas usan 404
 * también para ocultar recursos no visibles (ADR-006) y deberán distinguirlo por `code` en su propio
 * adaptador, sin cambiar esta función.
 * @param {Response} r
 * @param {unknown} cuerpo
 * @returns {FalloComun | Limitado | Prohibido | { tipo: 'invalido' } | null}
 */
export function falloComun(r, cuerpo) {
  if (r.status === 404 || r.status === 405 || r.status === 501) return { tipo: 'no-disponible' };
  if (r.status === 429) return { tipo: 'limitado', reintentarEn: segundosReintento(r.headers.get('retry-after')) };
  if (r.status === 403) return { tipo: 'prohibido', codigo: codigoProblema(cuerpo) };
  if (r.status === 422) return { tipo: 'invalido' };
  if (r.status >= 500) return { tipo: 'error-servidor' };
  return null;
}

/**
 * Transporte JSON hacia /api/v1 del mismo origen.
 * @param {Fetch} [fetchImpl]
 * @param {{ esperaMs?: number }} [opciones]
 */
export function crearTransporte(fetchImpl, opciones = {}) {
  const pedir = fetchImpl ?? ((url, init) => globalThis.fetch(url, init));
  const esperaMs = opciones.esperaMs ?? MAX_ESPERA_MS;

  /**
   * @param {'GET' | 'POST' | 'PATCH'} metodo
   * @param {string} ruta ruta relativa a /api/v1, ya construida por el adaptador
   * @param {{ cuerpo?: unknown, csrf?: string, ifMatch?: string }} [extra]
   * @returns {Promise<ResultadoLlamada>}
   */
  return async function llamar(metodo, ruta, extra = {}) {
    const control = new AbortController();
    const temporizador = setTimeout(() => control.abort(), esperaMs);
    /** @type {Record<string, string>} */
    const cabeceras = { Accept: 'application/json' };
    if (extra.cuerpo !== undefined) {
      cabeceras['Content-Type'] = 'application/json';
    }
    if (extra.csrf !== undefined) {
      cabeceras['X-CSRF-Token'] = extra.csrf;
    }
    if (extra.ifMatch !== undefined) {
      cabeceras['If-Match'] = extra.ifMatch;
    }
    try {
      const r = await pedir(`${BASE_API}${ruta}`, {
        method: metodo,
        headers: cabeceras,
        body: extra.cuerpo === undefined ? undefined : JSON.stringify(extra.cuerpo),
        credentials: 'same-origin',
        cache: 'no-store',
        redirect: 'error',
        signal: control.signal,
      });
      if (r.status !== 204 && !esJson(r)) {
        if (r.status >= 500) return { tipo: 'error-servidor' };
        if (r.status === 429) return { tipo: 'limitado', reintentarEn: segundosReintento(r.headers.get('retry-after')) };
        return { tipo: 'no-disponible' };
      }
      const cuerpo = r.status === 204 ? undefined : await leerJson(r);
      return { r, cuerpo };
    } catch {
      return { tipo: 'error-red' };
    } finally {
      clearTimeout(temporizador);
    }
  };
}
