# M6 — cierre final y preparación académica

## Resultado ejecutivo

**Actualización de preparación Render: M6 sigue PARCIAL.** PS1–PS4 conservan
PASS aislado. PS5 obtuvo PASS en una PostgreSQL desechable para bloqueo,
persistencia tras recrear el servicio, expiración, recuperación MFA y auditoría
redactada; la prueba PostgreSQL específica de límites TOTP/rate limit no se
completó, por lo que PS5 global sigue PARCIAL. PS6 conserva PASS offline para
la cadena ficticia y PARCIAL para la cadena persistida: no se ejecutó el
verificador sobre una copia persistida ni sus mutaciones.

La revisión de navegador anterior encontró las rutas principales renderizadas
y el panel M5 visible tras navegación/recarga. No se reprodujo un fallo
sostenido de React. La versión local respondió a las comprobaciones HTTP de
API y frontend.

Las cuatro migraciones se aplicaron y verificaron únicamente en una instancia
PostgreSQL temporal y desechable, en puerto 55434. La prueba M1 creó cuentas y
eventos sintéticos solo en esa base. No se conectó ni escribió en la base de
demostración. M3, M5 y AnchorWorker siguen deshabilitados; no hubo operaciones
Stellar.

## Alcance y arquitectura observada

- M1 usa Argon2id, TOTP, sesiones revocables y autorización por rol. El perfil
  HTTP de laboratorio requiere loopback y una base de laboratorio validada;
  las escrituras exigen configuración explícita.
- M2 separa AUTHOR y APPROVER y valida identidad, permisos y transición de
  estado en el servidor. `READY_TO_SIGN` no significa firma ni publicación.
- M3 sigue fuera de operación. Las comprobaciones criptográficas de este
  informe usan JWS y claves efímeras de prueba; no firman alertas operativas.
- M5 tiene contrato Soroban, gateway/worker, repositorios y persistencia de
  trabajos. El servidor HTTP no inicia AnchorWorker. Su consulta de evidencia
  es de solo lectura y exclusiva para ADMIN.
- La auditoría registra eventos y dispone de verificación de integridad; el
  control total de la base por un DBA sigue siendo un riesgo residual.
- El perfil de laboratorio M1 conserva su guard de loopback. Se añadió un
  perfil de producción explícito que requiere TLS PostgreSQL, HTTPS, secretos
  de sesión/TOTP y bind `0.0.0.0`; el proxy confiable se limita a un salto.
  Express sirve el build React con fallback SPA y cabeceras CSP/HSTS. La
  configuración se probó localmente en modo producción simulado, no dentro de
  Render.

## Matriz requisito–amenaza–control–prueba–evidencia

| Requisito | Amenaza | Control | Prueba/evidencia de este cierre | Resultado y límite |
|---|---|---|---|---|
| PS1 | `kid` desconocido, JWS sin firma, `alg=none` o clave no confiable | Verificación ES256 con claves confiables y rechazo fail-closed | `alert-signing.test.ts`, `trusted-alert-signing-key-provider.test.ts` | **PASS offline** con claves de prueba; no habilita M3 |
| PS2 | Alteración del encabezado o payload | Firma sobre los bytes del JWS y verificación criptográfica | `alert-signing.test.ts` y pruebas de verificación | **PASS offline**; no es una prueba visual M4 |
| PS3 | Repetición, duplicado o evidencia vencida | Identificadores inmutables, unicidad y validación de vigencia | `alert-draft-service.test.ts`, `prisma-alert-repository.test.ts`, pruebas de firma | **PASS offline**; no se publicaron alertas de prueba |
| PS4 | Autoaprobación o rol indebido | RBAC del servidor, atribución a identidad autenticada y transiciones permitidas | `alert-routes.test.ts`, pruebas de servicios de alertas | **PASS offline/HTTP aislado**; no se modificó la base de demostración |
| PS5 | Fuerza bruta de contraseña/TOTP o reutilización del desafío | Bloqueos, límites, expiración, revocación del desafío y auditoría | Pruebas offline más `scripts/render-postgres-auth-check.ts` en DB marcada y desechable | **PARCIAL** — PASS PostgreSQL para cinco contraseñas incorrectas, bloqueo persistido, intento correcto rechazado durante bloqueo aun con servicio recreado, recuperación después de 15 minutos, MFA que limpia el bloqueo, cookie Secure/HttpOnly/SameSite y auditoría saneada. La cuenta fue sintética y temporal. No se validaron en PostgreSQL el límite de solicitudes ni tres fallos TOTP; no se usaron cuentas principales. |
| PS6 | Eventos alterados, eliminados, reordenados o exposición de secretos | Eventos asociados a actor/acción, redacción y cadena verificable | `append-audit-event.test.ts`, `verify-m3-persisted-evidence.test.ts`; auditoría generada por PS5 | **PARCIAL** — PASS offline para cadena ficticia y mutaciones; PASS PostgreSQL para asociación y redacción de eventos de autenticación. **NO EJECUTADO** el verificador de cadena persistida ni modificación/eliminación/reordenamiento en copia desechable; no se alteró auditoría de demostración. |

