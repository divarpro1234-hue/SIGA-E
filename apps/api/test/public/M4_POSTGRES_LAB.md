# Laboratorio PostgreSQL M4

## Alcance y estado

`public-alert-service.postgres.integration.ts` invoca `PrismaPublicAlertService` y un `PrismaClient` reales. El harness comprueba el SQL PostgreSQL de listado/conteo, detalle y evidencia; las suites normales con mocks no prueban la ejecución del SQL en PostgreSQL.

Esta documentación y los archivos auxiliares preparan el flujo, pero no aprovisionan ni conectan nada. La prueba no se debe ejecutar hasta contar con autorización específica para aprovisionamiento y ejecución, y con un PostgreSQL 17 nuevo, local, dedicado y descartable. No usar Neon ni bases de M1, M2, M3, M5 u otros proyectos.

## Separación de identidades y aprobación

El laboratorio distingue:

1. **Bootstrap temporal** para inicializar el cluster, crear la base y los dos roles. No se usa en los preflights ni en las pruebas; debe quedar deshabilitado o eliminarse después de transferir propiedad y verificar dependencias.
2. **Identidad administrativa M4** para migraciones y preflight de solo lectura. No es superusuario y no se entrega al harness.
3. **Identidad ejecutora M4** para el harness. Solo recibe los privilegios de fixtures indicados abajo y su URL es la única fuente de conexión del test.

La confirmación interactiva y los prefijos de nombre no demuestran aislamiento. Se requieren dos atestaciones JSON, guardadas fuera del repositorio y sin credenciales:

- `SIGAE_M4_PG_CLUSTER_ATTESTATION_PATH` y `SIGAE_M4_PG_CLUSTER_ATTESTATION_SHA256`: archivo `CLUSTER_APPROVED`, aprobado por una persona antes de usar la identidad administrativa.
- `SIGAE_M4_PG_TEST_ATTESTATION_PATH` y `SIGAE_M4_PG_TEST_ATTESTATION_SHA256`: archivo `TEST_APPROVED`, aprobado independientemente después del preflight y antes del harness.

El SHA-256 esperado se debe entregar por un canal de aprobación separado del archivo. Cada atestación tiene vigencia máxima de 15 minutos desde `approvedAt`, contiene una referencia de aprobación y no puede estar vencida. El parser rechaza archivos dentro del repositorio, archivos mayores de 16 KiB, claves desconocidas y atestaciones cuyo hash no coincida. No genera ni aprueba atestaciones.

Ambas atestaciones declaran `schemaVersion: 1`, `status: "APPROVED"`, identificador de atestación, referencia de aprobación, `approvedAt`/`expiresAt` UTC, `dataDirectory`, `systemIdentifier`, `databaseName`, host loopback exacto (`127.0.0.1` o `::1`), puerto, roles administrativo/ejecutor y `postgresMajor: 17`. El destino debe llamarse `sigae_m4_test_*`; los roles deben tener prefijos `sigae_m4_admin_*` y `sigae_m4_test_*`.

La atestación `TEST_APPROVED` añade las cuatro migraciones verificadas, las 14 tablas de aplicación esperadas, conteos en cero (salvo la única fila génesis permitida de `audit_chain_state`), `unexpectedRelations: []`, `auditChainGenesisVerified: true` y `preflightReportSha256`. Su hash de archivo también se aprueba por separado. El preflight solo produce `PREFLIGHT_PASSED_REQUIRES_SEPARATE_APPROVAL`; nunca convierte su propio resultado en una atestación aprobada.

El ejecutor no consulta `system_identifier`, `data_directory` ni las nueve tablas ajenas a sus fixtures: su rol no debe obtener permisos adicionales para hacerlo. Consume la evidencia del preflight administrativo vinculada por hash y contrasta por sí mismo URL, base, rol, puerto, dirección efectiva loopback, `listen_addresses`, PostgreSQL 17, zona horaria, `search_path`, privilegios, migraciones y estado vacío de las tablas que usa. La atestación no elimina el riesgo de cambios concurrentes entre preflight y prueba. Se requiere cluster dedicado, ninguna otra sesión cliente durante el preflight, vigencia breve y ejecución inmediata; ante duda, cambios o vencimiento, STOP y repetir revisión/aprobación.

