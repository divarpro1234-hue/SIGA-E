const compactJwsPattern = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u;
const lineBreakPattern = /[\r\n]/u;
const messageKeyDomain = "SIGA-E-ALERT-ID-v1";
const encoder = new TextEncoder();

export { compactJwsPattern };

async function sha256(bytes: Uint8Array): Promise<Uint8Array> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return new Uint8Array(digest);
}

/** SHA-256(ASCII(jws_compact)); devuelve los mismos 32 bytes que Prompt 03. */
export function calcularJwsHash(jws: string): Promise<Uint8Array> {
  if (!compactJwsPattern.test(jws)) {
    throw new TypeError("El JWS debe tener tres segmentos base64url ASCII no vacíos.");
  }
  return sha256(encoder.encode(jws));
}

/** SHA-256(UTF8("SIGA-E-ALERT-ID-v1\n" + sender + "\n" + identifier + "\n" + sent)). */
export function calcularMessageKey(
  sender: string,
  identifier: string,
  sent: string,
): Promise<Uint8Array> {
  const fields = [sender, identifier, sent];
  if (fields.some((field) => typeof field !== "string" || field.length === 0 || lineBreakPattern.test(field))) {
    throw new TypeError("sender, identifier y sent deben ser textos no vacíos sin CR ni LF.");
  }
  return sha256(encoder.encode(`${messageKeyDomain}\n${sender}\n${identifier}\n${sent}`));
}

export function hexMinusculas(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}
