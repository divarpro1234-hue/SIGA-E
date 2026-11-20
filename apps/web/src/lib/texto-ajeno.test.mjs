// Pruebas de texto-ajeno.mjs. Ejecutar: node --test apps/web/src/lib/texto-ajeno.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { aNodos, nombreControl, segmentarTextoAjeno, MAX_GRAFEMAS_POR_DEFECTO } from './texto-ajeno.mjs';
import { CASOS } from '../../mocks/_shared/datos.js';

const controles = (r) => r.segmentos.filter((s) => s.tipo === 'control');
const textoPlano = (r) => r.segmentos.filter((s) => s.tipo === 'texto').map((s) => s.valor).join('');
const codigos = (r) => controles(r).map((s) => s.codigo);

test('texto vacío y valores no cadena devuelven sin segmentos', () => {
  for (const v of ['', null, undefined, 42, {}]) {
    const r = segmentarTextoAjeno(v);
    assert.deepEqual(r, { segmentos: [], recortado: false, controles: 0 });
  }
});

test('texto limpio pasa íntegro como un solo segmento', () => {
  const r = segmentarTextoAjeno('Crecida del río Ficticio, año 2026');
  assert.deepEqual(r.segmentos, [{ tipo: 'texto', valor: 'Crecida del río Ficticio, año 2026' }]);
  assert.equal(r.recortado, false);
});

test('salto de línea y tabulación se conservan; CRLF y CR se normalizan a LF', () => {
  const r = segmentarTextoAjeno('a\nb\tc\r\nd\re');
  assert.equal(controles(r).length, 0);
  assert.equal(textoPlano(r), 'a\nb\tc\nd\ne');
});

test('Trojan Source: anulación U+202E y aislantes U+2066 a U+2069 se vuelven marcas', () => {
  const r = segmentarTextoAjeno('acceso‮oreg‬ ⁦ABC⁩ ⁧x⁩ ⁨y⁩');
  assert.deepEqual(codigos(r), [
    'U+202E', 'U+202C', 'U+2066', 'U+2069', 'U+2067', 'U+2069', 'U+2068', 'U+2069',
  ]);
  assert.ok(!/[‪-‮⁦-⁩]/.test(textoPlano(r)));
});

test('todas las marcas bidi de la lista se neutralizan', () => {
  const lista = [0x061c, 0x200e, 0x200f, 0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069];
  for (const cp of lista) {
    const r = segmentarTextoAjeno(`a${String.fromCodePoint(cp)}b`);
    assert.equal(r.controles, 1, `U+${cp.toString(16)}`);
    assert.equal(textoPlano(r), 'ab');
  }
});

test('NUL y ESC se vuelven marcas con nombre', () => {
  const r = segmentarTextoAjeno('a\u0000b\u001B[31mc');
  assert.deepEqual(controles(r), [
    { tipo: 'control', codigo: 'U+0000', nombre: 'Nulo' },
    { tipo: 'control', codigo: 'U+001B', nombre: 'Escape' },
  ]);
  assert.equal(textoPlano(r), 'ab[31mc');
});

test('C0, DEL y C1 completos, salvo LF y tabulación', () => {
  for (let cp = 0; cp <= 0x9f; cp += 1) {
    if (cp === 0x0d) continue; // CR se normaliza antes
    const esperado = cp === 0x09 || cp === 0x0a ? null : cp <= 0x1f || (cp >= 0x7f && cp <= 0x9f);
    const nombre = nombreControl(cp);
    if (cp === 0x09 || cp === 0x0a) assert.equal(nombre, null);
    else if (esperado) assert.notEqual(nombre, null, `U+${cp.toString(16)}`);
    else assert.equal(nombre, null, `U+${cp.toString(16)}`);
  }
});

test('U+200B, U+2060 y U+FEFF se vuelven marcas', () => {
  const r = segmentarTextoAjeno('a​b⁠c﻿d');
  assert.deepEqual(codigos(r), ['U+200B', 'U+2060', 'U+FEFF']);
  assert.equal(textoPlano(r), 'abcd');
});

test('caracteres de etiqueta U+E0000 a U+E007F: cada uno es una marca (contrabando ASCII)', () => {
  const oculto = Array.from('OK', (c) => String.fromCodePoint(0xe0000 + c.charCodeAt(0))).join('');
  const r = segmentarTextoAjeno(`hola${oculto}`);
  assert.deepEqual(codigos(r), ['U+E004F', 'U+E004B']);
  assert.match(controles(r)[0].nombre, /oculta «O»/);
  assert.equal(textoPlano(r), 'hola');
  assert.equal(segmentarTextoAjeno('\u{E0000}\u{E007F}').controles, 2);
});