El administrador comprueba `system_identifier` desde la conexión con `pg_control_system()`. No consulta `data_directory`: PostgreSQL puede denegar `current_setting('data_directory')` a un rol no privilegiado, y no se concede `pg_read_all_settings` para evitar ampliar sus capacidades. El `dataDirectory` de la atestación debe estar verificado independientemente en Windows mediante `pg_controldata` sobre la ruta física y la identidad del proceso/listener PostgreSQL que atiende la dirección y puerto atestados. La evidencia externa debe mostrar el mismo `system_identifier`; una ruta declarada por sí sola no acredita el destino. Una persona independiente revisa y aprueba esa evidencia antes de crear `CLUSTER_APPROVED`. El informe del preflight identifica la ruta como procedente de la atestación aprobada, no como una propiedad releída desde la sesión SQL.

Procedimiento externo propuesto (solo consulta; no ejecutarlo como parte de preflight): identificar el PID único que escucha en `127.0.0.1:65535`, comprobar su ejecutable y que la configuración/argumentos de ese proceso apuntan al directorio esperado, y ejecutar `pg_controldata.exe` de PostgreSQL 17 sobre ese directorio. La evidencia debe registrar la fecha UTC, PID, ruta del ejecutable, ruta de datos comprobada y `Database system identifier: 7707660153733072384`. Si hay cero o varios PID, no se puede asociar el directorio al proceso, la versión/herramienta no es identificable o el ID no coincide, STOP. No publicar la línea de comandos completa del proceso si pudiera contener datos sensibles.

## Variables y límites de conexión

La configuración Prisma aislada `prisma.m4-postgres.config.ts` consume exclusivamente `SIGAE_M4_PG_ADMIN_URL` más las dos variables de referencia de la atestación de cluster. Antes de construir el config, exige exactamente las cuatro migraciones M4 previstas, su metadata permitida y el provider PostgreSQL; rechaza migraciones adicionales o faltantes. No importa `dotenv/config`, no recurre a `DATABASE_URL`/`DIRECT_URL` y no abre una conexión al importarse. La configuración Prisma estándar del proyecto no se usa ni modifica.

El harness consume exclusivamente `SIGAE_M4_PG_TEST_URL`, la confirmación `SIGAE_M4_PG_TEST_DISPOSABLE_ACK=I_ACKNOWLEDGE_M4_DISPOSABLE_POSTGRES` y la atestación `TEST_APPROVED` con su hash. La URL debe tener protocolo PostgreSQL, credencial, puerto explícito y un host IP literal `127.0.0.1` o `[::1]` (no `localhost`, para evitar resolución DNS), con base y rol idénticos a la atestación; no puede tener query ni fragmento. No se imprime la URL ni se usan variables alternativas.

La validación de configuración/atestación es local y sucede antes de crear `PrismaClient`; la verificación de identidad del harness sucede antes de fixtures. Errores de preflight son STOP, no una invitación a cambiar de destino. Ni el preflight ni el harness ejecutan migraciones, crean/eliminan bases, crean roles, otorgan permisos o usan Testnet/Soroban.

## Preflight administrativo

Ejecutar en una etapa futura expresamente autorizada, desde `apps/api`, una vez creada la base vacía y configuradas solo las variables aprobadas:

```powershell
pnpm exec tsx scripts/m4-postgres-admin-preflight.ts
```

El preflight valida localmente la URL administrativa contra la atestación `CLUSTER_APPROVED`, conecta solo a esa URL y realiza una transacción `RepeatableRead` y `READ ONLY`. Contrasta identidad/base/rol, host y puerto efectivos, `listen_addresses`, el `system_identifier` leído con `pg_control_system()`, zona UTC, versión 17, migraciones exactas, inventario de esquema/relaciones, conteo de las 14 tablas, fila génesis de auditoría y ausencia de otras conexiones cliente. El directorio físico se valida externamente y por aprobación independiente como se describe arriba; el preflight no lo presenta como comprobado por SQL.

La salida es un informe JSON sintético, no un certificado ni una aprobación. Debe revisarse independientemente, guardarse fuera del repositorio y vincularse con `preflightReportSha256` en la nueva atestación `TEST_APPROVED`. El preflight no verifica por sí solo el origen humano de la atestación ni puede excluir cambios de otro administrador después de terminar. Las consultas de inspección y sus resultados siguen sin validación física hasta ejecutarse en una etapa autorizada contra PostgreSQL 17.

## Rol ejecutor

El preflight administrativo y el harness comprueban por separado al ejecutor: la atestación fija un `runnerRoleName` distinto de `adminRoleName`; el preflight inspecciona el rol ejecutor y el harness confirma que su propia identidad coincide con esa atestación y no pertenece al rol administrativo. Ambos rechazan membresías de roles heredables o asignables mediante `SET ROLE`; el harness vuelve a comprobar los privilegios efectivos como el ejecutor. No se conceden ni revocan permisos automáticamente.

