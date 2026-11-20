import { describe, expect, it } from "vitest";

import {
  bytesToLowerHex,
  calculateJwsHash,
  calculateMessageKey,
} from "../../src/modules/signing/index.js";

describe("identificadores SHA-256 de SIGA-E", () => {
  it("coincide con el vector independiente de jws_hash y produce 32 bytes", () => {
    const digest = calculateJwsHash("aaa.bbb.ccc");

    expect(digest).toHaveLength(32);
    expect(bytesToLowerHex(digest)).toBe(
      "ce887a8eece06ba329c188b9cf872bd8a70a0c354275fe3c435450024784c9de",
    );
  });

  it("coincide con el vector independiente de message_key y conserva sent textual", () => {
    const digest = calculateMessageKey({
      sender: "urn:siga-e:simulacro",
      identifier: "SIGAE-2026-0001",
      sent: "2026-10-09T12:34:56-04:00",
    });

    expect(digest).toHaveLength(32);
    expect(bytesToLowerHex(digest)).toBe(
      "22bbe621f0bab63eda60e623c0fd80b4b5151cefda73f35d78882431486a2c77",
    );
  });

  it.each(["sender", "identifier", "sent"] as const)(
    "rechaza CR o LF en %s",
    (field) => {
      expect(() =>
        calculateMessageKey({
          sender: field === "sender" ? "emisor\ninyectado" : "emisor",
          identifier: field === "identifier" ? "id\rinyectado" : "id",
          sent: field === "sent" ? "fecha\ninyectada" : "fecha",
        }),
      ).toThrow(/sin CR ni LF/u);
    },
  );

  it("rechaza entradas JWS no ASCII o con estructura distinta", () => {
    expect(() => calculateJwsHash("á.b.c")).toThrow();
    expect(() => calculateJwsHash("a.b.c.d")).toThrow();
  });
});