## Estado M1–M6

| Módulo | Estado final | Evidencia y límite |
|---|---|---|
| M1 | **Funcional en perfil local; perfil Render implementado, despliegue bloqueado** | PASS de login/MFA HTTP y bloqueo persistido con PostgreSQL desechable. El bootstrap inicial de ADMIN en producción no existe; no se probaron cuentas de demostración ni Render real. |
| M2 | **Funcional según validación previa** | El estado `READY_TO_SIGN` se observó en ADMIN y las pruebas de permisos/transición pasaron. No se volvió a crear, editar ni aprobar una alerta persistente. |
| M3 | **Deshabilitado por alcance** | Sin activación del firmador ni firma de alertas operativas. Las pruebas PS1/PS2 son criptográficas offline. |
| M4 | **PASS manual informado; sanity check actual PASS** | El operador informa 10/10 pruebas visuales manuales PASS en Edge InPrivate. En esta revisión se cargaron y navegaron las rutas principales; no se reprodujo una pantalla blanca sostenida. `M4-cierre.md` aún debe cotejarse con el resultado manual informado. |
| M5 | **Backend y panel implementados; anclaje real deshabilitado** | En ADMIN se observaron `READY_TO_SIGN` y `NOT_REQUESTED`. Red, contrato y transacción no disponibles; confirmación no acreditada; digest no comprobado. El panel declara que M5 está deshabilitado operativamente. No se ejecutó transacción ni AnchorWorker. |
| M6 | **PARCIAL** | PS1–PS4 PASS offline/aislado; PS5 PARCIAL (bloqueo PostgreSQL PASS, pruebas de límites incompletas); PS6 PARCIAL (cadena persistida sin verificar). |

## Resultados reproducibles y clasificación de evidencia

**PASS automático ejecutado en este cierre**

- **272 pruebas PASS en 15 archivos** de API, mediante la configuración offline
  `vitest.m4-offline.config.ts`. Incluye JWS, RBAC de rutas, login/TOTP, auditoría
  y variables de entorno. Es una selección M6, no la suite completa de API.
- Build de API PASS: `pnpm --dir apps/api build`. Ejecutó generación de Prisma y
  TypeScript; no ejecutó migraciones.
- La prueba nueva de entorno comprueba que el servidor HTTP rechaza
  `STELLAR_NETWORK`, `STELLAR_RPC_URL`, `STELLAR_CONTRACT_ID` y
  `STELLAR_SECRET_SEED`.

Comando exacto de la selección M6:

```powershell
pnpm --dir apps/api exec vitest run --config vitest.m4-offline.config.ts `
  test/signing/alert-signing.test.ts `
  test/signing/trusted-alert-signing-key-provider.test.ts `
  test/signing/verify-m3-persisted-evidence.test.ts `
  test/alerts/alert-input.test.ts `
  test/alerts/prisma-alert-repository.test.ts `
  test/alerts/alert-draft-service.test.ts `
  test/alerts/alert-routes.test.ts `
  test/identity/password.test.ts `
  test/identity/totp.test.ts `
  test/identity/session-authentication.test.ts `
  test/identity/login-http.test.ts `
  test/identity/login-service.test.ts `
  test/identity/lab-provisioning.test.ts `
  test/audit/append-audit-event.test.ts `
  test/environment.test.ts