El ejecutor no es superusuario, no puede crear roles ni bases, replicar, omitir RLS, crear objetos, usar `TEMPORARY`, ser propietario de la base/esquemas/relaciones, ni heredar privilegios mediante membresías. No debe tener `CREATE` efectivo en ninguna base ni `CREATE` sobre esquemas, privilegios efectivos en esquemas ajenos a `public`, ni acceso a secuencias. Sus únicos privilegios efectivos de relación permitidos son `SELECT`, `INSERT` y `DELETE` sobre `users`, `public_keys`, `alerts`, `anchor_deployments` y `anchor_jobs`, y solo `SELECT` sobre `_prisma_migrations`.

La inspección de relaciones incluye tablas ordinarias y particionadas, vistas, vistas materializadas y tablas foráneas; la lista de privilegios incluye `SELECT`, `INSERT`, `UPDATE`, `DELETE`, `TRUNCATE`, `REFERENCES`, `TRIGGER` y `MAINTAIN` de PostgreSQL 17. Se comprueban privilegios efectivos por relación y columna, ACL explícitos por columna, y grant options en ACL de base, esquema, relaciones, secuencias y columnas para el usuario o `PUBLIC`. También se exige ausencia de `CONNECT` y `TEMPORARY` efectivos en bases ajenas; las consultas usan `has_database_privilege`, cuyo nombre es el expuesto por PostgreSQL 17. Como las membresías a otros roles se rechazan, los permisos heredados no se aceptan como excepción. Un privilegio, grant option, membresía, propiedad o tipo de relación que no pueda verificarse por falta de capacidad de catálogo produce `NO_VERIFICADO` y detiene el flujo; no se interpreta como ausencia de privilegios. Estas consultas son inspección estática hasta que se ejecuten en un laboratorio expresamente autorizado: su sintaxis y resultado físico en PostgreSQL 17 no se dan por validados aquí.

Las migraciones se aplican separadamente con la identidad administrativa y solo a la base atestada. El rol ejecutor no se usa para migrar ni para consultas administrativas. La configuración auxiliar de Prisma no cambia `schema.prisma`, migraciones ni la configuración normal.

## Fixture, cobertura y límites

Los fixtures usan modelos/tablas Prisma reales, UUID aleatorios, etiquetas `SIMULACRO`, dominios `example.invalid` y claves ES256 efímeras. El test no invoca worker, gateway, Testnet, Soroban ni firmador Windows. Para probar múltiples jobs, crea un deployment Testnet ficticio adicional en `RETIRED`, respetando la unicidad `(alertId, deploymentId)` y el índice de deployment activo.

- PG-M4-01: publicación confirmada y coherencia de listado/detalle/evidencia.
- PG-M4-02: `jwsHash` de `AnchorJob` inconsistente.
- PG-M4-03: `messageKey` discordante.
- PG-M4-04: `txHash` vacío o blanco.
- PG-M4-05: `confirmedLedger` nulo.
- PG-M4-06a: `confirmedLedger = 0`, rechazado con evidencia del constraint `anchor_jobs_confirmed_ledger_positive` o SQLSTATE `23514`.
- PG-M4-06b: `confirmedLedger < 0`, rechazado con evidencia del mismo constraint o SQLSTATE `23514`.
- PG-M4-06c: `confirmedLedger > 0`, admitido en un fixture válido.
- PG-M4-07: jobs de deployments distintos.
- PG-M4-08: elegibilidad, paginación, conteo y orden determinista.
- PG-M4-09: estado `SIGNED_PENDING_ANCHOR`.
- PG-M4-10: coherencia conjunta de listado, detalle y evidencia.
- PG-M4-11: pendiente; requiere un rol lector independiente con `SELECT` denegado y evidencia de `PUBLIC_DATA_UNAVAILABLE`. No se considera implementado ni aprobado.

PG-M4-06 no acepta `P2004` por sí solo. El harness busca el nombre exacto de la restricción o un SQLSTATE `23514` en los datos del error disponibles, sin depender de un único formato de metadatos Prisma. Si el adaptador solo expone `P2004`, el caso falla cerrado como `M4_PG_CONFIRMED_LEDGER_CONSTRAINT_NOT_IDENTIFIED`; no se considera prueba de la restricción. En una etapa autorizada, si Prisma no expone esa evidencia, la alternativa es una operación controlada que intente insertar un `anchor_jobs.confirmed_ledger` cero/negativo mientras conserva válidos los demás campos, capture el error PostgreSQL original (`code = 23514` y, si está disponible, `constraint = anchor_jobs_confirmed_ledger_positive`) y revierta la transacción. No se altera ni elimina el constraint. Esta etapa no ejecutó la prueba ni confirmó qué metadatos expondrá físicamente el adaptador.

