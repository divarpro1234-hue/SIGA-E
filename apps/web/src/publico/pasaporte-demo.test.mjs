import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { QRCodeSVG } from 'qrcode.react';
import {
  construirUrlDemoPasaporte,
  copiarEnlaceDemoPasaporte,
  esUrlDemoPasaporteSegura,
  PASAPORTE_DEMO,
} from './pasaporte-demo.mjs';

const ORIGEN = 'https://siga-e-web.onrender.com';
const ENLACE = `${ORIGEN}/demo/pasaporte`;
const pageSource = readFileSync(fileURLToPath(new URL('./PasaporteDemo.tsx', import.meta.url)), 'utf8');
const qrSource = readFileSync(fileURLToPath(new URL('./ImagenCodigoQR.tsx', import.meta.url)), 'utf8');
const inicioSource = readFileSync(fileURLToPath(new URL('../pantallas/Inicio.tsx', import.meta.url)), 'utf8');

test('la ruta pública de demo es de origen Render y exige HTTPS en producción', () => {
  assert.equal(construirUrlDemoPasaporte(ORIGEN), ENLACE);
  assert.equal(construirUrlDemoPasaporte('http://localhost:5173', false), 'http://localhost:5173/demo/pasaporte');
  for (const origen of ['http://siga-e-web.onrender.com', 'https://otra-app.onrender.com', 'https://user:pass@siga-e-web.onrender.com']) {
    assert.throws(() => construirUrlDemoPasaporte(origen));
  }
});

test('el QR contiene solo la URL fija, sin query, fragmentos ni material secreto', async () => {
  const enlace = construirUrlDemoPasaporte(ORIGEN);
  assert.equal(enlace, ENLACE);
  assert.equal(esUrlDemoPasaporteSegura(enlace, ORIGEN), true);
  for (const url of [`${ENLACE}?token=falso`, `${ENLACE}#jws`, `${ENLACE}/extra`, 'https://evil.example/demo/pasaporte']) {
    assert.equal(esUrlDemoPasaporteSegura(url, ORIGEN), false);
  }
  assert.doesNotMatch(enlace, /token|cookie|password|jws|eyJ/i);
  assert.match(pageSource, /<ImagenCodigoQR\s+value=\{enlace\.url\}/);
  assert.match(qrSource, /<QRCodeSVG[\s\S]*value=\{value\}/);
  assert.match(qrSource, /bgColor="#ffffff"/);
  assert.match(qrSource, /fgColor="#000000"/);

  const svg = renderToStaticMarkup(createElement(QRCodeSVG, {
    value: enlace,
    title: 'Código QR del pasaporte ficticio',
    size: 240,
    bgColor: '#ffffff',
    fgColor: '#000000',
  }));
  assert.match(svg, /^<svg/);
  assert.match(svg, /Código QR del pasaporte ficticio/);

  const copiados = [];
  await copiarEnlaceDemoPasaporte(enlace, ORIGEN, { writeText: async (value) => copiados.push(value) });
  assert.deepEqual(copiados, [ENLACE]);
});

test('el pasaporte renderiza únicamente datos de demostración sin afirmaciones verificadas', () => {
  const markup = renderToStaticMarkup(createElement('dl', {}, ...Object.entries(PASAPORTE_DEMO).flatMap(([key, value]) => [
    createElement('dt', { key: `${key}-label` }, key),
    createElement('dd', { key }, value),
  ])));
  for (const value of [
    'DEMO-PASAPORTE-001',
    'SIMULACRO: Crecida del río Ficticio',
    'Simulacro académico',
    'ALTA',
    'Sector ficticio de La Paz',
    'DEMOSTRACIÓN — NO PUBLICADA',
    'NO DISPONIBLE',
  ]) {
    assert.ok(markup.includes(value), `falta el dato ficticio ${value}`);
  }
  for (const key of Object.keys(PASAPORTE_DEMO)) {
    assert.ok(pageSource.includes(`PASAPORTE_DEMO.${key}`), `la pantalla no muestra el campo ${key}`);
  }
  assert.match(pageSource, /DEMOSTRACIÓN ACADÉMICA — DATOS FICTICIOS/);
  assert.match(pageSource, /SIN FIRMA DIGITAL NI ANCLAJE BLOCKCHAIN/);
  assert.match(pageSource, /Firma digital<\/dt><dd>\{PASAPORTE_DEMO\.firmaDigital\}/);
  assert.match(pageSource, /Anclaje blockchain<\/dt><dd>\{PASAPORTE_DEMO\.anclajeBlockchain\}/);
  assert.doesNotMatch(pageSource, /VALIDA|VERIFICADO|CONFIRMED|txHash|jwsCompact/);
});

test('el acceso a la demo está siempre en Inicio, fuera del estado de la bandeja y de DEV', () => {
  const inicio = inicioSource.indexOf('Probar Pasaporte Digital QR');
  const bandeja = inicioSource.indexOf('<BandejaPublicaLive />');
  assert.notEqual(inicio, -1);
  assert.ok(inicio < bandeja, 'el acceso visible debe estar fuera y antes de la bandeja');
  assert.match(inicioSource, /onClick=\{\(\) => navegar\(RUTAS\['demo-pasaporte'\]\)\}/);
  assert.doesNotMatch(inicioSource, /import\.meta\.env\.DEV.*Probar Pasaporte Digital QR/s);
});
