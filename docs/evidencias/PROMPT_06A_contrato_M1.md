# PROMPT 06-A — Inventario y contrato propuesto de M1

**Fecha:** 2026-10-12. **Revisión 06-D:** arquitectura M1 aprobada documentalmente por instrucción humana; ENM-001 delimita el QR M1 frente a M4 y OpenAPI se consolida. La aplicación de `20261011_initial` en `development` es un dato proporcionado por el Prompt 06-A; Codex no lo comprobó mediante conexión. El repositorio conserva varios cambios previos sin commit. En 06-A se crearon este documento y ADR-004; en 06-B y 06-C solo se revisaron ambos. La revisión 06-D no implica implementación ni operación sobre Neon.

## Fuentes y decisiones existentes

Se contrastaron, en orden, proyecto consolidado v1.2, arquitectura definitiva v1.2 y OpenAPI v1.2; después `schema.prisma`, migración inicial, ADR-002/003, código de identity y evidencia del Prompt 06. Ya están fijados: tres roles, estado pendiente por invitación, Argon2id, TOTP obligatorio, `ACTIVE` en cada petición, cinco fallos/bloqueo, sesiones opacas, cookie segura, CSRF, revocación al deshabilitar, auditoría encadenada y rutas base de login/segundo factor/sesión/logout/administración. No está definido un refresh token. La frase de ADR-003 sobre migración pendiente describe su estado al redactarse; el Prompt 06-A informa que luego fue aplicada. No se modifica esa historia ni se infiere estado remoto.

## Inventario físico de `User` y `Session`

Fuente: Prisma y SQL de `20261011_initial` (inspección local, no inventario remoto). Prisma genera UUID en cliente; el DDL no define `DEFAULT` de UUID. Todas las fechas son `timestamptz(3)`.

| `users` / Prisma | PostgreSQL, nulabilidad, default y función |
| --- | --- |
| `id` | `uuid NOT NULL PRIMARY KEY`; Prisma `@default(uuid())`. |
| `name` | `text NOT NULL`; `CHECK char_length BETWEEN 1 AND 120` y `name=btrim(name)`. |
| `email` | `text NOT NULL`; `UNIQUE(email)` y `UNIQUE(lower(email))` para evitar duplicado por mayúsculas. Normalización exacta pertenece al servicio. |
| `role` | enum `UserRole NOT NULL`: `AUTHOR`, `APPROVER`, `ADMIN`; un rol por fila. |
| `passwordHash` | `password_hash text NULL`; no vacío cuando existe; obligatorio para `ACTIVE`. No prueba Argon2id. |
| `totpSecretCiphertext` | `totp_secret_ciphertext bytea NULL`; no vacío cuando existe; obligatorio para `ACTIVE`. No prueba cifrado ni verificación TOTP. |
| `status` | enum `UserStatus NOT NULL DEFAULT PENDING_ENROLLMENT`: `PENDING_ENROLLMENT`, `ACTIVE`, `DISABLED`; índice `users_status_idx`. Ningún `CHECK` prohíbe activar incorrectamente desde un servicio. |
| `failedAttempts` | `failed_attempts integer NOT NULL DEFAULT 0 CHECK >=0`. |
| `lockedUntil` | `locked_until timestamptz(3) NULL`. |
| `createdAt` | `created_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP`. |
| `updatedAt` | `updated_at timestamptz(3) NOT NULL`; Prisma `@updatedAt`, sin default SQL. |

`User.sessions`, `User.authoredAlerts`, `User.approvals` y `User.auditEvents` son relaciones 1:N. Las FKs de sesiones, alertas y aprobaciones restringen borrado; `audit_events.actor_id` restringe también cambio de ID. Se deshabilitan cuentas históricas en lugar de borrarlas.

| `sessions` / Prisma | PostgreSQL, nulabilidad, default y función |
| --- | --- |
| `id` | `uuid NOT NULL PRIMARY KEY`; Prisma `@default(uuid())`. |
| `userId` | `user_id uuid NOT NULL`; FK a `users.id`, `ON DELETE RESTRICT ON UPDATE CASCADE`. |
| `tokenHash` | `token_hash bytea NOT NULL UNIQUE CHECK octet_length=32`. |
| `expiresAt` | `expires_at timestamptz(3) NOT NULL`; índice compuesto `(user_id,expires_at)` y `(expires_at,revoked_at)`. |
| `revokedAt` | `revoked_at timestamptz(3) NULL`. |
| `lastSeenAt` | `last_seen_at timestamptz(3) NOT NULL`. |
| `createdAt` | `created_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP`. |

