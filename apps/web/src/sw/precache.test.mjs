import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  calcularVersion,
  construirPrecache,
  excluir,
  integridadSri,
  renderizarSw,
  rutaSegura,
} from './precache.mjs';

const H1 = 'a'.repeat(64);
const H2 = 'b'.repeat(64);

test('rutaSegura: acepta rutas relativas normalizadas', () => {
  for (const r of ['index.html', 'assets/index-DJ3jcr-8.js', 'icons/icono-192.png', 'manifest.webmanifest']) {
    assert.equal(rutaSegura(r), true, r);
  }
});

test('rutaSegura: rechaza «..», absolutas, barras repetidas, invertidas y caracteres raros', () => {
  const malas = ['', '..', '../x', 'a/../b', 'a/..', '/etc/passwd', 'a//b', 'a/', 'a/./b', 'a\b', 'a b', "a'b", 'a"b', 'a%2e%2e/b', 'a/...', 'https://x/y', 'a\0b'];
  for (const r of malas) assert.equal(rutaSegura(r), false, JSON.stringify(r));
});

test('excluir: sw.js, mapas y .gitkeep', () => {
  assert.equal(excluir('sw.js'), true);
  assert.equal(excluir('assets/index-1.js.map'), true);
  assert.equal(excluir('fonts/.gitkeep'), true);
  assert.equal(excluir('fonts/LICENSE-IBMPlexMono.txt'), true);
  assert.equal(excluir('index.html'), false);
  assert.equal(excluir('assets/sw.js'), false);
});

test('construirPrecache: URLs absolutas, orden estable y exclusiones', () => {
  const a = construirPrecache([
    { ruta: 'sw.js', sha256: H1 },
    { ruta: 'index.html', sha256: H1 },
    { ruta: 'assets/z.js', sha256: H2 },
    { ruta: 'assets/a.js.map', sha256: H1 },
    { ruta: 'fonts/.gitkeep', sha256: H1 },
    { ruta: 'assets/a.js', sha256: H1 },
  ]);
  assert.deepEqual(a.map((e) => e.url), ['/assets/a.js', '/assets/z.js', '/index.html']);
  assert.equal(a[0].integridad, integridadSri(H1));
});

test('construirPrecache: la entrada del llamador no cambia el resultado (determinista)', () => {
  const lista = [
    { ruta: 'b.js', sha256: H1 },
    { ruta: 'a.js', sha256: H2 },
  ];
  const x = construirPrecache(lista);
  const y = construirPrecache([...lista].reverse());
  assert.deepEqual(x, y);
  assert.equal(calcularVersion(x), calcularVersion(y));
});

test('construirPrecache: rechaza rutas inseguras, repetidas y hashes mal formados', () => {
  assert.throws(() => construirPrecache([{ ruta: '../fuera.js', sha256: H1 }]), /no admitida/);
  assert.throws(() => construirPrecache([{ ruta: 'a.js', sha256: H1 }, { ruta: 'a.js', sha256: H2 }]), /repetida/);
  assert.throws(() => construirPrecache([{ ruta: 'a.js', sha256: 'xyz' }]), /SHA-256/);
});

test('calcularVersion: 12 hex, cambia con el contenido y con la lista', () => {
  const base = construirPrecache([{ ruta: 'a.js', sha256: H1 }]);
  const v = calcularVersion(base);
  assert.match(v, /^[0-9a-f]{12}$/);
  assert.notEqual(v, calcularVersion(construirPrecache([{ ruta: 'a.js', sha256: H2 }])));
  assert.notEqual(v, calcularVersion(construirPrecache([{ ruta: 'a.js', sha256: H1 }, { ruta: 'b.js', sha256: H1 }])));
  assert.equal(v, calcularVersion(construirPrecache([{ ruta: 'a.js', sha256: H1 }])));
});

test('integridadSri: formato sha256-base64', () => {
  assert.equal(integridadSri('00'.repeat(32)), `sha256-${'A'.repeat(43)}=`);
});

test('renderizarSw: sustituye los tres marcadores y exige uno de cada', () => {
  const entradas = construirPrecache([{ ruta: 'index.html', sha256: H1 }]);
  const v = calcularVersion(entradas);
  const rutas = ['/', '/verificar', '/verificar/resultado'];
  const plantilla = "const V = '__VERSION__';\nconst P = JSON.parse('__PRECACHE__');\nconst R = JSON.parse('__RUTAS__');\n";
  const salida = renderizarSw(plantilla, v, entradas, rutas);
  assert.ok(!/__(VERSION|PRECACHE|RUTAS)__/.test(salida));
  assert.ok(salida.includes(JSON.stringify(rutas)));
  assert.ok(salida.includes(`'${v}'`));
  const pares = JSON.parse(/JSON\.parse\('(.*)'\)/.exec(salida)[1]);
  assert.deepEqual(pares, [['/index.html', integridadSri(H1)]]);
  assert.throws(() => renderizarSw('sin marcadores', v, entradas, rutas), /__VERSION__/);
  assert.throws(() => renderizarSw("'__VERSION__' '__VERSION__' '__PRECACHE__' '__RUTAS__'", v, entradas, rutas), /__VERSION__/);
  assert.throws(() => renderizarSw(plantilla, 'corta', entradas, rutas), /Versión/);
  assert.throws(() => renderizarSw(plantilla, v, entradas, ['/../x']), /Rutas/);
  assert.throws(() => renderizarSw(plantilla, v, entradas, []), /Rutas/);
});