PG-M4-11 permanece `TODO` y no se contabiliza como aprobado. Su procedimiento futuro requiere autorización separada para crear una identidad temporal restringida, distinta del ejecutor principal, con `CONNECT` a la base y `USAGE` de `public`, pero sin `SELECT` sobre `public.alerts`; comprobar antes que no hereda ese permiso por membresías o `PUBLIC`. Usar únicamente esa identidad para intentar un `SELECT` acotado y esperar rechazo PostgreSQL (`42501`), registrar el error saneado y desconectarla. La creación del rol y sus permisos exige aprobación propia; no se crea ahora ni se modifican los permisos del ejecutor principal.

## Limpieza

El harness no elimina bases, esquemas, migraciones ni objetos ajenos. Registra UUID/IDs generados por su ejecución y borra, en orden de claves foráneas, sus jobs, alertas y deployments transitorios; después intenta limpiar por sus identificadores propios el deployment principal, la clave efímera y el usuario de la suite. No hay `TRUNCATE`, `DROP`, ni borrado global.

Si una limpieza transitoria falla, el harness conserva el error, bloquea la creación de fixtures y falla cada `beforeEach` posterior antes de ejecutar el cuerpo del test; Vitest no cancela toda la suite mediante ese hook. El hook `afterAll` vuelve a intentar limpiar los identificadores propios pendientes y siempre intenta `$disconnect()` mediante `finally`, agregando errores originales, de limpieza y desconexión para que permanezcan visibles. Los errores del test y de `afterEach` también se agregan cuando Vitest conserva el resultado del test. La desconexión no puede garantizarse después de terminación forzada del proceso. Un fallo sigue siendo fallo aunque el reintento de teardown logre retirar los fixtures; no autoriza a continuar sobre otro destino.

## Procedimiento futuro por fases

Ninguna de estas fases se ha ejecutado. Cada fase necesita autorización expresa correspondiente; la aprobación de este cambio de código no autoriza crear servicios, usuarios, credenciales, bases ni ejecutar pruebas.

### FASE A — Preparación de herramientas

Precondición: autorización para inventario local y ruta de instalación confirmada; no reutilizar servicios/clusters hallados. Consultas propuestas:

```powershell
Get-Command initdb, postgres, pg_ctl, psql -ErrorAction SilentlyContinue
& $InitdbPath --version
& $PostgresPath --version
& $PgCtlPath --version
```

Confirmar que cada binario pertenece a PostgreSQL 17, verificar permisos de escritura solo en la futura ruta de datos aprobada, e identificar un puerto con comprobación inmediatamente antes del arranque. La disponibilidad del puerto es transitoria y no prueba aislamiento.

### FASE B — Creación de cluster/base exclusiva

Precondiciones: instalación PostgreSQL 17 comprobada; ruta absoluta nueva fuera del repositorio, distinta de todos los directorios de datos de servicios existentes; puerto dedicado revisado; loopback y UTC; autorización explícita para crear el cluster. No completar variables con rutas/puertos supuestos.

Plantilla que solo se completa y ejecuta tras verificar cada valor:

```powershell
if (Test-Path -LiteralPath $DataDirectory) { throw "STOP: data directory already exists" }
if (Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue) {
  throw "STOP: selected port is occupied"
}
& $InitdbPath -D $DataDirectory -U $BootstrapRole --auth-local=scram-sha-256 --auth-host=scram-sha-256 --pwprompt
if ($LASTEXITCODE -ne 0) { throw "STOP: initdb failed" }
& $PgCtlPath -D $DataDirectory -l $LabLog -o "-h 127.0.0.1 -p $Port -c listen_addresses=127.0.0.1 -c timezone=UTC" -w start
if ($LASTEXITCODE -ne 0) { throw "STOP: cluster start failed" }
```

Antes de ejecutar, sustituir variables por valores absolutos revisados; no incluir contraseñas en argumentos, historial, archivos versionados o logs. El bootstrap no debe quedar como credencial de uso normal. El harness no arranca ni detiene servicios.

### FASE C — Configuración de roles y permisos

