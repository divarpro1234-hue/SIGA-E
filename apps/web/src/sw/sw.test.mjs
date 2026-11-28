// Comportamiento del service worker ejecutado en un contexto aislado de Node con dobles de prueba.
// No es el navegador real: la validación en navegador está en el informe de D05.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { test } from 'node:test';
import { normalizarRuta, RUTAS, RUTAS_PASAPORTES_DEMO } from '../app/router.mjs';
import { calcularVersion, construirPrecache, renderizarSw } from './precache.mjs';

const ORIGEN = 'https://siga.test';
const H = 'c'.repeat(64);

/** Respuesta de red del mismo origen: Node la marca «default», el navegador «basic». */
function basica(cuerpo, estado = 200) {
  const r = new Response(cuerpo, { status: estado });
  Object.defineProperty(r, 'type', { value: 'basic' });
  return r;
}

/** Doble de Request: en Node no admite URL relativas, que es lo que usa el precaché. */
class Peticion {
  constructor(url, init = {}) {
    this.url = url;
    Object.assign(this, init);
  }
}

function cargar({ cacheos = {}, red = async () => basica('red') } = {}) {
  const entradas = construirPrecache([
    { ruta: 'index.html', sha256: H },
    { ruta: 'assets/app.js', sha256: H },
  ]);
  const version = calcularVersion(entradas);
  const codigo = renderizarSw(
    readFileSync(new URL('./sw.js', import.meta.url), 'utf8'),
    version,
    entradas,
    [...Object.values(RUTAS), ...RUTAS_PASAPORTES_DEMO],
  );
  const oyentes = {};
  const almacenes = new Map(Object.entries(cacheos).map(([n, c]) => [n, new Map(Object.entries(c))]));
  const borradas = [];
  const llamadasRed = [];
  const self = {
    location: { origin: ORIGEN },
    addEventListener: (tipo, fn) => (oyentes[tipo] = fn),
    skipWaiting: () => (self.saltado = true),
    saltado: false,
  };
  const caches = {
    keys: async () => [...almacenes.keys()],
    delete: async (n) => (borradas.push(n), almacenes.delete(n)),
    open: async (n) => {
      if (!almacenes.has(n)) almacenes.set(n, new Map());
      const a = almacenes.get(n);
      return { match: async (u) => { const v = a.get(String(u)); return v && v.clone ? v.clone() : v; }, put: async (u, r) => void a.set(String(u), r) };
    },
  };
  const fetchDoble = async (p) => (llamadasRed.push(p), red(p));
  vm.runInNewContext(codigo, { self, caches, fetch: fetchDoble, URL, Request: Peticion, Response, JSON, Set, Error });
  return { oyentes, almacenes, borradas, llamadasRed, version, self };
}

function evento(url, { method = 'GET', mode = 'cors' } = {}) {
  const e = { request: { url, method, mode }, respondida: null, respondWith(p) { e.respondida = p; } };
  return e;
}

test('fetch: ignora POST y otros orígenes (no los intercepta)', () => {
  const { oyentes } = cargar();
  const post = evento(`${ORIGEN}/api/v1/algo`, { method: 'POST' });
  oyentes.fetch(post);
  assert.equal(post.respondida, null);
  const ajeno = evento('https://otro.test/assets/app.js');
  oyentes.fetch(ajeno);
  assert.equal(ajeno.respondida, null);
  const ajenoNav = evento('https://otro.test/', { mode: 'navigate' });
  oyentes.fetch(ajenoNav);
  assert.equal(ajenoNav.respondida, null);
});

test('fetch: GET del mismo origen fuera del precaché no se intercepta', () => {
  const { oyentes } = cargar();
  for (const ruta of ['/api/v1/public/alerts', '/assets/otro.js', '/assets/app.js?x=1', '/sw.js']) {
    const e = evento(`${ORIGEN}${ruta}`);
    oyentes.fetch(e);
    assert.equal(e.respondida, null, ruta);
  }
});

test('navegación a una ruta desconocida: red primero; sin red, /index.html guardado', async () => {
  let enLinea = true;
  const base = cargar({ red: async () => { if (!enLinea) throw new TypeError('offline'); return basica('desde red'); } });
  const nombre = `siga-e-${base.version}`;
  base.almacenes.set(nombre, new Map([['/index.html', new Response('concha')]]));
  const e1 = evento(`${ORIGEN}/no-existe-esta`, { mode: 'navigate' });
  base.oyentes.fetch(e1);
  assert.equal(await (await e1.respondida).text(), 'desde red');
  enLinea = false;
  const e2 = evento(`${ORIGEN}/ruta-desconocida`, { mode: 'navigate' });
  base.oyentes.fetch(e2);
  assert.equal(await (await e2.respondida).text(), 'concha');
});

test('precaché: recurso guardado se sirve sin red; instalación falla si la respuesta no es 200 básica', async () => {
  const c = cargar();
  const nombre = `siga-e-${c.version}`;
  c.almacenes.set(nombre, new Map([['/assets/app.js', new Response('guardado')]]));
  const e = evento(`${ORIGEN}/assets/app.js`);
  c.oyentes.fetch(e);
  assert.equal(await (await e.respondida).text(), 'guardado');
  assert.equal(c.llamadasRed.length, 0);

  const mala = cargar({ red: async () => basica('no', 404) });
  const redirigida = cargar({ red: async () => new Response('x', { status: 200 }) });
  let promesa2;
  redirigida.oyentes.install({ waitUntil: (p) => (promesa2 = p) });
  await assert.rejects(promesa2, /no guardable/); // type distinto de «basic»
  let promesa;
  mala.oyentes.install({ waitUntil: (p) => (promesa = p) });
  await assert.rejects(promesa, /no guardable/);
});

