import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const source = readFileSync(fileURLToPath(new URL('./CodigoQRAlerta.tsx', import.meta.url)), 'utf8');
const efectoApertura = source.match(/useLayoutEffect\(\(\) => \{([\s\S]*?)\}, \[\]\);/)?.[1];

test('el replay de efectos de React StrictMode no cierra el dialog QR recién abierto', () => {
  assert.ok(efectoApertura, 'debe encontrarse el efecto que abre el modal');
  assert.match(efectoApertura, /abrirDialogoQr/);
  assert.doesNotMatch(efectoApertura, /return\s*\(\)\s*=>/);
  assert.doesNotMatch(efectoApertura, /cerrarDialogoQr/);
});
