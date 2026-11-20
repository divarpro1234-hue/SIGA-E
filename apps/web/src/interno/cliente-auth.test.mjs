// D08A: adaptador HTTP de autenticación con un fetch FALSO, solo en esta prueba. Comprueba la
// correspondencia con el contrato M1 (OpenAPI + HANDOFF_M1_FINAL) y que falla cerrado.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BASE_API, DURACION_DESAFIO_MS, crearClienteAuth, restanteDesafio, segundosReintento, usuarioDe } from './cliente-auth.mjs';

const TOKEN = 'A'.repeat(43);
const CSRF = 'b'.repeat(43);
const USUARIO = { id: '00000000-0000-4000-8000-000000000001', name: 'Persona ficticia', email: 'persona@example.invalid', role: 'AUTHOR', status: 'ACTIVE' };

/** Respuesta JSON o problem+json. */
function json(status, cuerpo, cabeceras = {}) {
  const tipo = status >= 400 ? 'application/problem+json' : 'application/json; charset=utf-8';
  return new Response(JSON.stringify(cuerpo), { status, headers: { 'content-type': tipo, ...cabeceras } });
}
const problema = (status, code, extra = {}) =>
  json(status, { type: 'about:blank', title: 't', status, code, detail: 'Detalle del servidor que no debe mostrarse', requestId: 'r' }, extra);

/** Fetch falso que registra cada llamada y devuelve la respuesta indicada. */
function falso(respuesta) {
  const llamadas = [];
  const f = async (url, init) => {
    llamadas.push({ url, init });
    if (respuesta instanceof Error) throw respuesta;
    return typeof respuesta === 'function' ? respuesta(url, init) : respuesta.clone();
  };
  return { f, llamadas };
}

test('login: envía email y password solo en el cuerpo, mismo origen, sin caché ni redirecciones', async () => {
  const { f, llamadas } = falso(json(200, { challengeId: TOKEN, expiresAt: '2026-10-19T10:05:00Z' }, { date: 'Mon, 19 Oct 2026 10:00:00 GMT' }));
  const antes = Date.now();
  const r = await crearClienteAuth(f).iniciar('persona@example.invalid', 'contraseña secreta');
  assert.equal(r.tipo, 'desafio');
  assert.equal(r.challengeId, TOKEN);
  // Cinco minutos medidos con el reloj del servidor, sea cual sea el del equipo de la prueba.
  assert.ok(r.expiraEn >= antes + DURACION_DESAFIO_MS && r.expiraEn <= Date.now() + DURACION_DESAFIO_MS, String(r.expiraEn - antes));
  const [{ url, init }] = llamadas;
  assert.equal(url, `${BASE_API}/auth/login`);
  assert.equal(init.method, 'POST');
  assert.equal(init.credentials, 'same-origin');
  assert.equal(init.cache, 'no-store');
  assert.equal(init.redirect, 'error');
  assert.deepEqual(JSON.parse(init.body), { email: 'persona@example.invalid', password: 'contraseña secreta' });
  assert.doesNotMatch(url, /secreta|persona/);
  assert.equal(init.headers['X-CSRF-Token'], undefined);
});

test('login: 401 genérico, 422, 429 con Retry-After, 403, 404 y 5xx', async () => {
  const casos = [
    [problema(401, 'AUTH_REQUIRED'), { tipo: 'rechazado' }],
    [problema(422, 'VALIDATION_ERROR'), { tipo: 'invalido' }],
    [problema(429, 'TOO_MANY_ATTEMPTS', { 'retry-after': '900' }), { tipo: 'limitado', reintentarEn: 900 }],
    [problema(429, 'TOO_MANY_ATTEMPTS'), { tipo: 'limitado', reintentarEn: null }],
    [problema(403, 'CSRF_INVALID'), { tipo: 'prohibido', codigo: 'CSRF_INVALID' }],
    [problema(404, 'ROUTE_NOT_FOUND'), { tipo: 'no-disponible' }],
    [problema(500, 'INTERNAL_ERROR'), { tipo: 'error-servidor' }],
  ];
  for (const [resp, esperado] of casos) {
    const r = await crearClienteAuth(falso(resp).f).iniciar('a@b.cd', 'x');
    assert.deepEqual(r, esperado, String(resp.status));
    assert.equal(JSON.stringify(r).includes('Detalle del servidor'), false, 'detail nunca sale del adaptador');
  }
});

test('login: una respuesta que no es JSON (index.html de un servidor estático) es «no disponible», nunca éxito', async () => {
  for (const status of [200, 401, 403, 404, 405]) {
    const html = new Response('<!doctype html><title>SIGA-E</title>', { status, headers: { 'content-type': 'text/html' } });
    assert.deepEqual(await crearClienteAuth(falso(html).f).iniciar('a@b.cd', 'x'), { tipo: 'no-disponible' }, String(status));
  }
});