test('install guarda todo el precaché con integridad; no llama a skipWaiting', async () => {
  const c = cargar();
  let promesa;
  c.oyentes.install({ waitUntil: (p) => (promesa = p) });
  await promesa;
  const guardadas = [...c.almacenes.get(`siga-e-${c.version}`).keys()].sort();
  assert.deepEqual(guardadas, ['/assets/app.js', '/index.html']);
  assert.ok(c.llamadasRed.every((r) => r.integrity.startsWith('sha256-')));
  assert.equal(c.self.saltado, false);
});

test('activate: borra siga-e-* distintas de la actual y respeta las ajenas', async () => {
  const c = cargar({ cacheos: { 'siga-e-vieja': {}, 'otra-app-1': {} } });
  c.almacenes.set(`siga-e-${c.version}`, new Map());
  let promesa;
  c.oyentes.activate({ waitUntil: (p) => (promesa = p) });
  await promesa;
  assert.deepEqual(c.borradas, ['siga-e-vieja']);
  assert.equal(c.self.clients, undefined);
});

test('message: SKIP_WAITING solo desde un cliente del mismo origen', () => {
  const c = cargar();
  c.oyentes.message({ data: { type: 'SKIP_WAITING' }, origin: 'https://otro.test', source: { url: 'https://otro.test/' } });
  assert.equal(c.self.saltado, false);
  c.oyentes.message({ data: 'SKIP_WAITING', origin: ORIGEN, source: { url: `${ORIGEN}/` } });
  assert.equal(c.self.saltado, false);
  c.oyentes.message({ data: { type: 'SKIP_WAITING' }, origin: ORIGEN, source: { url: 'https://otro.test/' } });
  assert.equal(c.self.saltado, false);
  c.oyentes.message({ data: { type: 'SKIP_WAITING' }, origin: ORIGEN, source: { url: `${ORIGEN}/verificar` } });
  assert.equal(c.self.saltado, true);
});

test('navegación a rutas de la app: cache-first, sin tocar la red, también sin conexión', async () => {
  const c = cargar({ red: async () => { throw new TypeError('offline'); } });
  c.almacenes.set(`siga-e-${c.version}`, new Map([['/index.html', basica('concha')]]));
  for (const ruta of ['/', '/verificar', '/verificar/', '/verificar//resultado', '/verificar/resultado']) {
    const e = evento(`${ORIGEN}${ruta}`, { mode: 'navigate' });
    c.oyentes.fetch(e);
    assert.equal(await (await e.respondida).text(), 'concha', ruta);
  }
  assert.equal(c.llamadasRed.length, 0);
});

test('navegación a la API o a sw.js: no se intercepta, con o sin conexión', () => {
  const c = cargar();
  for (const ruta of ['/api/v1/public/alerts', '/api/v1', '/api', '/sw.js']) {
    const e = evento(`${ORIGEN}${ruta}`, { mode: 'navigate' });
    c.oyentes.fetch(e);
    assert.equal(e.respondida, null, ruta);
    const g = evento(`${ORIGEN}${ruta}`);
    c.oyentes.fetch(g);
    assert.equal(g.respondida, null, ruta);
  }
});

test('paridad: el service worker resuelve las rutas como router.mjs', async () => {
  const c = cargar({ red: async () => basica('red') });
  c.almacenes.set(`siga-e-${c.version}`, new Map([['/index.html', basica('concha')]]));
  const entradas = [
    '/',
    '/verificar',
    '/verificar/',
    '/verificar//',
    '/verificar/resultado/',
    '/demo/pasaporte/crecida-rio-ficticio',
    '/demo/pasaporte/deslizamiento-ficticio/',
    '/demo/pasaporte/interrupcion-vial',
    '/demo/pasaporte/no-existe',
    '//verificar',
    '/Verificar',
    '/verificar/otra',
    '/resultado',
    '/verificar%2Fresultado',
  ];
  const conocidas = new Set([
    ...Object.values(RUTAS),
    ...RUTAS_PASAPORTES_DEMO,
  ]);
  for (const ruta of entradas) {
    const e = evento(`${ORIGEN}${ruta}`, { mode: 'navigate' });
    c.oyentes.fetch(e);
    const cuerpo = await (await e.respondida).text();
    const esperada = conocidas.has(normalizarRuta(new URL(`${ORIGEN}${ruta}`).pathname)) ? 'concha' : 'red';
    assert.equal(cuerpo, esperada, ruta);
  }
});

test('un 200 redirigido no se guarda en el precaché', async () => {
  const c = cargar({
    red: async () => {
      const r = basica('x');
      Object.defineProperty(r, 'redirected', { value: true });
      return r;
    },
  });
  let promesa;
  c.oyentes.install({ waitUntil: (p) => (promesa = p) });
  await assert.rejects(promesa, /no guardable/);
});
