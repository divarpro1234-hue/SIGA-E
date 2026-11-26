import assert from 'node:assert/strict';
import { test } from 'node:test';
import { avisoBlockchainNoComprobable, mensajeErrorPasaporte, mensajeEstadoFirma } from './pasaporte-presentacion.mjs';

test('presenta cada resultado de firma sin convertir errores de confianza en éxito', () => {
  assert.match(mensajeEstadoFirma('verificando'), /Verificando la firma localmente/);
  assert.match(mensajeEstadoFirma('no-comprobable'), /Firma no comprobable/);
  assert.match(mensajeEstadoFirma('verificado', 'VALIDA'), /Firma válida/);
  assert.match(mensajeEstadoFirma('verificado', 'INVALIDA'), /Firma inválida/);
  assert.match(mensajeEstadoFirma('verificado', 'CLAVE_DESCONOCIDA'), /no está en el catálogo/);
  assert.match(mensajeEstadoFirma('verificado', 'CLAVE_REVOCADA'), /revocada/);
  assert.match(mensajeEstadoFirma('verificado', 'FUERA_DE_POLITICA'), /fuera de política/);
});

test('presenta errores de UUID, no publicación, servicio, conexión y contrato inválido', () => {
  assert.match(mensajeErrorPasaporte('uuid-invalido'), /No se realizó ninguna consulta/);
  assert.match(mensajeErrorPasaporte('no-encontrada'), /no estar publicada/);
  assert.match(mensajeErrorPasaporte('no-disponible'), /no está disponible/);
  assert.match(mensajeErrorPasaporte('error'), /conectar/);
  assert.match(mensajeErrorPasaporte('respuesta-invalida'), /respuesta inválida/);
});

test('no presenta metadatos del backend como verificación independiente de Soroban', () => {
  assert.match(avisoBlockchainNoComprobable(), /NO_COMPROBABLE/);
  assert.match(avisoBlockchainNoComprobable(), /no consulta Soroban/);
});
