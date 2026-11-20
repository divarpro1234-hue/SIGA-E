# ADR-009: Autorización LOCAL_SOLO_LAB para M4

- **Estado:** Aceptado por el operador único para el laboratorio académico local; no es revisión independiente ni aprobación de producción.
- **Fecha:** 2026-11-13.
- **Ámbito:** habilitación local del preflight, migraciones y harness PostgreSQL M4. No cambia el sistema de atestaciones independientes ni la aplicación.

## Contexto

El proyecto tiene un solo responsable y no dispone de un segundo revisor para emitir `CLUSTER_APPROVED` y `TEST_APPROVED`. El laboratorio M4 debe poder usarse sin falsificar esas aprobaciones ni retirar los controles técnicos de destino, identidad, privilegios y limpieza.

## Decisión

Se añade un camino separado `LOCAL_SOLO_LAB` con documento externo `OPERATOR_ACKNOWLEDGED`, revisor independiente `NONE` y alcance `ACADEMIC_LOCAL_LAB`. Una confirmación escrita interactivamente por el operador crea el documento; cargar Copilot, Prisma o Vitest no lo emite.

La autorización queda limitada a PostgreSQL 17 en `127.0.0.1:65535`, base `sigae_m4_test_20261113_01`, PGDATA `D:/Desarrollo/SIGAE-M4-POSTGRES-LAB/pgdata`, `system_identifier=7707660153733072384`, administrador `sigae_m4_admin_20261113_01` y ejecutor `sigae_m4_test_20261113_01`. El proceso/listener y `pg_controldata` se comprueban físicamente; la evidencia y el documento externo se vinculan por SHA-256. El documento vence como máximo a los 10 minutos y la evidencia física a los 15 minutos.

Las operaciones deben enumerarse explícitamente: `MIGRATE_DEPLOY`, `GRANT_RUNNER_PRIVILEGES`, `ADMIN_PREFLIGHT` y `RUN_POSTGRES_HARNESS`. Cada ruta automatizada exige su operación; el GRANT manual requiere una comprobación de autorización explícita y no es ejecutado por el preflight ni por el harness. Antes de abrir conexiones, el harness exige un informe externo de preflight con hash que coincida con el mismo `authorizationId`, identidad, inventario, privilegios y cero sesiones cliente adicionales. La configuración M4 rechaza `NODE_ENV=production` y cualquier destino distinto del fijo. La configuración Prisma estándar rechaza las variables M4 antes y después de su eventual carga de entorno.

`CLUSTER_APPROVED` y `TEST_APPROVED` conservan exactamente su comportamiento. `LOCAL_SOLO_LAB` nunca genera ni se serializa como `APPROVED`. El informe local identifica la modalidad y declara que no hubo revisión independiente. El preflight sigue comparando la identidad conectada, `system_identifier`, migraciones, esquema, ACL y sesiones; el harness sigue validando identidad ejecutora, privilegios, estado de datos y limpieza. No se conceden permisos automáticamente.

## Consecuencias y limitaciones

- Esta modalidad solo autoriza pruebas académicas en el cluster local descartable indicado; no permite Neon, producción, otros clusters, M3, DPAPI, IPC, Stellar, Soroban ni Testnet.
- La auto-declaración no acredita revisión independiente, aprobación docente, seguridad de producción ni integridad frente a un administrador local malicioso.
- Las migraciones, cambios de ACL, preflight y harness requieren autorización explícita antes de ejecutarse. La aceptación de este ADR no equivale a autorización para ejecutarlos.
- Si expira la autorización/evidencia, cambia cualquier identidad, aparece una sesión cliente inesperada o falla limpieza/verificación, se detiene el flujo.