test('login: un 5xx o un 429 de un proxy en HTML se dicen como error del servidor o límite', async () => {
  for (const status of [500, 502, 503]) {
    const html = new Response('<html>Bad gateway</html>', { status, headers: { 'content-type': 'text/html' } });
    assert.deepEqual(await crearClienteAuth(falso(html).f).iniciar('a@b.cd', 'x'), { tipo: 'error-servidor' }, String(status));
  }
  const limite = new Response('Too many', { status: 429, headers: { 'content-type': 'text/plain', 'retry-after': '60' } });
  assert.deepEqual(await crearClienteAuth(falso(limite).f).iniciar('a@b.cd', 'x'), { tipo: 'limitado', reintentarEn: 60 });
});

test('restanteDesafio: usa el reloj del servidor y no se fía de un reloj local desviado', () => {
  const exp = Date.parse('2026-10-19T10:05:00Z');
  // Con cabecera Date: cinco minutos aunque el equipo vaya seis minutos adelantado.
  assert.equal(restanteDesafio(exp, 'Mon, 19 Oct 2026 10:00:00 GMT', Date.parse('2026-10-19T10:06:00Z')), DURACION_DESAFIO_MS);
  assert.equal(restanteDesafio(exp, 'Mon, 19 Oct 2026 10:03:00 GMT'), 2 * 60_000);
  // Sin cabecera y con el reloj local adelantado: se usan los cinco minutos del contrato.
  assert.equal(restanteDesafio(exp, null, Date.parse('2026-10-19T10:06:00Z')), DURACION_DESAFIO_MS);
  // Nunca más de cinco minutos, aunque el reloj local vaya atrasado.
  assert.equal(restanteDesafio(exp, null, Date.parse('2026-10-19T09:00:00Z')), DURACION_DESAFIO_MS);
  assert.equal(restanteDesafio(exp, null, Date.parse('2026-10-19T10:04:00Z')), 60_000);
});

test('login: 200 con forma inesperada falla cerrado', async () => {
  for (const cuerpo of [{}, { challengeId: 'corto', expiresAt: '2026-10-19T10:05:00Z' }, { challengeId: TOKEN, expiresAt: 'no es fecha' }, null, [TOKEN]]) {
    assert.deepEqual(await crearClienteAuth(falso(json(200, cuerpo)).f).iniciar('a@b.cd', 'x'), { tipo: 'respuesta-invalida' }, JSON.stringify(cuerpo));
  }
});

test('login: fallo de red y tiempo de espera agotado', async () => {
  assert.deepEqual(await crearClienteAuth(falso(new TypeError('Failed to fetch')).f).iniciar('a@b.cd', 'x'), { tipo: 'error-red' });
  const colgado = (_u, init) =>
    new Promise((_res, rej) => init.signal.addEventListener('abort', () => rej(new DOMException('abort', 'AbortError'))));
  assert.deepEqual(await crearClienteAuth(colgado, { esperaMs: 20 }).iniciar('a@b.cd', 'x'), { tipo: 'error-red' });
});

test('código TOTP: 200 entrega usuario y CSRF; el código va solo en el cuerpo', async () => {
  const { f, llamadas } = falso(json(200, { user: USUARIO, csrfToken: CSRF }));
  const r = await crearClienteAuth(f).verificarCodigo(TOKEN, '123456');
  assert.deepEqual(r, { tipo: 'sesion', usuario: { id: USUARIO.id, nombre: USUARIO.name, correo: USUARIO.email, rol: 'AUTHOR' }, csrf: CSRF });
  assert.equal(llamadas[0].url, `${BASE_API}/auth/totp/verify`);
  assert.deepEqual(JSON.parse(llamadas[0].init.body), { challengeId: TOKEN, code: '123456' });
  assert.doesNotMatch(llamadas[0].url, /123456/);
});

test('código TOTP: 401 (código erróneo, usado o desafío caducado: indistinguibles) y 429', async () => {
  assert.deepEqual(await crearClienteAuth(falso(problema(401, 'AUTH_REQUIRED')).f).verificarCodigo(TOKEN, '000000'), { tipo: 'rechazado' });
  assert.deepEqual(
    await crearClienteAuth(falso(problema(429, 'TOO_MANY_ATTEMPTS', { 'retry-after': '900' })).f).verificarCodigo(TOKEN, '000000'),
    { tipo: 'limitado', reintentarEn: 900 },
  );
});