Precondiciones: identidad y cluster verificados; aprobación explícita para crear los roles y cambiar permisos. Crear una base `sigae_m4_test_*` propiedad de la identidad administrativa, y roles dedicados `sigae_m4_admin_*` y `sigae_m4_test_*`. El bootstrap no se usa en pruebas. Configuración de referencia, ajustada solo tras revisión del schema desplegado:

```sql
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT CONNECT ON DATABASE sigae_m4_test_<sufijo> TO sigae_m4_test_<sufijo>;
GRANT USAGE ON SCHEMA public TO sigae_m4_test_<sufijo>;
GRANT SELECT, INSERT, DELETE ON TABLE
  public.users, public.public_keys, public.alerts,
  public.anchor_deployments, public.anchor_jobs
  TO sigae_m4_test_<sufijo>;
GRANT SELECT ON TABLE public."_prisma_migrations" TO sigae_m4_test_<sufijo>;
```

El preflight y el harness también rechazan `TEMPORARY` efectivo en la base M4 y `CONNECT`/`TEMPORARY` efectivos en otras bases. PostgreSQL puede heredarlos de `PUBLIC`; si están presentes, ambos deben detenerse. Cualquier ajuste de ACL para la base desechable (por ejemplo, retirar esos permisos a `PUBLIC`) requiere autorización administrativa separada y revisión de impacto; nunca lo ejecutan el preflight ni el harness.

Usar credenciales distintas, solicitarla de forma interactiva y suministrarlas solo al proceso autorizado. No registrar URL/contraseñas. El administrador debe tener lo necesario para aplicar las migraciones, inspeccionar el destino y ejecutar consultas de solo lectura; no ser superusuario ni conservar `CREATEDB`, `CREATEROLE`, replicación o `BYPASSRLS`. No conceder `pg_read_all_settings`, `pg_monitor` ni otros roles amplios para leer `data_directory`; la ruta se comprueba por evidencia externa. `pg_control_system()` ya fue confirmado como accesible, así que no requiere un `GRANT EXECUTE` adicional. Transferir propiedad y deshabilitar/restringir el bootstrap antes de la atestación.

### FASE D — Comprobaciones de aislamiento

Precondiciones: cluster dedicado iniciado y roles configurados. Consultas propuestas con la identidad administrativa: inspeccionar `current_database()`, `current_user`, `inet_server_addr()`, `inet_server_port()`, `listen_addresses`, `pg_control_system().system_identifier`, `server_version_num`, `TimeZone`, `pg_stat_activity`, esquemas/relaciones, permisos y `pg_database`. No consultar `data_directory` desde el rol. Verificar además que el bootstrap ya no permite acceso y que la identidad ejecutora no posee privilegios fuera de fixtures. Un operador local independiente debe correlacionar el proceso/listener que atiende el puerto con la ruta de `pg_controldata` y el mismo `system_identifier`. Crear y aprobar una `CLUSTER_APPROVED` solo después de revisar ambas evidencias. No copiar una atestación de otro cluster.

### FASE E — Aplicación de migraciones

Precondiciones: aprobación de cluster vigente, base vacía exacta, configuración validada, respaldo fuera del destino y autorización explícita para modificar el cluster nuevo. Configurar `SIGAE_M4_PG_ADMIN_URL` y las dos variables `CLUSTER_ATTESTATION_*` solo en el proceso. Luego:

```powershell
pnpm exec prisma migrate deploy --config prisma.m4-postgres.config.ts
```

No usar `prisma.m4-postgres.config.ts` con otro comando/destino. Confirmar destino antes de ejecutar; si falla o se detecta migración inesperada, detenerse sin resetear ni reintentar a ciegas.

### FASE F — Ejecución del harness

Precondiciones: migraciones exactas aplicadas; preflight administrativo pasa; revisión humana independiente del informe; `TEST_APPROVED` y su hash aprobados por canal separado; no hay otros clientes ni cambios concurrentes; autorización explícita para ejecutar las pruebas que escriben/limpian fixtures.

```powershell
pnpm exec tsx scripts/m4-postgres-admin-preflight.ts
pnpm exec vitest run --config vitest.m4-postgres.config.ts
```

Después del preflight, capturar y revisar el JSON, calcular su SHA-256 y aprobar la atestación `TEST_APPROVED`. La URL ejecutora solo se configura como `SIGAE_M4_PG_TEST_URL`; no proporcionar al proceso de Vitest la URL administrativa. El comando requiere confirmación literal `SIGAE_M4_PG_TEST_DISPOSABLE_ACK`.

### FASE G — Revisión de evidencias

