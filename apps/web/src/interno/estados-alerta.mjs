// Representación de los estados de una alerta interna (D09-3). Solo presentación: no decide
// transiciones ni permisos, que son del servidor (Arquitectura §6, ADR-006).
//
// Dos ejes que nunca se mezclan:
// - Ciclo (`lifecycleState`, AlertState): DRAFT → PENDING_APPROVAL → READY_TO_SIGN → SIGNING →
//   SIGNED_PENDING_ANCHOR → PUBLISHED, con la rama PENDING_APPROVAL → REJECTED.
// - Anclaje (`anchorStatus`, AnchorState): lo que el BACKEND dice del registro en Stellar Testnet.
//   Es metadato del backend, no una lectura independiente del contrato: ningún texto de anclaje dice
//   «verificado», «coincide» ni «publicada», y CONFIRMED no lleva el tono de éxito.
// Solo PUBLISHED se presenta como publicada. SIGNING y SIGNED_PENDING_ANCHOR son «en proceso».
// Un valor desconocido no se interpreta: la interfaz muestra «Estado no reconocido».

/**
 * @typedef {'DRAFT' | 'PENDING_APPROVAL' | 'REJECTED' | 'READY_TO_SIGN' | 'SIGNING' | 'SIGNED_PENDING_ANCHOR' | 'PUBLISHED'} EstadoCiclo
 * @typedef {'NOT_REQUESTED' | 'PENDING' | 'SUBMITTED' | 'CONFIRMED' | 'RETRYABLE_ERROR' | 'CONFLICT' | 'UNVERIFIABLE'} EstadoAnclaje
 * @typedef {import('../dominio/tipos').Tono} Tono
 * @typedef {import('../dominio/tipos').NombreIcono} NombreIcono
 * @typedef {{ etiqueta: string, explica: string, tono: Tono, icono: NombreIcono }} TextoEstado
 * @typedef {{ estado: EstadoCiclo, paso: string, posicion: 'anterior' | 'actual' | 'siguiente' }} Paso
 */

/** @type {ReadonlyArray<EstadoCiclo>} */
export const ESTADOS_CICLO = Object.freeze([
  'DRAFT',
  'PENDING_APPROVAL',
  'REJECTED',
  'READY_TO_SIGN',
  'SIGNING',
  'SIGNED_PENDING_ANCHOR',
  'PUBLISHED',
]);

/** @type {ReadonlyArray<EstadoAnclaje>} */
export const ESTADOS_ANCLAJE = Object.freeze([
  'NOT_REQUESTED',
  'PENDING',
  'SUBMITTED',
  'CONFIRMED',
  'RETRYABLE_ERROR',
  'CONFLICT',
  'UNVERIFIABLE',
]);

/** @type {Readonly<Record<EstadoCiclo, TextoEstado>>} */
const TEXTO_CICLO = Object.freeze({
  DRAFT: {
    etiqueta: 'Borrador',
    explica: 'Se puede editar. Ningún contenido se ha congelado todavía.',
    tono: 'neutro',
    icono: 'dash',
  },
  PENDING_APPROVAL: {
    etiqueta: 'Pendiente de aprobación',
    explica: 'El contenido está congelado y espera la decisión de otra persona con rol de aprobación.',
    tono: 'neutro',
    icono: 'clock',
  },
  REJECTED: {
    etiqueta: 'Rechazada',
    explica: 'Otra persona rechazó esta versión. No se firmará ni se publicará.',
    tono: 'mal',
    icono: 'cross',
  },
  READY_TO_SIGN: {
    etiqueta: 'Aprobada, sin emitir',
    explica: 'Puede solicitarse la emisión. Todavía no está firmada ni publicada.',
    tono: 'neutro',
    icono: 'check',
  },
  SIGNING: {
    etiqueta: 'Firmando · en proceso',
    explica: 'El servidor está firmando el contenido aprobado. No está publicada.',
    tono: 'neutro',
    icono: 'clock',
  },
  SIGNED_PENDING_ANCHOR: {
    etiqueta: 'Firmada · anclaje en proceso',
    explica: 'Firmada por el servidor. Falta registrar su huella en Stellar Testnet y releerla. No está publicada.',
    tono: 'alerta',
    icono: 'clock',
  },
  PUBLISHED: {
    etiqueta: 'Publicada',
    explica: 'El backend la publicó tras releer su huella en el registro configurado. Sigue siendo un SIMULACRO.',
    tono: 'ok',
    icono: 'check',
  },
});