test('pares sustitutos válidos se conservan; un sustituto suelto es marca', () => {
  const valido = segmentarTextoAjeno('𝒜 😀 𠮷');
  assert.equal(valido.controles, 0);
  assert.equal(textoPlano(valido), '𝒜 😀 𠮷');
  const suelto = segmentarTextoAjeno('a\uD83Db\uDE00c');
  assert.deepEqual(codigos(suelto), ['U+D83D', 'U+DE00']);
  assert.equal(textoPlano(suelto), 'abc');
});

test('emoji con U+200D y U+200C quedan intactos', () => {
  const familia = '👨‍👩‍👧‍👦';
  const bandera = '🏳️‍🌈';
  const persa = 'می‌خواهم';
  const r = segmentarTextoAjeno(`${familia} ${bandera} ${persa}`);
  assert.equal(r.controles, 0);
  assert.equal(textoPlano(r), `${familia} ${bandera} ${persa}`);
  // Cuenta como un grafema cada emoji compuesto: caben en un máximo de 3 grafemas + espacios.
  const corto = segmentarTextoAjeno(familia + familia + familia, { maxGrafemas: 3 });
  assert.equal(corto.recortado, false);
  assert.equal(textoPlano(corto), familia + familia + familia);
});

test('longitud máxima en grafemas: no parte un emoji compuesto ni una letra con acento', () => {
  const r = segmentarTextoAjeno('a👨‍👩‍👧‍👦ébcd', { maxGrafemas: 3 });
  assert.equal(r.recortado, true);
  assert.equal(textoPlano(r), 'a👨‍👩‍👧‍👦é');
  const exacto = segmentarTextoAjeno('abc', { maxGrafemas: 3 });
  assert.equal(exacto.recortado, false);
  assert.equal(segmentarTextoAjeno('abcd', { maxGrafemas: 0 }).segmentos.length, 0);
  assert.equal(segmentarTextoAjeno('abcd', { maxGrafemas: 0 }).recortado, true);
});

test('las marcas cuentan para la longitud máxima y no se pueden esconder en un grafema', () => {
  const r = segmentarTextoAjeno('a' + '\u{E0041}'.repeat(500), { maxGrafemas: 10 });
  assert.equal(r.recortado, true);
  assert.equal(r.controles, 9);
});

test('entrada enorme: se acota antes de procesar y se marca como recortada', () => {
  const r = segmentarTextoAjeno('x'.repeat(5_000_000));
  assert.equal(r.recortado, true);
  assert.equal(textoPlano(r).length, MAX_GRAFEMAS_POR_DEFECTO);
});

test('titular hostil de datos.js: marcas visibles y nada de control en el texto', () => {
  const titular = CASOS.f.contenido.titular;
  assert.equal(Array.from(titular).length, 200);
  const r = segmentarTextoAjeno(titular, { maxGrafemas: 200 });
  assert.deepEqual(codigos(r), ['U+202E', 'U+202C', 'U+2066', 'U+2069']);
  assert.ok(!/[‪-‮⁦-⁩]/.test(textoPlano(r)));
  assert.match(textoPlano(r), /✔ Verificado por SIGA-E/); // el texto se conserva; lo detiene la estructura, no el filtro
});

test('descripción hostil: etiquetas HTML y enlaces quedan como texto literal', () => {
  const r = segmentarTextoAjeno(CASOS.f.contenido.descripcion, { maxGrafemas: 4000 });
  assert.match(textoPlano(r), /<img src=x onerror=alert\(1\)>/);
  assert.ok(codigos(r).includes('U+0007'));
  assert.ok(codigos(r).includes('U+001B'));
  assert.ok(codigos(r).includes('U+0000'));
});

test('aNodos construye con createElement/createTextNode y nunca asigna innerHTML', () => {
  const asignaciones = [];
  const nodo = (tag) => {
    const base = { tag, hijos: [], attrs: {}, append(...h) { this.hijos.push(...h); }, setAttribute(a, v) { this.attrs[a] = v; } };
    return new Proxy(base, {
      set(t, k, v) {
        if (k === 'innerHTML' || k === 'outerHTML' || k === 'insertAdjacentHTML') throw new Error(`asignó ${String(k)}`);
        asignaciones.push(`${tag}.${String(k)}`);
        t[k] = v;
        return true;
      },
    });
  };
  const doc = {
    createDocumentFragment: () => nodo('#fragmento'),
    createTextNode: (valor) => ({ tag: '#texto', valor }),
    createElement: (tag) => nodo(tag),
  };
  const r = segmentarTextoAjeno('a<b>‮b', { maxGrafemas: 6 });
  const frag = aNodos(r, doc);
  assert.deepEqual(frag.hijos.map((h) => h.tag), ['#texto', 'span', '#texto']);
  assert.equal(frag.hijos[0].valor, 'a<b>');
  assert.equal(frag.hijos[1].textContent, 'U+202E');
  assert.equal(frag.hijos[1].className, 'ctl-marca');
  assert.match(frag.hijos[1].attrs['aria-label'], /Anulación de derecha a izquierda/);
  assert.ok(asignaciones.every((a) => /\.(className|textContent)$/.test(a)));
});