`Session.user` es relación N:1 obligatoria. El modelo no tiene refresh token, campo CSRF, invitación ni challenge. El servicio puede derivar CSRF desde token de sesión con un secreto de servidor; la ausencia de columna no impide ese control. Tras recarga, el contrato aprobado exige `GET /auth/me` protegido por cookie válida que devuelve `{user,csrfToken}` con `Cache-Control: no-store` y `Vary: Cookie`; el navegador guarda el token solo en memoria. OpenAPI se actualiza documentalmente en 06-D, sin ruta pública adicional. El middleware actual comprueba hash, revocación, vencimiento absoluto y `ACTIVE`, pero todavía no inactividad, CSRF, devolución de CSRF o emisión.

### Matriz de las diez capacidades solicitadas

| Capacidad | Clasificación | Evidencia y límite |
| --- | --- | --- |
| 1. Crear usuario pendiente | **SOPORTADA** | `status` default pendiente; `name/email/role` presentes y unicidad. Falta flujo de invitación para usar la cuenta. |
| 2. Invitación temporal | **REQUIERE CAMBIO DE ESQUEMA** | No hay token hash, caducidad, revocación ni vínculo de invitación; la CLI local propuesta la emite después del alta HTTP. |
| 3. Invalidar invitación consumida | **REQUIERE CAMBIO DE ESQUEMA** | No hay estado persistente de consumo/reclamación. |
| 4. Enrolar contraseña | **DECIDIDA DOCUMENTALMENTE; REQUIERE ESQUEMA Y SERVICIO** | `password_hash` nullable permite guardar Argon2id, pero la autorización del enrolamiento depende de invitación/desafío nuevos. |
| 5. Guardar TOTP cifrado | **SOPORTADA** | `bytea` nullable permite ciphertext; formato/clave/confirmación quedan en servicio y contrato. |
| 6. Activar cuenta | **DECIDIDA DOCUMENTALMENTE; REQUIERE ESQUEMA Y SERVICIO** | `ACTIVE` existe y el `CHECK` exige credenciales, pero no prueba invitación ni TOTP: transacción de activación necesita nuevo estado persistente. |
| 7. Login en dos fases | **REQUIERE CAMBIO DE ESQUEMA** | OpenAPI define dos rutas; falta challenge persistente de contraseña aprobada, con caducidad/intentos/consumo. |
| 8. Emitir sesión opaca | **SOPORTADA** | `sessions` tiene hash único, vencimiento y FK; solo debe emitirse después de MFA. |
| 9. Revocar y expirar | **SOPORTADA** | `revoked_at`, `expires_at`, `last_seen_at`; el servicio debe bloquear, actualizar y comprobar. |
| 10. Limitar/bloquear fallos | **DECIDIDA DOCUMENTALMENTE** para cuenta; **REQUIERE CAMBIO DE ESQUEMA** para control compartido por origen | `failed_attempts/locked_until` sostienen bloqueo por cuenta; falta rate limit persistente para cuentas desconocidas y varias instancias. |

## Contrato HTTP: operaciones conservadas y aprobadas documentalmente en 06-D

Cada fila usa prefijo `/api/v1`. `401` de autenticación es genérico; `403` expresa falta de rol/CSRF sin revelar secreto; `409` representa estado o carrera; `422` validación; `429` límite por origen. Todos los errores son Problem Details saneados. En rutas con autenticación y mutación se exige cookie MFA, `X-CSRF-Token` y `Origin` same-origin. Las rutas anónimas tienen límite de tamaño y tasa compartida; respuestas con tokens/códigos de enrolamiento llevan `Cache-Control: no-store`, `Referrer-Policy: no-referrer` y no aparecen en logs. No se autoriza CORS amplio.

