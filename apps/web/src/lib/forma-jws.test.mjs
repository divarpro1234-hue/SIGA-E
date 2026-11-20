import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MAX_CARACTERES_JWS, validarFormaJws } from './forma-jws.mjs';

const JWS = 'eyJhbGciOiJFUzI1NiJ9.eyJhIjoiYiJ9.ZmlybWE';

test('acepta tres segmentos base64url y devuelve exactamente la misma cadena', () => {
  const r = validarFormaJws(JWS);
  assert.deepEqual(r, { ok: true, jws: JWS });
  assert.ok(r.ok && r.jws === JWS && r.jws.length === JWS.length);
});

test('rechaza espacios o saltos de línea externos en lugar de recortarlos', () => {
  for (const v of [` ${JWS}`, `${JWS} `, `${JWS}\n`, `${JWS}\r\n`, `\t${JWS}`, `  ${JWS}\n`]) {
    assert.deepEqual(validarFormaJws(v), { ok: false, motivo: 'espacios' }, JSON.stringify(v));
  }
});

test('rechaza espacios internos y espacios Unicode, incluida la marca de orden de bytes', () => {
  const [h, p, f] = JWS.split('.');
  for (const v of [
    `${h}. ${p}.${f}`,
    `${h}.${p}\n.${f}`,
    `${h}.${p}.${f} `,
    `﻿${JWS}`,
    `${h}.${p} .${f}`,
    `${h}.${p}.${f.slice(0, 2)}　${f.slice(2)}`,
  ]) {
    assert.deepEqual(validarFormaJws(v), { ok: false, motivo: 'espacios' }, JSON.stringify(v));
  }
});

test('vacío, solo espacios o no cadena', () => {
  for (const v of ['', '   \n', '\t', undefined, null, 42]) {
    assert.deepEqual(validarFormaJws(v), { ok: false, motivo: 'vacio' });
  }
});

test('segmentos distintos de tres o vacíos', () => {
  for (const v of ['a', 'a.b', 'a.b.c.d', 'a..c', '.b.c', 'a.b.']) {
    assert.deepEqual(validarFormaJws(v), { ok: false, motivo: 'segmentos' }, v);
  }
});

test('caracteres fuera de base64url', () => {
  for (const v of ['a.b.c=', 'a.b.<c>', 'a.b.c+d', 'a.b.ñ', 'a.b.c\u0000', 'a.b.c​']) {
    assert.deepEqual(validarFormaJws(v), { ok: false, motivo: 'caracteres' }, JSON.stringify(v));
  }
});

test('tamaño máximo: se mide la cadena recibida, espacios incluidos, antes de cualquier otra regla', () => {
  const seg = 'A'.repeat(Math.floor(MAX_CARACTERES_JWS / 3) - 1);
  const justo = `${seg}.${seg}.${seg}`;
  assert.equal(validarFormaJws(justo).ok, true);
  assert.deepEqual(validarFormaJws('A'.repeat(MAX_CARACTERES_JWS + 1)), { ok: false, motivo: 'grande' });
  assert.deepEqual(validarFormaJws(`${' '.repeat(MAX_CARACTERES_JWS)}x`), { ok: false, motivo: 'grande' });
});
