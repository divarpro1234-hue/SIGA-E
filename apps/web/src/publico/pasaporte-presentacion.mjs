/**
 * @param {'verificando' | 'no-comprobable' | 'verificado'} fase
 * @param {'VALIDA' | 'INVALIDA' | 'CLAVE_DESCONOCIDA' | 'CLAVE_REVOCADA' | 'FUERA_DE_POLITICA' | null} [firma]
 * @returns {string}
 */
export function mensajeEstadoFirma(fase, firma = null) {
  if (fase === 'verificando') return 'Verificando la firma localmente con el catálogo de confianza de este dispositivo…';
  if (fase === 'no-comprobable') return 'Firma no comprobable: no se pudo completar la verificación local.';
  switch (firma) {
    case 'VALIDA':
      return 'Firma válida según la verificación criptográfica local.';
    case 'INVALIDA':
      return 'Firma inválida: el contenido no coincide con su firma.';
    case 'CLAVE_DESCONOCIDA':
      return 'Firma no comprobable: la clave no está en el catálogo de confianza local.';
    case 'CLAVE_REVOCADA':
      return 'Firma no válida: la clave figura como revocada en el catálogo local.';
    case 'FUERA_DE_POLITICA':
      return 'Firma fuera de política: no se considera válida.';
    default:
      return 'La firma todavía no se ha verificado.';
  }
}

/**
 * @param {'uuid-invalido' | 'no-encontrada' | 'no-disponible' | 'error' | 'respuesta-invalida'} motivo
 * @returns {string}
 */
export function mensajeErrorPasaporte(motivo) {
  switch (motivo) {
    case 'uuid-invalido':
      return 'El identificador de la alerta no tiene un formato UUID válido. No se realizó ninguna consulta.';
    case 'no-encontrada':
      return 'La alerta no se encontró. Puede no estar publicada o ya no estar disponible.';
    case 'no-disponible':
      return 'El servicio público no está disponible en este momento.';
    case 'respuesta-invalida':
      return 'La API devolvió una respuesta inválida. No se mostrarán datos no verificables.';
    case 'error':
      return 'No fue posible conectar con el servicio público.';
  }
}

export function avisoBlockchainNoComprobable() {
  return 'Estado blockchain: NO_COMPROBABLE. Esta PWA no consulta Soroban; los metadatos del backend no son una comprobación independiente.';
}
