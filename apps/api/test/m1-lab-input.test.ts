import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";

import { createLabPrompt, promptNewPassword } from "../scripts/m1-lab-input.js";

function fakeTerminal() {
  const input = Object.assign(new PassThrough(), {
    isRaw: false,
    setRawMode(mode: boolean) { this.isRaw = mode; return this; },
  });
  const output = new PassThrough();
  let shown = "";
  output.on("data", (chunk: Buffer) => { shown += String(chunk); });
  return { input, output, prompt: createLabPrompt(input, output), shown: () => shown };
}

function assertClean(tty: ReturnType<typeof fakeTerminal>, previousRaw = false) {
  expect(tty.input.isRaw).toBe(previousRaw);
  expect(tty.input.listenerCount("data")).toBe(0);
  expect(tty.input.listenerCount("end")).toBe(0);
  expect(tty.input.listenerCount("error")).toBe(0);
}

function currentChallenge(tty: ReturnType<typeof fakeTerminal>): string {
  const matches = [...tty.shown().matchAll(/Escriba ([0-9A-F]{16}) y un espacio antes del valor: /gu)];
  const code = matches.at(-1)?.[1];
  expect(code).toMatch(/^[0-9A-F]{16}$/u);
  return code!;
}

describe("lector TTY local M1", () => {
  it("acepta pegado delimitado y no muestra una contraseña ficticia", async () => {
    const tty = fakeTerminal();
    const answer = tty.prompt("Clave: ", true);
    for (const byte of Buffer.from("\u001b[200~Frase ficticia 2026\u001b[201~")) {
      tty.input.write(Buffer.from([byte]));
    }
    tty.input.write("\r");
    expect(await answer).toBe("Frase ficticia 2026");
    expect(tty.shown()).toBe("Clave: \n");
    assertClean(tty);
  });

  it("borra el último carácter con Backspace y Delete sin añadir secuencias ANSI", async () => {
    const tty = fakeTerminal();
    const answer = tty.prompt("Clave: ", true);
    tty.input.write("PruebaX\u007fY\u001b[3~Z\r");
    expect(await answer).toBe("PruebaZ");
  });

  it("descarta LF residual aunque CR y LF lleguen en bloques separados", async () => {
    const tty = fakeTerminal();
    const first = tty.prompt("Uno: ");
    tty.input.write("primero\r");
    expect(await first).toBe("primero");
    const second = tty.prompt("Dos: ");
    tty.input.write(`\n${currentChallenge(tty)} segundo\r`);
    expect(await second).toBe("segundo");
  });

  it("decodifica UTF-8 fragmentado y borra un carácter Unicode completo", async () => {
    const tty = fakeTerminal();
    const answer = tty.prompt("Clave: ", true);
    const bytes = Buffer.from("A🙂");
    for (const byte of bytes) tty.input.write(Buffer.from([byte]));
    tty.input.write("\u007f");
    const accented = Buffer.from("é");
    for (const byte of accented) tty.input.write(Buffer.from([byte]));
    tty.input.write("\r");
    expect(await answer).toBe("Aé");
    expect(tty.shown()).toBe("Clave: \n");
  });

  it("rechaza UTF-8 malformado y secuencias incompletas sin sustitución", async () => {
    for (const chunks of [
      [Buffer.from([0xc3, 0x28])],
      [Buffer.from([0xc3]), Buffer.from([0x28])],
      [Buffer.from([0xf0, 0x9f]), Buffer.from("\r")],
      [Buffer.from([0xc0, 0xaf])],
    ]) {
      const tty = fakeTerminal();
      const answer = tty.prompt("Clave: ", true);
      for (const chunk of chunks) tty.input.write(chunk);
      await expect(answer).rejects.toMatchObject({ code: "LAB_INPUT_INVALID", message: "LAB_INPUT_INVALID" });
      expect(tty.shown()).toBe("Clave: ");
      assertClean(tty);
    }
  });

  it("rechaza un pegado residual repartido entre preguntas antes de la confirmación", async () => {
    const tty = fakeTerminal();
    const first = tty.prompt("Contraseña individual: ", true);
    tty.input.write("Frase ficticia extensa 2026\r");
    expect(await first).toBe("Frase ficticia extensa 2026");

    const confirmation = tty.prompt("Confirme contraseña individual: ", true);
    expect(currentChallenge(tty)).toHaveLength(16);
    tty.input.write("Frase ficticia extensa 2026\r");
    await expect(confirmation).rejects.toMatchObject({ code: "LAB_INPUT_INVALID" });
    expect(tty.shown()).not.toContain("Frase ficticia extensa 2026");
    assertClean(tty);
  });

  it("exige el desafío nuevo y rechaza su pegado delimitado", async () => {
    const tty = fakeTerminal();
    const first = tty.prompt("Uno: ", true);
    tty.input.write("ficticio\r");
    await first;
    const second = tty.prompt("Dos: ", true);
    const code = currentChallenge(tty);
    tty.input.write(`\u001b[200~${code} ficticio\u001b[201~\r`);
    await expect(second).rejects.toMatchObject({ code: "LAB_INPUT_INVALID" });
    assertClean(tty);
  });

  it("rechaza un código de desafío incorrecto repartido en bloques", async () => {
    const tty = fakeTerminal();
    const first = tty.prompt("Uno: ", true);
    tty.input.write("ficticio\r");
    await first;
    const second = tty.prompt("Dos: ", true);
    const code = currentChallenge(tty);
    const wrong = `${code.slice(0, -1)}${code.endsWith("0") ? "1" : "0"}`;
    tty.input.write(wrong.slice(0, 8));
    tty.input.write(`${wrong.slice(8)} ficticio\r`);
    await expect(second).rejects.toMatchObject({ code: "LAB_INPUT_INVALID" });
    expect(tty.shown()).not.toContain("ficticio");
    assertClean(tty);
  });

  it("cancela durante el prefijo de desafío y restaura el TTY", async () => {
    const tty = fakeTerminal();
    const first = tty.prompt("Uno: ", true);
    tty.input.write("ficticio\r");
    await first;
    const second = tty.prompt("Dos: ", true);
    currentChallenge(tty);
    tty.input.write("\u0003");
    await expect(second).rejects.toMatchObject({ code: "LAB_CANCELLED" });
    assertClean(tty);
  });

  it("confirma una contraseña ficticia solo tras el desafío nuevo y sin eco", async () => {
    const tty = fakeTerminal();
    const password = "Frase ficticia extensa 2026";
    const result = promptNewPassword(tty.prompt);
    tty.input.write(`${password}\r`);
    await vi.waitFor(() => expect(tty.shown()).toContain("Escriba "));
    tty.input.write(`${currentChallenge(tty)} `);
    tty.input.write(`\u001b[200~${password}\u001b[201~\r`);
    await expect(result).resolves.toBe(password);
    expect(tty.shown()).not.toContain(password);
    assertClean(tty);
  });

  it("restaura el modo TTY aunque falle pause durante la limpieza", async () => {
    const tty = fakeTerminal();
    const originalPause = tty.input.pause.bind(tty.input);
    tty.input.pause = () => { originalPause(); throw new Error("fallo ficticio"); };
    const answer = tty.prompt("Clave: ", true);
    tty.input.write("ficticio\r");
    await expect(answer).rejects.toMatchObject({ code: "LAB_INPUT_CLOSED" });
    assertClean(tty);
  });

  it("rechaza controles desconocidos, Enter dentro de pegado y Ctrl+C; restaura TTY", async () => {
    for (const [data, code] of [
      ["A\u001b[D", "LAB_INPUT_INVALID"],
      ["\u001b[200~A\r", "LAB_INPUT_INVALID"],
      ["Frase ficticia 2026\rSOBRA", "LAB_INPUT_INVALID"],
      ["A\u0003", "LAB_CANCELLED"],
    ]) {
      const tty = fakeTerminal();
      const answer = tty.prompt("Clave: ", true);
      tty.input.write(data);
      await expect(answer).rejects.toMatchObject({ code });
      assertClean(tty);
    }
  });

  it("restaura el modo previo y retira listeners ante cierre o error del stream", async () => {
    for (const event of ["end", "error"] as const) {
      const tty = fakeTerminal();
      tty.input.isRaw = true;
      const answer = tty.prompt("Clave: ", true);
      if (event === "end") tty.input.emit("end");
      else tty.input.emit("error", new Error("fallo ficticio"));
      await expect(answer).rejects.toMatchObject({ code: "LAB_INPUT_CLOSED" });
      assertClean(tty, true);
    }
  });

  it("sanea contraseña inválida y discrepancia antes de aprovisionar", async () => {
    const invalid = vi.fn().mockResolvedValueOnce("corta");
    await expect(promptNewPassword(invalid)).rejects.toMatchObject({ code: "LAB_PASSWORD_INVALID" });
    expect(invalid).toHaveBeenCalledTimes(1);
    const mismatch = vi.fn().mockResolvedValueOnce("Frase ficticia extensa 2026")
      .mockResolvedValueOnce("Frase ficticia distinta 2026");
    await expect(promptNewPassword(mismatch)).rejects.toMatchObject({ code: "LAB_PASSWORD_MISMATCH" });
    expect(mismatch).toHaveBeenCalledTimes(2);
    const accepted = vi.fn().mockResolvedValue("Frase ficticia extensa 2026");
    await expect(promptNewPassword(accepted)).resolves.toBe("Frase ficticia extensa 2026");
    expect(accepted).toHaveBeenCalledTimes(2);
  });
});