Precondición: ejecución terminada. Revisar resultados individuales PG-M4-01 a PG-M4-10, atestaciones y hashes, salida de identidad, ausencia de errores de cleanup y que los registros transient no permanecen. PG-M4-11 sigue pendiente hasta implementar y ejecutar con rol lector separado. No presentar datos ficticios como transacciones Testnet ni mocks como ejecución PostgreSQL.

### FASE H — Limpieza y reversión

Precondiciones: autorización explícita de limpieza, revisión de evidencias y confirmación de que el destino coincide exactamente con la atestación y la ruta de datos inspeccionada. Primero detener el cluster por su ruta de datos exacta:

```powershell
& $PgCtlPath -D $DataDirectory -m fast -w stop
if ($LASTEXITCODE -ne 0) { throw "STOP: cluster did not stop cleanly" }
```

Verificar proceso detenido, servicio no registrado, ruta y `system_identifier` de las evidencias; preservar el informe y respaldos requeridos. Eliminar el directorio solo con autorización separada, confirmación interactiva del identificador de atestación y ruta literal revisada. No usar comodines, variables sin validar ni comandos recursivos sobre rutas no inspeccionadas. Si la identidad del contenido no es inequívoca, conservar/quarentenar y pedir revisión; nunca borrar un cluster encontrado previamente.

## Criterios STOP

Detenerse sin degradar controles si: atestación ausente, hash incorrecto, vencida o dentro del repositorio; base/rol/host/puerto/ruta/system identifier/version no coinciden; host no es loopback; hay conexiones concurrentes, schemas/relaciones/datos no reconocidos, migraciones distintas o fila génesis inválida; permisos insuficientes o excesivos; destino compartido; cambios concurrentes entre preflight y harness; fixture/cleanup falla; no se puede demostrar reversión segura. No modificar permisos automáticamente ni continuar sobre otro destino.

## Estado de preparación

En esta etapa solo se habilita el patrón y se documenta el protocolo. No se crearon cluster, usuarios, bases, credenciales ni atestaciones; no se ejecutó el script, el harness, Prisma CLI o migraciones; no hubo conexión PostgreSQL ni operación blockchain.

## Excepción LOCAL_SOLO_LAB para operador único

`CLUSTER_APPROVED` y `TEST_APPROVED` conservan sin cambios sus parsers, formatos y requisitos de revisión independiente. El modo separado `LOCAL_SOLO_LAB` no crea, satisface ni sustituye ninguna de esas aprobaciones; tampoco se acepta en `NODE_ENV=production` ni en la configuración Prisma estándar. Esa configuración rechaza cualquier referencia al modo M4 antes y después de su carga de entorno. Solo se permite desde la configuración M4 y para este destino fijo:

- PostgreSQL 17; `127.0.0.1:65535`; base `sigae_m4_test_20261113_01`.
- `system_identifier=7707660153733072384`.
- PGDATA `D:/Desarrollo/SIGAE-M4-POSTGRES-LAB/pgdata`.
- Administrador `sigae_m4_admin_20261113_01`; ejecutor `sigae_m4_test_20261113_01`.

El documento externo tiene `mode: "LOCAL_SOLO_LAB"`, `status: "OPERATOR_ACKNOWLEDGED"`, `independentReviewer: "NONE"`, alcance `ACADEMIC_LOCAL_LAB`, operador, operaciones explícitas, `authorizationId`, timestamps UTC canónicos, evidencia física vinculada por ruta/hash y hash SHA-256 del documento exacto. No contiene `approvalReference` ni estado `APPROVED`. El parser rechaza propiedades desconocidas, hash incorrecto, archivos dentro del repositorio, destino/operaciones distintos, evidencia física inválida o vencida, y una vigencia superior a 10 minutos. La evidencia física debe tener como máximo 15 minutos.

El generador interactivo `scripts/create-m4-local-solo-authorization.ps1` verifica solo el proceso/listener local, que el único argumento `-D` sea el PGDATA M4, el resultado de `pg_controldata` 17 y la independencia del servicio `postgresql-x64-17`. Después muestra el alcance y exige que el operador escriba una frase exacta; iniciar Copilot, importar la configuración Prisma o cargar el harness no crea autorización. El script crea los JSON fuera del repositorio con `CreateNew` (nunca sobrescribe) y no conecta a PostgreSQL ni ejecuta migraciones, GRANT o pruebas. No se ha ejecutado este generador.

Variables de autorización individual, solo para el proceso local:

