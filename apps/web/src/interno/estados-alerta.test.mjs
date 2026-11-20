// D09-3: estados del ciclo y del anclaje. Las reglas de presentación se prueban aquí; los componentes
// solo las dibujan.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  ESTADOS_ANCLAJE,
  ESTADOS_CICLO,
  ESTADO_DESCONOCIDO,
  FUENTE_ANCLAJE,
  enProceso,
  esEstadoAnclaje,
  esEstadoCiclo,
  pasosCiclo,
  publicada,
  textoAnclaje,
  textoCiclo,
} from './estados-alerta.mjs';

test('los estados son exactamente los del contrato (OpenAPI AlertState y AnchorState)', () => {
  const yaml = readFileSync(new URL('../../../../docs/arquitectura/SIGA-E_API_OpenAPI_v1.2.yaml', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  const enumDe = (nombre) => {
    const bloque = yaml.split(`\n    ${nombre}:\n`)[1].split(/\n    [A-Z]/)[0];
    return [...bloque.matchAll(/^\s+- ([A-Z_]+)$/gm)].map((m) => m[1]);
  };
  assert.deepEqual([...ESTADOS_CICLO], enumDe('AlertState'));
  assert.deepEqual([...ESTADOS_ANCLAJE], enumDe('AnchorState'));
});

test('cada estado tiene etiqueta, explicación, tono e icono (nunca solo color)', () => {
  for (const e of ESTADOS_CICLO) {
    const t = textoCiclo(e);
    assert.ok(t.etiqueta && t.explica && t.tono && t.icono, e);
  }
  for (const e of ESTADOS_ANCLAJE) {
    const t = textoAnclaje(e);
    assert.ok(t.etiqueta && t.explica && t.tono && t.icono, e);
  }
});

test('solo PUBLISHED se presenta como publicada y con tono de éxito', () => {
  for (const e of ESTADOS_CICLO) {
    const t = textoCiclo(e);
    assert.equal(publicada(e), e === 'PUBLISHED', e);
    assert.equal(t.tono === 'ok', e === 'PUBLISHED', e);
    // La etiqueta es lo que se lee de un vistazo: solo PUBLISHED puede decir «publicada».
    if (e !== 'PUBLISHED') assert.doesNotMatch(t.etiqueta, /publicad/i, e);
  }
});

test('SIGNING y SIGNED_PENDING_ANCHOR son «en proceso» y dicen que no está publicada', () => {
  for (const e of ESTADOS_CICLO) assert.equal(enProceso(e), e === 'SIGNING' || e === 'SIGNED_PENDING_ANCHOR', e);
  for (const e of ['SIGNING', 'SIGNED_PENDING_ANCHOR', 'READY_TO_SIGN']) {
    assert.match(textoCiclo(e).explica, /[Nn]o está publicada|ni publicada/, e);
  }
  assert.match(textoCiclo('SIGNING').etiqueta, /en proceso/);
  assert.match(textoCiclo('SIGNED_PENDING_ANCHOR').etiqueta, /en proceso/);
});

test('el anclaje nunca se presenta como verificación independiente ni como publicación', () => {
  for (const e of ESTADOS_ANCLAJE) {
    const t = textoAnclaje(e);
    assert.notEqual(t.tono, 'ok', `${e}: ningún estado de anclaje lleva el tono de éxito`);
    assert.doesNotMatch(t.etiqueta, /verificad|coincide|publicad|registrad[oa] en/i, e);
  }
  assert.match(textoAnclaje('CONFIRMED').etiqueta, /según el backend/);
  assert.match(textoAnclaje('CONFIRMED').explica, /no lo ha comprobado|CLI externa/);
  assert.match(textoAnclaje('SUBMITTED').explica, /no prueba/);
  assert.match(FUENTE_ANCLAJE, /backend/);
  assert.match(FUENTE_ANCLAJE, /no una verificación independiente/);
});

test('conflicto y error no se suavizan', () => {
  assert.equal(textoAnclaje('CONFLICT').tono, 'mal');
  assert.match(textoAnclaje('CONFLICT').explica, /no se publica/);
  assert.match(textoAnclaje('RETRYABLE_ERROR').explica, /no se publica/);
  assert.equal(textoCiclo('REJECTED').tono, 'mal');
});

test('valores desconocidos no se interpretan', () => {
  for (const v of ['published', 'CANCELLED', 'ACTIVE', '', null, undefined, 3, {}]) {
    assert.equal(esEstadoCiclo(v), false);
    assert.equal(esEstadoAnclaje(v), false);
    assert.equal(textoCiclo(v), ESTADO_DESCONOCIDO);
    assert.equal(textoAnclaje(v), ESTADO_DESCONOCIDO);
    assert.equal(pasosCiclo(v), null);
    assert.equal(publicada(v), false);
  }
});

test('línea del ciclo: camino principal con posiciones', () => {
  const pasos = pasosCiclo('SIGNING');
  assert.deepEqual(pasos.map((p) => p.estado), ['DRAFT', 'PENDING_APPROVAL', 'READY_TO_SIGN', 'SIGNING', 'SIGNED_PENDING_ANCHOR', 'PUBLISHED']);
  assert.deepEqual(pasos.map((p) => p.posicion), ['anterior', 'anterior', 'anterior', 'actual', 'siguiente', 'siguiente']);
  assert.equal(pasosCiclo('DRAFT')[0].posicion, 'actual');
  assert.equal(pasosCiclo('PUBLISHED').at(-1).posicion, 'actual');
  assert.equal(pasosCiclo('PUBLISHED').filter((p) => p.posicion === 'actual').length, 1);
});

test('línea del ciclo: el rechazo muestra su rama y no los pasos de emisión', () => {
  const pasos = pasosCiclo('REJECTED');
  assert.deepEqual(pasos.map((p) => p.estado), ['DRAFT', 'PENDING_APPROVAL', 'REJECTED']);
  assert.equal(pasos.at(-1).posicion, 'actual');
});

test('el paso de aprobación aclara que solo aplica a severidades críticas', () => {
  assert.match(pasosCiclo('READY_TO_SIGN')[1].paso, /Severe y Extreme/);
});
