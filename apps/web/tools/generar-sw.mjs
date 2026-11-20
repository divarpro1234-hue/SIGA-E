// Genera dist/sw.js tras `vite build` (D05): lee dist/, calcula el SHA-256 de cada archivo, deriva la
// versión de la lista y sustituye los marcadores de src/sw/sw.js. Solo node:*, sin dependencias.
// Salida determinista: mismo contenido de dist/ → mismo sw.js, byte a byte.
import { createHash } from 'node:crypto';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { RUTAS } from '../src/app/router.mjs';
import { calcularVersion, construirPrecache, renderizarSw } from '../src/sw/precache.mjs';

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(RAIZ, 'dist');
const PLANTILLA = path.join(RAIZ, 'src', 'sw', 'sw.js');

/** Recorre dist/ y devuelve rutas relativas con «/». Los enlaces simbólicos se rechazan. */
async function listar(dir, prefijo = '') {
  const salida = [];
  for (const entrada of await readdir(dir, { withFileTypes: true })) {
    const ruta = prefijo === '' ? entrada.name : `${prefijo}/${entrada.name}`;
    if (entrada.isSymbolicLink()) throw new Error(`Enlace simbólico en dist/: ${ruta}`);
    if (entrada.isDirectory()) salida.push(...(await listar(path.join(dir, entrada.name), ruta)));
    else if (entrada.isFile()) salida.push(ruta);
  }
  return salida;
}

const rutas = await listar(DIST);
const archivos = [];
for (const ruta of rutas) {
  const bytes = await readFile(path.join(DIST, ...ruta.split('/')));
  archivos.push({ ruta, sha256: createHash('sha256').update(bytes).digest('hex') });
}

const entradas = construirPrecache(archivos);
if (!entradas.some((e) => e.url === '/index.html')) throw new Error('dist/ no contiene index.html');
const version = calcularVersion(entradas);
const salida = renderizarSw(await readFile(PLANTILLA, 'utf8'), version, entradas, Object.values(RUTAS));
await writeFile(path.join(DIST, 'sw.js'), salida, 'utf8');

console.log(`sw.js generado: versión ${version}, ${entradas.length} recursos en el precaché.`);