```powershell
$env:SIGAE_M4_PG_AUTHORIZATION_MODE = 'LOCAL_SOLO_LAB'
$env:SIGAE_M4_PG_LOCAL_SOLO_ACK = 'I_ACKNOWLEDGE_LOCAL_SOLO_LAB'
$env:SIGAE_M4_PG_LOCAL_SOLO_AUTH_PATH = '<ruta externa emitida por el generador>'
$env:SIGAE_M4_PG_LOCAL_SOLO_AUTH_SHA256 = '<SHA-256 externo emitido por el generador>'
```

Cada consumidor exige también la operación correspondiente: `MIGRATE_DEPLOY`, `GRANT_RUNNER_PRIVILEGES`, `ADMIN_PREFLIGHT` o `RUN_POSTGRES_HARNESS`. La configuración `prisma.m4-postgres.config.ts` acepta solo `MIGRATE_DEPLOY`; el preflight pide `ADMIN_PREFLIGHT`; el harness exige `RUN_POSTGRES_HARNESS` y un informe de preflight externo con ruta/hash. Antes del GRANT manual, el operador valida la autorización para esa operación con el modo `--assert-local-solo-operation` del preflight; ese modo no conecta a PostgreSQL. El harness verifica que el informe esté vinculado al mismo `authorizationId`, identidad, `system_identifier`, inventario, cero conexiones adicionales, privilegios y génesis; exige que el informe sea reciente y no esté vencido. La ruta de conexión sigue fija y el rol ejecutor sigue separado del administrador. El preflight verifica `system_identifier` conectado mediante `pg_control_system()`, las migraciones, las 14 tablas, la génesis, los privilegios efectivos/ACL y que no haya otras sesiones cliente en el cluster M4. La evidencia de PGDATA se etiqueta `OPERATOR_ACKNOWLEDGED_PHYSICAL_EVIDENCE`, nunca como aprobación independiente.

Flujo futuro, no ejecutado. Antes de cualquier operación PostgreSQL, el orquestador comprueba el estado local, analiza PowerShell, ejecuta TypeScript typecheck, la suite offline completa y la suite criptográfica protegida. Si alguna falla, detiene el flujo antes de verificar el cluster, solicitar autorización o escribir en PostgreSQL.

