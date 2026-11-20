# PROMPT 06 — M1 identidad y accesos

**Estado: PARCIAL (implementación local).** Fecha: 2026-10-12.

## Alcance realizado

- Lectura de la cookie opaca `sigae_session`, rechazo de valores ausentes, duplicados o de formato inválido, y búsqueda de su hash SHA-256 en `sessions`.
- Autorización de sesión solo si no está revocada ni vencida y el usuario sigue `ACTIVE` en cada solicitud. Middleware de roles desde la identidad leída en backend.
- `GET /api/v1/auth/me` devuelve únicamente los cinco campos del esquema público `User`: `id`, `name`, `email`, `role` y `status`. Errores 401/403 normalizados, sin token ni credenciales.
- Repositorio Prisma de lectura para sesiones y pruebas locales con repositorio simulado. No se creó ninguna sesión ni usuario remoto.

### Archivos de esta etapa

- `apps/api/src/modules/identity/session-reader.ts`
- `apps/api/src/modules/identity/session-authentication.ts`
- `apps/api/src/modules/identity/prisma-session-reader.ts`
- `apps/api/src/presentation/http/middleware/identity-authorization.ts`
- `apps/api/src/presentation/http/routes/identity-routes.ts`
- `apps/api/src/app.ts`
- `apps/api/src/server.ts`
- `apps/api/test/identity/session-authentication.test.ts`
- Este documento.

## Contrato y uso local

`GET /api/v1/auth/me` corresponde a OpenAPI v1.2: `sessionCookie` usa `sigae_session` y la respuesta contiene `user: User`. Ejemplo estructural, sin una cookie real:

```http
GET /api/v1/auth/me HTTP/1.1
Cookie: sigae_session=<token-opaco-de-ejemplo-no-utilizable>
```

Para iniciar la API manualmente, preparar el entorno local según `.env.example` y ejecutar `pnpm --dir apps/api dev`. El arranque no crea cuentas; la ruta requiere una sesión previamente emitida por un flujo M1 todavía pendiente. No usar una URL de production ni publicar credenciales en terminal o evidencias.

## Dependencias de diseño que impiden declarar M1 completo

- ADR-002 y ADR-003 exigen una invitación temporal de un solo uso, entrega privada, desafío de enrolamiento, contraseña Argon2id y verificación TOTP antes de activar. También indican que el almacenamiento de invitaciones/desafíos, límites de intentos y rutas de establecimiento requieren especificación M1 posterior. El esquema actual carece de esas entidades y OpenAPI no define las rutas de enrolamiento. Por ello no se implementaron `POST /admin/users`, activación, enrolamiento, login ni emisión de sesión.
- El primer ADMIN necesita un procedimiento excepcional revisado: aprovisionar una invitación inicial mediante operación local de una sola ejecución y acceso restringido, con token aleatorio de uso único almacenado solo por hash; entregar el token por canal privado; hacer que el titular establezca contraseña y TOTP; activar solo tras verificar TOTP en una transacción; retirar el mecanismo inicial después. Aún no es ejecutable: requieren aprobación del contrato HTTP, almacenamiento y flujo de entrega, además de auditoría. No se creó una contraseña o ruta de bootstrap predeterminada.
- La arquitectura aprobada prescribe sesiones opacas revocables con cookie HttpOnly y CSRF. No define refresh tokens; implementarlos requeriría un cambio de contrato y modelo. La lectura de sesiones no sustituye emisión, rotación, revocación ni logout.
- M5 aún no proporciona el servicio transaccional de `audit_events`; no se registraron eventos de seguridad ni se afirmó integridad de auditoría. Los endpoints mutables de M1 deben esperar a ese servicio.
- No se implementaron limitación de intentos, protección CSRF para rutas mutables, gestión de contraseñas, TOTP ni permisos de operaciones de M2–M6. Las pruebas de estos flujos dependen de cerrar las decisiones anteriores.

## Verificación local

| Comando o comprobación | Resultado |
| --- | --- |
| `pnpm.cmd --dir apps/api prisma:validate` | Aprobado: esquema Prisma válido. |
| `pnpm.cmd --dir apps/api prisma:generate` | Aprobado: cliente Prisma 7.10.0 generado localmente. |
| `pnpm.cmd --dir apps/api exec tsc --noEmit -p tsconfig.json` | Aprobado. |
| `pnpm.cmd --dir apps/api exec vitest run test/identity/session-authentication.test.ts` | 6/6 pruebas aprobadas. |
| `pnpm.cmd --dir apps/api exec vitest run` | 9 archivos, 52/52 pruebas aprobadas. |
| Análisis local de OpenAPI con PyYAML | Aprobado: ruta, cookie y campos requeridos de `User` coinciden. |

Las pruebas cubren cookies malformadas/duplicadas, sesión vencida o revocada, usuario pendiente/deshabilitado, RBAC, respuesta pública y errores sin filtración del token. No hubo conexión a Neon, migraciones, SQL de escritura, operaciones Stellar ni commits durante esta etapa.

## Siguiente paso

Aprobar mediante ADR y contrato HTTP el ciclo de invitación, enrolamiento y bootstrap inicial, con almacenamiento, caducidad, límites y entrega. Después implementar Argon2id/TOTP, auditoría transaccional, emisión y revocación de sesiones, CSRF, administración y las pruebas de integración correspondientes. Mantener M1 como **PARCIAL** hasta verificar todos esos flujos.
