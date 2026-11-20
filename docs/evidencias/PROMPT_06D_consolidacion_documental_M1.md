# PROMPT 06-D — Consolidación documental M1

- **Fecha:** 2026-10-12.
- **Autorización:** instrucción humana del Prompt 06-D para aprobar documentalmente M1 y enmendar la precedencia; ninguna autorización de implementación, migración, Neon o Stellar.
- **Estado de implementación:** M1 **PARCIAL**. Los contratos nuevos describen trabajo futuro y no prueban ejecución.

## A. Archivos documentales de esta etapa

1. `docs/enmiendas/ENM-001-canal-invitaciones-presenciales-M1.md` (nuevo).
2. `docs/adr/ADR-002-limites-modelo-prisma.md`.
3. `docs/adr/ADR-003-unicidad-enrolamiento-auditoria.md`.
4. `docs/adr/ADR-004-ciclo-identidad-autenticacion-m1.md`.
5. `docs/arquitectura/SIGA-E_Arquitectura_Definitiva_v1.2.md`.
6. `docs/arquitectura/SIGA-E_API_OpenAPI_v1.2.yaml`.
7. `docs/evidencias/PROMPT_06A_contrato_M1.md`.
8. Este documento.

## B y C. Enmienda y decisiones aprobadas

ENM-001 cita literalmente las cláusulas §1.5, §4.7 y §8.1 del proyecto consolidado v1.2, que tratan «QR» de forma genérica como excluido o diferible. La aprobación humana del 12/10/2026 exceptúa **solo la entrega de invitaciones M1**: QR local mostrado presencialmente mediante CLI restringida después de verificar identidad. El QR de enlace/paquete de alertas para ciudadanos de M4 sigue opcional/diferible. El proyecto original permanece sin reescritura y conserva precedencia interpretado junto con ENM-001. No cambian OE1–OE6, seis módulos, ES256 ni Soroban.

ADR-004 consolida sesiones opacas revocables sin JWT/refresh; Argon2id con calibración local pendiente; TOTP obligatorio para tres roles; cinco fallos acumulados y bloqueo; invitaciones persistentes, revocables, de uso único y por hash; desafíos opacos y antirreplay TOTP; CSRF recuperado mediante `/auth/me`; auditoría transaccional previa a escrituras críticas; bootstrap local irreversible del primer ADMIN pendiente; recuperación del único ADMIN bloqueada; y migración futura estrictamente aditiva. La aprobación **no** autoriza generar o aplicar esa migración.

## D. Matriz final de coherencia

| Fuente | Decisión/ajuste | Resultado documental |
| --- | --- | --- |
| Proyecto consolidado v1.2 + ENM-001 | QR de invitación M1 obligatorio; QR ciudadano M4 diferible; texto original conservado. | Coherente por enmienda trazable aprobada. |
| Arquitectura definitiva v1.2 | Alta HTTP separada de CLI; enrolamiento, CSRF, auditoría y bootstrap descritos. | Coherente con ENM-001 y ADR-004. |
| ADR-001 | Precedencia proyecto → arquitectura → OpenAPI. | Respetada: ENM-001 resuelve alcance antes de propagar contrato. |
| ADR-002 | `POST /admin/users` crea solo pendiente; CLI emite luego; historia de diseño conservada. | Referencia ADR-004 y ENM-001; decisiones ajenas intactas. |
| ADR-003 | Unicidad, estado pendiente, activación transaccional y auditoría conservados. | Canal posterior precisado; no se atribuye aplicación remota. |
| ADR-004 | Contrato M1 aprobado documentalmente tras validaciones locales. | Sin afirmación de implementación. |
| OpenAPI v1.2 | Seis rutas existentes conservadas, seis operaciones M1 añadidas, `/auth/me` con CSRF. | Interfaz HTTP documentada; CLI no se expone como endpoint. |
| Matriz M1 de 06-A | Clasificación física de Prisma distingue decisión aprobada de capacidad aún ausente. | Invitaciones, desafíos, antirreplay y bootstrap requieren esquema nuevo. |

## E y F. Rutas y esquemas HTTP

**Conservadas:** `POST /auth/login`, `POST /auth/totp/verify`, `GET /auth/me`, `POST /auth/logout`, `POST /admin/users` y `PATCH /admin/users/{id}/status`.

