// Validación local de los formularios de acceso (D08A). Solo evita envíos que el servidor rechazaría
// por forma; no decide nada sobre credenciales. Los límites siguen el backend M1: correo ≤254,
// contraseña ≤512 (zod de /auth/login) y código de exactamente seis dígitos (OpenAPI TotpCode).
// La contraseña nunca se recorta ni se normaliza: llega al servidor tal cual se escribió.

export const MAX_CORREO = 254;
export const MAX_CONTRASENA = 512;

/**
 * @typedef {'correo-vacio' | 'correo-forma' | 'correo-largo' | 'contrasena-vacia' | 'contrasena-larga'} ErrorAcceso
 * @typedef {'codigo-vacio' | 'codigo-forma'} ErrorCodigo
 */

// Forma mínima: algo@algo.algo sin espacios. El servidor aplica la validación completa.
const FORMA_CORREO = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * El correo se recorta por los extremos (copiar y pegar arrastra espacios); nada más.
 * @param {string} correo
 * @param {string} contrasena
 * @returns {{ ok: true, correo: string } | { ok: false, correo: ErrorAcceso | null, contrasena: ErrorAcceso | null }}
 */
export function validarAcceso(correo, contrasena) {
  const c = correo.trim();
  /** @type {ErrorAcceso | null} */
  let errCorreo = null;
  if (c === '') errCorreo = 'correo-vacio';
  else if (c.length > MAX_CORREO) errCorreo = 'correo-largo';
  else if (!FORMA_CORREO.test(c)) errCorreo = 'correo-forma';
  /** @type {ErrorAcceso | null} */
  let errContrasena = null;
  if (contrasena === '') errContrasena = 'contrasena-vacia';
  else if (contrasena.length > MAX_CONTRASENA) errContrasena = 'contrasena-larga';
  if (errCorreo || errContrasena) return { ok: false, correo: errCorreo, contrasena: errContrasena };
  return { ok: true, correo: c };
}

/**
 * Admite espacios entre grupos («123 456»), que se quitan; el resto debe ser exactamente seis dígitos ASCII.
 * @param {string} entrada
 * @returns {{ ok: true, codigo: string } | { ok: false, error: ErrorCodigo }}
 */
export function validarCodigo(entrada) {
  const c = entrada.replace(/[\s]/g, '');
  if (c === '') return { ok: false, error: 'codigo-vacio' };
  if (!/^[0-9]{6}$/.test(c)) return { ok: false, error: 'codigo-forma' };
  return { ok: true, codigo: c };
}
