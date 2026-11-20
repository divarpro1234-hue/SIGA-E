// Adaptador HTTP de autenticación interna (D08A). Solo las cuatro operaciones M1 implementadas en el
// backend (HANDOFF_M1_FINAL): POST /auth/login, POST /auth/totp/verify, GET /auth/me y
// POST /auth/logout. Nada más: alta, enrolamiento, cambio de contraseña o reconfiguración TOTP están
// diferidos (ENM-002) y no tienen cliente aquí.
//
// El transporte (mismo origen, sin caché ni redirecciones, CSRF en cabecera, respuestas no JSON
// tratadas como «no disponible») vive en http-interno.mjs (D09-1). Aquí:
// - Falla cerrado: una respuesta 200 con forma inesperada es un error, no una sesión.
// - La contraseña y el código solo viajan en el cuerpo de la petición; no se guardan ni registran.

import { BASE_API, crearTransporte, falloComun, segundosReintento } from './http-interno.mjs';
import { esRol } from './roles.mjs';

// Se reexportan para no cambiar la superficie pública de D08A.
export { BASE_API, segundosReintento };

const TOKEN_OPACO = /^[A-Za-z0-9_-]{43}$/;
/** Vida contractual del desafío de login (ADR-004 §3): cinco minutos. */
export const DURACION_DESAFIO_MS = 5 * 60_000;

/**
 * @typedef {import('./roles.mjs').Rol} Rol
 * @typedef {import('./http-interno.mjs').FalloComun} FalloComun
 * @typedef {import('./http-interno.mjs').Limitado} Limitado
 * @typedef {import('./http-interno.mjs').Prohibido} Prohibido
 * @typedef {import('./http-interno.mjs').Fetch} Fetch
 * @typedef {{ id: string, nombre: string, correo: string, rol: Rol }} UsuarioInterno
 * @typedef {{ tipo: 'desafio', challengeId: string, expiraEn: number }
 *   | { tipo: 'rechazado' } | { tipo: 'invalido' } | Limitado | Prohibido | FalloComun} RespuestaLogin
 * @typedef {{ tipo: 'sesion', usuario: UsuarioInterno, csrf: string }
 *   | { tipo: 'rechazado' } | { tipo: 'invalido' } | Limitado | Prohibido | FalloComun} RespuestaCodigo
 * @typedef {{ tipo: 'sesion', usuario: UsuarioInterno, csrf: string }
 *   | { tipo: 'sin-sesion' } | Prohibido | FalloComun} RespuestaSesion
 * @typedef {{ tipo: 'cerrada' } | { tipo: 'sin-sesion' } | Prohibido | FalloComun} RespuestaCierre
 */

/**
 * Milisegundos que le quedan al desafío, medidos con el reloj del SERVIDOR (cabecera Date) para que un
 * reloj del dispositivo adelantado o atrasado no lo dé por caducado ni alargue la cuenta atrás. Sin
 * cabecera Date se usa el reloj local; un resultado fuera de (0, 5 min] se sustituye por los cinco
 * minutos del contrato. Es solo una guía: quien decide la caducidad es el servidor.
 * @param {number} expira instante expiresAt (ms)
 * @param {string | null} fechaServidor cabecera Date
 * @param {number} [ahora]
 */
export function restanteDesafio(expira, fechaServidor, ahora = Date.now()) {
  const servidor = fechaServidor ? Date.parse(fechaServidor) : Number.NaN;
  const restante = expira - (Number.isNaN(servidor) ? ahora : servidor);
  return restante > 0 ? Math.min(restante, DURACION_DESAFIO_MS) : DURACION_DESAFIO_MS;
}

/**
 * Usuario de /auth/me o /auth/totp/verify. Solo una cuenta ACTIVE con rol conocido abre el portal.
 * @param {unknown} valor
 * @returns {UsuarioInterno | null}
 */
export function usuarioDe(valor) {
  if (typeof valor !== 'object' || valor === null) return null;
  const u = /** @type {Record<string, unknown>} */ (valor);
  if (typeof u.id !== 'string' || u.id.length === 0 || u.id.length > 64) return null;
  if (typeof u.name !== 'string' || u.name.length === 0 || u.name.length > 120) return null;
  if (typeof u.email !== 'string' || u.email.length === 0 || u.email.length > 254) return null;
  if (!esRol(u.role) || u.status !== 'ACTIVE') return null;
  return { id: u.id, nombre: u.name, correo: u.email, rol: u.role };
}

/**
 * @param {unknown} cuerpo
 * @returns {{ tipo: 'sesion', usuario: UsuarioInterno, csrf: string } | { tipo: 'respuesta-invalida' }}
 */
