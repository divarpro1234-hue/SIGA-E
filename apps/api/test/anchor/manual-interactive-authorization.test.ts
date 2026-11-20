import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { askExact } from "../../scripts/manual-soroban-testnet-anchor.js";

function terminal() {
  const input = Object.assign(new PassThrough(), { isTTY: true }) as unknown as typeof process.stdin;
  const output = Object.assign(new PassThrough(), { isTTY: true }) as unknown as typeof process.stdout;
  return { input, output, close: () => { input.destroy(); output.destroy(); } };
}

async function answer(value: string | null, challenge: string,
  options: { readonly signal?: AbortSignal; readonly timeoutMs?: number } = {}): Promise<boolean> {
  const io = terminal();
  try {
    const result = askExact(challenge, "prueba local", { ...io, ...options });
    await new Promise<void>((resolve) => setImmediate(resolve));
    if (value === null) io.input.push(null);
    else io.input.write(`${value}\n`);
    return await result;
  } finally { io.close(); }
}

describe("confirmaciones interactivas exactas con TTY simulado", () => {
  const declaration = "AUTORIZACIÓN EXTERNA CONFIRMADA PARA UNA TX TESTNET";
  const hash = "ab".repeat(32);
  const transaction = `AUTORIZO UNA TX TESTNET ${hash}`;

  it("acepta dos preguntas consecutivas con la segunda frase completa", async () => {
    const io = terminal();
    try {
      const first = askExact(declaration, "primera", io);
      await new Promise<void>((resolve) => setImmediate(resolve));
      io.input.write(`${declaration}\n`);
      expect(await first).toBe(true);
      const second = askExact(transaction, "segunda", io);
      await new Promise<void>((resolve) => setImmediate(resolve));
      io.input.write(`${transaction}\n`);
      expect(await second).toBe(true);
    } finally { io.close(); }
  });

  it("rechaza segunda respuesta vacía o con hash distinto", async () => {
    expect(await answer(declaration, declaration)).toBe(true);
    expect(await answer("", transaction)).toBe(false);
    expect(await answer(`AUTORIZO UNA TX TESTNET ${"cd".repeat(32)}`, transaction)).toBe(false);
  });

  it("inicia un plazo nuevo después de una preparación simulada prolongada", async () => {
    expect(await answer(declaration, declaration)).toBe(true);
    await new Promise<void>((resolve) => setTimeout(resolve, 30));
    expect(await answer(transaction, transaction, { timeoutMs: 1000 })).toBe(true);
  });

  it("rechaza timeout de autorización, EOF y cancelación", async () => {
    const timed = terminal();
    try {
      await expect(askExact(transaction, "prueba local", { ...timed, timeoutMs: 10 }))
        .resolves.toBe(false);
    } finally { timed.close(); }
    expect(await answer(null, transaction)).toBe(false);
    const cancelled = new AbortController();
    cancelled.abort();
    expect(await answer(transaction, transaction, { signal: cancelled.signal })).toBe(false);
  });

  it("no reutiliza la primera aprobación para una transacción posterior", async () => {
    expect(await answer(declaration, declaration)).toBe(true);
    const controller = new AbortController();
    const io = terminal();
    try {
      const pending = askExact(transaction, "prueba local", { ...io, signal: controller.signal });
      controller.abort();
      await expect(pending).resolves.toBe(false);
    } finally { io.close(); }
  });
});