1. Ejecutar el generador interactivamente y revisar ruta/hash/expiración; re-generar si vence.
2. Solicitar la contraseña del administrador de forma interactiva en memoria y ejecutar únicamente `pnpm exec prisma migrate deploy --config prisma.m4-postgres.config.ts` desde `apps/api`. No usar `DATABASE_URL`, `DIRECT_URL`, `migrate reset` ni `migrate dev`.
3. En una sesión `psql -X -W` dirigida solo a `127.0.0.1:65535/sigae_m4_test_20261113_01`, confirmar las cuatro migraciones, las 14 tablas y la fila génesis; revisar también el constraint sin alterarlo. La contraseña se solicita en el prompt de `psql`, nunca en sus argumentos:

   ```powershell
   psql -X -W -h 127.0.0.1 -p 65535 -U sigae_m4_admin_20261113_01 `
     -d sigae_m4_test_20261113_01 -v ON_ERROR_STOP=1
   ```

   Consultas de solo lectura:

   ```sql
   SELECT migration_name, finished_at IS NOT NULL AS finished,
          rolled_back_at IS NULL AS not_rolled_back
   FROM public."_prisma_migrations" ORDER BY migration_name;

   SELECT tablename FROM pg_tables
   WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'
   ORDER BY tablename;

   SELECT id, last_seq, encode(last_hash, 'hex') AS last_hash
   FROM public.audit_chain_state;

   SELECT conname, convalidated, pg_get_constraintdef(oid)
   FROM pg_constraint
   WHERE conrelid = 'public.anchor_jobs'::regclass
     AND conname = 'anchor_jobs_confirmed_ledger_positive'
     AND contype = 'c';
   ```

   Deben aparecer exactamente las cuatro migraciones y 14 tablas; la génesis debe ser una fila `(1, 0, 64 ceros)`. El constraint debe estar validado y expresar `confirmed_ledger IS NULL OR confirmed_ledger > 0`, conforme a `20261011_initial`. Cualquier diferencia es STOP.
4. Validar `GRANT_RUNNER_PRIVILEGES` con `pnpm exec tsx scripts/m4-postgres-admin-preflight.ts --assert-local-solo-operation GRANT_RUNNER_PRIVILEGES`; solo si pasa, aplicar manualmente los GRANT mínimos ya descritos en “Rol ejecutor”. Ni preflight ni harness otorgan/revocan permisos.
5. Ejecutar el preflight administrativo, revisar el informe y guardarlo fuera del repositorio. Un informe exitoso no es una aprobación.
6. Guardar el informe sin BOM y configurar su hash exacto:

   ```powershell
   $preflightPath = '<ruta externa nueva>.json'
   $preflightJson = (pnpm exec tsx scripts/m4-postgres-admin-preflight.ts | Out-String).Trim()
   if ($LASTEXITCODE -ne 0) { throw 'STOP: M4 preflight failed' }
   $preflightBytes = [Text.UTF8Encoding]::new($false).GetBytes($preflightJson)
   $preflightFile = [IO.File]::Open(
     $preflightPath, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None
   )
   try { $preflightFile.Write($preflightBytes, 0, $preflightBytes.Length) }
   finally { $preflightFile.Dispose() }
   $env:SIGAE_M4_PG_LOCAL_SOLO_PREFLIGHT_PATH = $preflightPath
   $env:SIGAE_M4_PG_LOCAL_SOLO_PREFLIGHT_SHA256 =
     (Get-FileHash -LiteralPath $preflightPath -Algorithm SHA256).Hash.ToLowerInvariant()
   ```

7. Ejecutar el harness solo con `RUN_POSTGRES_HARNESS`, rol ejecutor y URL exacta del cluster. Conserva todas las comprobaciones de identidad, permisos, migraciones, estado vacío y limpieza. PG-M4-11 continúa TODO.
8. Revisar las fases ejecutadas/no ejecutadas y las evidencias finales. Las suites offline ya se completaron antes de la verificación física y de cualquier autorización/escritura.

Esta excepción no habilita Neon, otros clusters/bases, M3, DPAPI, IPC, Stellar, Soroban ni Testnet. El estado `NODE_ENV=production`, un hash/archivo vencido o una diferencia de identidad es STOP. La verificación de cero sesiones es solo del cluster M4; el aislamiento de otros servicios se basa en el destino fijo y en la evidencia física del proceso, no en una afirmación de que el preflight inspecciona otras instancias PostgreSQL.

### Orquestador local del laboratorio

El flujo anterior queda automatizado por [`scripts/run-m4-local-solo-lab.ps1`](../../../../scripts/run-m4-local-solo-lab.ps1). Desde la raíz del repositorio, el operador ejecuta ese único script en Windows PowerShell 5.1. Primero comprueba HEAD, rama, staging y hashes de archivos protegidos; analiza la sintaxis PowerShell y prueba el parser; ejecuta typecheck, regresión offline completa y suite criptográfica protegida. Cualquier fallo detiene la ejecución antes de verificar el cluster M4 o solicitar autorización. Solo después valida el listener, rutas físicas, `pg_controldata` e independencia del servicio original, y solicita la frase de confirmación LOCAL_SOLO_LAB.

Después de la confirmación solicita cada contraseña con `Read-Host -AsSecureString`, nunca persiste ni imprime credenciales, ejecuta solo `migrate deploy`, el GRANT mínimo descrito, el preflight y el harness con su autorización y reporte vinculados. La configuración M4 rechaza cualquier conjunto distinto de las cuatro migraciones exactas antes de Prisma. Verifica migraciones, 14 tablas, génesis y constraint antes de conceder permisos. Comprueba la vigencia antes de cada operación; si la autorización está vencida o próxima a vencer, solicita una nueva confirmación y genera una autorización nueva, sin alterar timestamps. Si cambia la autorización después del preflight y antes del harness, vuelve a producir un preflight vinculado al nuevo `authorizationId`.

El resultado consolidado, los reportes y sus SHA-256 se guardan fuera del repositorio en el directorio de evidencias configurado por el script. Un error detiene las fases posteriores; el informe identifica fases completadas, fallidas y no ejecutadas. Preparar o invocar el script no equivale a aprobación independiente; el operador sigue confirmando manualmente en la terminal y la ejecución del laboratorio no forma parte de la preparación de código.

### Nota para el informe de seguridad posterior a la ejecución

El repositorio no contiene un informe de seguridad independiente identificado. El siguiente texto es una plantilla obligatoria para incorporar en ese informe solo después de que las pruebas reales se ejecuten y sus evidencias se revisen; no describe el estado actual:

> Las pruebas se ejecutaron en un laboratorio PostgreSQL local, aislado y descartable, bajo declaración responsable de un operador único. Se verificaron controles técnicos de identidad y privilegios; no se contó con revisión humana independiente.
