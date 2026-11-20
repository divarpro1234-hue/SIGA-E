# Integración HTTP M2 con PostgreSQL

Esta suite queda preparada, pero no se ejecutó en este paso. Solo el comando explícito con opt-in abre conexiones; el archivo `http.m2pg.ts` no coincide con el descubrimiento ordinario de Vitest. No reutilizar `sigae_m2_submit_itest`, ningún laboratorio M3 ni una base con datos de aplicación.

## Alcance y límites

La suite usa Supertest → `createApp` → `PrismaSessionReader` y `PrismaDraftAlertService` reales → Prisma → PostgreSQL. No usa dobles de persistencia en sus solicitudes HTTP. No configura firmante, servicio público, AnchorWorker ni Soroban.

Las identidades y sesiones se insertan directamente como fixtures sintéticos para probar autenticación de sesión, autorización, Origin y CSRF. **No** se ejecuta login, MFA/TOTP ni el aprovisionamiento M1; las credenciales sintéticas no sirven para iniciar sesión. No se eliminan fixtures al terminar: la base exclusiva debe mantenerse aislada y recrearse/aprovisionarse fuera de esta suite si se requiere otra ejecución.

## Preparación manual requerida

El operador/DBA debe preparar, fuera de esta etapa y sin reutilizar otros laboratorios:

- PostgreSQL local accesible únicamente por `127.0.0.1:55432`.
- Base `sigae_m2_http_itest`, propiedad de `sigae_m2_http_migrator`.
- Rol LOGIN no administrativo `sigae_m2_http_itest`, sin membresías, dueño de ningún objeto y sin `CREATE` en base o schema.
- El operador informa que las migraciones `20261011_initial`, `20261012_m1_identity_additive` y `20261021_m2_approval_snapshot` ya se aplicaron y que hay 15 tablas en `public`; el agente no lo verificó con una conexión. Esta suite no ejecuta migraciones.
- Confirmar como migrador, mediante consulta de solo lectura, que el ledger contiene exactamente esas tres migraciones finalizadas y ninguna revertida/adicional; que todas las tablas, incluidos `_prisma_migrations`, pertenecen al migrador; y que todas las tablas de aplicación están vacías, salvo `audit_chain_state` con la fila génesis `id=1`, `last_seq=0`, hash de 32 bytes cero.
- Solo después de comprobarlo, el migrador establece en comentario de la base el marcador exacto:
  `SIGAE_M2_HTTP_POSTGRES_LAB_V1;MIGRATIONS=20261011_initial,20261012_m1_identity_additive,20261021_m2_approval_snapshot;EMPTY=1`
- La sentencia de comentario (solo cuando esas comprobaciones estén completas) es:

```sql
COMMENT ON DATABASE sigae_m2_http_itest IS
  'SIGAE_M2_HTTP_POSTGRES_LAB_V1;MIGRATIONS=20261011_initial,20261012_m1_identity_additive,20261021_m2_approval_snapshot;EMPTY=1';
```
- Otorgar `CONNECT` en esa base y `USAGE` en `public` al runtime. Conceder únicamente los DML siguientes, como migrador:

```sql
GRANT CONNECT ON DATABASE sigae_m2_http_itest TO sigae_m2_http_itest;
GRANT USAGE ON SCHEMA public TO sigae_m2_http_itest;
GRANT SELECT, INSERT ON TABLE public.users TO sigae_m2_http_itest;
GRANT UPDATE (created_at) ON TABLE public.users TO sigae_m2_http_itest;
GRANT SELECT, INSERT ON TABLE public.sessions TO sigae_m2_http_itest;
GRANT UPDATE (last_seen_at) ON TABLE public.sessions TO sigae_m2_http_itest;
GRANT SELECT, INSERT, UPDATE ON TABLE public.alerts TO sigae_m2_http_itest;
GRANT SELECT, INSERT ON TABLE public.approvals TO sigae_m2_http_itest;
GRANT SELECT, INSERT ON TABLE public.audit_events TO sigae_m2_http_itest;
GRANT SELECT, UPDATE ON TABLE public.audit_chain_state TO sigae_m2_http_itest;
```

No conceder permisos sobre `_prisma_migrations`, `identity_*`, `alert_references`, `public_keys`, `anchor_*` ni otros objetos. No conceder `CREATE`, `DELETE`, `TRUNCATE`, `REFERENCES`, `TRIGGER`, `ALL PRIVILEGES` ni privilegios por defecto. El harness verifica permisos efectivos, roles, propietarios, dirección/puerto, base, marcador, esquema, índice M2 y génesis antes de crear fixtures. La verificación del ledger y del contenido de tablas que el runtime no puede leer es una atestación manual asociada al marcador; la suite no accede a `_prisma_migrations`.

Los `UPDATE` limitados a `users.created_at` y `sessions.last_seen_at` permiten las lecturas `SELECT ... FOR UPDATE` de identidad/sesión; el flujo solo cambia `sessions.last_seen_at`. No se necesita actualización de otras columnas de identidad.

Consultas de preflight de solo lectura para ejecutar manualmente como propietario/migrador:

```sql
SELECT current_database(), current_user, host(inet_server_addr()), inet_server_port(),
       shobj_description(oid, 'pg_database') AS marker
FROM pg_database WHERE datname = current_database();

SELECT migration_name, finished_at, rolled_back_at
FROM public._prisma_migrations
ORDER BY started_at;

SELECT c.relname, pg_get_userbyid(c.relowner) AS owner
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
ORDER BY c.relname;
```

