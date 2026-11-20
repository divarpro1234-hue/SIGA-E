// D08A: comprobaciones estáticas del código del portal interno. No sustituyen la revisión, pero fallan
// si alguien introduce almacenamiento persistente, registros, credenciales de demostración o un
// atajo que dé por iniciada una sesión sin el servidor.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const RAIZ = path.dirname(fileURLToPath(import.meta.url));

/** Fuentes del portal (sin pruebas). */
function fuentes(dir = RAIZ) {
  return readdirSync(dir).flatMap((n) => {
    const p = path.join(dir, n);
    if (statSync(p).isDirectory()) return fuentes(p);
    return /\.(mjs|ts|tsx)$/.test(n) && !n.includes('.test.') ? [p] : [];
  });
}
/** Quita comentarios: lo que se revisa es el código, no las explicaciones que nombran lo prohibido. */
const sinComentarios = (t) => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
const archivos = fuentes().map((p) => ({ p: path.relative(RAIZ, p).split(path.sep).join('/'), texto: sinComentarios(readFileSync(p, 'utf8')) }));

test('hay fuentes que revisar', () => {
  assert.ok(archivos.length >= 8, archivos.map((a) => a.p).join(', '));
});

test('sin almacenamiento persistente del navegador ni lectura de cookies', () => {
  for (const { p, texto } of archivos) {
    assert.doesNotMatch(texto, /localStorage|sessionStorage|indexedDB|document\.cookie|caches\.open/, p);
  }
});

test('sin registros en consola (podrían filtrar contraseña, código o token)', () => {
  for (const { p, texto } of archivos) assert.doesNotMatch(texto, /console\.(log|info|debug|warn|error)/, p);
});

test('sin HTML crudo', () => {
  // El patrón se compone por partes para no confundirse con un uso real.
  const html = new RegExp(['dangerously' + 'SetInner' + 'HTML', 'inner' + 'HTML', 'outer' + 'HTML', 'insertAdjacent' + 'HTML'].join('|'));
  for (const { p, texto } of archivos) assert.doesNotMatch(texto, html, p);
});

test('sin credenciales ni cuentas de demostración incrustadas', () => {
  for (const { p, texto } of archivos) {
    assert.doesNotMatch(texto, /\b(password|contrasena|contraseña)\s*[:=]\s*['"][^'"]+['"]/i, p);
    assert.doesNotMatch(texto, /code\s*[:=]\s*['"]\d{6}['"]/, p);
    assert.doesNotMatch(texto, /@example\.(invalid|com|org)/, p);
  }
});

test('sin selector de rol ni rol tomado de la URL o de la interfaz', () => {
  for (const { p, texto } of archivos) {
    assert.doesNotMatch(texto, /<select/, p);
    assert.doesNotMatch(texto, /location\.(search|hash)|URLSearchParams/, p);
  }
});

test('el estado «activa» solo lo fija la respuesta de GET /auth/me', () => {
  const asignaciones = archivos.filter(({ texto }) => /fase:\s*'activa'\s*,/.test(texto));
  assert.deepEqual(asignaciones.map((a) => a.p), ['sesion.ts']);
  const sesion = archivos.find((a) => a.p === 'sesion.ts').texto;
  // Única asignación, dentro del caso 'sesion' de consultarSesion.
  assert.equal((sesion.match(/fase:\s*'activa'\s*,/g) ?? []).length, 1);
  assert.match(sesion, /consultarSesion\(\)[\s\S]*case 'sesion':\s*fijarSesion\(\{ fase: 'activa'/);
});

test('el adaptador no tiene modo demostración ni respuesta de éxito sin red', () => {
  const nucleo = archivos.find((a) => a.p === 'http-interno.mjs').texto;
  assert.doesNotMatch(nucleo, /import\.meta\.env|demo|simulad|mock/i);
  const cliente = archivos.find((a) => a.p === 'cliente-auth.mjs').texto;
  assert.doesNotMatch(cliente, /import\.meta\.env|demo|simulad|mock/i);
  // Cada éxito sale de una respuesta HTTP: no hay objetos de sesión literales.
  assert.doesNotMatch(cliente, /tipo:\s*'sesion',\s*usuario:\s*\{/);
});
