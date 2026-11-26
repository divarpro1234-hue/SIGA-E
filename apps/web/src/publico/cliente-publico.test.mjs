import assert from 'node:assert/strict';
import { test } from 'node:test';
import { listarAlertasPublicas, obtenerAlertaPublica } from './cliente-publico.ts';

const ID = '00000000-0000-4000-8000-000000000001';
const DETALLE = {
  alert: {
    id: ID,
    identifier: 'SIGAE-DEMO-0001',
    lifecycleState: 'PUBLISHED',
    anchorStatus: 'CONFIRMED',
    notice: 'SIMULACRO',
    sender: 'urn:siga-e:simulacro',
    sent: '2026-10-20T14:32:00.000Z',
    status: 'Exercise',
    scope: 'Public',
  },
  jwsCompact: 'header.payload.signature',
  signatureMeta: { alg: 'ES256', kid: 'trusted-test-key' },
  anchorEvidenceMeta: {
    network: 'testnet',
    contractId: 'C'.repeat(56),
    anchorStatus: 'CONFIRMED',
    messageKeyHex: 'a'.repeat(64),
    jwsHashHex: 'b'.repeat(64),
    txHash: 'c'.repeat(64),
    checkedAt: null,
    verificationSource: 'backend_metadata',
    note: 'Metadatos del backend; no es una lectura independiente de Soroban.',
  },
};

function respuesta(status, body) {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

test('el UUID inválido se rechaza antes de solicitar el detalle', async () => {
  const originalFetch = globalThis.fetch;
  let llamadas = 0;
  globalThis.fetch = async () => {
    llamadas += 1;
    return respuesta(200, {});
  };
  try {
    await assert.deepEqual(await obtenerAlertaPublica('no-es-uuid'), {
      ok: false,
      motivo: 'respuesta-invalida',
    });
    assert.equal(llamadas, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('un 404 del detalle se clasifica como alerta no encontrada/no publicada', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => respuesta(404, { error: 'not found' });
  try {
    assert.deepEqual(await obtenerAlertaPublica(ID), { ok: false, motivo: 'no-encontrada' });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('el detalle publicado válido usa el endpoint existente, same-origin y sin caché', async () => {
  const originalFetch = globalThis.fetch;
  let llamada;
  globalThis.fetch = async (url, options) => {
    llamada = { url, options };
    return respuesta(200, DETALLE);
  };
  try {
    assert.deepEqual(await obtenerAlertaPublica(ID), { ok: true, detalle: DETALLE });
    assert.equal(llamada.url, `/api/v1/public/alerts/${ID}`);
    assert.equal(llamada.options.credentials, 'same-origin');
    assert.equal(llamada.options.cache, 'no-store');
    assert.equal(llamada.options.headers.Accept, 'application/json');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('el cliente descarta detalles cuya alerta no figura publicada y anclada', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => respuesta(200, {
    ...DETALLE,
    alert: { ...DETALLE.alert, lifecycleState: 'SIGNED_PENDING_ANCHOR' },
  });
  try {
    assert.deepEqual(await obtenerAlertaPublica(ID), {
      ok: false,
      motivo: 'respuesta-invalida',
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('un fallo de red y una respuesta malformada no producen un detalle público', async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => { throw new Error('red privada'); };
    assert.deepEqual(await obtenerAlertaPublica(ID), { ok: false, motivo: 'error' });

    globalThis.fetch = async () => new Response('{', { status: 200 });
    assert.deepEqual(await obtenerAlertaPublica(ID), { ok: false, motivo: 'respuesta-invalida' });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('una lista pública vacía permanece vacía y no fabrica alertas para generar QR', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => respuesta(200, { items: [], page: 1, total: 0 });
  try {
    assert.deepEqual(await listarAlertasPublicas(), { ok: true, items: [], total: 0 });
  } finally {
    globalThis.fetch = originalFetch;
  }
});