```

**PASS de validaciones anteriores, no repetidas porque los cambios de este
cierre solo afectaron configuración y pruebas de API**

- Web: 221 pruebas PASS; build y typecheck PASS.
- Pruebas de rutas HTTP: 31 PASS.
- Rust: 5 pruebas PASS.
- M5 offline: la matriz existente registra 130 PASS y 3 SKIPPED. No se repitió
  esa suite en este cierre ni se presenta como operación Testnet.

**PASS automático de preparación Render**

- 33 pruebas API dirigidas PASS en cinco archivos: entorno, bootstrap,
  servidor HTTP, rutas de login y fallback SPA/HTTPS.
- TypeScript API PASS (`pnpm exec tsc --noEmit -p tsconfig.json`).
- Build API PASS (`pnpm run build`); build web PASS (`pnpm run build`, que
  incluye typecheck y generación del service worker).
- Las cuatro migraciones versionadas se aplicaron en `sigae_render_test`,
  PostgreSQL desechable en `127.0.0.1:55434`; `prisma migrate status` indicó
  esquema al día. No se usó la base de demostración.
- `scripts/render-postgres-auth-check.ts` PASS contra esa base: bloqueo tras
  cinco contraseñas incorrectas, bloqueo persistido al recrear el servicio,
  rechazo durante el período de 15 minutos, recuperación posterior, MFA,
  cookie segura, `/auth/me` y eventos de auditoría saneados.
- Comando reproducible de autenticación (solo tras preparar el clúster aislado
  con el nombre/puerto/marker codificados por el guard; no apuntar a otra base):

  ```powershell
  $env:SIGAE_RUN_RENDER_PG_AUTH_TEST = 'I_ACKNOWLEDGE_DISPOSABLE_DB_WRITES'
  $env:SIGAE_RENDER_TEST_RUNTIME_URL = 'postgresql://sigae_render_runtime@127.0.0.1:55434/sigae_render_test'
  $env:SIGAE_RENDER_TEST_ADMIN_URL = 'postgresql://postgres@127.0.0.1:55434/sigae_render_test'
  pnpm exec tsx scripts/render-postgres-auth-check.ts
  ```

- Migraciones: `prisma migrate deploy` y `prisma migrate status` se ejecutaron
  mediante una configuración temporal apuntando al clúster desechable; esa
  configuración se retiró al terminar para no dejar un bypass de destino.
- Smoke de la aplicación compilada en modo production sobre un puerto aislado:
  `/`, `/verificar`, `/interno/acceso`, `/interno` y
  `/interno/administracion` respondieron 200 con CSP; `/api/v1/health` 200 y
  HTTP redirigió 308 al `APP_ORIGIN` HTTPS configurado. No se probó Render real.

**PASS visual informado por el operador**

- M4: 10/10 casos en Edge InPrivate, según el contexto recibido; no se repitió
  aquí esa sesión InPrivate.

**Verificación local de este cierre**

- `GET http://127.0.0.1:3000/api/v1/health`: HTTP 200; `GET
  https://127.0.0.1:5173/`: HTTP 200. El puerto PostgreSQL local de demo
  `55433` tenía listener. Los puertos 3000 y 5173 siguen activos y respondieron
  HTTP 200 después de las pruebas; el servidor aislado del smoke en 39876 se
  detuvo. La base local de demostración no se consultó.
- En Edge se visitaron `/`, `/verificar`, `/interno/acceso`, `/interno` y
  `/interno/administracion`. Con una sesión ADMIN ya activa, `/interno/acceso`
  redirigió a `/interno`; no se introdujeron credenciales. Administración
  mostró 9 alertas. La ruta quedó renderizada después de navegar y recargar.
- Hubo capturas vacías inmediatamente tras algunas transiciones, pero el
  contenido apareció al continuar observando la página. No se observó error
  JavaScript de React en Console; sí un aviso informativo de React DevTools.
  Network mostró recursos de `/verificar` con respuestas 200/304; la captura
  inmediata de un documento pendiente no demostró un fallo persistente.
- `INICIAR-SIGAE-LOCAL.ps1` se ejecutó solo después de comprobar que PostgreSQL
  55433, API 3000 y frontend 5173 ya escuchaban; devolvió PASS para los tres.
  Como los puertos estaban activos, no inició ni reinició procesos. El script
  limita la base a `127.0.0.1:55433/sigae_local_demo` y no ejecuta migraciones;
  su “PostgreSQL PASS” confirma el listener, no una consulta a la base.
