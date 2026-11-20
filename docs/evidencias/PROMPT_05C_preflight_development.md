# Prompt 05-C — Preflight de `development`

**Veredicto local:** PREPARADO PARA PREFLIGHT MANUAL. No se abrió una conexión a Neon desde esta sesión y no hay autorización para escribir ni migrar en `development`.

## A. Estado de las etapas anteriores

- Prompt 05: la evidencia local registra `20261011_initial` aplicada y verificada en `test-initial-migration`, con diez tablas, once enums, nueve FK, 21 CHECK, 29 índices explícitos, génesis y checksum coincidente. Es un resultado de la rama temporal.
- Prompt 05-B: la segunda ejecución manual registrada obtuvo T01–T09 `APROBADA`, con `ROLLBACK` confirmado y sin persistencia observable. La primera ejecución, que clasificó T08 como fallida por esperar `23503` en vez de `23001`, permanece documentada sin alteración.
- SQL local autorizado: SHA-256 `3A5D28D77DD23F9216A3C720C6EEC065507A9A421C7473D5382345D02146765F`.

## B. Identidad esperada de `development`

| Dato | Valor esperado |
|---|---|
| Proyecto Neon | `siga-e` |
| Rama | `development` |
| Branch ID comunicado anteriormente | `br-delicate-sky-b6okz1oe` |
| Endpoint directo comunicado anteriormente | `ep-red-butterfly-b61jbniu` |
| Base y esquema | `siga_e`, `public` |
| Motor | PostgreSQL 18 |

La asociación administrativa rama–endpoint **sigue pendiente de confirmación visual actual o de API administrativa**. El lanzador exige que el usuario consulte la consola de Neon e introduzca ambos IDs y `CONFIRMO` antes de solicitar la URL. La comprobación SQL del host y de la base no demuestra por sí sola esa asociación. Si el endpoint real difiere, detener el procedimiento; no adaptar la URL a un endpoint no verificado.

## C. Archivos preparados

- `apps/api/scripts/neon-development-url.mjs`: validador exclusivo; rechaza endpoint temporal, production, `-pooler`, otra base, TLS ausente, puerto diferente y parámetros no autorizados. Solo admite `sslmode=require` y, opcionalmente, `channel_binding=require` en ese orden.
- `apps/api/scripts/preflight-neon-development-readonly.mjs`: conexión directa con certificado TLS validado; `BEGIN READ ONLY`, inventario de tablas, vistas/índices/secuencias y otros objetos, enums/dominios, FK, otras restricciones, funciones/extensiones e historial Prisma; identifica nombres que colisionan con la migración; siempre intenta `ROLLBACK` y cierre.
- `apps/api/prisma.development-preflight.config.ts`: configuración aislada de Prisma 7 que no carga `.env` y solo admite `migrate status` con URL validada e ID de rama confirmado. No implementa `deploy`.
- `apps/api/scripts/run-neon-development-preflight.ps1`: confirmación visual, captura oculta de URL, variables solo en procesos hijos, timeouts, lectura concurrente de stdout/stderr y salida sanitizada. Ejecuta el inventario SQL y `prisma migrate status` de solo lectura; no interpreta un código 1 como autorización para migrar.
- `apps/api/scripts/neon-development-preflight.test.mjs`: simulaciones sin conexión.

El preflight **no presupone base vacía**. Si halla tablas o historial, los enumera y marca el inventario para revisión. Si no encuentra objetos públicos, reporta solo ese hecho observable; no autoriza aplicar la migración.

## D. Validaciones locales

- `node --check` de los tres archivos `.mjs`: correcto.
- Simulación `-SelfTestProcesses` del lanzador: salida concurrente y timeout correctos, sin conexión.
- Suite local: **36/36 pruebas aprobadas en 7 archivos**; incluye cinco casos nuevos de URL, hash, informe sanitizado e inventario no vacío.
- TypeScript `tsc --noEmit -p tsconfig.json`: correcto.
- Prisma CLI con la configuración aislada y sin confirmación de rama: salida 1, bloqueada antes de conectar.
- SHA-256 calculado nuevamente: `3A5D28D77DD23F9216A3C720C6EEC065507A9A421C7473D5382345D02146765F`, coincide.

## E. Comando de preflight manual