test('sesión: /auth/me 200 abre; 401 es sin sesión; 404 o HTML es no disponible', async () => {
  const { f, llamadas } = falso(json(200, { user: { ...USUARIO, role: 'APPROVER' }, csrfToken: CSRF }));
  const r = await crearClienteAuth(f).consultarSesion();
  assert.equal(r.tipo, 'sesion');
  assert.equal(r.usuario.rol, 'APPROVER');
  assert.equal(llamadas[0].init.method, 'GET');
  assert.equal(llamadas[0].init.body, undefined);
  assert.deepEqual(await crearClienteAuth(falso(problema(401, 'AUTH_REQUIRED')).f).consultarSesion(), { tipo: 'sin-sesion' });
  assert.deepEqual(await crearClienteAuth(falso(problema(404, 'ROUTE_NOT_FOUND')).f).consultarSesion(), { tipo: 'no-disponible' });
  const html = new Response('<html></html>', { status: 200, headers: { 'content-type': 'text/html' } });
  assert.deepEqual(await crearClienteAuth(falso(html).f).consultarSesion(), { tipo: 'no-disponible' });
});

test('sesión: rol desconocido, cuenta no ACTIVE o CSRF con otra forma no abren el portal', async () => {
  const malos = [
    { user: { ...USUARIO, role: 'SUPERADMIN' }, csrfToken: CSRF },
    { user: { ...USUARIO, role: 'admin' }, csrfToken: CSRF },
    { user: { ...USUARIO, status: 'PENDING_ENROLLMENT' }, csrfToken: CSRF },
    { user: { ...USUARIO, status: 'DISABLED' }, csrfToken: CSRF },
    { user: USUARIO, csrfToken: 'corto' },
    { user: USUARIO },
    { csrfToken: CSRF },
  ];
  for (const cuerpo of malos) {
    assert.deepEqual(await crearClienteAuth(falso(json(200, cuerpo)).f).consultarSesion(), { tipo: 'respuesta-invalida' }, JSON.stringify(cuerpo));
    assert.deepEqual(await crearClienteAuth(falso(json(200, cuerpo)).f).verificarCodigo(TOKEN, '123456'), { tipo: 'respuesta-invalida' });
  }
});

test('cierre: envía X-CSRF-Token; 204 cerrada, 401 sin sesión, 403 CSRF_INVALID prohibido', async () => {
  const { f, llamadas } = falso(new Response(null, { status: 204 }));
  assert.deepEqual(await crearClienteAuth(f).cerrarSesion(CSRF), { tipo: 'cerrada' });
  assert.equal(llamadas[0].url, `${BASE_API}/auth/logout`);
  assert.equal(llamadas[0].init.method, 'POST');
  assert.equal(llamadas[0].init.headers['X-CSRF-Token'], CSRF);
  assert.equal(llamadas[0].init.credentials, 'same-origin');
  assert.deepEqual(await crearClienteAuth(falso(problema(401, 'AUTH_REQUIRED')).f).cerrarSesion(CSRF), { tipo: 'sin-sesion' });
  assert.deepEqual(await crearClienteAuth(falso(problema(403, 'CSRF_INVALID')).f).cerrarSesion(CSRF), { tipo: 'prohibido', codigo: 'CSRF_INVALID' });
  assert.deepEqual(await crearClienteAuth(falso(new TypeError('x')).f).cerrarSesion(CSRF), { tipo: 'error-red' });
  // Un 200 no es el 204 del contrato: no se da por cerrada.
  assert.deepEqual(await crearClienteAuth(falso(json(200, {})).f).cerrarSesion(CSRF), { tipo: 'respuesta-invalida' });
});

test('403 ROLE_FORBIDDEN conserva solo el código, y un code con forma extraña se descarta', async () => {
  assert.deepEqual(await crearClienteAuth(falso(problema(403, 'ROLE_FORBIDDEN')).f).consultarSesion(), { tipo: 'prohibido', codigo: 'ROLE_FORBIDDEN' });
  assert.deepEqual(await crearClienteAuth(falso(problema(403, '<script>')).f).consultarSesion(), { tipo: 'prohibido', codigo: null });
});

test('segundosReintento: segundos, fecha HTTP, valores absurdos', () => {
  assert.equal(segundosReintento('900'), 900);
  assert.equal(segundosReintento(' 60 '), 60);
  assert.equal(segundosReintento('999999'), 86400);
  assert.equal(segundosReintento(null), null);
  assert.equal(segundosReintento('pronto'), null);
  assert.equal(segundosReintento('-5'), null);
  const ahora = Date.parse('2026-10-19T10:00:00Z');
  assert.equal(segundosReintento('Mon, 19 Oct 2026 10:15:00 GMT', ahora), 900);
  assert.equal(segundosReintento('Mon, 19 Oct 2026 09:00:00 GMT', ahora), 0);
});

test('usuarioDe: exige campos acotados', () => {
  assert.ok(usuarioDe(USUARIO));
  assert.equal(usuarioDe({ ...USUARIO, name: '' }), null);
  assert.equal(usuarioDe({ ...USUARIO, name: 'x'.repeat(121) }), null);
  assert.equal(usuarioDe({ ...USUARIO, id: 5 }), null);
  assert.equal(usuarioDe(null), null);
});
