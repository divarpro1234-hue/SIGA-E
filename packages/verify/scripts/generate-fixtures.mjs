import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { CompactSign, exportJWK, generateKeyPair } from "jose";

import { calcularJwsHash } from "../dist/index.js";

const directory = fileURLToPath(new URL("../fixtures/", import.meta.url));
const ahora = "2026-10-09T12:30:00Z";
const sent = "2026-10-09T12:00:00Z";
const encoder = new TextEncoder();
const payload = (expires) => ({
  sender: "urn:siga-e:simulacro",
  identifier: "SIGAE-FIXTURE-0001",
  sent,
  status: "Exercise",
  scope: "Public",
  msgType: "Alert",
  info: {
    scenario: "SISMO",
    event: "Simulacro de sismo",
    severity: "Moderate",
    urgency: "Immediate",
    certainty: "Likely",
    headline: "SIMULACRO: aviso ficticio de sismo",
    description: "Ejercicio académico; no es una alerta real.",
    expires,
    areaDesc: "Sector ficticio A",
  },
});
const hex = (bytes) => Buffer.from(bytes).toString("hex");
const save = (name, value) => writeFile(`${directory}${name}`, `${JSON.stringify(value, null, 2)}\n`, { flag: "w" });

await mkdir(directory, { recursive: true });
// La clave privada permanece como CryptoKey en memoria. Solo se exporta la JWK pública.
const active = await generateKeyPair("ES256");
const revoked = await generateKeyPair("ES256");
const unknown = await generateKeyPair("ES256");
const keys = [
  { kid: "fixture-active-2026", estado: "activa", validFrom: "2026-10-01T00:00:00Z", publicJwk: await exportJWK(active.publicKey) },
  { kid: "fixture-revoked-2026", estado: "revocada", validFrom: "2026-10-01T00:00:00Z", revokedAt: "2026-10-09T12:15:00Z", publicJwk: await exportJWK(revoked.publicKey) },
];
const sign = (body, key, kid) => new CompactSign(encoder.encode(JSON.stringify(body)))
  .setProtectedHeader({ alg: "ES256", kid }).sign(key);
const valid = await sign(payload("2026-10-09T13:00:00Z"), active.privateKey, keys[0].kid);
const parts = valid.split(".");
const changedPayload = { ...payload("2026-10-09T13:00:00Z"), identifier: "SIGAE-FIXTURE-TAMPERED" };
const altered = `${parts[0]}.${Buffer.from(JSON.stringify(changedPayload)).toString("base64url")}.${parts[2]}`;
const cases = [
  ["valid-current", valid, "VALIDA", "VIGENTE", keys[0].kid],
  ["tampered", altered, "INVALIDA", "DESCONOCIDA", keys[0].kid],
  ["expired", await sign(payload("2026-10-09T12:20:00Z"), active.privateKey, keys[0].kid), "VALIDA", "VENCIDA", keys[0].kid],
  ["revoked", await sign(payload("2026-10-09T13:00:00Z"), revoked.privateKey, keys[1].kid), "CLAVE_REVOCADA", "DESCONOCIDA", keys[1].kid],
  ["unknown-kid", await sign(payload("2026-10-09T13:00:00Z"), unknown.privateKey, "fixture-unknown-2026"), "CLAVE_DESCONOCIDA", "DESCONOCIDA", "fixture-unknown-2026"],
];
const manifest = {
  ahora,
  uso: "verificarJws(fixture.jws, catalogo, new Date(manifest.ahora))",
  fixtures: await Promise.all(cases.map(async ([name, jws, firma, vigencia, kid]) => {
    await save(`${name}.json`, { jws });
    return { name, file: `${name}.json`, firma, vigencia, kid, jwsHash: hex(await calcularJwsHash(jws)) };
  })),
};
await save("catalogo.json", { claves: keys });
await save("manifest.json", manifest);
