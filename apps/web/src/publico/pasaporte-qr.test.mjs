import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolverRuta } from '../app/router.mjs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { QRCodeSVG } from 'qrcode.react';
import {
  abrirDialogoQr,
  abrirPasaporteDesdeQr,
  cerrarDialogoQr,
  copiarEnlacePasaporte,
  construirUrlPasaporte,
  esUrlPasaporteSegura,
  rutaPasaporteAlerta,
} from './pasaporte-qr.mjs';

const ID = '00000000-0000-4000-8000-000000000001';
const ORIGEN = 'https://siga.example';
const URL_PUBLICA = `${ORIGEN}/alerta/${ID}`;

test('construye URL HTTPS same-origin únicamente para UUID válidos', () => {
  assert.equal(construirUrlPasaporte(ID, ORIGEN), URL_PUBLICA);
  assert.equal(construirUrlPasaporte(ID, 'http://localhost:5173'), `http://localhost:5173/alerta/${ID}`);
  assert.equal(rutaPasaporteAlerta(ID), `/alerta/${ID}`);
  assert.equal(resolverRuta(rutaPasaporteAlerta(ID)).id, ID);
});

test('el botón Abrir pasaporte cierra el modal y navega a la ruta pública del mismo UUID', () => {
  const eventos = [];
  abrirPasaporteDesdeQr(ID, () => eventos.push('cerrar'), (ruta) => eventos.push(ruta));
  assert.deepEqual(eventos, ['cerrar', `/alerta/${ID}`]);
});

test('rechaza UUID inválidos y orígenes inseguros al construir la URL', () => {
  assert.throws(() => construirUrlPasaporte('no-es-uuid', ORIGEN), /inválido/);
  for (const origen of ['http://siga.example', 'https://evil.example/path', 'https://user:pass@siga.example']) {
    assert.throws(() => construirUrlPasaporte(ID, origen));
  }
});

test('rechaza esquemas, dominios externos, parámetros y material ajeno al pasaporte', () => {
  assert.equal(esUrlPasaporteSegura(URL_PUBLICA, ORIGEN), true);
  for (const url of [
    `https://evil.example/alerta/${ID}`,
    `http://siga.example/alerta/${ID}`,
    `javascript:alert(1)`,
    `${URL_PUBLICA}?token=secret`,
    `${URL_PUBLICA}#jws`,
    `${ORIGEN}/alerta/${ID}/extra`,
    `${ORIGEN}/alerta/no-es-uuid`,
  ]) {
    assert.equal(esUrlPasaporteSegura(url, ORIGEN), false, url);
  }
});

test('la URL generada no contiene credenciales, tokens ni un JWS', () => {
  const url = construirUrlPasaporte(ID, ORIGEN);
  assert.equal(new URL(url).username, '');
  assert.equal(new URL(url).password, '');
  assert.equal(new URL(url).search, '');
  assert.equal(new URL(url).hash, '');
  assert.equal(url.includes('eyJ'), false);
});

test('el botón copiar escribe solo el enlace validado y falla cerrado para un enlace externo', async () => {
  const copiados = [];
  const portapapeles = { writeText: async (value) => copiados.push(value) };
  await copiarEnlacePasaporte(URL_PUBLICA, ORIGEN, portapapeles);
  assert.deepEqual(copiados, [URL_PUBLICA]);
  await assert.rejects(copiarEnlacePasaporte(`https://evil.example/alerta/${ID}`, ORIGEN, portapapeles));
  assert.equal(copiados.length, 1);
});

test('el diálogo abre con foco en Cerrar, cierra y puede restaurar el foco al disparador', () => {
  const eventos = [];
  const dialogo = {
    open: false,
    showModal() { this.open = true; eventos.push('mostrar'); },
    close() { this.open = false; eventos.push('cerrar'); },
  };
  const botonCerrar = { focus() { eventos.push('foco-cerrar'); } };
  const disparador = { focus() { eventos.push('foco-disparador'); } };

  abrirDialogoQr(dialogo, botonCerrar);
  assert.equal(dialogo.open, true);
  cerrarDialogoQr(dialogo, () => eventos.push('estado-cerrado'), disparador);

  assert.deepEqual(eventos, ['mostrar', 'foco-cerrar', 'cerrar', 'estado-cerrado', 'foco-disparador']);
  assert.equal(dialogo.open, false);
});

test('QRCodeSVG genera un QR escaneable local con etiqueta DEMO LOCAL y título accesible', () => {
  const enlaceDemoLocal = construirUrlPasaporte(ID, 'https://demo.local');
  const svg = renderToStaticMarkup(createElement(QRCodeSVG, {
    value: enlaceDemoLocal,
    size: 240,
    level: 'M',
    includeMargin: true,
    bgColor: '#ffffff',
    fgColor: '#111827',
    title: `DEMO LOCAL: pasaporte de prueba ${ID}`,
  }));
  assert.match(svg, /^<svg/);
  assert.match(svg, /DEMO LOCAL: pasaporte de prueba/);
  assert.match(svg, /width="240"/);
});
