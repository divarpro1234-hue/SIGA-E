// D09-1: núcleo HTTP compartido del portal interno, con un fetch FALSO solo en esta prueba.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BASE_API, codigoProblema, crearTransporte, esJson, falloComun } from './http-interno.mjs';

function falso(respuesta) {
  const llamadas = [];
  const f = async (url, init) => {
    llamadas.push({ url, init });
    if (respuesta instanceof Error) throw respuesta;
    return respuesta.clone();
  };
  return { f, llamadas };
}
const json = (status, cuerpo, cabeceras = {}) =>
  new Response(JSON.stringify(cuerpo), { status, headers: { 'content-type': 'application/json', ...cabeceras } });

test('opciones fijas: mismo origen, sin caché, sin redirecciones, con señal de cancelación', async () => {
  const { f, llamadas } = falso(json(200, { ok: 1 }));
  const r = await crearTransporte(f)('GET', '/alerts');
  assert.equal(r.r.status, 200);
  assert.deepEqual(r.cuerpo, { ok: 1 });
  const { url, init } = llamadas[0];
  assert.equal(url, `${BASE_API}/alerts`);
  assert.equal(init.credentials, 'same-origin');
  assert.equal(init.cache, 'no-store');
  assert.equal(init.redirect, 'error');
  assert.ok(init.signal instanceof AbortSignal);
});

test('GET sin cuerpo ni Content-Type; CSRF solo si se pasa y solo en cabecera', async () => {
  const { f, llamadas } = falso(json(200, {}));
  const llamar = crearTransporte(f);
  await llamar('GET', '/alerts');
  assert.equal(llamadas[0].init.body, undefined);
  assert.equal(llamadas[0].init.headers['Content-Type'], undefined);
  assert.equal(llamadas[0].init.headers['X-CSRF-Token'], undefined);
  const csrf = 'k'.repeat(43);
  await llamar('PATCH', '/alerts/x', { cuerpo: { a: 1 }, csrf });
  assert.equal(llamadas[1].init.method, 'PATCH');
  assert.equal(llamadas[1].init.headers['Content-Type'], 'application/json');
  assert.equal(llamadas[1].init.headers['X-CSRF-Token'], csrf);
  assert.equal(JSON.parse(llamadas[1].init.body).a, 1);
  assert.doesNotMatch(llamadas[1].url, new RegExp(csrf));
});

test('respuestas no JSON: 5xx → error-servidor, 429 → limitado, resto → no disponible', async () => {
  const html = (status, extra = {}) => new Response('<html></html>', { status, headers: { 'content-type': 'text/html', ...extra } });
  assert.deepEqual(await crearTransporte(falso(html(502)).f)('GET', '/x'), { tipo: 'error-servidor' });
  assert.deepEqual(await crearTransporte(falso(html(429, { 'retry-after': '30' })).f)('GET', '/x'), { tipo: 'limitado', reintentarEn: 30 });
  for (const s of [200, 401, 403, 404]) assert.deepEqual(await crearTransporte(falso(html(s)).f)('GET', '/x'), { tipo: 'no-disponible' }, String(s));
});

test('204 sin cuerpo se entrega al llamador; JSON corrupto llega como cuerpo indefinido', async () => {
  const r204 = await crearTransporte(falso(new Response(null, { status: 204 })).f)('POST', '/x');
  assert.equal(r204.r.status, 204);
  assert.equal(r204.cuerpo, undefined);
  const roto = new Response('{no es json', { status: 200, headers: { 'content-type': 'application/json' } });
  const r = await crearTransporte(falso(roto).f)('GET', '/x');
  assert.equal(r.cuerpo, undefined);
});

test('fallo de red y tiempo de espera → error-red', async () => {
  assert.deepEqual(await crearTransporte(falso(new TypeError('x')).f)('GET', '/x'), { tipo: 'error-red' });
  const colgado = (_u, init) => new Promise((_r, rej) => init.signal.addEventListener('abort', () => rej(new Error('abort'))));
  assert.deepEqual(await crearTransporte(colgado, { esperaMs: 10 })('GET', '/x'), { tipo: 'error-red' });
});

test('esJson y codigoProblema', () => {
  assert.equal(esJson(new Response('', { headers: { 'content-type': 'application/problem+json' } })), true);
  assert.equal(esJson(new Response('', { headers: { 'content-type': 'Application/JSON; charset=utf-8' } })), true);
  assert.equal(esJson(new Response('', { headers: { 'content-type': 'text/plain' } })), false);
  assert.equal(codigoProblema({ code: 'STALE_ALERT_VERSION' }), 'STALE_ALERT_VERSION');
  for (const c of [{ code: 'minusculas' }, { code: '<b>' }, { code: 5 }, null, 'x', { code: 'A'.repeat(65) }]) assert.equal(codigoProblema(c), null);
});

test('falloComun: misma tabla que D08A', () => {
  const r = (status, h = {}) => new Response(null, { status, headers: h });
  assert.deepEqual(falloComun(r(404), {}), { tipo: 'no-disponible' });
  assert.deepEqual(falloComun(r(405), {}), { tipo: 'no-disponible' });
  assert.deepEqual(falloComun(r(501), {}), { tipo: 'no-disponible' });
  assert.deepEqual(falloComun(r(429, { 'retry-after': '900' }), {}), { tipo: 'limitado', reintentarEn: 900 });
  assert.deepEqual(falloComun(r(403), { code: 'ROLE_FORBIDDEN' }), { tipo: 'prohibido', codigo: 'ROLE_FORBIDDEN' });
  assert.deepEqual(falloComun(r(422), {}), { tipo: 'invalido' });
  assert.deepEqual(falloComun(r(503), {}), { tipo: 'error-servidor' });
  for (const s of [200, 201, 202, 204, 401, 409]) assert.equal(falloComun(r(s), {}), null, String(s));
});
