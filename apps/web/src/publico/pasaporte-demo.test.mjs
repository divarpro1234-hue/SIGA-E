import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { QRCodeSVG } from 'qrcode.react';
import {
  construirUrlPasaporteDemo,
  construirUrlDemoPasaporte,
  copiarEnlaceDemoPasaporte,
  copiarEnlacePasaporteDemo,
  esUrlPasaporteDemoSegura,
  esUrlDemoPasaporteSegura,
  obtenerPasaporteDemo,
  PASAPORTES_DEMO,
  PASAPORTE_DEMO,
  rutaPasaporteDemo,
} from './pasaporte-demo.mjs';
import { resolverRuta } from '../app/router.mjs';

const ORIGEN = 'https://siga-e-web.onrender.com';
const ENLACE = `${ORIGEN}/demo/pasaporte`;
const pageSource = readFileSync(fileURLToPath(new URL('./PasaporteDemo.tsx', import.meta.url)), 'utf8');
const bandejaSource = readFileSync(fileURLToPath(new URL('./BandejaSimulacrosDemostrativos.tsx', import.meta.url)), 'utf8');
const qrDemoSource = readFileSync(fileURLToPath(new URL('./CodigoQRSimulacro.tsx', import.meta.url)), 'utf8');
const pasaporteIndividualSource = readFileSync(fileURLToPath(new URL('./PasaporteDemoIndividual.tsx', import.meta.url)), 'utf8');
const qrSource = readFileSync(fileURLToPath(new URL('./ImagenCodigoQR.tsx', import.meta.url)), 'utf8');
const inicioSource = readFileSync(fileURLToPath(new URL('../pantallas/Inicio.tsx', import.meta.url)), 'utf8');
const appSource = readFileSync(fileURLToPath(new URL('../App.tsx', import.meta.url)), 'utf8');
const clientePublicoSource = readFileSync(fileURLToPath(new URL('./cliente-publico.ts', import.meta.url)), 'utf8');

test('la ruta pública de demo es de origen Render y exige HTTPS en producción', () => {
  assert.equal(construirUrlDemoPasaporte(ORIGEN), ENLACE);
  assert.equal(construirUrlDemoPasaporte('http://localhost:5173', false), 'http://localhost:5173/demo/pasaporte');
  for (const origen of ['http://siga-e-web.onrender.com', 'https://otra-app.onrender.com', 'https://user:pass@siga-e-web.onrender.com']) {
    assert.throws(() => construirUrlDemoPasaporte(origen));
  }
});

test('existen exactamente tres simulacros ficticios con identificadores únicos y campos requeridos', () => {
  assert.equal(PASAPORTES_DEMO.length, 3);
  assert.equal(new Set(PASAPORTES_DEMO.map(({ identificador }) => identificador)).size, 3);
  assert.deepEqual(PASAPORTES_DEMO.map(({ identificador, severidad, area }) => [identificador, severidad, area]), [
    ['DEMO-001', 'ALTA', 'Cuenca ficticia de La Paz'],
    ['DEMO-002', 'EXTREMA', 'Ladera ficticia de La Paz'],
    ['DEMO-003', 'MEDIA', 'Vía urbana ficticia de La Paz'],
  ]);
  for (const pasaporte of PASAPORTES_DEMO) {
    assert.match(pasaporte.titulo, /^SIMULACRO:/);
    assert.ok(pasaporte.descripcion.length > 0);
    assert.equal(pasaporte.estado, 'NO PUBLICADA');
    assert.equal(pasaporte.firmaDigital, 'NO DISPONIBLE');
    assert.equal(pasaporte.anclajeBlockchain, 'NO DISPONIBLE');
    assert.equal(obtenerPasaporteDemo(pasaporte.slug), pasaporte);
  }
});

