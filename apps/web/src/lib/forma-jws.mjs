// Validación local de FORMA de un JWS compacto pegado o cargado (brief §3): tamaño máximo y tres
// segmentos base64url. No verifica firma ni decodifica nada: eso es de packages/verify (P11).
// La cadena aceptada se devuelve idéntica a la recibida: sin trim, sin normalizar y sin reconstruir
// sus segmentos (ENM-002 §6). Un espacio o salto de línea en cualquier posición se rechaza.

/** Tamaño máximo en caracteres: el mismo que aplica @siga-e/verify y OpenAPI (jwsCompact, P21). */
export const MAX_CARACTERES_JWS = 32768;

// \s de JavaScript cubre espacios Unicode, tabulaciones, saltos de línea y la marca de orden de bytes.
const ESPACIO = /\s/;
const SEGMENTO = /^[A-Za-z0-9_-]+$/;

/** @typedef {'vacio' | 'espacios' | 'segmentos' | 'caracteres' | 'grande'} MotivoForma */
/** @typedef {{ ok: true, jws: string } | { ok: false, motivo: MotivoForma }} ResultadoForma */

/**
 * @param {unknown} entrada
 * @returns {ResultadoForma}
 */
export function validarFormaJws(entrada) {
  if (typeof entrada !== 'string') return { ok: false, motivo: 'vacio' };
  // Se comprueba el tamaño antes de recorrer o dividir nada.
  if (entrada.length > MAX_CARACTERES_JWS) return { ok: false, motivo: 'grande' };
  // Solo espacios equivale a no haber pegado nada; no se recorta para decidirlo.
  if (!/\S/.test(entrada)) return { ok: false, motivo: 'vacio' };
  if (ESPACIO.test(entrada)) return { ok: false, motivo: 'espacios' };
  const partes = entrada.split('.');
  if (partes.length !== 3 || partes.some((p) => p.length === 0)) return { ok: false, motivo: 'segmentos' };
  if (!partes.every((p) => SEGMENTO.test(p))) return { ok: false, motivo: 'caracteres' };
  return { ok: true, jws: entrada };
}