**Añadidas:** `POST /auth/enrollment/start`, `POST /auth/enrollment/confirm`, `POST /auth/password/change`, `POST /auth/totp/reconfigure/start`, `POST /auth/totp/reconfigure/confirm` y `POST /admin/users/{id}/reinvite`.

`/auth/login` devuelve `challengeId` opaco de 32 bytes CSPRNG codificado en 43 caracteres base64url, distinto del UUID interno; dura 5 minutos y el desafío admite tres códigos erróneos. `/auth/me` devuelve `{user,csrfToken}` solo con sesión MFA válida y respuesta `Cache-Control: no-store`, `Vary: Cookie`. `csrfToken` no es token de sesión. `/admin/users` responde solo `User` pendiente; `reinvite` responde `{user,invitationStatus:"NOT_ISSUED"}`. Se agregaron esquemas reutilizables para token opaco, TOTP y respuestas de preparación de enrolamiento/reconfiguración; errores usan Problem Details saneado. Operaciones con cookie exigen CSRF; las anónimas tienen control de tasa. Invitación y URI TOTP viajan solo en cuerpos/respuestas HTTPS no cacheables, nunca en logs; la CLI no tiene ruta HTTP pública.

## G. Limitaciones y riesgos residuales

La presencia física y un navegador con acceso HTTPS al frontend son necesarios. Un QR fotografiado puede exponer el token; el QR no prueba identidad. La visualización de 60 segundos no revoca la invitación de 24 horas. El frontend debe quitar inmediatamente el fragmento con `history.replaceState` antes de cargar recursos externos y enviar el token solo en el cuerpo HTTPS de enrolamiento. TOTP puede ser objeto de phishing; una sesión bearer robada puede funcionar hasta revocación/expiración; el rate limit puede causar bloqueo inducido; un DBA puede reconstruir la cadena auditora. No se afirma que esos riesgos desaparezcan.

## H e I. Dependencias de ejecución futura

La migración aditiva deberá agregar `identity_invitations`, `identity_challenges`, `users.last_totp_step`, `identity_bootstrap` e `identity_rate_limits`, con índices y restricciones SQL necesarios. El esquema actual solo soporta físicamente usuarios pendientes, hash de contraseña, ciphertext TOTP, contadores, bloqueo y sesiones. No hay tabla actual de invitaciones/desafíos ni antirreplay persistente. El servicio mínimo `AppendAuditEvent` debe bloquear `audit_chain_state`, asignar secuencia y confirmar el evento **en la misma transacción** que cada escritura crítica; los fallos de autenticación se persisten y auditan antes de responder rechazo. Si la auditoría falla, la operación sensible falla cerrada. Su implementación y pruebas preceden a habilitar escrituras M1.

## J. Comprobaciones y límites

- Se leyeron AGENTS.md, proyecto, arquitectura, OpenAPI, ADR-001–004, evidencia 06-A y `schema.prisma`. La cláusula original de ENM-001 se comparó con las tres líneas del proyecto.
- PyYAML cargó OpenAPI 3.1.0 sin claves YAML duplicadas. Una comprobación estructural con `jsonschema` disponible validó raíz, operaciones, respuestas, identificadores, seguridad, rutas esperadas, referencias locales `$ref`, roles y estados. Resultado: **28 rutas, 30 `operationId` únicos**, sin colisión detectada. Es una validación de **subconjunto**; no reemplaza un validador semántico completo de OpenAPI, que no estaba instalado.
- Hash SHA-256 local inicial de `schema.prisma`: `8995332346b148cb01593964900f50bcec789ab760c5a57d513ed70a63790e9e`. De `20261011_initial/migration.sql`: `3a5d28d77dd23f9216a3c720c6eec065507a9a421c7473d5382345d02146765f`. Se comparan de nuevo al cierre para detectar cambios durante 06-D; esto no verifica el estado remoto de Neon.
- No se ejecutaron pruebas funcionales ni operaciones de bases de datos o Stellar. El repositorio ya contenía cambios de código y Prisma anteriores al inicio de 06-D; esta etapa no los modificó ni les atribuye validación.

**Siguiente paso fuera de 06-D:** una autorización independiente para implementar el servicio mínimo de auditoría, preparar la migración aditiva revisable y construir los flujos M1 con pruebas locales, sin operar sobre Neon hasta nueva autorización explícita.
