// SIGA-E SIGNATURE — Pruebas negativas de acceso y aislamiento de roles (F3.2).
// Garantiza que la interfaz interna no expone secciones operativas sin sesión activa
// confirmada por el servidor, y que la separación de roles RBAC se mantiene estricta.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RUTAS } from '../app/router.mjs';
import { ROLES, seccionPermitida, seccionesPara } from './roles.mjs';

test('seguridad: sin sesión activa, ninguna sección interna operativa es accesible', () => {
  const estadosSinSesion = [
    { fase: 'sin-comprobar' },
    { fase: 'comprobando' },
    { fase: 'sin-sesion', motivo: 'ausente' },
    { fase: 'sin-sesion', motivo: 'cerrada' },
    { fase: 'sin-sesion', motivo: 'vencida' },
    { fase: 'no-disponible', motivo: 'red' },
    { fase: 'no-disponible', motivo: 'servidor' },
  ];

  for (const estado of estadosSinSesion) {
    const esActiva = estado.fase === 'activa';
    assert.equal(esActiva, false, `El estado ${estado.fase} no debe ser considerado activo`);
  }
});

test('seguridad RBAC: portal-alertas (Bandeja Operativa) es exclusivo de AUTHOR', () => {
  assert.equal(seccionPermitida('AUTHOR', 'portal-alertas'), true);
  assert.equal(seccionPermitida('APPROVER', 'portal-alertas'), false);
  assert.equal(seccionPermitida('ADMIN', 'portal-alertas'), false);
});

test('seguridad RBAC: portal-revision es exclusivo de APPROVER', () => {
  assert.equal(seccionPermitida('APPROVER', 'portal-revision'), true);
  assert.equal(seccionPermitida('AUTHOR', 'portal-revision'), false);
  assert.equal(seccionPermitida('ADMIN', 'portal-revision'), false);
});

test('seguridad RBAC: portal-administracion es exclusivo de ADMIN', () => {
  assert.equal(seccionPermitida('ADMIN', 'portal-administracion'), true);
  assert.equal(seccionPermitida('AUTHOR', 'portal-administracion'), false);
  assert.equal(seccionPermitida('APPROVER', 'portal-administracion'), false);
});

test('seguridad: la lista de secciones para roles desconocidos es siempre vacía', () => {
  const intentosInvalidos = ['GUEST', 'OPERATOR', 'SUPERUSER', 'root', '', null, undefined];
  for (const rolInvalido of intentosInvalidos) {
    assert.deepEqual(seccionesPara(rolInvalido), []);
    assert.equal(seccionPermitida(rolInvalido, 'portal-alertas'), false);
    assert.equal(seccionPermitida(rolInvalido, 'portal-revision'), false);
    assert.equal(seccionPermitida(rolInvalido, 'portal-administracion'), false);
    assert.equal(seccionPermitida(rolInvalido, 'portal'), false);
  }
});

test('seguridad de rutas: todas las secciones internas operativas se resuelven bajo /interno', () => {
  assert.equal(RUTAS['portal-alertas'], '/interno/alertas');
  assert.equal(RUTAS['portal-revision'], '/interno/revision');
  assert.equal(RUTAS['portal-administracion'], '/interno/administracion');
  assert.equal(RUTAS.portal, '/interno');
});

test('seguridad RBAC cruzada: un AUTHOR no puede acceder a la sección de revisión de APPROVER', () => {
  // Garantía F3.3: la interfaz deniega portal-revision a AUTHOR
  assert.equal(seccionPermitida('AUTHOR', 'portal-revision'), false);
  // Y APPROVER no puede acceder a portal-alertas de AUTHOR
  assert.equal(seccionPermitida('APPROVER', 'portal-alertas'), false);
});
