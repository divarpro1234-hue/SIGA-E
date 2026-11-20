// Origen del resultado. Falla a lo seguro: solo VERIFICACION_LOCAL, puesto por verificarLocal tras
// llamar a @siga-e/verify, cuenta como verificación real. Cualquier otro valor, o su ausencia, se
// presenta como DEMOSTRACIÓN SIMULADA. No depende de import.meta.env.DEV.

/** @param {{ origen?: unknown } | null | undefined} resultado */
export function esResultadoSimulado(resultado) {
  return resultado?.origen !== 'VERIFICACION_LOCAL';
}

/**
 * @param {string} etiqueta Estado fijo de un resultado.
 * @param {boolean} simulado
 */
export function etiquetaDimension(etiqueta, simulado) {
  return simulado ? `Escenario de prueba: ${etiqueta.toLowerCase()}` : etiqueta;
}
