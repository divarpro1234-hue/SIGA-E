import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MAX_NOMBRE_ARCHIVO, nombreArchivoSeguro } from './nombre-archivo.mjs';

test('conserva un nombre simple', () => {
  assert.equal(nombreArchivoSeguro('alerta.jws'), 'alerta.jws');
});

test('elimina rutas locales de cualquier sistema', () => {
  assert.equal(nombreArchivoSeguro('C:\\Users\\maman\\Descargas\\alerta.jws'), 'alerta.jws');
  assert.equal(nombreArchivoSeguro('/home/maman/alerta.jws'), 'alerta.jws');
  assert.equal(nombreArchivoSeguro('..\\..\\secreto.txt'), 'secreto.txt');
});

test('nombre vacío o no cadena: cadena vacía', () => {
  for (const x of ['', '   ', '/', 'dir/', undefined, null, 42, {}]) assert.equal(nombreArchivoSeguro(x), '', String(x));
});

test('acota la longitud', () => {
  assert.equal(nombreArchivoSeguro('a'.repeat(5000)).length, MAX_NOMBRE_ARCHIVO);
});

test('no interpreta nada: el HTML queda como texto tal cual', () => {
  assert.equal(nombreArchivoSeguro('<img src=x onerror=alert(1)>.txt'), '<img src=x onerror=alert(1)>.txt');
});

test('conserva controles y marcas bidireccionales para que TextoAjeno los neutralice', () => {
  assert.equal(nombreArchivoSeguro('a\u202Egnp.exe'), 'a\u202Egnp.exe');
});
