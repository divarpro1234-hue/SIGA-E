import { PassThrough, type Readable, type Writable } from "node:stream";
import { emitKeypressEvents, type Key } from "node:readline";
import { randomBytes } from "node:crypto";

import { normalizePassword } from "../src/modules/identity/password.js";

type TtyInput = Readable & { isRaw?: boolean; setRawMode(mode: boolean): unknown };

export class LabInputError extends Error {
  override readonly name = "LabInputError";
  constructor(readonly code: string) { super(code); }
}

export function createLabPrompt(input: TtyInput, output: Writable) {
  // Un CR puede llegar separado de su LF. La siguiente pregunta descarta solo ese LF.
  let discardLfAfterCr = false;
  let hasAnswered = false;

  const readLine = (label: string, secret = false, challenge = ""): Promise<string> => new Promise((resolve, reject) => {
    const keyStream = new PassThrough();
    emitKeypressEvents(keyStream);
    const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
    const previousRaw = Boolean(input.isRaw);
    const answer: string[] = [];
    const prefix = challenge ? `${challenge} ` : "";
    let prefixIndex = 0;
    let finished = false;
    let inPaste = false;

    const cleanup = () => {
      input.off("data", onData);
      input.off("end", onEnd);
      input.off("error", onError);
      keyStream.removeAllListeners();
      keyStream.destroy();
      try { input.pause(); }
      finally { input.setRawMode(previousRaw); }
    };
    const settle = (value: string | null, error?: LabInputError) => {
      if (finished) return;
      finished = true;
      try {
        cleanup();
      } catch {
        reject(new LabInputError("LAB_INPUT_CLOSED"));
        return;
      }
      if (error) reject(error);
      else resolve(value!);
    };
    const onEnd = () => settle(null, new LabInputError("LAB_INPUT_CLOSED"));
    const onError = () => settle(null, new LabInputError("LAB_INPUT_CLOSED"));
    const onData = (chunk: Buffer) => {
      try { decoder.decode(chunk, { stream: true }); }
      catch { settle(null, new LabInputError("LAB_INPUT_INVALID")); return; }
      // Un pegado con texto después de Enter no debe confirmar solo su prefijo.
      const start = discardLfAfterCr && chunk[0] === 10 ? 1 : 0;
      for (let index = start; index < chunk.length; index++) {
        if (chunk[index] !== 13 && chunk[index] !== 10) continue;
        const rest = chunk.subarray(index + 1);
        if (rest.length > 0 && !(chunk[index] === 13 && rest.length === 1 && rest[0] === 10)) {
          settle(null, new LabInputError("LAB_INPUT_INVALID"));
          return;
        }
        break;
      }
      try { keyStream.write(chunk); }
      catch { settle(null, new LabInputError("LAB_INPUT_INVALID")); }
    };
    const handleKeypress = (char: string | undefined, key: Key) => {
      if (finished) return;
      if (discardLfAfterCr) {
        discardLfAfterCr = false;
        if (key.name === "enter" && key.sequence === "\n") return;
      }
      if (key.ctrl && key.name === "c") {
        settle(null, new LabInputError("LAB_CANCELLED"));
        return;
      }
      if (key.name === "paste-start") {
        if (inPaste || prefixIndex < prefix.length) settle(null, new LabInputError("LAB_INPUT_INVALID"));
        else inPaste = true;
        return;
      }
      if (key.name === "paste-end") {
        if (!inPaste) settle(null, new LabInputError("LAB_INPUT_INVALID"));
        else inPaste = false;
        return;
      }
      if (key.name === "return" || key.name === "enter") {
        if (inPaste || prefixIndex < prefix.length) {
          settle(null, new LabInputError("LAB_INPUT_INVALID"));
          return;
        }
        try { decoder.decode(); }
        catch { settle(null, new LabInputError("LAB_INPUT_INVALID")); return; }
        discardLfAfterCr = key.name === "return";
        output.write("\n");
        settle(answer.join(""));
        return;
      }
      if (key.name === "backspace" || key.name === "delete") {
        if (answer.length > 0) {
          answer.pop();
          if (!secret) output.write("\b \b");
        } else if (prefixIndex > 0) prefixIndex--;
        return;
      }
      if (!char || key.ctrl || key.meta || /[\u0000-\u001f\u007f\u001b]/u.test(char) ||
          Array.from(char).length !== 1 || answer.length >= 512 ||
          (key.name && char !== key.sequence)) {
        settle(null, new LabInputError("LAB_INPUT_INVALID"));
        return;
      }
      if (prefixIndex < prefix.length) {
        if (char !== prefix[prefixIndex]) {
          settle(null, new LabInputError("LAB_INPUT_INVALID"));
          return;
        }
        prefixIndex++;
        return;
      }
      answer.push(char);
      if (!secret) output.write(char);
    };
    const onKeypress = (char: string | undefined, key: Key) => {
      try { handleKeypress(char, key); }
      catch { settle(null, new LabInputError("LAB_INPUT_CLOSED")); }
    };

    try {
      keyStream.on("keypress", onKeypress);
      output.write(label);
      input.setRawMode(true);
      input.on("data", onData);
      input.on("end", onEnd);
      input.on("error", onError);
      input.resume();
    } catch {
      settle(null, new LabInputError("LAB_INPUT_CLOSED"));
    }
  });

  return async (label: string, secret = false): Promise<string> => {
    if (hasAnswered) {
      // El prefijo se crea después de la respuesta anterior. Un pegado pendiente
      // no puede anticiparlo ni convertirse en la siguiente respuesta.
      const code = randomBytes(8).toString("hex").toUpperCase();
      const value = await readLine(`${label}Escriba ${code} y un espacio antes del valor: `, secret, code);
      hasAnswered = true;
      return value;
    }
    const value = await readLine(label, secret);
    hasAnswered = true;
    return value;
  };
}

export async function promptNewPassword(prompt: ReturnType<typeof createLabPrompt>): Promise<string> {
  const password = await prompt("Contraseña individual: ", true);
  try { normalizePassword(password); }
  catch { throw new LabInputError("LAB_PASSWORD_INVALID"); }
  const confirmation = await prompt("Confirme contraseña individual: ", true);
  if (confirmation !== password) throw new LabInputError("LAB_PASSWORD_MISMATCH");
  return password;
}
