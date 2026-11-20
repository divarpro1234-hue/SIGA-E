// Pruebas con el verificador REAL (@siga-e/verify, dist compilado) y los fixtures públicos de Codex.
// Fecha fija del manifiesto: la prueba nunca depende del reloj del equipo.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { interpretarCatalogo } from './catalogo-confianza.mjs';
import { MAX_CARACTERES_JWS, validarFormaJws } from './forma-jws.mjs';
import { esResultadoSimulado } from './origen-resultado.mjs';
import { contenidoDe, verificarLocal } from './verificacion-local.mjs';
// Política compartida compilada (solo lectura, ningún cambio en packages/verify).
import { validarPoliticaPayload } from '../../../../packages/verify/dist/policy.js';

const FIXTURES = new URL('../../../../packages/verify/fixtures/', import.meta.url);
const leer = (nombre) => readFileSync(new URL(nombre, FIXTURES));
const manifiesto = JSON.parse(leer('manifest.json').toString('utf8'));
const AHORA = new Date(manifiesto.ahora);
const publico = readFileSync(fileURLToPath(new URL('../../public/catalogo/catalogo-demostracion.json', import.meta.url)));

const cat = await interpretarCatalogo(new Uint8Array(publico));
assert.ok(cat.ok, 'el catálogo público debe ser válido');
const contexto = { huella: cat.huella, sinConexion: false };

test('el catálogo servido es idéntico al fixture de Codex y no lleva claves privadas', () => {
  assert.deepEqual(Buffer.from(publico), leer('catalogo.json'));
  assert.equal(JSON.stringify(cat.catalogo).includes('"d"'), false);
});

for (const caso of manifiesto.fixtures) {
  test(`fixture ${caso.name}: coincide con el manifiesto`, async () => {
    const { jws } = JSON.parse(leer(caso.file).toString('utf8'));
    assert.equal(validarFormaJws(jws).ok, true);
    const r = await verificarLocal(jws, cat.catalogo, AHORA, contexto);
    assert.equal(r.firma, caso.firma);
    assert.equal(r.vigencia, caso.vigencia);
    assert.equal(r.panel.hashJws, caso.jwsHash);
    assert.equal(r.panel.kid, caso.kid);
    // D07A: una verificación real nunca lleva el aviso de demostración simulada.
    assert.equal(r.origen, 'VERIFICACION_LOCAL');
    assert.equal(esResultadoSimulado(r), false);
    // Sin lectura confiable del contrato la dimensión blockchain es siempre NO_COMPROBABLE.
    assert.equal(r.cadena, 'NO_COMPROBABLE');
    if (caso.firma === 'VALIDA') assert.ok(r.contenido, 'con firma VALIDA hay contenido');
    else assert.equal(r.contenido, null, 'sin firma VALIDA no hay contenido');
  });
}

// Vigencia: el reloj fijo del manifiesto (09/10/2026 12:30Z) es el único con el que valid-current es
// VIGENTE. Con una fecha posterior a su vencimiento (13:00Z) la firma sigue VALIDA y la vigencia es VENCIDA.
test('valid-current con el reloj fijo del manifiesto es VIGENTE', async () => {
  const { jws } = JSON.parse(leer('valid-current.json').toString('utf8'));
  const r = await verificarLocal(jws, cat.catalogo, AHORA, contexto);
  assert.equal(r.firma, 'VALIDA');
  assert.equal(r.vigencia, 'VIGENTE');
});

test('valid-current con una fecha fija posterior (2030) queda VENCIDA y conserva la firma VALIDA', async () => {
  const { jws } = JSON.parse(leer('valid-current.json').toString('utf8'));
  const r = await verificarLocal(jws, cat.catalogo, new Date('2030-01-01T00:00:00Z'), contexto);
  assert.equal(r.firma, 'VALIDA');
  assert.equal(r.vigencia, 'VENCIDA');
});

test('la huella mostrada es SHA-256 de la cadena exacta recibida, sin recortes', async () => {
  const { jws } = JSON.parse(leer('valid-current.json').toString('utf8'));
  const forma = validarFormaJws(jws);
  assert.ok(forma.ok && forma.jws === jws);
  const r = await verificarLocal(forma.jws, cat.catalogo, AHORA, contexto);
  assert.equal(r.panel.hashJws, createHash('sha256').update(Buffer.from(jws, 'ascii')).digest('hex'));
  // La misma cadena con un salto de línea final no llega al verificador.
  assert.deepEqual(validarFormaJws(`${jws}\n`), { ok: false, motivo: 'espacios' });
});

test('el resultado nunca trae contractId ni una dimensión blockchain distinta de NO_COMPROBABLE', async () => {
  for (const caso of manifiesto.fixtures) {
    const { jws } = JSON.parse(leer(caso.file).toString('utf8'));
    for (const sinConexion of [false, true]) {
      const r = await verificarLocal(jws, cat.catalogo, AHORA, { ...contexto, sinConexion });
      assert.equal(r.cadena, 'NO_COMPROBABLE', caso.name);
      assert.equal(Object.hasOwn(r.panel, 'contractId'), false, caso.name);
    }
  }
});