- No se ejecutaron migraciones en la base de demostración, escrituras de
  alertas ni transacciones Stellar.

**Resultados de las comprobaciones PS5/PS6**

- PS5: **PASS PostgreSQL limitado al bloqueo y recuperación**, en una base
  marcada como `SIGAE_RENDER_AUTH_TEST_V1`, con rol runtime sin superusuario y
  rol de preparación separado. Se usaron cuentas sintéticas; no se alteraron
  ADMIN, AUTHOR ni APPROVER de demostración. La prueba de rate limit y los
  fallos de TOTP no se repitieron contra PostgreSQL; PS5 global queda PARCIAL.
- PS6: **NO EJECUTADO persistido**. La prueba de login confirmó eventos
  asociados y redacción, no invocó el verificador de cadena sobre la base.
  Las mutaciones del historial solo conservan evidencia offline previa.
- El PostgreSQL desechable utilizó el puerto 55434, no los puertos de las
  bases locales. No se conectó al destino 55433 ni se modificó la auditoría
  histórica de demostración.

## Evidencia de M5 y RBAC

La vista ADMIN usa el adaptador de API para solicitar metadatos de anclaje; no
crea evidencia local ni fixture para llenar el panel. El estado observado en
esta revisión fue:

| Campo | Dato mostrado |
|---|---|
| Estado del ciclo | `READY_TO_SIGN` |
| Estado de anclaje | `NOT_REQUESTED` |
| Red y contrato | No disponibles |
| Identificador de transacción | No disponible |
| Confirmación | No acreditada |
| Verificación del digest | No comprobado |
| Motivo | M5 deshabilitado operativamente; no se ejecuta AnchorWorker ni se envían transacciones |

Las pruebas HTTP de `alert-routes.test.ts` permiten la consulta a ADMIN y la
deniegan a AUTHOR, APPROVER y solicitudes sin sesión. No se muestran claves,
semillas ni secretos en el panel.

## Archivos asociados a la preparación Render

- `.env.example`: añade `APP_ORIGIN` y elimina variables heredadas de firma y
  variables Stellar/M5 que no corresponden al proceso HTTP. Los valores
  requeridos siguen siendo marcadores vacíos que deben configurarse fuera de Git.
- API: `src/config/environment.ts`, `src/bootstrap.ts`, `src/server.ts`,
  `src/app.ts` y `src/presentation/http/routes/identity-routes.ts` implementan
  el perfil Render explícito, TLS/proxy/CSP, el build SPA y la IP de cliente
  confiable.
- Pruebas API: `test/environment.test.ts`, `test/bootstrap.test.ts` y
  `test/app.test.ts` cubren el perfil de producción, HTTPS, CSP, fallback y
  proxy. `scripts/render-postgres-auth-check.ts` es un verificador opt-in que
  acepta solo el PostgreSQL loopback desechable marcado.
- Frontend/Render: `apps/web/vite.config.ts` ya no intenta leer certificados
  Windows al compilar; `render.yaml` y `docs/deployment/render.md` describen
  servicio, base, variables y secuencia manual.
- `docs/evidencias/M6-cierre-final.md` registra los resultados y límites de
  esta preparación. No se revirtieron cambios previos ni se hizo push.

## Congelación Git y revisión de secretos

- Rama: `integration/local-demo`; HEAD: `0a5232a` (`feat(anchor): implement
  M5 PB3 retry budget and offline validation`).
- El árbol de trabajo incluye cambios previos y los de esta preparación; no hay
  archivos preparados en el índice. El inventario completo queda en
  `docs/deployment/render-file-manifest.md`. `git diff --check` no reportó
  errores de whitespace; mostró advertencias CRLF/LF.
- `.env.example` es el único archivo `.env*` rastreado. `.gitignore` excluye
  `.env`, `.env.*` (salvo ejemplos), claves/certificados, semillas Stellar y
  `.sigae-local-pg`; `apps/api/dist` y `apps/web/dist` también están ignorados.
  El escaneo de nombres no encontró archivos de entorno reales, claves,
  certificados, bases ni volcados pendientes; sí detectó un `.backup`, que se
  excluye. No se imprimieron valores secretos.
