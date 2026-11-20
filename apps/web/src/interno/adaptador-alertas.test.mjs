import assert from 'node:assert/strict';
import { test } from 'node:test';
import { crearClienteAlertas } from './adaptador-alertas.mjs';

const id = '00000000-0000-4000-8000-000000000001';
const resumen = {
  id,
  identifier: 'SIGA-E-2026-0001',
  lifecycleState: 'DRAFT',
  anchorStatus: 'NOT_REQUESTED',
  notice: 'SIMULACRO',
};
const info = {
  scenario: 'DESLIZAMIENTO',
  event: 'Simulacro de deslizamiento',
  severity: 'Severe',
  urgency: 'Immediate',
  certainty: 'Possible',
  headline: 'SIMULACRO: alerta de prueba',
  description: 'Texto de prueba no confiable.',
  expires: '2027-01-01T00:00:00.000Z',
  areaDesc: 'Zona ficticia',
};
const detalle = { ...resumen, version: 4, kind: 'Alert', info };
const digest = 'a'.repeat(64);
const digestAprobado = 'b'.repeat(64);
const detalleAprobador = {
  ...resumen,
  lifecycleState: 'PENDING_APPROVAL',
  authorId: '00000000-0000-4000-8000-000000000002',
  kind: 'Alert',
  severity: 'Severe',
  version: 7,
  reviewSnapshot: { payloadBase64Url: 'cGF5bG9hZA', payloadDigestHex: digestAprobado },
};