Revisar manualmente que las tablas de aplicación estén vacías excepto la fila génesis de auditoría. La suite repite como runtime la comprobación de tablas que puede leer y se detiene si encuentra filas en `users`, `sessions`, `alerts`, `approvals` o `audit_events`.

## Ejecución futura autorizada

Desde `D:\Desarrollo\SIGA-E\apps\api`, ejecutar:

```powershell
.\scripts\run-m2-http-postgres.ps1
```

El script rechaza variables genéricas de conexión heredadas, solicita la frase `I_ACKNOWLEDGE_M2_HTTP_WRITES` y lee la contraseña del runtime de forma oculta. La contraseña solo se usa en memoria/proceso, no se escribe en archivos ni se pasa como argumento de línea de comandos. Se acepta una contraseña URL-safe de 16–128 caracteres (`A-Z`, `a-z`, dígitos, `.`, `_`, `~`, `-`). Tras finalizar, el script quita las variables temporales.

La suite escribe tres usuarios sintéticos, tres sesiones, dos alertas, dos decisiones y seis eventos auditados. No hace `DELETE`, `TRUNCATE`, reset, migraciones ni seeds de identidad; las evidencias permanecen en la base dedicada.

## Aplicación separada de migraciones (referencia del procedimiento ya ejecutado por el operador)

Según el estado informado por el operador en el paso 168.66-B.8-A, las tres migraciones están aplicadas y existen 15 tablas en `public`. El agente no verificó esos datos mediante conexión. El marcador del laboratorio, los permisos mínimos del runtime y que las tablas de aplicación estén vacías siguen siendo precondiciones separadas que no se consideran comprobadas por ese reporte de migración.

`apps/api/prisma7.config.ts` no se debe reutilizar: carga `.env` raíz y puede seleccionar `DIRECT_URL`. El ejecutor dedicado `prisma.m2-http-migrator.config.ts` no carga `.env`, `DATABASE_URL` ni `DIRECT_URL`; toma exclusivamente `SIGAE_M2_HTTP_MIGRATOR_DATABASE_URL`. Su configuración fija `prisma/schema.prisma` y `prisma/migrations`, y exige un opt-in para que `prisma migrate deploy` pueda iniciar.

El ejecutor comprueba en orden:

1. Que las únicas carpetas migratorias son las tres esperadas; cada una contiene `migration.sql`, y la carpeta M1 también puede contener su `README.md` histórico conocido. Los SHA-256 de los tres SQL y `migration_lock.toml` deben coincidir con la línea base revisada. No modifica estos archivos.
2. Antes de migrar, con conexión `pg` solo de lectura, que la conexión efectiva indica base `sigae_m2_http_itest`, usuario y propietario de base `sigae_m2_http_migrator`, PostgreSQL 17, servidor `127.0.0.1:55432`, UTF8, permiso de `CREATE` en `public`, schema sin objetos ni schemas adicionales, ledger inexistente y sin comentario/marcador.
3. Ejecuta exclusivamente `prisma migrate deploy --config prisma.m2-http-migrator.config.ts`, sin `--schema` alternativo ni URL en argumentos. El wrapper invoca el Node instalado directamente: `node --import tsx` para preflight/postflight y `node .\node_modules\prisma\build\index.js` para Prisma. No usa los shims `pnpm exec tsx` ni `tsx.cmd`, que inyectan `NODE_PATH` y son rechazados por la guardia. Prisma recibe por config la misma URL dedicada validada para preflight/postflight; las variables heredadas peligrosas producen rechazo, no se borran silenciosamente.
4. Después, vuelve a comprobar identidad y destino; exige únicamente las 15 tablas esperadas propiedad del migrador, ledger exactamente con las tres migraciones finalizadas y sin rollback, fila génesis única de auditoría con hash cero y marcador todavía ausente.

La migración inicial escribe su fila génesis de auditoría como parte del SQL versionado. No se crea el historial a mano. Si Prisma falla o una verificación posterior no coincide, el script se detiene sin reset, rollback manual, reintento automático, cambio de propietario, GRANT o comentario de base; se debe inspeccionar el estado antes de cualquier nuevo intento. No mantener otros clientes cambiando el laboratorio durante la operación.

Comando exacto futuro, desde `D:\Desarrollo\SIGA-E\apps\api`:

```powershell
.\scripts\run-m2-http-migrations.ps1
```

El script pide escribir `I_ACKNOWLEDGE_M2_HTTP_MIGRATIONS` y solicita la contraseña del migrador mediante entrada oculta. La codifica para URI sin limitar el conjunto de caracteres de la contraseña original; la cadena vive solo en memoria/variables de entorno temporales y no aparece en argumentos. No imprime stdout/stderr arbitrarios. Si una fase falla, informa la fase y únicamente códigos Prisma de una allowlist explícita; las pruebas offline verifican que texto arbitrario, contraseñas y URLs no se exponen. Luego se eliminan las variables y se borra el búfer BSTR. El ejecutor no crea roles/bases, concede permisos ni establece el marcador `SIGAE_M2_HTTP_POSTGRES_LAB_V1`. Después de la migración se requiere una fase de verificación del propietario/ledger y autorización separada antes de establecer el marcador o conceder DML runtime.