- **No se creó commit, tag, stash ni snapshot.** El conjunto pendiente mezcla
  cambios de varios módulos, documentos, scripts y directorios de backup. El
  manifiesto limita el delta de despliegue de esta tarea, pero el resto del
  árbol no ha sido revisado archivo por archivo para publicar. No usar `git add
  .`; no hay un commit seguro preparado y no se hizo push.

## Riesgos pendientes y bloqueos para publicar

1. Completar PS5 contra PostgreSQL para los límites de solicitudes y los
   fallos TOTP; bloqueo/recuperación de contraseña ya tiene evidencia persistida.
2. Ejecutar el verificador de auditoría y mutaciones sobre una copia aislada de
   PostgreSQL, sin alterar la base local de demostración.
3. Resolver documentalmente la discrepancia entre `M4-cierre.md` y las 10/10
   pruebas visuales PASS informadas por el operador. Esta revisión no reprodujo
   una pantalla blanca sostenida.
4. Las cuatro migraciones pasaron en PostgreSQL desechable. Antes de Render,
   debe confirmarse de nuevo el nombre de destino, la cadena de migraciones y
   los privilegios de migrador; nunca ejecutar sobre la base de demostración.
   `prisma/drafts/initial.sql` es un borrador separado y no se debe aplicar.
5. El perfil M1 de Render ya existe, pero el bootstrap inicial de ADMIN
   disponible en `m1-lab.ts` está restringido a loopback. No iniciar el portal
   completo hasta contar con un bootstrap inicial de producción de un solo uso,
   operado y revisado. No exponer registro público ni reutilizar cuentas demo.
6. La configuración de hosting/CSP se probó en un smoke local. `script-src`
   permanece limitado a `'self'`; `style-src 'unsafe-inline'` es una concesión
   necesaria por los estilos inline existentes en React. Falta validarla en
   Render real y comprobar los headers desde un cliente externo.
7. El árbol pendiente de Git no tiene un conjunto completo revisado para
   publicación. El manifiesto de esta tarea no autoriza incluir los demás
   archivos no rastreados ni backups.
8. El anclaje real de M5 y el firmador M3 quedan fuera del MVP académico; no
   declarar producción real ni evidencia blockchain real.

## Pasos restantes de despliegue académico

El despliegue **no está autorizado ni listo para ejecutarse**. Tras resolver
los bloqueos anteriores, seguir `docs/deployment/render.md` y:

1. Aprovisionar PostgreSQL administrado nuevo, con roles mínimos separados,
   backups/PITR y destino validado. No copiar ni importar la base local.
2. Ejecutar las migraciones ya probadas desde un operador, con `DIRECT_URL`
   temporal y privado; no almacenar esa variable en el servicio web.
3. Configurar `DATABASE_URL` del rol runtime, `APP_ORIGIN`, `SESSION_SECRET`,
   `TOTP_ENCRYPTION_KEY`, `SIGAE_M1_RENDER_ENABLED` y `M1_WRITES_ENABLED` en
   el gestor de secretos. No incluir valores en Git.
4. Compilar y arrancar mediante el `render.yaml` revisado:

   ```sh
   corepack enable
   corepack prepare pnpm@12.10.1 --activate
   pnpm install --frozen-lockfile
   pnpm --filter @siga-e/web build
   pnpm --filter @siga-e/api build
   pnpm --filter @siga-e/api start
   ```

5. Crear cuentas ficticias nuevas únicamente por un bootstrap aprobado;
   verificar login/MFA, RBAC, auditoría, salud y CSP antes de abrir acceso.
6. Mantener `SIGAE_M3_SIGNING_ENABLED` sin configurar, no inyectar firmador,
   no pasar variables Stellar/M5 y no iniciar AnchorWorker.

**Conclusión:** existe evidencia reproducible para los controles offline
cubiertos, las migraciones aisladas y la integración M1 con PostgreSQL
desechable. La demo local sigue respondiendo. M6 continúa parcial por rate
limits/TOTP persistidos y verificación PS6 pendiente. La publicación está
bloqueada por el bootstrap inicial de ADMIN, el árbol Git sin manifiesto
completo y la falta de validación externa en Render. No está lista para
producción real ni para firma o anclaje blockchain reales.
