// Verificación local de la instantánea de revisión de M2 (D09-2; ADR-006, OpenAPI AlertDetail).
//
// El aprobador decide sobre `reviewSnapshot = { payloadBase64Url, payloadDigestHex }`. Antes de
// mostrar nada como «lo que vas a aprobar», el navegador comprueba por su cuenta que:
//   1. payloadBase64Url es base64url CANÓNICO sin padding (una sola codificación posible por bytes);
//   2. el SHA-256 de esos bytes EXACTOS coincide con payloadDigestHex (64 hex minúsculas);
//   3. los bytes son UTF-8 estricto (sin BOM, sin secuencias inválidas, sin sustitución silenciosa).
// Nunca se parsea y se vuelve a serializar JSON para calcular el digest: se hashean los bytes tal cual
// llegaron. El texto devuelto es la decodificación exacta, sin normalizar; mostrarlo como texto no
// confiable (y, si hace falta, parsear una COPIA solo para presentación) corresponde a otra capa.
//
// Que el digest coincida solo prueba coherencia entre los bytes y el digest recibidos en la misma
// respuesta: no prueba que sean los persistidos (eso lo comprueba el servidor contra payloadSha256),
// ni dice nada de firma ni de blockchain. El digest de aprobación NO es jwsHash.

/** Límite defensivo de la interfaz, no del contrato: ~48 KiB de payload. El contrato no fija máximo. */
export const MAX_CARACTERES_INSTANTANEA = 65536;
export const FORMA_DIGEST = /^[a-f0-9]{64}$/;

const ALFABETO = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const FORMA_BASE64URL = /^[A-Za-z0-9_-]+$/;
/** @type {Map<string, number>} */
const VALOR = new Map([...ALFABETO].map((c, i) => [c, i]));

/**
 * @typedef {'forma' | 'digest-forma' | 'tamano' | 'base64' | 'digest-distinto' | 'utf8' | 'sin-webcrypto'} MotivoInstantanea
 * @typedef {{ ok: true, bytes: Uint8Array, texto: string, digest: string }
 *   | { ok: false, motivo: MotivoInstantanea }} ResultadoInstantanea
 */

/**
 * base64url sin padding de unos bytes.
 * @param {Uint8Array} bytes
 */
export function codificarBase64Url(bytes) {
  /** @param {number} k */
  const b = (k) => bytes[k] ?? 0;
  /** @param {number} n */
  const c = (n) => ALFABETO.charAt(n & 63);
  let salida = '';
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n = (b(i) << 16) | (b(i + 1) << 8) | b(i + 2);
    salida += c(n >> 18) + c(n >> 12) + c(n >> 6) + c(n);
  }
  const resto = bytes.length - i;
  if (resto === 1) {
    const n = b(i) << 16;
    salida += c(n >> 18) + c(n >> 12);
  } else if (resto === 2) {
    const n = (b(i) << 16) | (b(i + 1) << 8);
    salida += c(n >> 18) + c(n >> 12) + c(n >> 6);
  }
  return salida;
}

/**
 * Decodifica base64url canónico sin padding. Rechaza `=`, `+`, `/`, espacios, longitudes imposibles
 * y bits sobrantes distintos de cero (que harían que varios textos codifiquen los mismos bytes).
 * @param {unknown} texto
 * @returns {Uint8Array | null}
 */
export function decodificarBase64UrlCanonico(texto) {
  if (typeof texto !== 'string' || texto.length === 0 || !FORMA_BASE64URL.test(texto)) return null;
  if (texto.length % 4 === 1) return null;
  const bytes = new Uint8Array(Math.floor((texto.length * 3) / 4));
  let acumulado = 0;
  let bits = 0;
  let j = 0;
  for (const c of texto) {
    acumulado = (acumulado << 6) | /** @type {number} */ (VALOR.get(c));
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes[j++] = (acumulado >> bits) & 0xff;
    }
    acumulado &= (1 << bits) - 1;
  }
  // Canonicidad: los bits que sobran al final deben ser cero. La recodificación lo garantiza.
  if (acumulado !== 0 || codificarBase64Url(bytes) !== texto) return null;
  return bytes;
}

const DECODIFICADOR = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

/**
 * UTF-8 estricto: falla ante secuencias inválidas, sobrelargas o sustitutos, y rechaza la marca de
 * orden de bytes inicial (no forma parte de un JSON válido y podría ocultar diferencias).
 * @param {Uint8Array} bytes
 * @returns {string | null}
 */
export function utf8Estricto(bytes) {
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return null;
  try {
    return DECODIFICADOR.decode(bytes);
  } catch {
    return null;
  }
}

/**
 * SHA-256 en hexadecimal minúsculo con WebCrypto (contexto seguro: HTTPS o localhost).
 * @param {Uint8Array} bytes
 * @returns {Promise<string | null>} null si WebCrypto no está disponible
 */
export async function sha256Hex(bytes) {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) return null;
  // Copia propia: el digest se calcula exactamente sobre estos bytes, aunque el original cambie.
  const resumen = new Uint8Array(await subtle.digest('SHA-256', new Uint8Array(bytes)));
  let hex = '';
  for (const b of resumen) hex += b.toString(16).padStart(2, '0');
  return hex;
}

/**
 * Verifica una reviewSnapshot recibida del servidor. Orden: forma → digest declarado → tamaño →
 * base64url canónico → SHA-256 local frente al declarado → UTF-8 estricto.
 * @param {unknown} instantanea
 * @returns {Promise<ResultadoInstantanea>}
 */
export async function verificarInstantanea(instantanea) {
  if (typeof instantanea !== 'object' || instantanea === null || Array.isArray(instantanea)) return { ok: false, motivo: 'forma' };
  const claves = Object.keys(instantanea);
  // additionalProperties: false en el contrato.
  if (claves.length !== 2 || !claves.includes('payloadBase64Url') || !claves.includes('payloadDigestHex')) {
    return { ok: false, motivo: 'forma' };
  }
  const { payloadBase64Url, payloadDigestHex } = /** @type {Record<string, unknown>} */ (instantanea);
  if (typeof payloadDigestHex !== 'string' || !FORMA_DIGEST.test(payloadDigestHex)) return { ok: false, motivo: 'digest-forma' };
  if (typeof payloadBase64Url !== 'string') return { ok: false, motivo: 'forma' };
  if (payloadBase64Url.length > MAX_CARACTERES_INSTANTANEA) return { ok: false, motivo: 'tamano' };
  const bytes = decodificarBase64UrlCanonico(payloadBase64Url);
  if (!bytes) return { ok: false, motivo: 'base64' };
  const digest = await sha256Hex(bytes);
  if (digest === null) return { ok: false, motivo: 'sin-webcrypto' };
  if (digest !== payloadDigestHex) return { ok: false, motivo: 'digest-distinto' };
  const texto = utf8Estricto(bytes);
  if (texto === null) return { ok: false, motivo: 'utf8' };
  return { ok: true, bytes, texto, digest };
}
