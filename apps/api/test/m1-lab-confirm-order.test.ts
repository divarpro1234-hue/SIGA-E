import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(new URL("../scripts/m1-lab.ts", import.meta.url));

describe("flujo confirm de la CLI M1", () => {
  it("captura ambos TOTP al final y llama al servicio inmediatamente después del TOTP ADMIN", () => {
    const source = readFileSync(scriptPath, "utf8");
    const confirmBranch = source.slice(source.indexOf('command === "confirm"'), source.indexOf('} else {', source.indexOf('command === "confirm"')));
    const order = [
      'ask("Correo de la cuenta pendiente: ")',
      'ask("Correo del ADMIN activo: ")',
      'prompt("Contraseña del ADMIN: ", true)',
      'prompt("Token de invitación: ", true)',
      'prompt("Token de enrolamiento: ", true)',
      'prompt("Código TOTP de la cuenta pendiente: ", true)',
      'prompt("Código TOTP del ADMIN: ", true)',
      "service.confirm(email, code, invitationToken, enrollmentToken",
    ].map((fragment) => confirmBranch.indexOf(fragment));

    expect(order.every((index) => index >= 0)).toBe(true);
    expect(order).toEqual([...order].sort((left, right) => left - right));
    expect(confirmBranch.slice(order[6], order[7])).toContain("const success = await");
  });
});