Desde `D:\Desarrollo\SIGA-E` en PowerShell de VS Code:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\apps\api\scripts\run-neon-development-preflight.ps1
```

Primero confirmar visualmente en Neon proyecto, rama, Branch ID y endpoint directo; el lanzador pedirá los IDs. Después pegar la URL **directa** cuando se solicite mediante entrada oculta. Compartir únicamente la salida sanitizada, sin captura de la URL ni credenciales.

## F. Riesgos y pendientes

1. Identidad administrativa actual de `development`: pendiente de confirmación visual por el usuario. No se consultó API administrativa.
2. Estado real de tablas, enums, restricciones y `_prisma_migrations` en `development`: desconocido hasta ejecutar el preflight manual.
3. Una base con objetos o historial requiere análisis antes de decidir una migración; no se preparó un comando de aplicación ni SQL correctivo.
4. Un timeout o un cierre no confirmado impide concluir el diagnóstico. El inventario solo informa objetos visibles para la cuenta de conexión.

## G. Estado

**PREPARADO PARA PREFLIGHT MANUAL; MIGRACIÓN EN DEVELOPMENT NO AUTORIZADA.**

## H. Corrección del diagnóstico (12/10/2026)

El mensaje genérico procedía del `catch` único del lanzador, que descartaba la etapa y el código de salida. Podían llegar allí: hash SQL local o confirmación de identidad, lectura de URL, validación de URL, conexión/TLS, inventario o cierre/`ROLLBACK`, timeout/inicio de un hijo, salida JSON inesperada, `prisma migrate status` y generación del informe. No hay evidencia suficiente para atribuir **el intento manual concreto** a una de estas causas sin repetirlo; Codex no abrió una conexión a Neon.

El lanzador ahora emite solo `ETAPA`, `CODIGO_SALIDA` y `MOTIVO` de una lista segura. No reenvía stdout/stderr crudos ni excepciones. Los fallos del hijo SQL identifican `VALIDACION_URL`, `CONEXION_TLS` o `INVENTARIO_POSTGRESQL`; los del lanzador identifican además `CONFIRMACION_IDENTIDAD`, `PRISMA_MIGRATE_STATUS`, `TIMEOUT_PROCESO` y `GENERACION_INFORME`. `NO_INICIADO` y `SIN_CODIGO` distinguen ausencia de código de salida de un valor numérico.

Se corrigió una ambigüedad: Prisma puede devolver `1` tanto por migraciones pendientes como por error. El lanzador solo informa `MIGRACIONES_PENDIENTES` si la salida de Prisma contiene el marcador de pendientes; de otro modo detiene el preflight y expone únicamente un código Prisma permitido (`P1000`, `P1001`, `P1002`, `P1011`, `P1017`, `P3005`) o `PRISMA_STATUS_NO_CLASIFICADO`. El inventario de `_prisma_migrations` se conserva como comprobación independiente. Un código `0` sin historial SQL se declara inconsistente.

La URL directa acepta exactamente `sslmode=require` y la variante con `&channel_binding=require`. En la segunda, la conexión SQL exige TLS validado y que el servidor ofrezca `SCRAM-SHA-256-PLUS`; el cliente `pg` fijado usa ese mecanismo cuando se ofrece. Prisma recibe la URL original validada. No se cambió el endpoint, la rama, la base ni las consultas de inventario de solo lectura.

Validaciones locales de esta corrección, sin conexión:

- `pnpm.cmd --dir apps/api exec vitest run scripts/neon-development-preflight.test.mjs`: **8/8** pruebas aprobadas, incluidas simulaciones de conexión/Prisma y rechazo de identidad.
- `powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\apps\api\scripts\run-neon-development-preflight.ps1 -SelfTestProcesses`: correcto, salida concurrente y timeout.
- Mismo comando con `-SelfTestDiagnostics`: correcto, clasificación de Prisma.
- `node --check apps/api/scripts/preflight-neon-development-readonly.mjs`: correcto.
- `pnpm.cmd --dir apps/api exec tsc --noEmit -p tsconfig.json`: correcto.

Siguiente paso: el usuario puede repetir manualmente el comando de la sección E y compartir **solo** la línea `PREFLIGHT DETENIDO` o el informe sanitizado. No ejecutar migraciones a partir de este preflight.

## I. Corrección puntual de Prisma 7 (12/10/2026)

La ejecución manual informó `PRISMA_MIGRATE_STATUS`, salida `1` y `PRISMA_STATUS_NO_CLASIFICADO`. Esa línea no contenía stdout/stderr de Prisma, por lo que **no permite saber cuál de sus motivos causó esa ejecución**. La revisión del CLI local instalado (`prisma/build/cli.js`) encontró dos motivos que la clasificación anterior no reconocía:

1. Con una migración pendiente, el CLI escribe `Following migration have not yet been applied:` (singular), mientras la expresión anterior exigía literalmente `migration(s)`.
2. Si falta `_prisma_migrations`, el CLI puede escribir `The current database is not managed by Prisma Migrate.` y salir con `1`, incluso cuando existe la migración local inicial. Esa salida también puede referirse a una base con objetos previos, por lo que sola no prueba que esté vacía.

`prisma.development-preflight.config.ts` usa el comando de solo lectura `migrate status`, una ruta local de migraciones y la URL directa validada. No se encontró en la inspección local un error de ruta o de subcomando; la ejecución real sigue sin verificarse desde Codex.

El lanzador ahora reconoce marcadores fijos en stdout y stderr, por separado, y códigos Prisma solo en posiciones de error. Emite nombres de marcadores y códigos, nunca texto crudo. Un código `1` se clasifica como `MIGRACION_INICIAL_PENDIENTE` únicamente si el inventario PostgreSQL confirmó `_prisma_migrations` ausente, cero objetos públicos, cero colisiones, y el CLI confirmó exactamente una migración local `20261011_initial` junto con un marcador de pendiente o base no gestionada. Divergencia, migración fallida, línea de error del CLI, código Prisma, inventario ocupado y salida desconocida detienen el preflight. El resultado pendiente **no autoriza migrar**.

Pruebas locales posteriores, sin conexión: `-SelfTestDiagnostics` correcto; `-SelfTestProcesses` correcto; `pnpm.cmd --dir apps/api exec vitest run scripts/neon-development-preflight.test.mjs` **8/8** aprobadas. La prueba de diagnóstico cubre singular, plural, base sin historial, inventario ocupado, historial existente, divergencia, `P1001`, código aparente dentro de una URL ficticia y salida desconocida. Siguiente paso: repetir manualmente el comando de la sección E y revisar solo la salida saneada.
