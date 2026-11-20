import { describe, expect, it } from "vitest";
import { bytesEqual } from "./bytes-equal.js";

describe("comparación binaria exacta del harness M2 HTTP", () => {
  it("acepta Buffer y Uint8Array con los mismos bytes", () => {
    const actual = Buffer.from([0x00, 0xff, 0x41, 0x80]);
    const expected = new Uint8Array([0x00, 0xff, 0x41, 0x80]);

    expect(bytesEqual(actual, expected)).toBe(true);
  });

  it("rechaza un byte distinto", () => {
    const actual = Buffer.from([0x00, 0xff, 0x41, 0x80]);
    const expected = new Uint8Array([0x00, 0xfe, 0x41, 0x80]);

    expect(bytesEqual(actual, expected)).toBe(false);
  });

  it("rechaza longitudes distintas", () => {
    const actual = Buffer.from([0x00, 0xff, 0x41]);
    const expected = new Uint8Array([0x00, 0xff, 0x41, 0x80]);

    expect(bytesEqual(actual, expected)).toBe(false);
  });
});
