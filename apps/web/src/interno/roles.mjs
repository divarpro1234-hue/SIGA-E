// Roles internos y secciones del portal (D08A). El rol SIEMPRE lo dice el servidor en /auth/me;
// la interfaz no tiene selector de rol. Esta tabla solo decide qué estructura se dibuja: los
// permisos reales los comprueba el backend en cada operación (ADR-004, RBAC en servidor).

/**
 * @typedef {'AUTHOR' | 'APPROVER' | 'ADMIN'} Rol
 * @typedef {'portal' | 'portal-alertas' | 'portal-revision' | 'portal-administracion'} Seccion
 */

/** @type {ReadonlyArray<Rol>} */
export const ROLES = Object.freeze(['AUTHOR', 'APPROVER', 'ADMIN']);

/** Nombre visible de cada rol. */
export const NOMBRE_ROL = Object.freeze({
  AUTHOR: 'Autoría',
  APPROVER: 'Aprobación',
  ADMIN: 'Administración',
});

/**
 * Secciones por rol, en orden de navegación. Roles excluyentes: cada sesión tiene uno solo.
 * ADMIN no crea, aprueba ni firma alertas; AUTHOR no revisa; APPROVER no redacta.
 * @type {Readonly<Record<Rol, ReadonlyArray<Seccion>>>}
 */
const SECCIONES = Object.freeze({
  AUTHOR: Object.freeze(/** @type {Seccion[]} */ (['portal', 'portal-alertas'])),
  APPROVER: Object.freeze(/** @type {Seccion[]} */ (['portal', 'portal-revision'])),
  ADMIN: Object.freeze(/** @type {Seccion[]} */ (['portal', 'portal-administracion'])),
});

/**
 * @param {unknown} valor
 * @returns {valor is Rol}
 */
export function esRol(valor) {
  return typeof valor === 'string' && /** @type {ReadonlyArray<string>} */ (ROLES).includes(valor);
}

/**
 * Secciones que la interfaz dibuja para un rol. Con un rol desconocido, ninguna.
 * @param {unknown} rol
 * @returns {ReadonlyArray<Seccion>}
 */
export function seccionesPara(rol) {
  return esRol(rol) ? SECCIONES[rol] : [];
}

/**
 * @param {unknown} rol
 * @param {Seccion} seccion
 */
export function seccionPermitida(rol, seccion) {
  return seccionesPara(rol).includes(seccion);
}