| Estado; método y ruta | Actor, autenticación y solicitud | Respuesta y errores | Efectos en BD y controles específicos |
| --- | --- | --- | --- |
| Existente `POST /auth/login` | Anónimo, `{email,password}`. | 200 `{challengeId,expiresAt}`; 401 genérico, 429. | Busca `ACTIVE` no bloqueado y verifica Argon2id con señuelo para desconocidos. Si acierta, crea challenge LOGIN interno UUID, genera `challengeId` aleatorio de 32 bytes en base64url y guarda solo su hash SHA-256. Si falla, confirma contador de usuario y auditoría antes del 401. 5 min; sin sesión. |
| Existente `POST /auth/totp/verify` | Anónimo con `{challengeId,code}`. | 200 `{user,csrfToken}` + `Set-Cookie`; 401/429. | Busca exclusivamente por hash del token, no por UUID. Exige challenge LOGIN vigente, abierto, con menos de 3 fallos y usuario `ACTIVE` no bloqueado. Error TOTP incrementa contador del desafío y de cuenta y audita **antes** del 401; tercer error revoca challenge, quinto acumulado bloquea cuenta. Éxito consume challenge/paso TOTP, reinicia contador, crea **una** sesión y audita en una transacción. |
| Existente `GET /auth/me` | Cookie MFA, sin body. | **Aprobado documentalmente:** 200 `{user,csrfToken}`; 401. OpenAPI actualizado en 06-D. | Lee sesión/usuario, exige vigencia absoluta e inactividad, `ACTIVE`; actualiza `last_seen_at` de forma acotada. Regenera CSRF ligado a esa sesión para recarga de página; `no-store`, `Vary: Cookie`, same-origin; sin login nuevo. |
| Existente `POST /auth/logout` | Cookie MFA + CSRF, sin body. | 204; 401/403. | Revoca la sesión actual y audita. Borra cookie con mismos atributos. |
| Existente `POST /admin/users` | `ADMIN` MFA + CSRF, `{name,email,role}`. | 201 `User` pendiente; 401/403/409/422. **No significa invitación emitida ni entregada.** | Normaliza nombre/email; inserta solo usuario pendiente y auditoría en la misma transacción. Luego un operador local autorizado ejecuta CLI de emisión. OpenAPI y ADR-002 actualizados documentalmente en 06-D. |
| Existente `PATCH /admin/users/{id}/status` | `ADMIN` MFA + CSRF, `{status:"DISABLED"}`. | 200 `User`; 401/403/409/422. | Deshabilita, revoca todas las sesiones y desafíos/invitaciones abiertos y audita en una transacción. No admite `ACTIVE`. |
| **Nuevo** `POST /auth/enrollment/start` | Anónimo con invitación, `{invitationToken,password}`. | 200 `{enrollmentToken,expiresAt,otpauthUri}`; 401/409/422/429. | Reclama invitación, guarda Argon2id y TOTP cifrado en usuario aún pendiente, crea challenge ENROLLMENT por hash; sin cookie. Solo una exposición del URI bajo HTTPS/no-store. |
| **Nuevo** `POST /auth/enrollment/confirm` | Anónimo con `{enrollmentToken,code}`. | 200 `User`; 401/409/429. | Verifica TOTP, incrementa intentos o, con éxito, consume paso/challenge/invitación, activa y audita atómicamente. No crea sesión: luego login normal. |
| **Nuevo** `POST /auth/password/change` | Cookie MFA + CSRF, `{currentPassword,newPassword,code}`. | 204; 401/403/422/429. | Confirma contraseña y TOTP, cambia Argon2id, consume paso y revoca todas las sesiones en transacción auditada. Requiere login nuevo. |
| **Nuevo** `POST /auth/totp/reconfigure/start` | Cookie MFA + CSRF, `{password,currentCode}`. | 200 `{reconfigureToken,expiresAt,otpauthUri}`; 401/403/429. | Verifica factores actuales, consume paso viejo y crea challenge con secreto nuevo cifrado; secreto activo permanece intacto. |
| **Nuevo** `POST /auth/totp/reconfigure/confirm` | Cookie MFA + CSRF y `{reconfigureToken,newCode}`. | 204; 401/403/409/429. | Verifica paso nuevo, sustituye ciphertext, consume challenge, revoca sesiones y audita atómicamente. Luego login nuevo. |
| **Nuevo** `POST /admin/users/{id}/reinvite` | `ADMIN` MFA + CSRF y TOTP reciente en `{adminTotpCode,reason}`; para ADMIN exige otro ADMIN activo y revisión reforzada; único ADMIN bloqueado. | 200 `{user,invitationStatus:"NOT_ISSUED"}`; 401/403/404/409/422/429. No afirma entrega. | Tras verificación humana documentada, revoca acceso y estados abiertos, restablece a pendiente, limpia credenciales antiguas y audita en una transacción. La CLI emite una invitación **posteriormente**; nunca activa directamente. |

