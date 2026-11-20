// D08A: separación de roles (solo estructura; el servidor decide) y validación local de formularios.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { esRol, ROLES, seccionPermitida, seccionesPara } from './roles.mjs';
import { MAX_CONTRASENA, validarAcceso, validarCodigo } from './validacion.mjs';

test('roles: cada rol ve solo su sección propia, además del inicio', () => {
  assert.deepEqual(seccionesPara('AUTHOR'), ['portal', 'portal-alertas']);
  assert.deepEqual(seccionesPara('APPROVER'), ['portal', 'portal-revision']);
  assert.deepEqual(seccionesPara('ADMIN'), ['portal', 'portal-administracion']);
});

test('roles: excluyentes; nadie ve la sección de otro rol', () => {
  const propias = { AUTHOR: 'portal-alertas', APPROVER: 'portal-revision', ADMIN: 'portal-administracion' };
  for (const rol of ROLES) {
    for (const [otro, seccion] of Object.entries(propias)) {
      assert.equal(seccionPermitida(rol, seccion), rol === otro, `${rol} → ${seccion}`);
    }
  }
});

test('roles: un rol desconocido o con otra grafía no ve nada', () => {
  for (const v of ['admin', 'SUPERADMIN', '', null, undefined, 1, {}]) {
    assert.equal(esRol(v), false);
    assert.deepEqual(seccionesPara(v), []);
    assert.equal(seccionPermitida(v, 'portal'), false);
  }
});

test('acceso: campos vacíos', () => {
  assert.deepEqual(validarAcceso('', ''), { ok: false, correo: 'correo-vacio', contrasena: 'contrasena-vacia' });
  assert.deepEqual(validarAcceso('   ', 'x'), { ok: false, correo: 'correo-vacio', contrasena: null });
});

test('acceso: forma del correo y longitudes', () => {
  assert.equal(validarAcceso('sin-arroba', 'x').correo, 'correo-forma');
  assert.equal(validarAcceso('a@b', 'x').correo, 'correo-forma');
  assert.equal(validarAcceso('a b@c.de', 'x').correo, 'correo-forma');
  assert.equal(validarAcceso(`${'a'.repeat(250)}@b.cd`, 'x').correo, 'correo-largo');
  assert.equal(validarAcceso('a@b.cd', 'x'.repeat(MAX_CONTRASENA + 1)).contrasena, 'contrasena-larga');
});

test('acceso: el correo se recorta; la contraseña nunca se toca', () => {
  assert.deepEqual(validarAcceso('  persona@example.invalid ', '  con espacios  '), { ok: true, correo: 'persona@example.invalid' });
  // Sin reglas de composición: la política la aplica el servidor (ADR-004 §3).
  assert.equal(validarAcceso('a@b.cd', 'x').ok, true);
});

test('código: seis cifras, con o sin espacio en medio', () => {
  assert.deepEqual(validarCodigo('123456'), { ok: true, codigo: '123456' });
  assert.deepEqual(validarCodigo('123 456'), { ok: true, codigo: '123456' });
  assert.deepEqual(validarCodigo(' 012345 '), { ok: true, codigo: '012345' });
});

test('código: vacío, corto, largo, letras y cifras no ASCII', () => {
  assert.deepEqual(validarCodigo(''), { ok: false, error: 'codigo-vacio' });
  assert.deepEqual(validarCodigo('   '), { ok: false, error: 'codigo-vacio' });
  for (const v of ['12345', '1234567', '12a456', '١٢٣٤٥٦', '12-456', '+12345']) {
    assert.deepEqual(validarCodigo(v), { ok: false, error: 'codigo-forma' }, v);
  }
});