function respuesta(cuerpo, status = 200, headers = {}) {
  return new Response(JSON.stringify(cuerpo), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

test('listarAlertas envía page/limit y adapta la respuesta paginada sin inventar campos', async () => {
  let llamada;
  const cliente = crearClienteAlertas(async (url, init) => {
    llamada = { url, init };
    return respuesta({ items: [resumen], page: 1, total: 1 });
  });

  const res = await cliente.listarAlertas();

  assert.equal(llamada.url, '/api/v1/alerts?page=1&limit=20');
  assert.equal(llamada.init.method, 'GET');
  assert.equal(llamada.init.headers['X-CSRF-Token'], undefined);
  assert.equal(res.ok, true);
  if (res.ok) {
    assert.equal(res.page, 1);
    assert.equal(res.total, 1);
    assert.equal(res.alertas[0].identifier, resumen.identifier);
    assert.equal(res.alertas[0].lifecycleState, 'DRAFT');
    assert.equal('info' in res.alertas[0], false);
    assert.equal('sent' in res.alertas[0], false);
    assert.equal('author' in res.alertas[0], false);
  }
});

test('listarAlertas permite paginación contractual y rechaza respuestas no paginadas', async () => {
  let llamadaUrl = '';
  const cliente = crearClienteAlertas(async (url) => {
    llamadaUrl = url;
    return respuesta({ items: [], page: 2, total: 21 });
  });

  const res = await cliente.listarAlertas({ page: 2, limit: 10 });
  assert.equal(llamadaUrl, '/api/v1/alerts?page=2&limit=10');
  assert.deepEqual(res, { ok: true, alertas: [], page: 2, total: 21 });

  const clienteInvalido = crearClienteAlertas(async () => respuesta([]));
  assert.deepEqual(await clienteInvalido.listarAlertas(), { ok: false, motivo: 'error-servidor' });
});

test('consultarAuditoria lee los eventos de la alerta seleccionada sin transformar datos faltantes', async () => {
  let llamadaUrl = '';
  const evento = {
    seq: '42',
    occurredAt: '2026-11-19T16:00:00.000Z',
    actorId: '00000000-0000-4000-8000-000000000002',
    action: 'ALERT_APPROVED',
    redactedDetails: { status: 'READY_TO_SIGN' },
  };
  const cliente = crearClienteAlertas(async (url, init) => {
    llamadaUrl = url;
    assert.equal(init.method, 'GET');
    assert.equal(init.credentials, 'same-origin');
    return respuesta({ items: [evento] });
  });

  assert.deepEqual(await cliente.consultarAuditoria(id), { ok: true, eventos: [evento] });
  assert.equal(llamadaUrl, `/api/v1/alerts/${id}/audit`);

  const malformada = crearClienteAlertas(async () => respuesta({ items: [{ ...evento, action: 2 }] }));
  assert.deepEqual(await malformada.consultarAuditoria(id), { ok: false, motivo: 'error-servidor' });
});

test('consultarAnclaje solo adapta metadatos reales y de lectura segura', async () => {
  let llamadaUrl = '';
  const evidencia = {
    anchorStatus: 'NOT_REQUESTED',
    network: null,
    contractId: null,
    txHash: null,
    confirmedLedger: null,
    digestVerification: 'NOT_CHECKED',
    checkedAt: null,
    unavailableReason: 'M5_DISABLED',
  };
  const cliente = crearClienteAlertas(async (url, init) => {
    llamadaUrl = url;
    assert.equal(init.method, 'GET');
    return respuesta(evidencia);
  });

  assert.deepEqual(await cliente.consultarAnclaje(id), { ok: true, evidencia });
  assert.equal(llamadaUrl, `/api/v1/alerts/${id}/anchor`);

  const malformada = crearClienteAlertas(async () => respuesta({ ...evidencia, txHash: 42 }));
  assert.deepEqual(await malformada.consultarAnclaje(id), { ok: false, motivo: 'error-servidor' });
});

test('obtenerAlerta transforma detalle AUTHOR y exige ETag fuerte igual a version', async () => {
  let llamadaUrl = '';
  const cliente = crearClienteAlertas(async (url) => {
    llamadaUrl = url;
    return respuesta(detalle, 200, { ETag: '"v4"' });
  });

  const res = await cliente.obtenerAlerta(id);

  assert.equal(llamadaUrl, `/api/v1/alerts/${id}`);
  assert.equal(res.ok, true);
  if (res.ok) {
    assert.equal(res.alerta.version, 4);
    assert.equal(res.alerta.etag, '"v4"');
    assert.equal(res.alerta.info?.headline, info.headline);
    assert.equal('author' in res.alerta, false);
    assert.equal(res.etag, '"v4"');
  }

  const etagObsoleto = crearClienteAlertas(async () => respuesta(detalle, 200, { ETag: 'W/"v4"' }));
  assert.deepEqual(await etagObsoleto.obtenerAlerta(id), { ok: false, motivo: 'error-servidor' });
});

test('obtenerDetalleRevision conserva DTO y snapshot APPROVER, y exige estado, severidad y ETag contractuales', async () => {
  let llamada;
  const cliente = crearClienteAlertas(async (url, init) => {
    llamada = { url, init };
    return respuesta(detalleAprobador, 200, { ETag: '"v7"' });
  });

  const res = await cliente.obtenerDetalleRevision(id);

  assert.equal(llamada.url, `/api/v1/alerts/${id}`);
  assert.equal(llamada.init.method, 'GET');
  assert.equal(llamada.init.headers['X-CSRF-Token'], undefined);
  assert.equal(res.ok, true);
  if (res.ok) {
    assert.equal(res.alerta.authorId, detalleAprobador.authorId);
    assert.equal(res.alerta.kind, 'Alert');
    assert.equal(res.alerta.severity, 'Severe');
    assert.equal(res.alerta.lifecycleState, 'PENDING_APPROVAL');
    assert.equal(res.alerta.version, 7);
    assert.deepEqual(res.alerta.reviewSnapshot, detalleAprobador.reviewSnapshot);
    assert.equal(res.alerta.etag, '"v7"');
    assert.equal('info' in res.alerta, false);
    assert.equal('sender' in res.alerta, false);
  }

  for (const [cambio, etag] of [
    [{ lifecycleState: 'READY_TO_SIGN' }, '"v7"'],
    [{ severity: 'Moderate' }, '"v7"'],
    [{ reviewSnapshot: { ...detalleAprobador.reviewSnapshot, payloadDigestHex: 'B'.repeat(64) } }, '"v7"'],
    [{ reviewSnapshot: { ...detalleAprobador.reviewSnapshot, payloadBase64Url: 'YQ==' } }, '"v7"'],
    [{ reviewSnapshot: { ...detalleAprobador.reviewSnapshot, extra: true } }, '"v7"'],
    [{}, 'W/"v7"'],
    [{ version: 8 }, '"v7"'],
  ]) {
    const clienteInvalido = crearClienteAlertas(async () =>
      respuesta({ ...detalleAprobador, ...cambio }, 200, { ETag: etag }),
    );
    assert.deepEqual(await clienteInvalido.obtenerDetalleRevision(id), { ok: false, motivo: 'error-servidor' });
  }
});

test('aprobarAlerta envía digest y versión autoritativos, CSRF y cookie same-origin; comprueba ETag de resultado', async () => {
  let llamada;
  const cliente = crearClienteAlertas(async (url, init) => {
    llamada = { url, init };
    return respuesta({ ...resumen, lifecycleState: 'READY_TO_SIGN' }, 200, { ETag: '"v8"' });
  });

  const res = await cliente.aprobarAlerta(id, 7, '"v7"', digestAprobado, 'csrf-en-memoria');

  assert.equal(llamada.url, `/api/v1/alerts/${id}/approve`);
  assert.equal(llamada.init.method, 'POST');
  assert.deepEqual(JSON.parse(llamada.init.body), { expectedDigestHex: digestAprobado, expectedVersion: 7 });
  assert.equal(llamada.init.headers['X-CSRF-Token'], 'csrf-en-memoria');
  assert.equal(llamada.init.headers['If-Match'], undefined);
  assert.equal(llamada.init.credentials, 'same-origin');
  assert.deepEqual(res, {
    ok: true,
    alerta: { ...resumen, lifecycleState: 'READY_TO_SIGN' },
    etag: '"v8"',
    version: 8,
  });
});

test('rechazarAlerta envía motivo, digest y versión y no hace HTTP con motivo inválido', async () => {
  let llamada;
  let llamadas = 0;
  const cliente = crearClienteAlertas(async (url, init) => {
    llamadas += 1;
    llamada = { url, init };
    return respuesta({ ...resumen, lifecycleState: 'REJECTED' }, 200, { ETag: '"v8"' });
  });

  const res = await cliente.rechazarAlerta(id, 7, '"v7"', digestAprobado, 'Revisar el área', 'csrf-en-memoria');

  assert.equal(llamada.url, `/api/v1/alerts/${id}/reject`);
  assert.deepEqual(JSON.parse(llamada.init.body), {
    reason: 'Revisar el área',
    expectedDigestHex: digestAprobado,
    expectedVersion: 7,
  });
  assert.equal(llamada.init.headers['X-CSRF-Token'], 'csrf-en-memoria');
  assert.equal(llamada.init.headers['If-Match'], undefined);
  assert.equal(llamada.init.credentials, 'same-origin');
  assert.deepEqual(res, {
    ok: true,
    alerta: { ...resumen, lifecycleState: 'REJECTED' },
    etag: '"v8"',
    version: 8,
  });

  for (const reason of ['', '  ', 'No', '😀😀', 'linea\nsiguiente', 'linea\r\nsiguiente', 'x'.repeat(501)]) {
    assert.deepEqual(await cliente.rechazarAlerta(id, 7, '"v7"', digestAprobado, reason, 'csrf'), {
      ok: false,
      motivo: 'invalido',
    });
  }
  assert.equal(
    (await cliente.rechazarAlerta(id, 7, '"v7"', digestAprobado, '😀😀😀', 'csrf')).ok,
    true,
    'el límite contractual cuenta puntos de código, no unidades UTF-16',
  );
  assert.equal(llamadas, 2);
});

test('las decisiones fallan cerradas ante falta de CSRF, digest o ETag/version discordantes', async () => {
  let llamadas = 0;
  const cliente = crearClienteAlertas(async () => {
    llamadas += 1;
    return respuesta({});
  });

  assert.deepEqual(await cliente.aprobarAlerta(id, 7, '"v7"', digestAprobado, ''), {
    ok: false,
    motivo: 'prohibido',
  });
  assert.deepEqual(await cliente.aprobarAlerta(id, 7, '"v6"', digestAprobado, 'csrf'), {
    ok: false,
    motivo: 'conflicto',
  });
  assert.deepEqual(await cliente.aprobarAlerta(id, 7, '"v7"', 'digest-no-autoritativo', 'csrf'), {
    ok: false,
    motivo: 'conflicto',
  });
  assert.equal(llamadas, 0);
});

test('las decisiones solo aceptan el estado esperado y el ETag de versión resultante', async () => {
  for (const [cuerpo, etag] of [
    [{ ...resumen, lifecycleState: 'REJECTED' }, '"v8"'],
    [{ ...resumen, lifecycleState: 'READY_TO_SIGN' }, '"v9"'],
    [{ ...resumen, id: '00000000-0000-4000-8000-000000000009', lifecycleState: 'READY_TO_SIGN' }, '"v8"'],
  ]) {
    const cliente = crearClienteAlertas(async () => respuesta(cuerpo, 200, { ETag: etag }));
    assert.deepEqual(await cliente.aprobarAlerta(id, 7, '"v7"', digestAprobado, 'csrf'), {
      ok: false,
      motivo: 'error-servidor',
    });
  }
});

test('detalle y decisiones traducen errores HTTP canónicos sin éxito', async () => {
  const esperado = [
    [401, 'sin-sesion'],
    [403, 'prohibido'],
    [404, 'no-encontrada'],
    [409, 'conflicto'],
    [422, 'invalido'],
    [503, 'error-servidor'],
  ];

  for (const [status, motivo] of esperado) {
    const cliente = crearClienteAlertas(async () => respuesta({ code: 'TEST' }, status));
    const motivoDetalle = status === 409 ? 'error-servidor' : motivo;
    assert.deepEqual(await cliente.obtenerDetalleRevision(id), { ok: false, motivo: motivoDetalle });
    assert.deepEqual(await cliente.aprobarAlerta(id, 7, '"v7"', digestAprobado, 'csrf'), { ok: false, motivo });
    assert.deepEqual(
      await cliente.rechazarAlerta(id, 7, '"v7"', digestAprobado, 'Motivo válido', 'csrf'),
      { ok: false, motivo },
    );
  }
});

test('rechazo de fetch se representa como error-red en detalle y ambas decisiones', async () => {
  const cliente = crearClienteAlertas(async () => {
    throw new Error('red simulada');
  });

  assert.deepEqual(await cliente.obtenerDetalleRevision(id), { ok: false, motivo: 'error-red' });
  assert.deepEqual(await cliente.aprobarAlerta(id, 7, '"v7"', digestAprobado, 'csrf'), {
    ok: false,
    motivo: 'error-red',
  });
  assert.deepEqual(
    await cliente.rechazarAlerta(id, 7, '"v7"', digestAprobado, 'Motivo válido', 'csrf'),
    { ok: false, motivo: 'error-red' },
  );
});

test('enviarARevision envía solo expectedVersion, CSRF y cookie same-origin; usa el digest y ETag del servidor', async () => {
  let llamada;
  const cliente = crearClienteAlertas(async (url, init) => {
    llamada = { url, init };
    return respuesta(
      { lifecycleState: 'PENDING_APPROVAL', payloadDigestHex: digest },
      200,
      { ETag: '"v5"' },
    );
  });

  const res = await cliente.enviarARevision(id, 4, '"v4"', 'csrf-en-memoria');

  assert.equal(llamada.url, `/api/v1/alerts/${id}/submit`);
  assert.equal(llamada.init.method, 'POST');
  assert.deepEqual(JSON.parse(llamada.init.body), { expectedVersion: 4 });
  assert.equal(llamada.init.headers['X-CSRF-Token'], 'csrf-en-memoria');
  assert.equal(llamada.init.headers['If-Match'], undefined);
  assert.equal(llamada.init.credentials, 'same-origin');
  assert.deepEqual(res, {
    ok: true,
    lifecycleState: 'PENDING_APPROVAL',
    payloadDigestHex: digest,
    etag: '"v5"',
    version: 5,
  });
});

test('enviarARevision no realiza HTTP sin CSRF o con ETag/version discordantes', async () => {
  let llamadas = 0;
  const cliente = crearClienteAlertas(async () => {
    llamadas += 1;
    return respuesta({});
  });

  assert.deepEqual(await cliente.enviarARevision(id, 4, '"v4"', ''), {
    ok: false,
    motivo: 'prohibido',
  });
  assert.deepEqual(await cliente.enviarARevision(id, 4, '"v3"', 'csrf'), {
    ok: false,
    motivo: 'conflicto',
  });
  assert.equal(llamadas, 0);
});

test('enviarARevision valida contrato de éxito y no inventa digest ni estado', async () => {
  const malformado = crearClienteAlertas(async () =>
    respuesta({ lifecycleState: 'PENDING_APPROVAL', payloadDigestHex: 'digest-local' }, 200, { ETag: '"v5"' }),
  );
  assert.deepEqual(await malformado.enviarARevision(id, 4, '"v4"', 'csrf'), {
    ok: false,
    motivo: 'error-servidor',
  });

  const etagInconsistente = crearClienteAlertas(async () =>
    respuesta({ lifecycleState: 'READY_TO_SIGN', payloadDigestHex: digest }, 200, { ETag: '"v6"' }),
  );
  assert.deepEqual(await etagInconsistente.enviarARevision(id, 4, '"v4"', 'csrf'), {
    ok: false,
    motivo: 'error-servidor',
  });
});

test('listado, detalle y submit traducen errores HTTP canónicos sin éxito', async () => {
  const esperado = [
    [401, 'sin-sesion'],
    [403, 'prohibido'],
    [404, 'no-encontrada'],
    [409, 'conflicto'],
    [422, 'invalido'],
    [503, 'error-servidor'],
  ];

  for (const [status, motivo] of esperado) {
    const cliente = crearClienteAlertas(async () => respuesta({ code: 'TEST' }, status));
    const motivoDetalle = status === 409 ? 'error-servidor' : motivo;
    assert.deepEqual(await cliente.obtenerAlerta(id), { ok: false, motivo: motivoDetalle });
    assert.deepEqual(await cliente.enviarARevision(id, 4, '"v4"', 'csrf'), { ok: false, motivo });
  }
});

test('rechazos de fetch se convierten en error-red para consulta y mutación', async () => {
  const cliente = crearClienteAlertas(async () => {
    throw new Error('red simulada');
  });

  assert.deepEqual(await cliente.listarAlertas(), { ok: false, motivo: 'error-red' });
  assert.deepEqual(await cliente.obtenerAlerta(id), { ok: false, motivo: 'error-red' });
  assert.deepEqual(await cliente.enviarARevision(id, 4, '"v4"', 'csrf'), {
    ok: false,
    motivo: 'error-red',
  });
});
