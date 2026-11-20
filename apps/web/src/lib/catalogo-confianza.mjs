// Validación estricta del catálogo de confianza antes de pasarlo a @siga-e/verify. Solo JWK públicas
// P-256: cualquier miembro privado (d, p, q…) o desconocido rechaza el catálogo entero.

/** Máximo de bytes del catálogo. Un archivo mayor no es un catálogo de claves públicas. */
export const MAX_BYTES_CATALOGO = 65536;

const ESTADOS = new Set(['activa', 'retirada', 'revocada']);
const KID = /^[A-Za-z0-9._:-]{1,64}$/;
const BASE64URL = /^[A-Za-z0-9_-]{1,64}$/;
const MIEMBROS_JWK = new Set(['kty', 'crv', 'x', 'y']);

/** @param {unknown} v */
const esObjeto = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);
/** @param {unknown} v */
const esFecha = (v) => typeof v === 'string' && v.length <= 40 && !Number.isNaN(Date.parse(v));
/** @param {unknown} v */
const fechaOpcional = (v) => v === undefined || v === null || esFecha(v);

/**
 * @typedef {import('@siga-e/verify').CatalogoConfianza} CatalogoConfianza
 * @param {unknown} valor
 * @returns {{ ok: true, catalogo: CatalogoConfianza } | { ok: false }}
 */
export function validarCatalogo(valor) {
  const malo = { ok: /** @type {const} */ (false) };
  if (!esObjeto(valor)) return malo;
  const claves = /** @type {Record<string, unknown>} */ (valor).claves;
  if (!Array.isArray(claves) || claves.length === 0 || claves.length > 32) return malo;
  const vistos = new Set();
  /** @type {CatalogoConfianza['claves'][number][]} */
  const salida = [];
  for (const c of claves) {
    if (!esObjeto(c)) return malo;
    const k = /** @type {Record<string, unknown>} */ (c);
    const { kid, estado, validFrom, revokedAt, retiredAt } = k;
    const jwk = /** @type {Record<string, unknown>} */ (k.publicJwk);
    if (!esObjeto(jwk)) return malo;
    if (typeof kid !== 'string' || !KID.test(kid) || vistos.has(kid)) return malo;
    if (typeof estado !== 'string' || !ESTADOS.has(estado)) return malo;
    if (!esFecha(validFrom) || !fechaOpcional(revokedAt) || !fechaOpcional(retiredAt)) return malo;
    if (Object.keys(jwk).some((m) => !MIEMBROS_JWK.has(m))) return malo;
    if (jwk.kty !== 'EC' || jwk.crv !== 'P-256') return malo;
    if (typeof jwk.x !== 'string' || typeof jwk.y !== 'string') return malo;
    if (!BASE64URL.test(jwk.x) || !BASE64URL.test(jwk.y)) return malo;
    vistos.add(kid);
    salida.push({
      kid,
      estado: /** @type {'activa' | 'retirada' | 'revocada'} */ (estado),
      validFrom: /** @type {string} */ (validFrom),
      ...(typeof revokedAt === 'string' ? { revokedAt } : {}),
      ...(typeof retiredAt === 'string' ? { retiredAt } : {}),
      publicJwk: { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y },
    });
  }
  return { ok: true, catalogo: { claves: salida } };
}

/**
 * SHA-256 en hexadecimal minúsculo de los bytes exactos recibidos.
 * @param {Uint8Array<ArrayBuffer>} bytes
 * @returns {Promise<string>}
 */
export async function huellaSha256(bytes) {
  const resumen = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return Array.from(resumen, (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Interpreta los bytes de un catálogo: tamaño, UTF-8 estricto, JSON y forma.
 * @param {Uint8Array<ArrayBuffer>} bytes
 * @returns {Promise<{ ok: true, catalogo: CatalogoConfianza, huella: string } | { ok: false }>}
 */
export async function interpretarCatalogo(bytes) {
  if (bytes.length === 0 || bytes.length > MAX_BYTES_CATALOGO) return { ok: false };
  let json;
  try {
    json = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    return { ok: false };
  }
  const r = validarCatalogo(json);
  if (!r.ok) return { ok: false };
  return { ok: true, catalogo: r.catalogo, huella: await huellaSha256(bytes) };
}
