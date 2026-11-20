// SIGA-E — Validación de Formulario de Alerta M2 (F4-A).
// Reglas estrictas derivadas de OpenAPI v1.2 (AlertInput / InfoInput).

/**
 * @typedef {import('../adaptador-alertas.mjs').EscenarioCAP} EscenarioCAP
 * @typedef {import('../adaptador-alertas.mjs').SeveridadCAP} SeveridadCAP
 * @typedef {import('../adaptador-alertas.mjs').UrgenciaCAP} UrgenciaCAP
 * @typedef {import('../adaptador-alertas.mjs').CertezaCAP} CertezaCAP
 * @typedef {import('../adaptador-alertas.mjs').AlertInput} AlertInput
 *
 * @typedef {{
 *   scenario: EscenarioCAP,
 *   event: string,
 *   severity: SeveridadCAP,
 *   urgency: UrgenciaCAP,
 *   certainty: CertezaCAP,
 *   headline: string,
 *   description: string,
 *   expires: string,
 *   areaDesc: string,
 * }} FormularioAlertaValores
 *
 * @typedef {keyof FormularioAlertaValores} CampoAlerta
 *
 * @typedef {{
 *   scenario?: string,
 *   event?: string,
 *   severity?: string,
 *   urgency?: string,
 *   certainty?: string,
 *   headline?: string,
 *   description?: string,
 *   expires?: string,
 *   areaDesc?: string,
 * }} ErroresFormularioAlerta
 *
 * @typedef {{
 *   ok: boolean,
 *   errores: ErroresFormularioAlerta,
 *   payload?: AlertInput,
 * }} ResultadoValidacionAlerta
 */

/** @type {readonly EscenarioCAP[]} */
export const ESCENARIOS_VALIDOS = ['INUNDACION', 'DESLIZAMIENTO', 'SISMO'];
/** @type {readonly SeveridadCAP[]} */
export const SEVERIDADES_VALIDAS = ['Extreme', 'Severe', 'Moderate', 'Minor', 'Unknown'];
/** @type {readonly UrgenciaCAP[]} */
export const URGENCIAS_VALIDAS = ['Immediate', 'Expected', 'Future', 'Past', 'Unknown'];
/** @type {readonly CertezaCAP[]} */
export const CERTEZAS_VALIDAS = ['Observed', 'Likely', 'Possible', 'Unlikely', 'Unknown'];

/**
 * @param {FormularioAlertaValores} valores
 * @param {number} [ahoraMs]
 * @returns {ResultadoValidacionAlerta}
 */
export function validarFormularioAlerta(valores, ahoraMs = Date.now()) {
  /** @type {ErroresFormularioAlerta} */
  const errores = {};

  // 1. scenario
  if (!ESCENARIOS_VALIDOS.includes(valores.scenario)) {
    errores.scenario = 'Selecciona un escenario de simulacro válido (Inundación, Deslizamiento o Sismo).';
  }

  // 2. event (1..120 chars)
  const evento = valores.event.trim();
  if (evento.length < 1) {
    errores.event = 'El tipo de evento es obligatorio.';
  } else if (evento.length > 120) {
    errores.event = 'El evento no puede superar los 120 caracteres.';
  }

  // 3. severity
  if (!SEVERIDADES_VALIDAS.includes(valores.severity)) {
    errores.severity = 'Selecciona una severidad válida.';
  }

  // 4. urgency
  if (!URGENCIAS_VALIDAS.includes(valores.urgency)) {
    errores.urgency = 'Selecciona una urgencia válida.';
  }

  // 5. certainty
  if (!CERTEZAS_VALIDAS.includes(valores.certainty)) {
    errores.certainty = 'Selecciona una certeza válida.';
  }

  // 6. headline (10..200 chars, DEBE contener "SIMULACRO")
  const titular = valores.headline.trim();
  if (titular.length < 10) {
    errores.headline = 'El titular debe tener al menos 10 caracteres.';
  } else if (titular.length > 200) {
    errores.headline = 'El titular no puede superar los 200 caracteres.';
  } else if (!titular.toUpperCase().includes('SIMULACRO')) {
    errores.headline = 'El titular DEBE incluir la palabra "SIMULACRO" (requisito de seguridad obligatorio).';
  }

  // 7. description (10..4000 chars)
  const descripcion = valores.description.trim();
  if (descripcion.length < 10) {
    errores.description = 'La descripción debe tener al menos 10 caracteres explicativos.';
  } else if (descripcion.length > 4000) {
    errores.description = 'La descripción no puede superar los 4000 caracteres.';
  }

  // 8. expires (fecha futura válida)
  if (!valores.expires || valores.expires.trim() === '') {
    errores.expires = 'La fecha y hora de vencimiento es obligatoria.';
  } else {
    const fechaExp = Date.parse(valores.expires);
    if (Number.isNaN(fechaExp)) {
      errores.expires = 'La fecha de vencimiento no tiene un formato válido.';
    } else if (fechaExp <= ahoraMs) {
      errores.expires = 'La fecha de vencimiento debe estar en el futuro.';
    }
  }

  // 9. areaDesc (3..200 chars)
  const area = valores.areaDesc.trim();
  if (area.length < 3) {
    errores.areaDesc = 'El área afectada debe tener al menos 3 caracteres.';
  } else if (area.length > 200) {
    errores.areaDesc = 'El área no puede superar los 200 caracteres.';
  }

  const ok = Object.keys(errores).length === 0;

  if (!ok) {
    return { ok: false, errores };
  }

  /** @type {AlertInput} */
  const payload = {
    kind: 'Alert',
    info: {
      scenario: valores.scenario,
      event: evento,
      severity: valores.severity,
      urgency: valores.urgency,
      certainty: valores.certainty,
      headline: titular,
      description: descripcion,
      expires: new Date(Date.parse(valores.expires)).toISOString(),
      areaDesc: area,
    },
    references: [],
  };

  return { ok: true, errores: {}, payload };
}
