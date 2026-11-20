// SIGA-E — Pruebas de Creación de Alertas M2 (F4-A).
// Valida reglas de validación en cliente y manejo estricto de respuestas del contrato OpenAPI v1.2.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { crearClienteAlertas } from '../adaptador-alertas.mjs';
import { validarFormularioAlerta } from './validacion-alerta.mjs';

test('validarFormularioAlerta: rechaza titular sin la palabra SIMULACRO', () => {
  const ahora = Date.now();
  const res = validarFormularioAlerta(
    {
      scenario: 'INUNDACION',
      event: 'Crecida de río',
      severity: 'Severe',
      urgency: 'Expected',
      certainty: 'Likely',
      headline: 'Alerta crítica sobre río Ficticio', // falta SIMULACRO
      description: 'Descripción operativa con más de diez caracteres.',
      expires: new Date(ahora + 3600000).toISOString(),
      areaDesc: 'Sector Las Cañas',
    },
    ahora,
  );

  assert.equal(res.ok, false);
  assert.match(res.errores.headline ?? '', /SIMULACRO/);
});

test('validarFormularioAlerta: rechaza titular menor a 10 caracteres', () => {
  const ahora = Date.now();
  const res = validarFormularioAlerta(
    {
      scenario: 'INUNDACION',
      event: 'Crecida',
      severity: 'Severe',
      urgency: 'Expected',
      certainty: 'Likely',
      headline: 'SIMULACRO', // 9 caracteres
      description: 'Descripción operativa con más de diez caracteres.',
      expires: new Date(ahora + 3600000).toISOString(),
      areaDesc: 'Sector Las Cañas',
    },
    ahora,
  );

  assert.equal(res.ok, false);
  assert.equal(res.errores.headline, 'El titular debe tener al menos 10 caracteres.');
});

test('validarFormularioAlerta: rechaza expiración pasada', () => {
  const ahora = Date.now();
  const res = validarFormularioAlerta(
    {
      scenario: 'INUNDACION',
      event: 'Crecida',
      severity: 'Severe',
      urgency: 'Expected',
      certainty: 'Likely',
      headline: 'SIMULACRO: Crecida en río',
      description: 'Descripción operativa con más de diez caracteres.',
      expires: new Date(ahora - 1000).toISOString(), // en el pasado
      areaDesc: 'Sector Las Cañas',
    },
    ahora,
  );

  assert.equal(res.ok, false);
  assert.equal(res.errores.expires, 'La fecha de vencimiento debe estar en el futuro.');
});

test('validarFormularioAlerta: acepta datos canónicos válidos y genera payload AlertInput', () => {
  const ahora = Date.now();
  const fechaFutura = new Date(ahora + 4 * 3600000).toISOString();
  const res = validarFormularioAlerta(
    {
      scenario: 'INUNDACION',
      event: 'Crecida extraordinaria',
      severity: 'Severe',
      urgency: 'Immediate',
      certainty: 'Observed',
      headline: 'SIMULACRO: Crecida del río Ficticio',
      description: 'Evacuación preventiva simulada en sector bajo.',
      expires: fechaFutura,
      areaDesc: 'Sector Las Cañas',
    },
    ahora,
  );

  assert.equal(res.ok, true);
  assert.deepEqual(res.errores, {});
  assert.equal(res.payload?.kind, 'Alert');
  assert.equal(res.payload?.info.scenario, 'INUNDACION');
  assert.equal(res.payload?.info.severity, 'Severe');
  assert.equal(res.payload?.info.headline, 'SIMULACRO: Crecida del río Ficticio');
  assert.deepEqual(res.payload?.references, []);
});

