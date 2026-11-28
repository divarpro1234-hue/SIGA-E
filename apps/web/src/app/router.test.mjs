import assert from 'node:assert/strict';
import { test } from 'node:test';
import { esRutaInterna, normalizarRuta, redireccion, resolverRuta, RUTAS, tituloDocumento, TITULOS } from './router.mjs';
import { esUuidPublico } from '../publico/cliente-publico.ts';

test('normalizarRuta: barra inicial, sin barra final, sin query ni fragmento', () => {
  assert.equal(normalizarRuta('/'), '/');
  assert.equal(normalizarRuta(''), '/');
  assert.equal(normalizarRuta('verificar'), '/verificar');
  assert.equal(normalizarRuta('/verificar/'), '/verificar');
  assert.equal(normalizarRuta('/verificar///resultado//'), '/verificar/resultado');
  assert.equal(normalizarRuta('/verificar?jws=abc'), '/verificar');
  assert.equal(normalizarRuta('/verificar/resultado#x'), '/verificar/resultado');
  assert.equal(normalizarRuta('?solo=query'), '/');
});

test('normalizarRuta: entradas que no son cadena caen en la raíz', () => {
  for (const v of [undefined, null, 5, {}, []]) assert.equal(normalizarRuta(v), '/');
});

test('resolverRuta: rutas conocidas', () => {
  assert.deepEqual(resolverRuta('/'), { nombre: 'inicio', ruta: '/', conocida: true });
  assert.deepEqual(resolverRuta('/verificar'), { nombre: 'verificar', ruta: '/verificar', conocida: true });
  assert.deepEqual(resolverRuta('/verificar/resultado/'), {
    nombre: 'resultado',
    ruta: '/verificar/resultado',
    conocida: true,
  });
  assert.deepEqual(resolverRuta('/demo/pasaporte'), {
    nombre: 'demo-pasaporte',
    ruta: '/demo/pasaporte',
    conocida: true,
  });
});

test('resolverRuta: reconoce únicamente los pasaportes demo permitidos', () => {
  for (const slug of ['crecida-rio-ficticio', 'deslizamiento-ficticio', 'interrupcion-vial']) {
    assert.deepEqual(resolverRuta(`/demo/pasaporte/${slug}`), {
      nombre: 'demo-pasaporte-individual',
      ruta: `/demo/pasaporte/${slug}`,
      conocida: true,
      slug,
    });
  }
  for (const ruta of [
    '/demo/pasaporte/no-existe',
    '/demo/pasaporte/crecida-rio-ficticio/extra',
    '/demo/pasaporte/%63recida-rio-ficticio',
  ]) {
    assert.equal(resolverRuta(ruta).conocida, false, ruta);
  }
});

test('resolverRuta: pasaporte público conserva el ID de la ruta para validarlo antes de consultar', () => {
  const id = '00000000-0000-4000-8000-000000000001';
  assert.deepEqual(resolverRuta(`/alerta/${id}`), {
    nombre: 'pasaporte',
    ruta: `/alerta/${id}`,
    conocida: true,
    id,
  });
  assert.deepEqual(resolverRuta('/alerta/no-es-uuid'), {
    nombre: 'pasaporte',
    ruta: '/alerta/no-es-uuid',
    conocida: true,
    id: 'no-es-uuid',
  });
  assert.equal(resolverRuta(`/alerta/${id}?jws=no#secreto`).id, id);
  assert.equal(resolverRuta(`/alerta/${id}/extra`).conocida, false);
});

test('esUuidPublico: acepta UUID válidos y rechaza valores inválidos o codificados', () => {
  assert.equal(esUuidPublico('00000000-0000-4000-8000-000000000001'), true);
  for (const value of ['', 'no-es-uuid', '%30%30%30%30', '00000000-0000-0000-0000-000000000000', null]) {
    assert.equal(esUuidPublico(value), false);
  }
});

test('resolverRuta: ruta desconocida', () => {
  for (const v of ['/nada', '/Verificar', '/verificar/otro', '/verificar/resultado/x', '/index.html', '/%76erificar']) {
    const r = resolverRuta(v);
    assert.equal(r.nombre, 'no-existe', v);
    assert.equal(r.conocida, false, v);
  }
});

test('resolverRuta: la ruta de origen externo no resuelve', () => {
  assert.equal(resolverRuta('//evil.example/verificar').nombre, 'no-existe');
  assert.equal(resolverRuta('https://evil.example/').nombre, 'no-existe');
});

test('redireccion: resultado sin resultado en memoria vuelve a Verificar', () => {
  assert.equal(redireccion('resultado', false), RUTAS.verificar);
  assert.equal(redireccion('resultado', true), null);
  assert.equal(redireccion('verificar', false), null);
  assert.equal(redireccion('inicio', false), null);
  assert.equal(redireccion('no-existe', false), null);
});

test('RUTAS y TITULOS no llevan parámetros', () => {
  for (const r of Object.values(RUTAS)) assert.doesNotMatch(r, /[?#:]/);
  assert.equal(tituloDocumento('no-existe'), `${TITULOS['no-existe']} · SIGA-E`);
  assert.equal(tituloDocumento('pasaporte'), `${TITULOS.pasaporte} · SIGA-E`);
});

// ---- D08A: portal interno ----

test('resolverRuta: rutas internas conocidas, sin parámetros', () => {
  assert.equal(resolverRuta('/interno').nombre, 'portal');
  assert.equal(resolverRuta('/interno/').nombre, 'portal');
  assert.equal(resolverRuta('/interno/acceso').nombre, 'acceso');
  assert.equal(resolverRuta('/interno/acceso/codigo').nombre, 'codigo');
  assert.equal(resolverRuta('/interno/alertas').nombre, 'portal-alertas');
  assert.equal(resolverRuta('/interno/revision').nombre, 'portal-revision');
  assert.equal(resolverRuta('/interno/administracion').nombre, 'portal-administracion');
  // El desafío o un rol en la URL no cambian nada: se descartan con la query y el fragmento.
  assert.equal(resolverRuta('/interno/acceso/codigo?challengeId=x#rol=ADMIN').nombre, 'codigo');
  for (const v of ['/Interno', '/interno/usuarios', '/interno/acceso/codigo/x', '/interno/ADMIN']) {
    assert.equal(resolverRuta(v).nombre, 'no-existe', v);
  }
});

test('esRutaInterna: separa los dos portales', () => {
  for (const n of ['acceso', 'codigo', 'portal', 'portal-alertas', 'portal-revision', 'portal-administracion']) assert.equal(esRutaInterna(n), true, n);
  for (const n of ['inicio', 'verificar', 'resultado', 'pasaporte', 'demo-pasaporte', 'demo-pasaporte-individual', 'no-existe']) assert.equal(esRutaInterna(n), false, n);
});

test('redireccion: el código TOTP sin desafío en memoria vuelve al acceso', () => {
  assert.equal(redireccion('codigo', false, false), RUTAS.acceso);
  assert.equal(redireccion('codigo', false, true), null);
  assert.equal(redireccion('portal', false, false), null);
  assert.equal(redireccion('acceso', false, false), null);
});

test('TITULOS cubre todas las rutas', () => {
  for (const n of Object.keys(RUTAS)) assert.equal(typeof TITULOS[n], 'string', n);
});
