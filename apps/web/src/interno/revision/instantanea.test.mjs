// D09-2: verificación local de reviewSnapshot. Vectores construidos aquí; ninguno es una alerta real.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import {
  MAX_CARACTERES_INSTANTANEA,
  codificarBase64Url,
  decodificarBase64UrlCanonico,
  sha256Hex,
  utf8Estricto,
  verificarInstantanea,
} from './instantanea.mjs';

const b64 = (bytes) => Buffer.from(bytes).toString('base64url');
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const instantanea = (bytes) => ({ payloadBase64Url: b64(bytes), payloadDigestHex: sha(bytes) });

// Payload de ejemplo con forma inspirada en CAP; solo bytes de prueba, el esquema exacto está PENDIENTE (C8).
const PAYLOAD = Buffer.from(
  '{"sender":"emisor-simulado.example","identifier":"SIGAE-PRUEBA-0001","sent":"2026-10-19T10:00:00Z","status":"Exercise","scope":"Public","msgType":"Alert","info":{"headline":"SIMULACRO: ñandú ‮ prueba"}}',
  'utf8',
);

test('vector conocido: SHA-256("abc")', async () => {
  assert.equal(await sha256Hex(new TextEncoder().encode('abc')), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
});

test('base64url: ida y vuelta para todas las longitudes de resto, igual que Node', () => {
  for (let n = 1; n <= 40; n += 1) {
    const bytes = new Uint8Array(n).map((_, i) => (i * 37 + n) & 0xff);
    const texto = codificarBase64Url(bytes);
    assert.equal(texto, b64(bytes), String(n));
    assert.deepEqual(decodificarBase64UrlCanonico(texto), bytes, String(n));
  }
});

test('base64url: rechaza padding, alfabeto estándar, espacios, vacío y longitudes imposibles', () => {
  for (const malo of ['YQ==', 'YWJj=', 'a+b/', 'YW Jj', ' YWJj', 'YWJj\n', '', 'Y', 'YWJjZ', 'ñ', null, 5, ['YWJj']]) {
    assert.equal(decodificarBase64UrlCanonico(malo), null, JSON.stringify(malo));
  }
});

test('base64url: rechaza codificaciones no canónicas (bits sobrantes distintos de cero)', () => {
  assert.deepEqual(decodificarBase64UrlCanonico('YQ'), new Uint8Array([0x61]));
  for (const malo of ['YR', 'YS', 'YT', 'YWK', 'YWL']) assert.equal(decodificarBase64UrlCanonico(malo), null, malo);
});

test('UTF-8 estricto: inválidos, sobrelargos, sustitutos, truncados y BOM', () => {
  assert.equal(utf8Estricto(new Uint8Array([0xc3, 0xb1])), 'ñ');
  for (const malo of [[0xc3, 0x28], [0xc0, 0xaf], [0xed, 0xa0, 0x80], [0xe2, 0x82], [0xff], [0xef, 0xbb, 0xbf, 0x7b, 0x7d]]) {
    assert.equal(utf8Estricto(new Uint8Array(malo)), null, JSON.stringify(malo));
  }
});

test('instantánea válida: digest local igual al declarado y texto exacto, sin normalizar', async () => {
  const r = await verificarInstantanea(instantanea(PAYLOAD));
  assert.equal(r.ok, true);
  assert.equal(r.digest, sha(PAYLOAD));
  assert.equal(r.texto, PAYLOAD.toString('utf8'));
  assert.ok(r.texto.includes('‮'), 'los controles bidi se conservan: mostrarlos es tarea de la capa de texto ajeno');
  assert.deepEqual(Buffer.from(r.bytes), PAYLOAD);
  // NFD no se convierte a NFC: los bytes mandan.
  const nfd = Buffer.from('é', 'utf8');
  const rn = await verificarInstantanea(instantanea(nfd));
  assert.equal(rn.texto, 'é');
  assert.equal(rn.texto.length, 2);
});

test('el digest es de los BYTES: el mismo JSON con otro espaciado u orden da otro digest', async () => {
  const otro = Buffer.from(JSON.stringify(JSON.parse(PAYLOAD.toString('utf8')), null, 1), 'utf8');
  assert.notEqual(sha(otro), sha(PAYLOAD));
  const r = await verificarInstantanea({ payloadBase64Url: b64(otro), payloadDigestHex: sha(PAYLOAD) });
  assert.deepEqual(r, { ok: false, motivo: 'digest-distinto' });
});

test('un solo byte cambiado o un digest de otra versión se detectan', async () => {
  const alterado = Buffer.from(PAYLOAD);
  alterado[alterado.length - 3] ^= 0x01;
  assert.deepEqual(await verificarInstantanea({ payloadBase64Url: b64(alterado), payloadDigestHex: sha(PAYLOAD) }), { ok: false, motivo: 'digest-distinto' });
  const digest = sha(PAYLOAD);
  const casi = digest.slice(0, -1) + (digest.at(-1) === '0' ? '1' : '0');
  assert.deepEqual(await verificarInstantanea({ payloadBase64Url: b64(PAYLOAD), payloadDigestHex: casi }), { ok: false, motivo: 'digest-distinto' });
});

test('forma del digest declarado: 64 hexadecimales minúsculas', async () => {
  const base = instantanea(PAYLOAD);
  for (const d of [base.payloadDigestHex.toUpperCase(), base.payloadDigestHex.slice(1), `${base.payloadDigestHex}0`, 'g'.repeat(64), 5, null]) {
    assert.deepEqual(await verificarInstantanea({ ...base, payloadDigestHex: d }), { ok: false, motivo: 'digest-forma' }, String(d));
  }
});

test('forma de la instantánea: exactamente los dos campos del contrato', async () => {
  const base = instantanea(PAYLOAD);
  for (const malo of [null, 'x', [], {}, { payloadBase64Url: base.payloadBase64Url }, { ...base, extra: 1 }, { ...base, payloadBase64Url: 7 }]) {
    const r = await verificarInstantanea(malo);
    assert.equal(r.ok, false, JSON.stringify(malo));
    assert.ok(['forma', 'digest-forma'].includes(r.motivo));
  }
});

test('base64url no canónico se rechaza aunque el digest declarado sea el de los bytes', async () => {
  const bytes = new Uint8Array([0x61]);
  assert.deepEqual(await verificarInstantanea({ payloadBase64Url: 'YR', payloadDigestHex: sha(bytes) }), { ok: false, motivo: 'base64' });
  assert.deepEqual(await verificarInstantanea({ payloadBase64Url: 'YQ==', payloadDigestHex: sha(bytes) }), { ok: false, motivo: 'base64' });
});

test('UTF-8 inválido con digest correcto: se rechaza (no se muestra con caracteres sustituidos)', async () => {
  const bytes = new Uint8Array([0x7b, 0xc3, 0x28, 0x7d]);
  assert.deepEqual(await verificarInstantanea(instantanea(bytes)), { ok: false, motivo: 'utf8' });
  const bom = Buffer.from([0xef, 0xbb, 0xbf, ...PAYLOAD]);
  assert.deepEqual(await verificarInstantanea(instantanea(bom)), { ok: false, motivo: 'utf8' });
});

test('tamaño: por encima del límite defensivo se rechaza sin decodificar', async () => {
  const r = await verificarInstantanea({ payloadBase64Url: 'A'.repeat(MAX_CARACTERES_INSTANTANEA + 4), payloadDigestHex: '0'.repeat(64) });
  assert.deepEqual(r, { ok: false, motivo: 'tamano' });
  const grande = Buffer.alloc(40000, 0x61);
  assert.equal((await verificarInstantanea(instantanea(grande))).ok, true);
});

test('sin WebCrypto no se da por verificado', async () => {
  const original = globalThis.crypto;
  Object.defineProperty(globalThis, 'crypto', { value: undefined, configurable: true });
  try {
    assert.deepEqual(await verificarInstantanea(instantanea(PAYLOAD)), { ok: false, motivo: 'sin-webcrypto' });
  } finally {
    Object.defineProperty(globalThis, 'crypto', { value: original, configurable: true });
  }
});

test('los bytes devueltos no cambian si se altera el original tras verificar', async () => {
  const copia = Buffer.from(PAYLOAD);
  const ins = instantanea(copia);
  const r = await verificarInstantanea(ins);
  copia[0] = 0x20;
  assert.equal(r.bytes[0], 0x7b);
});
