// D08A: estado de sesión en memoria. Una respuesta de /auth/me que llega tarde (lanzada antes de cerrar
// sesión o antes de completar el TOTP) no puede reabrir ni cerrar el portal. fetch FALSO, solo aquí.
import assert from 'node:assert/strict';
import { test } from 'node:test';

const CSRF = 'k'.repeat(43);
const pendientes = [];
globalThis.fetch = (url) =>
  new Promise((resolver) => {
    pendientes.push({ url, resolver });
  });
const responder = (i, status, cuerpo) =>
  pendientes[i].resolver(
    new Response(cuerpo === undefined ? null : JSON.stringify(cuerpo), {
      status,
      headers: { 'content-type': status >= 400 ? 'application/problem+json' : 'application/json' },
    }),
  );
const usuario = { id: 'u1', name: 'Persona de prueba', email: 'p@prueba.invalid', role: 'ADMIN', status: 'ACTIVE' };

const { codigoAceptado, comprobarSesion, leerSesion, olvidarTodo } = await import('./sesion.ts');

test('sin respuesta del servidor, el estado es «comprobando», nunca «activa»', async () => {
  const p = comprobarSesion();
  assert.equal(leerSesion().fase, 'comprobando');
  responder(0, 200, { user: usuario, csrfToken: CSRF });
  await p;
  assert.equal(leerSesion().fase, 'activa');
  assert.equal(leerSesion().usuario.rol, 'ADMIN');
});

test('un corte de red con sesión confirmada la conserva con aviso; el 200 siguiente lo quita', async () => {
  const p = comprobarSesion();
  pendientes[1].resolver(Promise.reject(new TypeError('Failed to fetch')));
  await p;
  assert.equal(leerSesion().fase, 'activa');
  assert.equal(leerSesion().sinConfirmar, 'red');
  const q = comprobarSesion();
  responder(2, 200, { user: usuario, csrfToken: CSRF });
  await q;
  assert.equal(leerSesion().sinConfirmar, undefined);
});

test('401 tras una sesión activa se presenta como vencida', async () => {
  const p = comprobarSesion();
  assert.equal(leerSesion().fase, 'activa', 'mientras comprueba, la sesión confirmada no parpadea');
  responder(3, 401, { code: 'AUTH_REQUIRED' });
  await p;
  assert.deepEqual(leerSesion(), { fase: 'sin-sesion', motivo: 'vencida' });
});

test('una respuesta 200 tardía de /auth/me no reabre el portal tras cerrar sesión', async () => {
  const p = comprobarSesion();
  olvidarTodo('cerrada');
  responder(4, 200, { user: usuario, csrfToken: CSRF });
  await p;
  assert.deepEqual(leerSesion(), { fase: 'sin-sesion', motivo: 'cerrada' });
});

test('un 401 lanzado antes del TOTP no invalida la sesión recién creada', async () => {
  const vieja = comprobarSesion();
  codigoAceptado();
  assert.equal(leerSesion().fase, 'comprobando');
  const nueva = comprobarSesion();
  assert.equal(pendientes.length, 7, 'tras el TOTP se lanza una consulta nueva, no se reutiliza la vieja');
  responder(5, 401, { code: 'AUTH_REQUIRED' });
  await vieja;
  assert.equal(leerSesion().fase, 'comprobando', 'la respuesta vieja se descarta');
  responder(6, 200, { user: { ...usuario, role: 'APPROVER' }, csrfToken: CSRF });
  await nueva;
  assert.equal(leerSesion().fase, 'activa');
  assert.equal(leerSesion().usuario.rol, 'APPROVER');
});
