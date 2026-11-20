# Prompt 05-B — Integridad PostgreSQL

> **Corrección posterior:** la tabla de expectativas y la ejecución manual conservadas más abajo reflejan el evaluador original. Para T08, el SQLSTATE exigido ahora es `23001` tanto en DELETE como en UPDATE, siempre junto con `audit_events_actor_id_fkey`. T06 mantiene `23503` con `sessions_user_id_fkey`. La primera ejecución y su clasificación FALLIDA no se reescriben.

**Estado original, antes de la primera ejecución:** PREPARADO PARA EJECUCIÓN LOCAL POR EL USUARIO. Ninguna prueba T01–T09 había sido ejecutada en Neon desde aquella sesión. La aplicación previa de `20261011_initial` y sus conteos eran datos reportados por el usuario, no una nueva comprobación remota.

## Destino y controles

- Proyecto `siga-e`; rama `test-initial-migration` (`br-late-bread-b6rl2mw3`); endpoint esperado `ep-green-frost-b6itfmc0`; base `siga_e`; PostgreSQL 18.
- El usuario verificó visualmente la asociación rama–endpoint. Esta prueba SQL no sustituye la comprobación independiente mediante la API administrativa de Neon.
- URL directa validada por `neon-test-url.mjs`: endpoint exacto, base, TLS y solo `sslmode=require` con `channel_binding=require` opcional. No se usa `.env`.
- El verificador posterior existente debe confirmar catálogo, génesis, TLS y checksum antes de cualquier fixture. El ejecutor repite identidad SQL, historial y hash local, y bloquea triggers activos, event triggers, reglas, secuencias públicas y defaults con llamadas a funciones en tablas de aplicación.
- SHA-256 autorizado de `migration.sql`: `3A5D28D77DD23F9216A3C720C6EEC065507A9A421C7473D5382345D02146765F`.

## Matriz original de expectativas (antes de la primera ejecución)

| Prueba | Operación y restricción real | SQLSTATE esperado | Estado real |
|---|---|---|---|
| T01 | Insertar `users` ficticio, `PENDING_ENROLLMENT`, sin credenciales | Ninguno | NO EJECUTADA |
| T02 | `users_credentials_consistent`, `ACTIVE` sin contraseña ni TOTP | `23514` | NO EJECUTADA |
| T03 | `users_name_length_and_trim`, nombre con espacios externos | `23514` | NO EJECUTADA |
| T04 | `alerts_jws_hash_32_bytes`, hash de 31 bytes | `23514` | NO EJECUTADA |
| T05 | `alerts_jws_hash_key`, segunda alerta con identidad distinta y hash igual | `23505` | NO EJECUTADA |
| T06 | `sessions_user_id_fkey`, usuario UUID ausente | `23503` | NO EJECUTADA |
| T07 | `audit_events_seq_positive`, secuencia cero con resto de campos válidos | `23514` | NO EJECUTADA |
| T08 | `audit_events_actor_id_fkey`, DELETE y UPDATE del ID del actor histórico | `23503` en ambos | NO EJECUTADA |
| T09 | Génesis `(1,0,32 bytes cero)` antes y después; conteos, UUID e historial tras ROLLBACK | Ninguno | NO EJECUTADA |

Los SQLSTATE y nombres de restricción deben coincidir ambos. Una violación distinta queda `FALLIDA`. El ejecutor usa UUID aleatorios y datos ficticios `example.invalid`; no genera contraseñas, TOTP, JWS reales ni notificaciones.

## Aislamiento y límites

Los fixtures usan una conexión directa y una transacción principal. Cada caso negativo crea `SAVEPOINT`, ejecuta la operación y hace `ROLLBACK TO SAVEPOINT` incluso si la operación tuvo éxito inesperado. El `finally` principal intenta `ROLLBACK`; la conexión se cierra. Un fallo al recuperar un savepoint interrumpe la batería. Si no se confirma el rollback, el estado es `INCIERTO` y no debe repetirse automáticamente.

Después del rollback, una transacción de solo lectura compara los conteos de las diez tablas, la génesis y el historial `_prisma_migrations`, y busca UUID de fixtures. El resultado confirma solo ausencia de persistencia **observable**; no demuestra reversión de efectos externos. El bloqueo previo de mecanismos con posibles efectos externos reduce ese riesgo.

## Ejecución futura desde PowerShell en VS Code