Bootstrap y emisión/revocación/reemisión de invitaciones no son HTTP: CLI local interactiva y restringida, ejecutada en el entorno de la API mediante sus casos de uso; Neon sigue accesible solo desde la API. El bootstrap de un solo uso crea ADMIN pendiente, marcador irreversible e invitación bajo una transacción. Para cuentas posteriores, la CLI recibe el ID de un usuario pendiente cuya creación/recuperación ya fue autorizada y registrada. Exige operador del sistema operativo autorizado **y** autenticación reciente de ADMIN `ACTIVE` con contraseña y TOTP; el primer ADMIN es la única excepción, con autorización humana específica registrada y operador local autorizado, sin fingir sesión ADMIN. Genera token de 32 bytes por CSPRNG, guarda solo SHA-256 y caducidad de 24 h, confirma transacción con auditoría y genera localmente en memoria un QR con URL HTTPS y token en fragmento. Lo muestra al operador por máximo 60 s ante el titular verificado presencialmente. No se guarda imagen/URL/token en archivo, logs, API ni telemetría; TTY obligatorio, sin redirección ni CI. Ocultar el QR a los 60 s no revoca el token. Si falla o queda incierta la presentación, revoca y reemite auditadamente otro token. `delivery_reported_at` solo registra declaración de presentación, no recepción ni identidad criptográfica. Sin ruta pública de bootstrap, recuperación anónima ni refresh.

### Matriz de compatibilidad ruta ↔ servicio ↔ modelo ↔ arquitectura

| Rutas / CLI | Servicio de aplicación requerido | Modelo actual / nuevo | Regla arquitectónica |
| --- | --- | --- | --- |
| `/auth/me`, middleware RBAC | `AuthenticateSession`, `RequireRole` | `Session`+`User` actuales | Exigir `ACTIVE`, rol y sesión por petición. Ya parcial; falta idle. |
| Login + TOTP verify | `BeginLogin`, `CompleteMfa` | `User`, `Session`; **nuevo** challenge, último paso, rate limit | `challengeId` aleatorio distinto de UUID; hash en BD, 5 min, consumo único, máximo 3 fallos por challenge y cinco acumulados por cuenta; MFA antes de cookie. |
| `/auth/logout`, cambio de contraseña | `RevokeSession`, `ChangePassword` | `Session`+`User`; último paso y auditoría | CSRF, revocación, verificación MFA. |
| `/admin/users`, `reinvite` | `CreatePendingUser`, `PrepareReinvitation` | `User`, `Session`; **nuevos** estados de invitación se administran por CLI | ADMIN crea/restablece pendiente; API no emite token ni declara entrega. Escritura y auditoría atómicas. |
| CLI emisión/revocación/reemisión | `IssueInvitation`, `RevokeInvitation`, `ReportDelivery` | **Nueva** `identity_invitations`, `User`, `AuditEvent` | Operador local y ADMIN MFA reciente; QR local en memoria durante 60 s, entrega presencial tras verificar identidad, revocación ante incertidumbre. |
| Enrolamiento start/confirm | `StartEnrollment`, `ConfirmEnrollment` | `User`; **nuevas** invitación, challenge y último paso | `PENDING_ENROLLMENT` hasta TOTP y consumo atómico. |
| Reconfiguración TOTP | `StartTotpReconfiguration`, `ConfirmTotpReconfiguration` | `User`+`Session`; **nuevo** challenge y último paso | No sobrescribir factor actual antes de confirmar. |
| CLI bootstrap | `BootstrapInitialAdmin` | `User`; **nuevo** marcador e invitación | Excepcional, operador local autorizado y aprobación humana específica, de un solo uso; sin credenciales predeterminadas ni recuperación del único ADMIN. |
| Todas las mutaciones críticas | `AppendAuditEvent` | `AuditEvent`+`AuditChainState` actuales | Misma cadena, cabeza bloqueada en transacción; servicio aún no implementado. |

