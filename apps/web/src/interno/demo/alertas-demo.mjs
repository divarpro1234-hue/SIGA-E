// Adaptador DEMO para la Bandeja Operativa (F3).
//
// PROPÓSITO: Proveer datos ficticios mientras el backend M2 no esté disponible.
// Este módulo SOLO se usa cuando el endpoint real devuelve 404/405/501 (no disponible)
// o cuando se fuerza DEMO_BANDEJA=true en la configuración de desarrollo.
//
// INVARIANTE: Los datos de este módulo son explícitamente ficticios (SIMULACRO).
// Ninguna operación de este adaptador persiste nada: es solo presentación local.
// El adaptador real vive en adaptador-alertas.mjs (pendiente de backend M2).

/**
 * @typedef {'DRAFT' | 'PENDING_APPROVAL' | 'REJECTED' | 'READY_TO_SIGN' | 'SIGNING' | 'SIGNED_PENDING_ANCHOR' | 'PUBLISHED'} EstadoCiclo
 * @typedef {'NOT_REQUESTED' | 'PENDING' | 'SUBMITTED' | 'CONFIRMED' | 'RETRYABLE_ERROR' | 'CONFLICT' | 'UNVERIFIABLE'} EstadoAnclaje
 * @typedef {'Extreme' | 'Severe' | 'Moderate' | 'Minor'} Severidad
 *
 * @typedef {{
 *   id: string,
 *   identifier: string,
 *   sender: string,
 *   sent: string,
 *   version: number,
 *   msgType: 'Alert' | 'Update' | 'Cancel',
 *   lifecycleState: EstadoCiclo,
 *   anchorStatus: EstadoAnclaje,
 *   info: {
 *     severity: Severidad,
 *     headline: string,
 *     description: string,
 *     event: string,
 *     areaDesc: string,
 *     expires: string,
 *   },
 *   author: { id: string, name: string },
 *   approver: { id: string, name: string, approvedAt: string } | null,
 *   frozenPayload: {
 *     payloadDigestHex: string,
 *     bytesCount: number,
 *   } | null,
 * }} AlertaInterna
 */

