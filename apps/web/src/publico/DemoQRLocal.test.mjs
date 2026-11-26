import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { construirUrlPasaporte } from './pasaporte-qr.mjs';

const source = readFileSync(fileURLToPath(new URL('./DemoQRLocal.tsx', import.meta.url)), 'utf8');
const inicio = readFileSync(fileURLToPath(new URL('../pantallas/Inicio.tsx', import.meta.url)), 'utf8');
const idDemo = 'f64f36e4-73aa-4f3d-b487-cf2a13f2a7b9';

test('la demo sintética genera una URL localhost sin API ni material de autenticación', () => {
  const url = construirUrlPasaporte(idDemo, 'http://localhost:5173');
  assert.equal(url, `http://localhost:5173/alerta/${idDemo}`);
  assert.equal(new URL(url).search, '');
  assert.equal(new URL(url).hash, '');
  assert.match(source, /DEMO LOCAL — DATOS FICTICIOS/);
  assert.match(source, /No acredita publicación, firma digital ni anclaje/);
  assert.match(source, /devolverá 404/);
  assert.doesNotMatch(source, /\b(fetch|listarAlertasPublicas|obtenerAlertaPublica)\s*\(/);
});

test('la integración en Inicio y el componente se limitan explícitamente al modo Vite DEV', () => {
  assert.match(inicio, /import\.meta\.env\.DEV\s*\?\s*<DemoQRLocal\s*\/>/);
  assert.match(source, /if\s*\(!import\.meta\.env\.DEV\)\s*return null/);
});
