// D07A: todo resultado de demostración se marca SIMULADO y no lleva kid, huella ni catálogo.
// datos-demo.ts solo importa tipos: Node lo carga quitando las anotaciones.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { esResultadoSimulado } from '../lib/origen-resultado.mjs';
import { CASOS_DEMO } from './datos-demo.ts';
import { resultadoSimulado } from './resultado-simulado.mjs';

const claves = Object.keys(CASOS_DEMO);

test('hay ocho casos de demostración (a–h)', () => {
  assert.deepEqual(claves, ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']);
});

for (const clave of claves) {
  test(`caso ${clave}: origen SIMULADO, aviso obligatorio y sin datos técnicos`, () => {
    const r = resultadoSimulado(CASOS_DEMO[clave].resultado);
    assert.equal(r.origen, 'SIMULADO');
    assert.equal(esResultadoSimulado(r), true);
    assert.deepEqual(r.panel, { kid: null, hashJws: null, catalogo: null });
  });
}

test('los datos fijos no pueden colar un origen real ni un kid o huella', () => {
  const trampa = { ...CASOS_DEMO.a.resultado, origen: 'VERIFICACION_LOCAL', panel: { kid: 'siga-e-2026-01', hashJws: 'f'.repeat(64) } };
  const r = resultadoSimulado(trampa);
  assert.equal(r.origen, 'SIMULADO');
  assert.deepEqual(r.panel, { kid: null, hashJws: null, catalogo: null });
});

test('el resultado es una copia: no comparte objetos con los datos fijos', () => {
  const r = resultadoSimulado(CASOS_DEMO.g.resultado);
  assert.notEqual(r.contenido, CASOS_DEMO.g.resultado.contenido);
});

test('ninguna etiqueta de caso llama «firmado» a un resultado simulado', () => {
  for (const { nombre } of Object.values(CASOS_DEMO)) assert.doesNotMatch(nombre, /firmad[oa]/i, nombre);
});

test('esResultadoSimulado falla a lo seguro: sin origen o con origen desconocido es simulado', () => {
  for (const r of [null, undefined, {}, { origen: 'verificacion_local' }, { origen: 'BACKEND' }]) {
    assert.equal(esResultadoSimulado(r), true, JSON.stringify(r));
  }
  assert.equal(esResultadoSimulado({ origen: 'VERIFICACION_LOCAL' }), false);
});