// ---- Alert, Update y Cancel (ENM-002 §5) ----
// No hay fixtures firmados de Update ni Cancel y desde la UI no se firma nada: se usan payloads sin
// firmar, se comprueba que la política compartida los acepta tal cual y cómo los presenta la PWA.
const base = {
  sender: 'urn:siga-e:simulacro',
  identifier: 'SIGAE-PRUEBA-0002',
  sent: '2026-10-09T12:10:00Z',
  status: 'Exercise',
  scope: 'Public',
  msgType: 'Alert',
  info: {
    scenario: 'SISMO',
    event: 'Simulacro de sismo',
    severity: 'Severe',
    urgency: 'Immediate',
    certainty: 'Likely',
    headline: 'SIMULACRO: aviso ficticio de sismo',
    description: 'Ejercicio académico; no es una alerta real.',
    expires: '2026-10-09T13:00:00Z',
    areaDesc: 'Sector ficticio A',
  },
};
const ref = { sender: 'urn:siga-e:simulacro', identifier: 'SIGAE-FIXTURE-0001', sent: '2026-10-09T12:00:00Z' };

test('Alert sin referencias: tipo Alert y lista de referencias vacía', () => {
  assert.ok(validarPoliticaPayload(base));
  const c = contenidoDe(base);
  assert.equal(c?.tipo, 'Alert');
  assert.deepEqual(c?.referencias, []);
});

for (const tipo of ['Update', 'Cancel']) {
  test(`${tipo} con referencia: la política lo acepta y la PWA lo marca como mensaje relacionado`, () => {
    const p = { ...base, msgType: tipo, references: [ref] };
    assert.ok(validarPoliticaPayload(p), 'la política compartida admite el mensaje');
    const c = contenidoDe(p);
    assert.equal(c?.tipo, tipo);
    // La referencia se copia tal cual: no se inventa estado, historial ni relación adicional.
    assert.deepEqual(c?.referencias, [ref]);
    assert.equal(Object.keys(c ?? {}).some((k) => /estado|cancelad|actualizad|historial/i.test(k)), false);
  });

  test(`${tipo} sin referencias no se muestra como contenido`, () => {
    assert.equal(validarPoliticaPayload({ ...base, msgType: tipo }), null);
    assert.equal(contenidoDe({ ...base, msgType: tipo }), null);
    assert.equal(contenidoDe({ ...base, msgType: tipo, references: [] }), null);
  });
}

test('msgType desconocido, ausente o referencias con forma inesperada: sin contenido', () => {
  for (const p of [
    { ...base, msgType: 'Ack' },
    { ...base, msgType: undefined },
    { ...base, msgType: 'Update', references: 'SIGAE-FIXTURE-0001' },
    { ...base, msgType: 'Cancel', references: [{ sender: 'x', identifier: 'y' }] },
    { ...base, msgType: 'Cancel', references: [null] },
    { ...base, msgType: 'Cancel', references: [[ref.sender, ref.identifier, ref.sent]] },
  ]) {
    assert.equal(contenidoDe(p), null, JSON.stringify(p.msgType));
  }
});

test('referencias hostiles que la política acepta llegan intactas como texto', () => {
  // La política no acota sender ni identifier ni prohíbe «<»: esto sí puede llegar firmado a la PWA.
  const hostil = { sender: '✔ Verificado por SIGA-E <img src=x onerror=alert(1)>', identifier: 'A'.repeat(500), sent: ref.sent };
  const p = { ...base, msgType: 'Cancel', references: [hostil] };
  assert.ok(validarPoliticaPayload(p), 'la política compartida admite la referencia');
  assert.deepEqual(contenidoDe(p)?.referencias, [hostil]);
});

test('referencias con controles bidi: la política las rechaza; contenidoDe las conserva como defensa', () => {
  const bidi = { sender: 'urn:siga-e:\u202Eodalucnac\u202C', identifier: ref.identifier, sent: ref.sent };
  const p = { ...base, msgType: 'Cancel', references: [bidi] };
  assert.equal(validarPoliticaPayload(p), null);
  // Si otra capa dejara pasar el texto, se copia sin interpretar y TextoAjeno lo marca al dibujarlo.
  assert.deepEqual(contenidoDe(p)?.referencias, [bidi]);
});

test('un JWS de más de 32768 caracteres se rechaza por forma y el verificador no lo da por válido', async () => {
  const grande = 'A'.repeat(MAX_CARACTERES_JWS + 1);
  assert.deepEqual(validarFormaJws(grande), { ok: false, motivo: 'grande' });
  const largo = `${'A'.repeat(20000)}.${'B'.repeat(12000)}.C`;
  const r = await verificarLocal(largo, cat.catalogo, AHORA, contexto);
  assert.notEqual(r.firma, 'VALIDA');
  assert.equal(r.contenido, null);
});

test('un JWS alterado nunca expone contenido ni kid con forma peligrosa', async () => {
  const { jws } = JSON.parse(leer('tampered.json').toString('utf8'));
  const r = await verificarLocal(jws, cat.catalogo, AHORA, contexto);
  assert.equal(r.firma, 'INVALIDA');
  assert.equal(r.contenido, null);
  assert.equal(r.vigencia, 'DESCONOCIDA');
});

test('catálogos inválidos se rechazan: vacío, JSON roto, clave privada, curva ajena', async () => {
  const bytes = (v) => new TextEncoder().encode(typeof v === 'string' ? v : JSON.stringify(v));
  const buena = JSON.parse(publico.toString('utf8'));
  const conPrivada = structuredClone(buena);
  conPrivada.claves[0].publicJwk.d = 'AAAA';
  const otraCurva = structuredClone(buena);
  otraCurva.claves[0].publicJwk.crv = 'P-384';
  for (const malo of [new Uint8Array(0), bytes('no es json'), bytes({}), bytes({ claves: [] }), bytes(conPrivada), bytes(otraCurva)]) {
    assert.deepEqual(await interpretarCatalogo(malo), { ok: false });
  }
});