## Compatibilidad PostgreSQL y clasificación A/B/C

- **A, sin esquema nuevo:** alta de fila pendiente aislada, almacenamiento de hash Argon2id/ciphertext TOTP, emisión/lectura/revocación de sesión, bloqueo por cuenta. Su existencia física no autoriza habilitar los endpoints antes de MFA, CSRF y auditoría.
- **B, con límites:** `last_seen_at` permite caducidad por inactividad y `users.failed_attempts` permite bloqueo por cuenta, pero no rate limit compartido de desconocidos; CSRF puede derivarse sin columna. Un proceso único con memoria sirve solo de capa adicional y no satisface garantía persistente.
- **C, nueva migración:** invitaciones de un solo uso con `delivery_reported_at` como declaración humana, desafíos de login/enrolamiento/reconfiguración, antirreplay TOTP, límite distribuido por origen y marcador permanente de bootstrap. ADR-004 propone cinco cambios aditivos; ninguno toca `20261011_initial`.

No existe columna para refresh token ni se necesita bajo la arquitectura aprobada. `schema.prisma` y `migration.sql` permanecen sin cambios en 06-D.

## Riesgos, mitigaciones y registro histórico de aprobación

El canal presencial requiere presencia física y un navegador con acceso HTTPS al frontend SIGA-E. El QR por sí mismo no demuestra identidad ni impide que se fotografíe el token. La pantalla dura 60 s, mientras el token expira en 24 h o antes por uso/revocación; si la entrega falla tras el commit, la CLI debe revocar y permitir reemisión auditada. `delivery_reported_at` no prueba recepción. La recuperación ordinaria de `AUTHOR`/`APPROVER` exige un ADMIN distinto, caso documentado, contacto previamente registrado y confirmación por segundo canal; después restaura a pendiente y la CLI emite una invitación nueva. Otro ADMIN requiere ADMIN activo distinto y revisión reforzada; **el único ADMIN permanece bloqueado** hasta aprobación excepcional. TOTP puede ser phished; sesión bearer robada puede usarse hasta revocación; no se afirma detección infalible. Rate limit por cuenta puede producir bloqueo inducido y el límite por origen requiere almacenamiento compartido. La cadena auditora mantiene su límite frente a DBA. Los valores de duración y parámetros del ADR son propuestas, no requisitos previos.

El contador de cinco fallos suma contraseña y TOTP de login y se reinicia solo tras MFA completo o, al vencer el bloqueo, antes del nuevo ciclo bajo bloqueo de fila. Tres TOTP erróneos invalidan el challenge aunque la cuenta aún no alcance cinco; el quinto fallo acumulado bloquea la cuenta y revoca challenges abiertos. Un error de contraseña/TOTP se persiste con su evento de auditoría **antes** de emitir 401; una excepción dentro de la transacción no debe deshacerlo. Éxitos críticos confirman cambio de negocio y evento de auditoría juntos. Si falla el servicio mínimo de auditoría, la operación falla cerrada. Este servicio debe implementarse y probarse antes de activar escrituras M1.

### Preguntas de aprobación de 06-A/06-C (históricas; resueltas documentalmente en 06-D salvo recuperación del único ADMIN)

1. ¿Se aprueba ADR-004 y el cambio **aditivo** de esquema propuesto, para preparar una migración posterior sin aplicarla todavía a Neon?
2. La decisión humana ya eligió presentación presencial mediante QR local temporal. ¿Se aprueba enmendar el proyecto v1.2, que actualmente trata QR como diferible, y aceptar el procedimiento propuesto de autorización de CLI, presentación de 60 s y revocación/reemisión? La elección del canal no equivale a aprobación definitiva del ADR.
3. ¿Se aprueban los umbrales propuestos de contraseñas, TOTP, invitaciones, desafíos, bloqueos y sesiones, sujetos a calibración local de Argon2id?
4. ¿Se aprueba la comprobación humana ordinaria descrita y la revisión reforzada para otro ADMIN? La recuperación del único ADMIN queda bloqueada hasta aprobar un procedimiento distinto.
5. ¿Se aprueba ampliar `GET /auth/me` a `{user,csrfToken}` protegido y `no-store`, para recuperar CSRF después de recargar?
6. ¿Se aprueba exigir el servicio mínimo de auditoría transaccional antes de habilitar las escrituras M1?