test('clienteAlertas.crearBorrador: envía cabeceras correctas y procesa 201 Created', async () => {
  let llamadaUrl = '';
  let llamadaInit = {};

  const mockFetch = async (url, init) => {
    llamadaUrl = url;
    llamadaInit = init;
    return new Response(
      JSON.stringify({
        id: '00000000-0000-4000-8000-000000000001',
        identifier: 'SIGA-E-2026-0001',
        lifecycleState: 'DRAFT',
        anchorStatus: 'NOT_REQUESTED',
        notice: 'SIMULACRO',
      }),
      {
        status: 201,
        headers: { 'Content-Type': 'application/json', ETag: '"v1"' },
      },
    );
  };

  const cliente = crearClienteAlertas(mockFetch);
  const input = {
    kind: 'Alert',
    info: {
      scenario: 'INUNDACION',
      event: 'Inundación',
      severity: 'Severe',
      urgency: 'Immediate',
      certainty: 'Observed',
      headline: 'SIMULACRO: Inundación de prueba',
      description: 'Texto de prueba de más de diez caracteres.',
      expires: '2026-11-01T23:00:00Z',
      areaDesc: 'Zona de prueba',
    },
    references: [],
  };

  const res = await cliente.crearBorrador(input, 'csrf-token-valido-123');

  assert.equal(llamadaUrl, '/api/v1/alerts');
  assert.equal(llamadaInit.method, 'POST');
  assert.equal(llamadaInit.headers['X-CSRF-Token'], 'csrf-token-valido-123');
  assert.equal(llamadaInit.headers['Content-Type'], 'application/json');
  assert.equal(res.ok, true);
  if (res.ok) {
    assert.equal(res.alerta.id, '00000000-0000-4000-8000-000000000001');
    assert.equal(res.alerta.identifier, 'SIGA-E-2026-0001');
    assert.equal(res.alerta.lifecycleState, 'DRAFT');
    assert.equal(res.version, 1);
  }
});

test('clienteAlertas.crearBorrador: si endpoint devuelve 404/501 (no montado), devuelve no-disponible y NUNCA éxito', async () => {
  const mockFetch = async () => {
    return new Response(JSON.stringify({ code: 'NOT_FOUND', message: 'Cannot POST /api/v1/alerts' }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' },
    });
  };

  const cliente = crearClienteAlertas(mockFetch);
  const input = {
    kind: 'Alert',
    info: {
      scenario: 'INUNDACION',
      event: 'Inundación',
      severity: 'Severe',
      urgency: 'Immediate',
      certainty: 'Observed',
      headline: 'SIMULACRO: Inundación',
      description: 'Texto descriptivo...',
      expires: '2026-11-01T23:00:00Z',
      areaDesc: 'Zona',
    },
  };

  const res = await cliente.crearBorrador(input, 'csrf');
  assert.equal(res.ok, false);
  if (!res.ok) {
    assert.equal(res.motivo, 'no-disponible');
  }
});

test('clienteAlertas.crearBorrador: maneja 401 sin sesión, 403 prohibido y 422 inválido', async () => {
  const mockConEstado = (status) =>
    crearClienteAlertas(async () => new Response('{}', { status, headers: { 'Content-Type': 'application/json' } }));

  const c401 = mockConEstado(401);
  const r401 = await c401.crearBorrador({ kind: 'Alert', info: {} }, 'csrf');
  assert.deepEqual(r401, { ok: false, motivo: 'sin-sesion' });

  const c403 = mockConEstado(403);
  const r403 = await c403.crearBorrador({ kind: 'Alert', info: {} }, 'csrf');
  assert.deepEqual(r403, { ok: false, motivo: 'prohibido' });

  const c422 = mockConEstado(422);
  const r422 = await c422.crearBorrador({ kind: 'Alert', info: {} }, 'csrf');
  assert.deepEqual(r422, { ok: false, motivo: 'invalido' });
});

test('clienteAlertas.crearBorrador: fallo de red devuelve error-red', async () => {
  const mockRedError = async () => {
    throw new Error('Network error');
  };

  const cliente = crearClienteAlertas(mockRedError);
  const res = await cliente.crearBorrador({ kind: 'Alert', info: {} }, 'csrf');
  assert.deepEqual(res, { ok: false, motivo: 'error-red' });
});