/** @type {Readonly<Record<EstadoAnclaje, TextoEstado>>} */
const TEXTO_ANCLAJE = Object.freeze({
  NOT_REQUESTED: {
    etiqueta: 'Sin solicitar',
    explica: 'Todavía no se ha pedido registrar su huella.',
    tono: 'neutro',
    icono: 'dash',
  },
  PENDING: {
    etiqueta: 'Pendiente',
    explica: 'El registro de la huella está en cola.',
    tono: 'neutro',
    icono: 'clock',
  },
  SUBMITTED: {
    etiqueta: 'Enviado, sin confirmar',
    explica: 'Se envió una transacción. Un envío no prueba que el registro exista.',
    tono: 'neutro',
    icono: 'clock',
  },
  CONFIRMED: {
    etiqueta: 'Confirmado según el backend',
    explica: 'El backend afirma haber releído la huella. Esta pantalla no lo ha comprobado en Stellar; la comprobación independiente la hace la CLI externa.',
    tono: 'neutro',
    icono: 'link',
  },
  RETRYABLE_ERROR: {
    etiqueta: 'Error recuperable',
    explica: 'El registro falló de forma recuperable. La alerta no se publica mientras tanto.',
    tono: 'alerta',
    icono: 'link-off',
  },
  CONFLICT: {
    etiqueta: 'Conflicto de huella',
    explica: 'El registro guarda otra huella para este mensaje. La alerta no se publica.',
    tono: 'mal',
    icono: 'cross',
  },
  UNVERIFIABLE: {
    etiqueta: 'No comprobable ahora',
    explica: 'La evidencia actual no se puede comprobar (reinicio de Testnet o caducidad). El hecho histórico se conserva.',
    tono: 'neutro',
    icono: 'help',
  },
});

/** Nota que acompaña siempre al estado de anclaje. */
export const FUENTE_ANCLAJE = 'Dato del backend, no una verificación independiente en Stellar.';

/** Texto para un valor que no es un estado conocido. */
export const ESTADO_DESCONOCIDO = Object.freeze({
  etiqueta: 'Estado no reconocido',
  explica: 'El servidor envió un estado que esta aplicación no conoce. No se interpreta.',
  tono: /** @type {Tono} */ ('neutro'),
  icono: /** @type {NombreIcono} */ ('help'),
});

/**
 * @param {unknown} v
 * @returns {v is EstadoCiclo}
 */
export function esEstadoCiclo(v) {
  return typeof v === 'string' && /** @type {ReadonlyArray<string>} */ (ESTADOS_CICLO).includes(v);
}

/**
 * @param {unknown} v
 * @returns {v is EstadoAnclaje}
 */
export function esEstadoAnclaje(v) {
  return typeof v === 'string' && /** @type {ReadonlyArray<string>} */ (ESTADOS_ANCLAJE).includes(v);
}

/**
 * @param {unknown} estado
 * @returns {TextoEstado}
 */
export function textoCiclo(estado) {
  return esEstadoCiclo(estado) ? TEXTO_CICLO[estado] : ESTADO_DESCONOCIDO;
}

/**
 * @param {unknown} estado
 * @returns {TextoEstado}
 */
export function textoAnclaje(estado) {
  return esEstadoAnclaje(estado) ? TEXTO_ANCLAJE[estado] : ESTADO_DESCONOCIDO;
}

/** @param {unknown} estado */
export function enProceso(estado) {
  return estado === 'SIGNING' || estado === 'SIGNED_PENDING_ANCHOR';
}

/** @param {unknown} estado */
export function publicada(estado) {
  return estado === 'PUBLISHED';
}

const CAMINO = /** @type {ReadonlyArray<EstadoCiclo>} */ (['DRAFT', 'PENDING_APPROVAL', 'READY_TO_SIGN', 'SIGNING', 'SIGNED_PENDING_ANCHOR', 'PUBLISHED']);
const CAMINO_RECHAZO = /** @type {ReadonlyArray<EstadoCiclo>} */ (['DRAFT', 'PENDING_APPROVAL', 'REJECTED']);

/** Nombre del paso en la línea del ciclo (no del estado actual). */
const PASO = /** @type {Readonly<Record<EstadoCiclo, string>>} */ (Object.freeze({
  DRAFT: 'Borrador',
  // Las severidades no críticas pasan de borrador a «aprobada» sin revisión (Arquitectura §6).
  PENDING_APPROVAL: 'Aprobación por otra persona (Severe y Extreme)',
  REJECTED: 'Rechazada',
  READY_TO_SIGN: 'Lista para emitir',
  SIGNING: 'Firma',
  SIGNED_PENDING_ANCHOR: 'Registro y relectura en Stellar Testnet',
  PUBLISHED: 'Publicación',
}));

/**
 * Pasos de la línea del ciclo con la posición de cada uno respecto al estado actual. Con REJECTED
 * se muestra la rama de rechazo. Con un estado desconocido, null (no se dibuja una línea inventada).
 * @param {unknown} estado
 * @returns {Paso[] | null}
 */
export function pasosCiclo(estado) {
  if (!esEstadoCiclo(estado)) return null;
  const camino = estado === 'REJECTED' ? CAMINO_RECHAZO : CAMINO;
  const actual = camino.indexOf(estado);
  return camino.map((e, i) => ({
    estado: e,
    paso: PASO[e],
    posicion: i < actual ? 'anterior' : i === actual ? 'actual' : 'siguiente',
  }));
}
