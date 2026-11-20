# Revisión local de la migración inicial (11/10/2026)

**Estado:** propuesta preparada, sin ejecución contra Neon. Se conserva la
rama `production` sin interacción desde esta revisión. La rama autorizada para
una futura aplicación es `development` (`br-delicate-sky-b6okz1oe`), endpoint
`ep-red-butterfly-b61jbniu`, base `siga_e` del proyecto `siga-e`, según la
confirmación del usuario. Estos identificadores no demuestran por sí solos el
contenido actual de la base ni autorizan una conexión.

## Método y alcance

- Fuente de verdad leída en orden: proyecto v1.2, arquitectura v1.2, OpenAPI v1.2.
- La decisión humana incorpora `users.name` obligatorio; ADR-002 documenta la
  validación de 1–120 caracteres. ADR-003 documenta la revisión correctiva de
  unicidad JWS, enrolamiento pendiente y auditoría; el flujo M1 sigue pendiente.
- SQL generado localmente mediante Prisma CLI 7.10.0 con
  `pnpm.cmd exec prisma migrate diff --from-empty --to-schema prisma/schema.prisma --script --output prisma/migrations/20261011_initial/migration.sql`.
  Después se añadieron `CHECK`, índices de expresión/parciales y la fila génesis.
  Una generación temporal posterior coincidió en la estructura Prisma; las
  diferencias restantes fueron solo esas adiciones SQL personalizadas.
- `pnpm.cmd exec prisma validate --schema prisma/schema.prisma`: **correcto**.
- `pnpm.cmd exec prisma generate --schema prisma/schema.prisma`: **correcto**.
- `pnpm.cmd run typecheck`: **correcto**.
- `pnpm.cmd run test`: **4 archivos / 20 pruebas correctas**; son pruebas
  locales existentes, no ensayos de las restricciones PostgreSQL.
- Comparación de nombres y recuentos del SQL: **10 tablas**, **11 tipos enum**,
  **9 claves foráneas**, **29 índices** (13 únicos) y **21 restricciones CHECK**.
- Escaneo estático de `migration.sql`: ninguna sentencia `DROP`, `TRUNCATE`,
  `DELETE`, `UPDATE`, `ON DELETE CASCADE` ni `ALTER TABLE ... DROP/ALTER COLUMN`.
  `ON UPDATE CASCADE` de las FKs de Prisma cambia referencias únicamente si
  se modifica una clave; no borra datos en esta migración.

## Correspondencia relacional

| Grupo | Objetos verificados |
|---|---|
| Tablas | `users`, `sessions`, `alerts`, `alert_references`, `approvals`, `public_keys`, `anchor_deployments`, `anchor_jobs`, `audit_events`, `audit_chain_state`. |
| FKs | `sessions.user_id → users`; `alerts.author_id → users`; `alerts.kid → public_keys`; `alert_references.alert_id → alerts`; `approvals.alert_id → alerts`; `approvals.approver_id → users`; `anchor_jobs.alert_id → alerts`; `anchor_jobs.deployment_id → anchor_deployments`; `audit_events.actor_id → users`. |
| Unicidad | email exacto y normalizado, token de sesión, identidad triple de alerta, **`jws_hash`** y `message_key` (ambos nullable), referencia por alerta, thumbprint, generación/contrato por red, job por alerta/despliegue y por despliegue/clave, un deployment activo por red. `jws_compact` no tiene índice único. |
| CHECK | longitud de `name`; credenciales no vacías y obligatorias para `ACTIVE`; 11 hashes binarios de 32 bytes; singleton y secuencias positivas/no negativas de auditoría; contadores/versión/generación/ledger no negativos o positivos según campo. |

La migración incluye la fila génesis `audit_chain_state(1,0,32 bytes cero)`.
`audit_events.seq` es `BIGINT` sin autoincremento para asignación bajo bloqueo de
la cabeza. Las relaciones con `users` usan `ON DELETE RESTRICT`, incluido
`audit_events.actor_id`; esa columna sigue admitiendo `NULL` para eventos del
sistema.

Los `CHECK` solo cubren invariantes de una fila. Segregación autor/aprobador,
inmutabilidad del JWS, hashes calculados sobre bytes exactos, TOTP verificado,
prohibición de sesiones para pendientes y transición a
`PUBLISHED` tras lectura de Soroban requieren servicios transaccionales y
pruebas posteriores. No se ha comprobado sintaxis ejecutando SQL en PostgreSQL,
estado/ausencia de objetos en `development` ni deriva respecto a Neon.

## Pendiente antes de aplicar

Definir y aprobar el contrato de invitación, establecimiento de contraseña,
enrolamiento TOTP y eventual rehabilitación de M1. Revisar en modo lectura que `development.siga_e` esté
en el estado esperado y decidir el procedimiento de aplicación; se necesita
autorización explícita posterior para ejecutar cualquier migración en Neon.