// PRUEBAS NEGATIVAS Y AISLAMIENTO DE SEGURIDAD (F4-A.1)

test('aislamiento DEMO: rechazo estricto sin CSRF válido (fail-closed, 0 peticiones de red)', async () => {
  let peticionesRealizadas = 0;
  const mockFetch = async () => {
    peticionesRealizadas++;
    return new Response('{}', { status: 200 });
  };

  const cliente = crearClienteAlertas(mockFetch);
  const inputValido = {
    kind: 'Alert',
    info: {
      scenario: 'INUNDACION',
      event: 'Inundación simulada',
      severity: 'Severe',
      urgency: 'Expected',
      certainty: 'Likely',
      headline: 'SIMULACRO: Desborde controlado',
      description: 'Descripción operativa de prueba',
      expires: '2026-11-01T23:00:00Z',
      areaDesc: 'Área de prueba',
    },
  };

  // Sin CSRF o CSRF vacío
  const rVacio = await cliente.crearBorrador(inputValido, '');
  assert.deepEqual(rVacio, { ok: false, motivo: 'prohibido', codigo: 'CSRF_AUSENTE' });
  assert.equal(peticionesRealizadas, 0, 'No debe invocar fetch con CSRF vacío');

  const rEspacios = await cliente.crearBorrador(inputValido, '   ');
  assert.deepEqual(rEspacios, { ok: false, motivo: 'prohibido', codigo: 'CSRF_AUSENTE' });
  assert.equal(peticionesRealizadas, 0, 'No debe invocar fetch con CSRF en blanco');

  const rNull = await cliente.crearBorrador(inputValido, null);
  assert.deepEqual(rNull, { ok: false, motivo: 'prohibido', codigo: 'CSRF_AUSENTE' });
  assert.equal(peticionesRealizadas, 0, 'No debe invocar fetch con CSRF nulo');
});

test('RBAC negativo: un APPROVER o rol no autorizado recibe 403 Forbidden y no puede crear alertas', async () => {
  let llamadaConHeaders = null;
  const mockFetch = async (url, init) => {
    llamadaConHeaders = init.headers;
    return new Response(JSON.stringify({ code: 'FORBIDDEN', message: 'Rol APPROVER no autorizado para crear alertas' }), {
      status: 403,
      headers: { 'Content-Type': 'application/json' },
    });
  };

  const cliente = crearClienteAlertas(mockFetch);
  const input = {
    kind: 'Alert',
    info: {
      scenario: 'INUNDACION',
      event: 'Prueba',
      severity: 'Severe',
      urgency: 'Immediate',
      certainty: 'Observed',
      headline: 'SIMULACRO: Intento no autorizado',
      description: 'Descripción de prueba...',
      expires: '2026-11-01T23:00:00Z',
      areaDesc: 'Área',
    },
  };

  const res = await cliente.crearBorrador(input, 'csrf-approver');
  assert.equal(res.ok, false);
  assert.equal(res.motivo, 'prohibido');
  assert.equal(llamadaConHeaders['X-CSRF-Token'], 'csrf-approver');
});

test('integridad de persistencia: error de API nunca genera AlertSummary ficticio', async () => {
  const codigosFallo = [400, 401, 403, 404, 409, 422, 500, 502, 503];

  for (const status of codigosFallo) {
    const mock = async () => new Response('{}', { status, headers: { 'Content-Type': 'application/json' } });
    const cliente = crearClienteAlertas(mock);
    const res = await cliente.crearBorrador({ kind: 'Alert', info: {} }, 'csrf-token');

    assert.equal(res.ok, false, `Status ${status} no debe producir ok: true`);
    assert.equal('alerta' in res, false, `Status ${status} no debe contener objeto alerta`);
  }
});