test('cada simulacro tiene una ruta y un QR HTTPS diferentes, asociados a su propio pasaporte', () => {
  const enlaces = PASAPORTES_DEMO.map((pasaporte) => {
    const enlace = construirUrlPasaporteDemo(pasaporte.slug, ORIGEN);
    const url = new URL(enlace);
    assert.equal(url.href, `${ORIGEN}/demo/pasaporte/${pasaporte.slug}`);
    assert.equal(url.search, '');
    assert.equal(url.hash, '');
    assert.equal(esUrlPasaporteDemoSegura(enlace, ORIGEN, pasaporte.slug), true);

    const ruta = resolverRuta(url.pathname);
    assert.equal(ruta.nombre, 'demo-pasaporte-individual');
    assert.equal(ruta.slug, pasaporte.slug);
    assert.equal(obtenerPasaporteDemo(ruta.slug).identificador, pasaporte.identificador);

    const svg = renderToStaticMarkup(createElement(QRCodeSVG, {
      value: enlace,
      title: `Código QR del pasaporte ficticio ${pasaporte.identificador}`,
      size: 240,
      bgColor: '#ffffff',
      fgColor: '#000000',
    }));
    assert.match(svg, /^<svg/);
    assert.match(svg, /#ffffff/i);
    assert.match(svg, /#000000/i);
    return { enlace, svg };
  });
  assert.equal(new Set(enlaces.map(({ enlace }) => enlace)).size, 3);
  assert.equal(new Set(enlaces.map(({ svg }) => svg)).size, 3);
  for (const { enlace } of enlaces) assert.doesNotMatch(enlace, /token|cookie|password|jws|eyJ/i);
});

test('rutas, orígenes y acciones de URL demo rechazan entradas no permitidas', async () => {
  assert.throws(() => rutaPasaporteDemo('slug-desconocido'));
  assert.throws(() => construirUrlPasaporteDemo('slug-desconocido', ORIGEN));
  assert.throws(() => construirUrlPasaporteDemo('crecida-rio-ficticio', 'http://siga-e-web.onrender.com'));
  const enlace = construirUrlPasaporteDemo('crecida-rio-ficticio', ORIGEN);
  for (const url of [
    `${enlace}?token=falso`,
    `${enlace}#jws`,
    `${ORIGEN}/demo/pasaporte/deslizamiento-ficticio`,
    'https://evil.example/demo/pasaporte/crecida-rio-ficticio',
  ]) {
    assert.equal(esUrlPasaporteDemoSegura(url, ORIGEN, 'crecida-rio-ficticio'), false);
  }
  const copiados = [];
  for (const pasaporte of PASAPORTES_DEMO) {
    const url = construirUrlPasaporteDemo(pasaporte.slug, ORIGEN);
    await copiarEnlacePasaporteDemo(url, ORIGEN, pasaporte.slug, { writeText: async (value) => copiados.push(value) });
  }
  assert.deepEqual(copiados, PASAPORTES_DEMO.map(({ slug }) => construirUrlPasaporteDemo(slug, ORIGEN)));
  await assert.rejects(copiarEnlacePasaporteDemo(`https://evil.example/demo/pasaporte/${PASAPORTES_DEMO[0].slug}`, ORIGEN, PASAPORTES_DEMO[0].slug, { writeText: async () => {} }));
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

test('la bandeja de demostración es estática y visualmente separada de la API Live', () => {
  assert.match(inicioSource, /<BandejaPublicaLive\s*\/>/);
  assert.match(inicioSource, /<BandejaSimulacrosDemostrativos\s*\/>/);
  assert.ok(inicioSource.indexOf('<BandejaPublicaLive />') < inicioSource.indexOf('<BandejaSimulacrosDemostrativos />'));
  assert.match(bandejaSource, /Bandeja de Simulacros Demostrativos/);
  assert.match(bandejaSource, /DEMOSTRACIÓN ACADÉMICA/);
  assert.match(bandejaSource, /Los registros de esta sección son ficticios/);
  assert.match(bandejaSource, /PASAPORTES_DEMO\.map/);
  assert.match(bandejaSource, /Ver pasaporte/);
  assert.match(bandejaSource, /Ver código QR/);
  assert.doesNotMatch(bandejaSource, /listarAlertasPublicas|obtenerAlertaPublica|cliente-publico|fetch\s*\(/);
  assert.match(clientePublicoSource, /lifecycleState === 'PUBLISHED'/);
  assert.match(clientePublicoSource, /anchorStatus === 'CONFIRMED'/);
});

test('el modal QR y cada ruta muestran estados explícitos sin crear material criptográfico', () => {
  assert.match(qrDemoSource, /<ImagenCodigoQR\s+value=\{enlace\}/);
  assert.match(qrDemoSource, /abrirDialogoQr/);
  assert.match(qrDemoSource, /cerrarDialogoQr/);
  assert.match(qrDemoSource, /aria-modal="true"/);
  assert.match(qrDemoSource, /Copiar enlace/);
  assert.match(qrDemoSource, /Abrir enlace/);
  assert.match(pasaporteIndividualSource, /PASAPORTE|pasaporte\.identificador/);
  assert.match(pasaporteIndividualSource, /DATOS FICTICIOS/);
  assert.match(pasaporteIndividualSource, /pasaporte\.estado/);
  assert.match(pasaporteIndividualSource, /pasaporte\.firmaDigital/);
  assert.match(pasaporteIndividualSource, /pasaporte\.anclajeBlockchain/);
  assert.doesNotMatch(pasaporteIndividualSource, /jwsCompact|txHash|CONFIRMED|PUBLISHED/);
  assert.match(appSource, /demo-pasaporte-individual.*PasaporteDemoIndividual/);
  assert.equal(resolverRuta('/demo/pasaporte').nombre, 'demo-pasaporte');
});