Desde `D:\Desarrollo\SIGA-E`:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\apps\api\scripts\run-neon-integrity-test.ps1
```

El lanzador pide la URL mediante entrada oculta, la pasa solo al proceso hijo, no imprime stdout crudo ni stderr y elimina su variable temporal. Tiene timeout de 180 segundos; un timeout se informa como `INCIERTO`, sin reintento automático. Si se produce, comprobar el estado de PostgreSQL y los fixtures antes de repetir.

## Evidencia local

- `node --check` para ejecutor y pruebas: correcto.
- `run-neon-integrity-test.ps1 -SelfTestProcesses`: correcto; salida concurrente y timeout con procesos ficticios, sin conexión.
- Vitest local: 6 archivos y 28 pruebas aprobadas. Incluye SQLSTATE y nombre exacto, éxito inesperado, recuperación fallida de savepoint, intento de ROLLBACK por excepción, URL inválida y ausencia de secreto en informe.
- `tsc --noEmit -p tsconfig.json`: correcto.
- SHA-256 local de `migration.sql`: `3A5D28D77DD23F9216A3C720C6EEC065507A9A421C7473D5382345D02146765F`, coincide.
- Ejecución sin URL: estado `BLOQUEADO` y todas T01–T09 `NO EJECUTADA`, sin conexión.

Las simulaciones locales no convierten ninguna fila T01–T09 en `APROBADA`. El lanzador añadirá una tabla sanitizada a este archivo tras una ejecución manual real que produzca informe completo. En un timeout, informará `INCIERTO`; no se debe inferir un rollback confirmado.

## Resultado remoto al preparar los scripts (registro histórico)

**NO EJECUTADO.** Tras la ejecución manual, registrar para cada fila `APROBADA`, `FALLIDA` o `NO EJECUTADA`, el SQLSTATE real sanitizado, la restricción real y los indicadores `rollback_confirmado` y `no_persistencia_observable` emitidos por el proceso. No registrar URL, usuario ni contraseña.

## Ejecucion manual 
2026-10-12T02:54:41Z

Estado: 
FALLIDA
ROLLBACK confirmado: 
True
No persistencia observable: 
True

| Prueba | Estado | SQLSTATE real | Restriccion real |
|---|---|---|---|
| T01 | APROBADA | - | - |
| T02 | APROBADA | 23514 | users_credentials_consistent |
| T03 | APROBADA | 23514 | users_name_length_and_trim |
| T04 | APROBADA | 23514 | alerts_jws_hash_32_bytes |
| T05 | APROBADA | 23505 | alerts_jws_hash_key |
| T06 | APROBADA | 23503 | sessions_user_id_fkey |
| T07 | APROBADA | 23514 | audit_events_seq_positive |
| T08 | FALLIDA | - | - |
| T09 | APROBADA | - | - |
| T08 borrar | FALLIDA | 23001 | audit_events_actor_id_fkey |
| T08 actualizar_id | FALLIDA | 23001 | audit_events_actor_id_fkey |

## Corrección puntual de T08

La primera ejecución real, informada por el usuario y registrada arriba, tuvo T01–T07 y T09 **APROBADAS**, T08 **FALLIDA** por el evaluador, `ROLLBACK` confirmado y no persistencia observable. DELETE y UPDATE del actor histórico devolvieron ambos `23001` con `audit_events_actor_id_fkey`. Esos datos históricos permanecen intactos.

La expectativa original `23503` correspondía a `foreign_key_violation`, mientras PostgreSQL clasifica la acción `RESTRICT` como `restrict_violation` (`23001`). El evaluador ahora exige simultáneamente `23001` y `audit_events_actor_id_fkey` en las dos operaciones de T08; otros SQLSTATE o nombres no aprueban la prueba. T06 sigue exigiendo `23503` y `sessions_user_id_fkey` para la inserción que referencia un usuario inexistente.

| Prueba corregida | SQLSTATE exigido | Restricción exigida |
|---|---|---|
| T06 | `23503` | `sessions_user_id_fkey` |
| T08 DELETE | `23001` | `audit_events_actor_id_fkey` |
| T08 UPDATE | `23001` | `audit_events_actor_id_fkey` |

Validación local tras la corrección: sintaxis Node correcta, TypeScript sin errores y Vitest **31/31** pruebas aprobadas en 6 archivos. Las nuevas simulaciones aceptan `23001` con la FK exacta para ambas operaciones de T08, rechazan `23503` u otra FK para T08 y confirman que T06 conserva `23503`. El SHA-256 de `migration.sql` sigue siendo `3A5D28D77DD23F9216A3C720C6EEC065507A9A421C7473D5382345D02146765F`.

No se cambiaron el esquema, el SQL, los savepoints, el `ROLLBACK` principal ni la comprobación de no persistencia. La primera ejecución no se reclasifica retroactivamente; la confirmación del evaluador corregido requiere una nueva ejecución manual del usuario.

## Ejecucion manual 
2026-10-12T02:59:50Z

Estado: 
APROBADA
ROLLBACK confirmado: 
True
No persistencia observable: 
True

| Prueba | Estado | SQLSTATE real | Restriccion real |
|---|---|---|---|
| T01 | APROBADA | - | - |
| T02 | APROBADA | 23514 | users_credentials_consistent |
| T03 | APROBADA | 23514 | users_name_length_and_trim |
| T04 | APROBADA | 23514 | alerts_jws_hash_32_bytes |
| T05 | APROBADA | 23505 | alerts_jws_hash_key |
| T06 | APROBADA | 23503 | sessions_user_id_fkey |
| T07 | APROBADA | 23514 | audit_events_seq_positive |
| T08 | APROBADA | - | - |
| T09 | APROBADA | - | - |
| T08 borrar | APROBADA | 23001 | audit_events_actor_id_fkey |
| T08 actualizar_id | APROBADA | 23001 | audit_events_actor_id_fkey |