function sesionDe(cuerpo) {
  if (typeof cuerpo !== 'object' || cuerpo === null) return { tipo: 'respuesta-invalida' };
  const c = /** @type {Record<string, unknown>} */ (cuerpo);
  const usuario = usuarioDe(c.user);
  const csrf = c.csrfToken;
  if (!usuario || typeof csrf !== 'string' || !TOKEN_OPACO.test(csrf)) return { tipo: 'respuesta-invalida' };
  return { tipo: 'sesion', usuario, csrf };
}

/**
 * @param {Fetch} [fetchImpl]
 * @param {{ esperaMs?: number }} [opciones]
 */
export function crearClienteAuth(fetchImpl, opciones = {}) {
  const llamar = crearTransporte(fetchImpl, opciones);

  return {
    /**
     * Primer paso: correo y contraseña. 200 entrega un desafío, nunca una sesión.
     * @param {string} correo
     * @param {string} contrasena
     * @returns {Promise<RespuestaLogin>}
     */
    async iniciar(correo, contrasena) {
      const res = await llamar('POST', '/auth/login', { cuerpo: { email: correo, password: contrasena } });
      if ('tipo' in res) return res;
      const { r, cuerpo } = res;
      if (r.status === 401) return { tipo: 'rechazado' };
      const fallo = falloComun(r, cuerpo);
      if (fallo) return fallo;
      if (r.status !== 200 || typeof cuerpo !== 'object' || cuerpo === null) return { tipo: 'respuesta-invalida' };
      const { challengeId, expiresAt } = /** @type {Record<string, unknown>} */ (cuerpo);
      const expira = typeof expiresAt === 'string' ? Date.parse(expiresAt) : Number.NaN;
      if (typeof challengeId !== 'string' || !TOKEN_OPACO.test(challengeId) || Number.isNaN(expira)) {
        return { tipo: 'respuesta-invalida' };
      }
      return { tipo: 'desafio', challengeId, expiraEn: Date.now() + restanteDesafio(expira, r.headers.get('date')) };
    },

    /**
     * Segundo paso: código TOTP sobre el desafío en memoria. 200 crea la cookie de sesión.
     * @param {string} challengeId
     * @param {string} codigo
     * @returns {Promise<RespuestaCodigo>}
     */
    async verificarCodigo(challengeId, codigo) {
      const res = await llamar('POST', '/auth/totp/verify', { cuerpo: { challengeId, code: codigo } });
      if ('tipo' in res) return res;
      const { r, cuerpo } = res;
      if (r.status === 401) return { tipo: 'rechazado' };
      const fallo = falloComun(r, cuerpo);
      if (fallo) return fallo;
      if (r.status !== 200) return { tipo: 'respuesta-invalida' };
      return sesionDe(cuerpo);
    },

    /**
     * Estado real de la sesión. Es la única fuente para mostrar el portal.
     * @returns {Promise<RespuestaSesion>}
     */
    async consultarSesion() {
      const res = await llamar('GET', '/auth/me');
      if ('tipo' in res) return res.tipo === 'limitado' ? { tipo: 'respuesta-invalida' } : res;
      const { r, cuerpo } = res;
      if (r.status === 401) return { tipo: 'sin-sesion' };
      const fallo = falloComun(r, cuerpo);
      if (fallo) return fallo.tipo === 'invalido' || fallo.tipo === 'limitado' ? { tipo: 'respuesta-invalida' } : fallo;
      if (r.status !== 200) return { tipo: 'respuesta-invalida' };
      return sesionDe(cuerpo);
    },

    /**
     * Cierre de sesión con el token CSRF en memoria. El Origin lo pone el navegador.
     * @param {string} csrf
     * @returns {Promise<RespuestaCierre>}
     */
    async cerrarSesion(csrf) {
      const res = await llamar('POST', '/auth/logout', { csrf });
      if ('tipo' in res) return res.tipo === 'limitado' ? { tipo: 'respuesta-invalida' } : res;
      const { r, cuerpo } = res;
      if (r.status === 204) return { tipo: 'cerrada' };
      if (r.status === 401) return { tipo: 'sin-sesion' };
      const fallo = falloComun(r, cuerpo);
      if (fallo) return fallo.tipo === 'invalido' || fallo.tipo === 'limitado' ? { tipo: 'respuesta-invalida' } : fallo;
      return { tipo: 'respuesta-invalida' };
    },
  };
}

/** @typedef {ReturnType<typeof crearClienteAuth>} ClienteAuth */
