import assert from 'node:assert/strict';
import { test } from 'node:test';
import { crearControladorCargaBandeja } from './carga-bandeja.mjs';

const fixture = { id: 'demo-1' };

function crearEscenario(cargarReales = async () => []) {
  let modo = 'real';
  const estados = [];
  const controlador = crearControladorCargaBandeja({
    cargarReales,
    modoActual: () => modo,
    publicar: (estado) => estados.push(estado),
  });
  return {
    estados,
    controlador,
    cambiarModo: (nuevoModo) => {
      modo = nuevoModo;
    },
  };
}

test('DEMO con fixtures usa únicamente datos locales', async () => {
  let llamadasHttp = 0;
  const escenario = crearEscenario(async () => {
    llamadasHttp += 1;
    return [];
  });
  escenario.cambiarModo('demo');

  await escenario.controlador.cargar('demo', [fixture]);

  assert.equal(llamadasHttp, 0);
  assert.deepEqual(escenario.estados.at(-1), { tipo: 'demo', alertas: [fixture] });
});

test('DEMO sin fixtures presenta una bandeja vacía sin llamar HTTP', async () => {
  let llamadasHttp = 0;
  const escenario = crearEscenario(async () => {
    llamadasHttp += 1;
    return [fixture];
  });
  escenario.cambiarModo('demo');

  await escenario.controlador.cargar('demo', undefined);

  assert.equal(llamadasHttp, 0);
  assert.deepEqual(escenario.estados.at(-1), { tipo: 'demo', alertas: [] });
});

test('DEMO con fixtures vacías permanece vacío y no consulta el backend', async () => {
  let llamadasHttp = 0;
  const escenario = crearEscenario(async () => {
    llamadasHttp += 1;
    return [fixture];
  });
  escenario.cambiarModo('demo');

  await escenario.controlador.cargar('demo', []);

  assert.equal(llamadasHttp, 0);
  assert.deepEqual(escenario.estados.at(-1), { tipo: 'demo', alertas: [] });
});

test('reintentar en DEMO recarga fixtures localmente sin petición operativa', async () => {
  let llamadasHttp = 0;
  const escenario = crearEscenario(async () => {
    llamadasHttp += 1;
    return [fixture];
  });
  escenario.cambiarModo('demo');

  await escenario.controlador.cargar('demo', []);
  await escenario.controlador.cargar('demo', []);

  assert.equal(llamadasHttp, 0);
  assert.deepEqual(escenario.estados.slice(-2), [
    { tipo: 'cargando' },
    { tipo: 'demo', alertas: [] },
  ]);
});

test('REAL publica exclusivamente alertas devueltas por el backend', async () => {
  const alertaReal = { id: 'real-1' };
  const escenario = crearEscenario(async () => [alertaReal]);

  await escenario.controlador.cargar('real', [fixture]);

  assert.deepEqual(escenario.estados.at(-1), { tipo: 'real', alertas: [alertaReal] });
  assert.equal(JSON.stringify(escenario.estados.at(-1)).includes(fixture.id), false);
});

test('REAL con error publica error y no sustituye la respuesta por fixtures', async () => {
  const escenario = crearEscenario(async () => 'error');

  await escenario.controlador.cargar('real', [fixture]);

  assert.equal(escenario.estados.at(-1).tipo, 'error');
  assert.equal(JSON.stringify(escenario.estados.at(-1)).includes(fixture.id), false);
});

test('un rechazo inesperado del cargador HTTP se trata como error controlado', async () => {
  const escenario = crearEscenario(async () => {
    throw new Error('fallo de red inesperado');
  });

  await assert.doesNotReject(escenario.controlador.cargar('real', [fixture]));
  assert.equal(escenario.estados.at(-1).tipo, 'error');
  assert.equal(JSON.stringify(escenario.estados.at(-1)).includes(fixture.id), false);
});

test('una respuesta REAL antigua no sobrescribe DEMO después de cambiar de modo', async () => {
  let resolverReal;
  const escenario = crearEscenario(
    () =>
      new Promise((resolve) => {
        resolverReal = resolve;
      }),
  );
  const solicitudReal = escenario.controlador.cargar('real', [fixture]);
  escenario.cambiarModo('demo');
  await escenario.controlador.cargar('demo', []);
  resolverReal([{ id: 'real-antigua' }]);

  assert.equal(await solicitudReal, false);
  assert.deepEqual(escenario.estados.at(-1), { tipo: 'demo', alertas: [] });
  assert.equal(escenario.estados.some((estado) => estado.tipo === 'real'), false);
});

test('entre solicitudes concurrentes solo publica el resultado de la más reciente', async () => {
  const resolvers = [];
  const escenario = crearEscenario(
    () =>
      new Promise((resolve) => {
        resolvers.push(resolve);
      }),
  );
  const anterior = escenario.controlador.cargar('real', []);
  const vigente = escenario.controlador.cargar('real', []);
  resolvers[1]([{ id: 'vigente' }]);
  assert.equal(await vigente, true);
  resolvers[0]([{ id: 'obsoleta' }]);

  assert.equal(await anterior, false);
  assert.deepEqual(escenario.estados.at(-1), { tipo: 'real', alertas: [{ id: 'vigente' }] });
  assert.equal(escenario.estados.some((estado) => JSON.stringify(estado).includes('obsoleta')), false);
});

test('invalidar al desmontar impide publicar la respuesta tardía', async () => {
  let resolverReal;
  const escenario = crearEscenario(
    () =>
      new Promise((resolve) => {
        resolverReal = resolve;
      }),
  );
  const solicitud = escenario.controlador.cargar('real', [fixture]);
  escenario.controlador.invalidar();
  resolverReal([{ id: 'respuesta-tardia' }]);

  assert.equal(await solicitud, false);
  assert.deepEqual(escenario.estados, [{ tipo: 'cargando' }]);
});
