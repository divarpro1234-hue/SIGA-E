# Prompt 05-D — Preparación de la migración inicial en `development`

**Veredicto: PREPARADO PARA AUTORIZACION.** Esta preparación no abrió conexiones a Neon, no ejecutó `prisma migrate deploy` y no modificó ninguna rama de base de datos. La autorización de escritura para `development` sigue pendiente.

## Base de la decisión

El usuario comunicó un preflight manual satisfactorio para proyecto `siga-e`, rama `development` (`br-delicate-sky-b6okz1oe`), endpoint directo `ep-red-butterfly-b61jbniu`, base `siga_e`, esquema `public`, PostgreSQL 18, TLS verificado, cero objetos públicos, `_prisma_migrations` ausente, migración inicial pendiente y `ROLLBACK` confirmado. Codex no repitió esa conexión. La asociación rama–endpoint fue confirmada visualmente por el usuario, no mediante API administrativa.

La migración local `20261011_initial` y `migration_lock.toml` permanecen sin cambios. SHA-256 local comprobado: `3A5D28D77DD23F9216A3C720C6EEC065507A9A421C7473D5382345D02146765F`.

## Archivos preparados

| Archivo | Función |
|---|---|
| `apps/api/prisma.development-deploy.config.ts` | Acepta solo la invocación prevista de `migrate deploy`, URL directa de `development`, rama confirmada, única migración local y hash autorizado. No carga `.env`. |
| `apps/api/scripts/run-initial-migration-development.ps1` | Ejecuta las fases A–J tras confirmaciones manuales. Aísla variables, lee stdout/stderr concurrentemente, aplica timeouts y registra evidencia sanitizada por ejecución. |
| `apps/api/scripts/verify-neon-development-initial-readonly.mjs` | Adaptación del verificador temporal probado a la URL exclusiva de `development`. Comprueba catálogos, historial, índices, FK, secuencia, génesis, TLS y `ROLLBACK`. |
| `apps/api/scripts/neon-development-migration.test.mjs` | Simulaciones locales de destino, configuración, Prisma, inventario, postflight, salidas y timeout. |
| `docs/evidencias/PROMPT_05D_preparacion_migracion_development.md` | Este informe de preparación. |

No se tocaron `schema.prisma`, `migration.sql`, los scripts de la rama temporal ni las evidencias históricas 05, 05-B y 05-C.

## Secuencia futura del ejecutor

1. Verifica hash, único directorio de migración y proveedor PostgreSQL.
2. Solicita IDs de rama y endpoint, y confirmación visual exacta; después solicita la URL en entrada oculta.
3. Ejecuta el inventario de `development` dentro de `BEGIN READ ONLY`/`ROLLBACK` y exige cero objetos públicos e historial ausente.
4. Ejecuta `prisma migrate status` y exige `MIGRACION_INICIAL_PENDIENTE` según los marcadores saneados y el inventario independiente.
5. Solicita la frase manual `AUTORIZO MIGRACION DEVELOPMENT`.
6. Repite inventario de solo lectura y hash inmediatamente antes de `deploy`.
7. Ejecuta `prisma migrate deploy` **una sola vez**, sin reintento automático.
8. Verifica en solo lectura 10 tablas de aplicación, `_prisma_migrations`, 11 enums, 9 FK, 21 CHECK, 29 índices explícitos, índice único de `jws_hash` y ausencia del de `jws_compact`, FK histórica `RESTRICT` en ambas direcciones, secuencia de auditoría ausente, génesis, migración finalizada y checksum coincidente.
9. Exige `migrate status` final `AL_DIA` y crea un informe local nuevo con sello de tiempo y nombre único.

Estados del ejecutor: `NO_EJECUTADA` antes de `deploy`; `RESULTADO_INCIERTO` desde el inicio de `deploy` hasta conocer éxito; `APLICADA_VALIDACION_PENDIENTE` después de salida `0` hasta completar verificaciones; `VALIDADA` solo tras postflight y status final. Un timeout o error durante `deploy` no se interpreta como rollback. No se reintenta ni se ejecuta SQL correctivo.

## Pruebas locales realizadas

| Comando o comprobación | Resultado |
|---|---|
| `pnpm.cmd --dir apps/api exec vitest run scripts/neon-development-migration.test.mjs scripts/neon-development-preflight.test.mjs` | 15/15 pruebas aprobadas en 2 archivos. |
| `-SelfTestGuards`, `-SelfTestDiagnostics`, `-SelfTestProcesses` del nuevo lanzador | Correctos; sin conexión. |
| `node --check apps/api/scripts/verify-neon-development-initial-readonly.mjs` | Correcto. |
| Análisis sintáctico PowerShell mediante `Parser.ParseFile` | Sin errores. |
| `pnpm.cmd --dir apps/api exec tsc --noEmit -p tsconfig.json` | Correcto. |
| `Get-FileHash` de `migration.sql` | Coincide con hash autorizado. |

Las pruebas incluyen rechazo de endpoint temporal y de production simulados, pooling, TLS inseguro y parámetros extra; configuración de `deploy` invocada **solo como módulo en memoria**, sin ejecutar el comando Prisma; errores simulados de conexión y divergencia, salida desconocida, historial ausente, inventario ocupado, postflight alterado, protección de la URL, lectura concurrente y timeout.

## Comando reservado para una autorización posterior

Desde `D:\Desarrollo\SIGA-E`, solo cuando exista autorización de escritura separada para `development`:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\apps\api\scripts\run-initial-migration-development.ps1
```

El lanzador nunca muestra la URL, contraseña ni stderr crudo. Cada ejecución manual genera `docs/evidencias/PROMPT_05D_ejecucion_development_*.md` con estados sanitizados. Compartir únicamente ese informe tras revisarlo.

## Riesgos y pendientes

- El preflight exitoso de `development` es información comunicada por el usuario; Codex no la verificó remotamente. El lanzador repetirá las comprobaciones antes de escribir.
- La asociación rama–endpoint se comprueba visualmente, sin API administrativa. Debe volver a confirmarse en la ejecución manual.
- Entre el segundo preflight y `deploy` puede existir una carrera con otro actor. Un resultado incierto exige consultar catálogo e historial antes de considerar otra acción.
- La verificación local y las simulaciones no sustituyen la verificación posterior real. Si falla postflight o status final, el estado queda `APLICADA_VALIDACION_PENDIENTE` y no se asume que un `ROLLBACK` pueda deshacer el despliegue.

**Siguiente paso:** revisión de este informe y autorización explícita separada para escribir en `development`. No comenzar Prompt 06.

## Endurecimiento final del hostname

El usuario confirmó visualmente el hostname directo completo `ep-red-butterfly-b61jbniu.c-2.sa-east-1.aws.neon.tech`. Al revisar `neon-development-url.mjs`, la constante `AUTHORIZED_HOST` y la comparación exacta con `url.hostname.toLowerCase()` ya estaban presentes; no fue necesario cambiar el validador. Se actualizaron las URLs sintéticas de las pruebas, que aún apuntaban a la región anterior, y se agregaron rechazos de otro endpoint, subdominio adicional, dominio engañoso, `-pooler` y parámetros no autorizados. Preflight, ambas configuraciones aisladas de Prisma y verificador posterior importan el mismo validador.

No hubo conexión a Neon ni ejecución de migraciones. El SHA-256 de `migration.sql` continúa en `3A5D28D77DD23F9216A3C720C6EEC065507A9A421C7473D5382345D02146765F`. La autorización de escritura para `development` continúa pendiente.