## Validación de esta etapa

Se inspeccionaron localmente los documentos, el esquema, las restricciones SQL y el código. Una comprobación Python/PyYAML confirmó las seis rutas base, la ausencia de las seis propuestas en OpenAPI, los modelos y constraints citados, el estado PROPUESTO del ADR y la ausencia de espacios finales. El primer intento de esa comprobación falló por comparar texto acentuado pasado por PowerShell; se corrigió la comparación y el resultado final fue **OK**. No se ejecutaron pruebas de aplicación porque no se cambió código funcional. No se conectó a Neon, no se generó/aplicó migración, no se instaló dependencia y no se ejecutó Stellar. Siguiente paso, solo tras aprobación: actualizar OpenAPI/ADR, preparar nueva migración revisable y continuar M1 con pruebas locales.

### Revisión 06-B (registro histórico; canal sustituido en 06-C)

Se corrigió el contrato de `/admin/users` y `reinvite` para que devuelvan solo estado pendiente sin prometer emisión/entrega; la emisión, revocación y reemisión quedaron en CLI local con declaración humana posterior de entrega. Se propuso recuperar CSRF por `/auth/me` protegido y no cacheable. Se definió `challengeId` como bearer aleatorio distinto del UUID, hash persistido, caducidad, límite de tres intentos y consumo concurrente único. Se detalló persistencia de fallos y atomicidad con auditoría. Una comprobación local Python/PyYAML validó esas cláusulas, el estado PROPUESTO, la respuesta canónica de `/auth/me` aún sin `csrfToken` y la ausencia de espacios finales; el primer intento de esta comprobación falló por comparar texto acentuado pasado por PowerShell y se repitió con comparaciones ASCII: **11/11 comprobaciones OK**. ADR-004 sigue **PROPUESTO**. No se modificaron OpenAPI canónico, Prisma ni código funcional.

### Revisión 06-C: canal presencial y coherencia (registro histórico previo a la aprobación 06-D)

**Secuencia propuesta:** `POST /admin/users` crea y audita solo `PENDING_ENROLLMENT`; `POST /admin/users/{id}/reinvite`, si se aprueba, prepara otra cuenta pendiente y revoca acceso previo, **sin** emitir token. Luego la CLI local, con ADMIN `ACTIVE` autenticado recientemente por contraseña y TOTP y operador del SO autorizado, emite la invitación por hash, genera QR local y lo muestra por máximo 60 s. El destinatario verificado presencialmente lo escanea, la página HTTPS elimina el fragmento con `history.replaceState` antes de cargar recursos externos y envía el token solo en el **cuerpo HTTPS** de `/auth/enrollment/start`. La API activa únicamente al confirmar contraseña Argon2id y TOTP en `/auth/enrollment/confirm`, consumiendo invitación, desafío y paso TOTP en una transacción auditada. Para bootstrap del primer ADMIN no existe ADMIN previo: rigen operador local autorizado, aprobación humana específica registrada, marcador irreversible y la misma activación posterior. No hay archivo QR, servicio QR externo, token en logs ni migración autorizada por esta revisión.

