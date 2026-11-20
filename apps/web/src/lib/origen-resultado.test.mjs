import assert from 'node:assert/strict';
import { test } from 'node:test';
import { etiquetaDimension } from './origen-resultado.mjs';

test('una etiqueta de fixture describe un escenario y no afirma una verificación real', () => {
  assert.equal(etiquetaDimension('Firma válida', true), 'Escenario de prueba: firma válida');
});

test('una etiqueta de verificación local conserva su texto normal', () => {
  assert.equal(etiquetaDimension('Firma válida', false), 'Firma válida');
});
