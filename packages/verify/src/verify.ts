import { compactVerify, decodeProtectedHeader, importJWK } from "jose";

import { calcularJwsHash, compactJwsPattern, hexMinusculas } from "./hashes.js";
import { parseTimestamp, validarPoliticaPayload } from "./policy.js";
import type { CatalogoConfianza, ClavePublicaConfiable, ResultadoFirma } from "./types.js";

const maxJwsLength = 32768;
const allowedHeaderNames = new Set(["alg", "kid"]);
const base64urlPattern = /^[A-Za-z0-9_-]{43}$/u;
const privateJwkNames = new Set(["d", "p", "q", "dp", "dq", "qi", "oth", "k"]);
const utf8Decoder = new TextDecoder("utf-8", { fatal: true });

function resultado(
  firma: ResultadoFirma["firma"],
  kid: string | null = null,
  jwsHash: string | null = null,
  vigencia: ResultadoFirma["vigencia"] = "DESCONOCIDA",
  payload: unknown | null = null,
): ResultadoFirma {
  return { firma, vigencia, kid, jwsHash, payload: firma === "VALIDA" ? payload : null };
}

function publicKeyIsUsable(entry: ClavePublicaConfiable): boolean {
  const jwk = entry.publicJwk;
  if (jwk === null || typeof jwk !== "object") return false;
  const material = jwk as Record<string, unknown>;
  if (Object.keys(material).some((name) => privateJwkNames.has(name))) return false;
  return material.kty === "EC" && material.crv === "P-256" &&
    typeof material.x === "string" && base64urlPattern.test(material.x) &&
    typeof material.y === "string" && base64urlPattern.test(material.y) &&
    (material.alg === undefined || material.alg === "ES256");
}

function allowedByKeyDates(entry: ClavePublicaConfiable, sentMs: number): boolean {
  const validFrom = parseTimestamp(entry.validFrom);
  if (validFrom === null || sentMs < validFrom) return false;
  if (entry.estado === "activa") return entry.retiredAt == null && entry.revokedAt == null;
  if (entry.estado === "retirada") {
    const retiredAt = parseTimestamp(entry.retiredAt);
    return retiredAt !== null && retiredAt > validFrom && sentMs < retiredAt && entry.revokedAt == null;
  }
  return false;
}

/**
 * Verifica únicamente con claves que el llamador ya estableció como confiables.
 * No consulta red, RPC, JWKS ni el reloj del sistema. Errores esperados devuelven
 * un resultado estable y nunca exponen el payload como alerta validada.
 */
export async function verificarJws(
  jws: string,
  confianza: CatalogoConfianza,
  ahora: Date,
): Promise<ResultadoFirma> {
  let kid: string | null = null;
  let jwsHash: string | null = null;
  try {
    if (typeof jws !== "string" || jws.length > maxJwsLength || !compactJwsPattern.test(jws)) {
      return resultado("INVALIDA");
    }
    jwsHash = hexMinusculas(await calcularJwsHash(jws));
    const header = decodeProtectedHeader(jws);
    if (header.alg !== "ES256" || typeof header.kid !== "string" || header.kid.length === 0 ||
        Object.keys(header).some((name) => !allowedHeaderNames.has(name))) {
      return resultado("INVALIDA", null, jwsHash);
    }
    kid = header.kid;
    if (!confianza || !Array.isArray(confianza.claves)) return resultado("CLAVE_DESCONOCIDA", kid, jwsHash);
    const matches = confianza.claves.filter((entry) => entry && entry.kid === kid);
    if (matches.length !== 1) return resultado("CLAVE_DESCONOCIDA", kid, jwsHash);
    const entry = matches[0];
    if (entry === undefined || !publicKeyIsUsable(entry)) return resultado("FUERA_DE_POLITICA", kid, jwsHash);

    // Incluso una clave revocada debe superar esta comprobación antes de clasificarse.
    const key = await importJWK(entry.publicJwk, "ES256");
    const verified = await compactVerify(jws, key, { algorithms: ["ES256"] });
    if (entry.estado === "revocada") return resultado("CLAVE_REVOCADA", kid, jwsHash);

    // El JSON del payload se interpreta solo después de verificar criptográficamente.
    let parsed: unknown;
    try {
      parsed = JSON.parse(utf8Decoder.decode(verified.payload));
    } catch {
      return resultado("FUERA_DE_POLITICA", kid, jwsHash);
    }
    const policy = validarPoliticaPayload(parsed);
    if (policy === null || !allowedByKeyDates(entry, policy.sentMs)) {
      return resultado("FUERA_DE_POLITICA", kid, jwsHash);
    }
    const nowMs = ahora instanceof Date ? ahora.getTime() : NaN;
    const vigencia = !Number.isFinite(nowMs) || nowMs < policy.sentMs
      ? "DESCONOCIDA"
      : nowMs >= policy.expiresMs ? "VENCIDA" : "VIGENTE";
    return resultado("VALIDA", kid, jwsHash, vigencia, policy.alerta);
  } catch {
    return resultado("INVALIDA", kid, jwsHash);
  }
}
