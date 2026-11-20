// Pruebas del adaptador DEMO de alertas (F3).
// Verifican que los datos ficticios tienen la estructura correcta
// y que el filtrado funciona como se espera.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ALERTAS_DEMO, filtrarAlertasDemo } from './alertas-demo.mjs';

const ESTADOS_CICLO_VALIDOS = new Set([
  'DRAFT', 'PENDING_APPROVAL', 'REJECTED',
  'READY_TO_SIGN', 'SIGNING', 'SIGNED_PENDING_ANCHOR', 'PUBLISHED',
]);

const ESTADOS_ANCLAJE_VALIDOS = new Set([
  'NOT_REQUESTED', 'PENDING', 'SUBMITTED',
  'CONFIRMED', 'RETRYABLE_ERROR', 'CONFLICT', 'UNVERIFIABLE',
]);

const SEVERIDADES_VALIDAS = new Set(['Extreme', 'Severe', 'Moderate', 'Minor']);

describe('ALERTAS_DEMO', () => {
  it('tiene al menos 1 alerta', () => {
    assert.ok(ALERTAS_DEMO.length >= 1, 'debería haber alertas de demo');
  });

  it('todos los campos requeridos están presentes en cada alerta', () => {
    for (const a of ALERTAS_DEMO) {
      assert.ok(typeof a.id === 'string' && a.id.length > 0, `id requerido: ${a.id}`);
      assert.ok(typeof a.identifier === 'string' && a.identifier.length > 0, `identifier requerido: ${a.identifier}`);
      assert.ok(typeof a.sender === 'string', `sender requerido: ${a.identifier}`);
      assert.ok(typeof a.sent === 'string', `sent requerido: ${a.identifier}`);
      assert.ok(typeof a.version === 'number', `version requerido: ${a.identifier}`);
      assert.ok(['Alert', 'Update', 'Cancel'].includes(a.msgType), `msgType inválido: ${a.msgType}`);
      assert.ok(ESTADOS_CICLO_VALIDOS.has(a.lifecycleState), `lifecycleState inválido: ${a.lifecycleState}`);
      assert.ok(ESTADOS_ANCLAJE_VALIDOS.has(a.anchorStatus), `anchorStatus inválido: ${a.anchorStatus}`);
      assert.ok(SEVERIDADES_VALIDAS.has(a.info.severity), `severity inválida: ${a.info.severity}`);
      assert.ok(typeof a.info.headline === 'string' && a.info.headline.length > 0, `headline requerido`);
      assert.ok(typeof a.info.description === 'string', `description requerida`);
      assert.ok(typeof a.author.name === 'string', `author.name requerido`);
    }
  });

  it('los identificadores son únicos', () => {
    const ids = ALERTAS_DEMO.map((a) => a.id);
    const unicos = new Set(ids);
    assert.equal(unicos.size, ids.length, 'los IDs deben ser únicos');

    const identifiers = ALERTAS_DEMO.map((a) => a.identifier);
    const unicosId = new Set(identifiers);
    assert.equal(unicosId.size, identifiers.length, 'los identifiers deben ser únicos');
  });

  it('todos los headline incluyen "SIMULACRO" o "simulacro"', () => {
    for (const a of ALERTAS_DEMO) {
      assert.ok(
        a.info.headline.toLowerCase().includes('simulacro'),
        `El headline de ${a.identifier} debe incluir SIMULACRO`,
      );
    }
  });

  it('frozenPayload solo existe cuando lifecycleState != DRAFT', () => {
    for (const a of ALERTAS_DEMO) {
      if (a.lifecycleState === 'DRAFT') {
        assert.equal(a.frozenPayload, null, `${a.identifier}: DRAFT no debe tener frozenPayload`);
      }
    }
  });

  it('tiene al menos un estado PENDING_APPROVAL para demostrar el flujo de aprobación', () => {
    const hay = ALERTAS_DEMO.some((a) => a.lifecycleState === 'PENDING_APPROVAL');
    assert.ok(hay, 'debe haber al menos una alerta PENDING_APPROVAL para demostrar el flujo');
  });
});

describe('filtrarAlertasDemo', () => {
  it('sin término devuelve todas', () => {
    const resultado = filtrarAlertasDemo('');
    assert.equal(resultado.length, ALERTAS_DEMO.length);
  });

  it('filtra por identifier exacto (case insensitive)', () => {
    const primer = ALERTAS_DEMO[0];
    const resultado = filtrarAlertasDemo(primer.identifier.slice(0, 8).toLowerCase());
    assert.ok(resultado.length >= 1, 'debe encontrar al menos la primera alerta');
    assert.ok(resultado.some((a) => a.id === primer.id));
  });

  it('filtra por severidad', () => {
    const resultado = filtrarAlertasDemo('extreme');
    assert.ok(resultado.every((a) => a.info.severity === 'Extreme'));
  });

  it('término sin coincidencia devuelve array vacío', () => {
    const resultado = filtrarAlertasDemo('xXxNOEXISTExXx');
    assert.equal(resultado.length, 0);
  });

  it('filtra por estado del ciclo', () => {
    const resultado = filtrarAlertasDemo('published');
    assert.ok(resultado.every((a) => a.lifecycleState.toLowerCase().includes('published')));
  });
});