/** @type {readonly AlertaInterna[]} */
export const ALERTAS_DEMO = Object.freeze([
  {
    id: 'a001-e87f-412b-b892-0192a01',
    identifier: 'SIGA-E-2026-0089',
    sender: 'senapred-simulacro@siga-e.local',
    sent: '2026-10-26T22:30:00Z',
    version: 1,
    msgType: 'Alert',
    lifecycleState: 'PENDING_APPROVAL',
    anchorStatus: 'NOT_REQUESTED',
    info: {
      severity: 'Extreme',
      headline: 'SIMULACRO: Evacuación preventiva inmediata a cota 30 en borde costero',
      description: 'SIMULACRO DE ALERTA NACIONAL. Tras sismo simulado de alta intensidad en cuenca oceánica central, se activa protocolo de evacuación a zona de seguridad sobre cota 30 metros. Esta comunicación es un ejercicio técnico de seguridad de la información.',
      event: 'Tsunami costero por sismo mayor de simulacro M8.2',
      areaDesc: 'Borde costero región de Valparaíso, sectores Viña del Mar y Valparaíso',
      expires: '2026-10-27T04:30:00Z',
    },
    author: { id: 'usr-auth-042', name: 'Carlos Méndez' },
    approver: null,
    frozenPayload: {
      payloadDigestHex: 'd8a4f36c5b9e812d7c04192837465abcde918273645feadbc0192837465a12f8',
      bytesCount: 654,
    },
  },
  {
    id: 'a002-f14c-5d9e-c871-0293b02',
    identifier: 'SIGA-E-2026-0088',
    sender: 'conaf-simulacro@siga-e.local',
    sent: '2026-10-26T21:15:00Z',
    version: 1,
    msgType: 'Alert',
    lifecycleState: 'READY_TO_SIGN',
    anchorStatus: 'NOT_REQUESTED',
    info: {
      severity: 'Severe',
      headline: 'SIMULACRO: Alerta roja por avance rápido de incendio forestal en interfaz urbano-rural',
      description: 'SIMULACRO. Incendio forestal simulado avanza hacia zona habitada. Evacuación preventiva de 500 metros perimetrales activa.',
      event: 'Incendio forestal de alta intensidad (simulacro)',
      areaDesc: 'Sector Viñas del Monte, Quilpué, Región de Valparaíso',
      expires: '2026-10-27T21:15:00Z',
    },
    author: { id: 'usr-auth-042', name: 'Carlos Méndez' },
    approver: { id: 'usr-apr-001', name: 'Mariana Albarracín', approvedAt: '2026-10-26T21:45:00Z' },
    frozenPayload: {
      payloadDigestHex: 'a1b2c3d4e5f6789012345678901234567890abcdef1234567890abcdef123456',
      bytesCount: 487,
    },
  },
  {
    id: 'a003-g22d-6f0a-d982-0394c03',
    identifier: 'SIGA-E-2026-0087',
    sender: 'senapred-simulacro@siga-e.local',
    sent: '2026-10-26T19:00:00Z',
    version: 1,
    msgType: 'Alert',
    lifecycleState: 'SIGNED_PENDING_ANCHOR',
    anchorStatus: 'PENDING',
    info: {
      severity: 'Severe',
      headline: 'SIMULACRO: Alerta de nevazón intensa y corte de ruta en pasos cordilleranos',
      description: 'SIMULACRO. Sistema frontal de alta intensidad genera nevazón extrema en pasos cordilleranos. Corte de ruta preventivo activado.',
      event: 'Nevazón intensa en cordillera (simulacro)',
      areaDesc: 'Paso Los Libertadores y Paso El Vergel, Región de Valparaíso',
      expires: '2026-10-27T19:00:00Z',
    },
    author: { id: 'usr-auth-042', name: 'Carlos Méndez' },
    approver: { id: 'usr-apr-001', name: 'Mariana Albarracín', approvedAt: '2026-10-26T19:30:00Z' },
    frozenPayload: {
      payloadDigestHex: 'f9e8d7c6b5a4321098765432109876543210fedcba9876543210fedcba987654',
      bytesCount: 523,
    },
  },
  {
    id: 'a004-h33e-7g1b-e093-0495d04',
    identifier: 'SIGA-E-2026-0086',
    sender: 'dirima-simulacro@siga-e.local',
    sent: '2026-10-26T15:00:00Z',
    version: 1,
    msgType: 'Alert',
    lifecycleState: 'PUBLISHED',
    anchorStatus: 'CONFIRMED',
    info: {
      severity: 'Moderate',
      headline: 'SIMULACRO: Advertencia de oleaje anómalo en borde costero central',
      description: 'SIMULACRO. Oleaje anómalo simulado con olas de 4 a 6 metros en sector costero central. Actividad pesquera artesanal suspendida.',
      event: 'Oleaje anómalo costero (simulacro)',
      areaDesc: 'Costa de Coquimbo y norte de Valparaíso',
      expires: '2026-10-27T03:00:00Z',
    },
    author: { id: 'usr-auth-099', name: 'Laura Espinoza' },
    approver: { id: 'usr-apr-002', name: 'Pedro Ramírez', approvedAt: '2026-10-26T15:45:00Z' },
    frozenPayload: {
      payloadDigestHex: '12345678901234567890123456789012345678901234567890123456789abcde',
      bytesCount: 412,
    },
  },
  {
    id: 'a005-i44f-8h2c-f104-0596e05',
    identifier: 'SIGA-E-2026-0085',
    sender: 'sernageomin-simulacro@siga-e.local',
    sent: '2026-10-26T10:30:00Z',
    version: 1,
    msgType: 'Alert',
    lifecycleState: 'DRAFT',
    anchorStatus: 'NOT_REQUESTED',
    info: {
      severity: 'Minor',
      headline: 'SIMULACRO: Aviso de actividad volcánica menor en zona de observación',
      description: 'SIMULACRO. Incremento de microsismicidad volcánica simulada en zona controlada. Nivel de alerta técnica, sin evacuación.',
      event: 'Actividad volcánica menor (simulacro)',
      areaDesc: 'Zona de observación volcán Lascar, Región de Antofagasta',
      expires: '2026-10-27T10:30:00Z',
    },
    author: { id: 'usr-auth-042', name: 'Carlos Méndez' },
    approver: null,
    frozenPayload: null,
  },
]);

/**
 * Retorna las alertas DEMO filtradas por término de búsqueda.
 * No llama a ningún endpoint real.
 * @param {string} termino
 * @returns {readonly AlertaInterna[]}
 */
export function filtrarAlertasDemo(termino) {
  if (!termino) return ALERTAS_DEMO;
  const t = termino.toLowerCase();
  return ALERTAS_DEMO.filter(
    (a) =>
      a.identifier.toLowerCase().includes(t) ||
      a.info.headline.toLowerCase().includes(t) ||
      a.info.severity.toLowerCase().includes(t) ||
      a.lifecycleState.toLowerCase().includes(t),
  );
}