| Parámetro M1 | Propuesta que se conserva | Límite o validación pendiente |
| --- | --- | --- |
| Invitación | 32 bytes CSPRNG, hash SHA-256 en BD, uso único, revocación/reemisión auditadas, 24 h. | QR visible 60 s; desaparecer no revoca. Probar carreras y vencimiento después de aprobación. |
| Contraseña / Argon2id | 12–128 caracteres Unicode NFC, sin recorte silencioso; `m=19456 KiB, t=2, p=1` como base y sal aleatoria. | Calibrar tiempo, memoria y límite de bytes en equipo objetivo; lista de contraseñas comprometidas. |
| TOTP | Secreto ≥160 bits, 6 dígitos, 30 s, ventana ±1; AES-256-GCM y antirreplay con `last_totp_step`. | Verificar reloj y consumo atómico del paso; clave fuera de BD. |
| Desafío login | `challengeId` opaco de 32 bytes CSPRNG, base64url canónico de 43 caracteres; solo hash en BD; 5 min, tres códigos erróneos. | UUID interno nunca actúa como bearer; consumo único y fallo persistido antes de 401. |
| Desafíos enrolamiento/reconfiguración | 15 min, cinco códigos erróneos por desafío. | Sin cookie operativa antes de completar MFA; revocación y limpieza posterior. |
| Bloqueo | Cinco fallos acumulados de contraseña y TOTP login; 15 min; rate limit por origen compartido. | Calibrar umbrales por origen; cuenta desconocida con respuesta genérica. |
| Sesión / CSRF | Cookie opaca 32 bytes, 8 h absolutas, 30 min inactividad; `HttpOnly; Secure; SameSite=Strict`; CSRF HMAC ligado a sesión. | `/auth/me` propuesto devuelve `{user,csrfToken}` con `Cache-Control: no-store`, `Vary: Cookie`; token solo en memoria. |

| Documento | Coherencia y ajuste propuesto, sin aplicar | Estado |
| --- | --- | --- |
| Proyecto consolidado v1.2 | §1.5, §4.7 y §8.1 llaman QR excluido/diferible. Proponer excepción explícita para invitaciones M1 presenciales, con impacto en alcance y cronograma. | **Contradicción de precedencia; aprobación humana requerida.** |
| Arquitectura definitiva v1.2 | §9.1 asocia invitación segura a `POST /admin/users` y deja `/auth/me` en `{user}`. Proponer separar CLI y ampliar respuesta CSRF. | Ajuste de contrato pendiente. |
| ADR-002 | Alta e invitación aparecen en una operación y entrega privada indefinida. Proponer alta pendiente sola; CLI emite hash y presenta QR presencial. | Ajuste pendiente; no reescribir su historia. |
| ADR-003 | Uso único por hash y activación transaccional compatibles; canal estaba pendiente. | Añadir referencia a ADR-004 tras aprobación; decisiones vigentes preservadas. |
| ADR-004 | Ahora distingue creación, emisión, visualización, escaneo, activación y bootstrap. | **PROPUESTO**, no aprobado. |
| OpenAPI v1.2 | Proponer aclarar `POST /admin/users` 201 sin token/QR; `GET /auth/me` con `csrfToken`, `no-store`; `challengeId` opaco base64url de 32 bytes y 5 min; añadir rutas de enrolamiento y reinvitación propuestas. | Sin cambio en YAML hasta aprobación. |
| Matriz M1 de este documento | Capacidad física de esquema y dependencias siguen válidas; las filas de invitación/CLI usan QR local presencial y auditoría previa. | Consolidada como propuesta; no representa pruebas funcionales. |

**Resultado documental:** la especificación del canal, CSRF y desafíos está lista para decisión humana, pero el proyecto académico debe enmendarse antes de promover QR a requisito vinculante. El servicio mínimo `AppendAuditEvent` transaccional y sus pruebas siguen siendo requisito previo a escrituras críticas M1. En 06-C se revisaron documentos y diferencias; no se ejecutaron pruebas de aplicación, migraciones, conexión a Neon ni operaciones Stellar. El siguiente paso es aprobación humana de enmiendas de precedencia y ADR-004; solo entonces actualizar ADR-002, arquitectura y OpenAPI y planificar implementación separada.

### Revisión 06-D: estado documental vigente

La autorización humana del Prompt 06-D aprobó la arquitectura M1 descrita en 06-A/B/C **solo a nivel documental**. ENM-001 exceptúa el QR de invitación M1 de las referencias genéricas a QR diferible del proyecto v1.2 y conserva diferible el QR ciudadano M4. ADR-004, ADR-002/003, arquitectura y OpenAPI se consolidan en esta etapa. Las tablas anteriores conservan valor de inventario e historia; las expresiones «propuesta», «si se aprueba» y «pendiente de aprobación» en los apartados 06-A/B/C describen su estado **anterior** a 06-D. La matriz física sigue indicando qué necesita futura migración aditiva; aprobación documental no equivale a soporte implementado. Véase `PROMPT_06D_consolidacion_documental_M1.md` para validaciones y estado final.
