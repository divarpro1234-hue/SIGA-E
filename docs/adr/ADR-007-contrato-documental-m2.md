# ADR-007: Contrato de borradores, versiones y decisiones M2

- **Fecha:** 21/10/2026.
- **Estado:** APROBADO DOCUMENTALMENTE por instrucción humana del 21/10/2026; estado de implementación HTTP local actualizado al 02/11/2026.
- **Ámbito:** complemento de ADR-006, arquitectura v1.2 y OpenAPI v1.2 para M2.
- **Precedencia:** respeta proyecto consolidado v1.2, ENM-001, ENM-002 y ADR-001–006. Las precisiones siguientes sustituyen solo las frases de ADR-006 que limitaban `AUTHOR` a `AlertSummary`, omitían digest en rechazo o indicaban que no se ampliaría `Approval`. No se reescriben las decisiones históricas.

## Estado de implementación al cierre del incremento 3 (histórico, 21/10/2026)

Está implementado y probado mediante pruebas automatizadas, HTTP controlado y PostgreSQL local aislado:

- creación de borradores `Alert` por `AUTHOR`;
- listado y detalle con alcance `AUTHOR`/`APPROVER`/`ADMIN`;
- edición de borradores propios mediante `PATCH`;
- versiones, `ETag` e `If-Match`, incluido el rechazo de versiones obsoletas;
- persistencia, digest SHA-256 de los bytes y auditoría asociada;
- rechazos de acceso anónimo, de `APPROVER` y de `ADMIN` para escritura.

El esquema de `Approval` está disponible mediante la migración aditiva
`20261021_m2_approval_snapshot`, aplicada y verificada en la base local
`sigae_m1_test`. Esto no implica que el flujo funcional de decisiones esté
implementado.

Sigue pendiente de implementación: `submit` (`DRAFT` → `PENDING_APPROVAL`),
`approve`, `reject`, el flujo transaccional de decisiones y las etapas
posteriores de firma, anclaje y publicación. La cadena histórica completa de
auditoría no está verificada criptográficamente; además, la suite general
mantiene tres fallos pendientes ajenos a este cierre de borradores.

## Estado actualizado del árbol backend local (02/11/2026)

El código local implementa `POST /alerts`, `GET /alerts`, `GET /alerts/{id}`,
`PATCH /alerts/{id}`, `POST /alerts/{id}/submit`, `POST /alerts/{id}/approve`
y `POST /alerts/{id}/reject`. Las pruebas Supertest de rutas usan un servicio
simulado; las pruebas M2 de PostgreSQL ejercitan `PrismaDraftAlertService`
directamente. No se ha acreditado la integración Express→servicio→Prisma→
PostgreSQL ni la disponibilidad de estas rutas en un servidor desplegado. La
descripción de implementación no cambia los contratos ni garantías aprobados
en este ADR.

## Alcance y política

El incremento inicial implementará solo `kind="Alert"`. `Update` y `Cancel`, sus referencias y estados permanecen en diseño y en el modelo, pero las rutas de creación/edición/envío M2 rechazarán esos `kind` con `422 INVALID_ALERT_PAYLOAD` hasta su etapa autorizada. `Severe` y `Extreme` requieren `APPROVER` con UUID distinto al `author_id`; las demás severidades pasan de `DRAFT` a `READY_TO_SIGN` al enviar, según la política v1.2. `APPROVED` es valor de `Approval.decision`, no estado de `Alert`. M2 no firma, ancla, publica ni expone alertas al ciudadano.

`AUTHOR` ve y modifica solo sus alertas. `APPROVER` ve la instantánea de alertas críticas en `PENDING_APPROVAL` elegibles y decide; no hay asignación individual. `ADMIN` ve solo resúmenes. El anónimo no accede a rutas internas. Toda lectura interna y respuesta de mutación usa `Cache-Control: no-store`; la identidad se valida con sesión MFA `ACTIVE`. Mutaciones exigen CSRF y `Origin` de M1. Un UUID inexistente o no visible recibe el mismo `404 ALERT_NOT_FOUND`; un rol indebido recibe `403 ROLE_FORBIDDEN`; autoaprobación recibe `403 SELF_APPROVAL_FORBIDDEN`. Los demás códigos públicos M2 son `401 AUTH_REQUIRED`, `403 CSRF_INVALID` (M1), `409 STALE_ALERT_VERSION`, `409 INVALID_STATE_TRANSITION`, `409 ALERT_ID_DUPLICATE`, `422 INVALID_ALERT_PAYLOAD` y `500 INTERNAL_ERROR` saneado. Los errores siguen `application/problem+json` con `type,title,status,code,requestId` y `detail` público opcional; no revelan contenido ajeno ni datos SQL.

## Entrada, identidad y bytes

`AlertInput` es un objeto estricto `{kind, info, references?}`. `kind="Alert"` exige `references` ausente o vacío. `info` es estricto y exige `scenario` (`INUNDACION|DESLIZAMIENTO|SISMO`), `event` (1–120), `severity` (`Extreme|Severe|Moderate|Minor|Unknown`), `urgency` (`Immediate|Expected|Future|Past|Unknown`), `certainty` (`Observed|Likely|Possible|Unlikely|Unknown`), `headline` (10–200, contiene la leyenda literal `SIMULACRO`), `description` (10–4000), `expires` (RFC 3339 con zona explícita) y `areaDesc` (3–200). Los límites son de caracteres JSON tras validación. Rechazar controles y saltos de línea en `sender`, `identifier`, `sent`. `expires` debe ser posterior a `sent` y seguir vigente en `submit`. No usar lugares ni emisores reales. Se rechazan campos del cliente como `authorId`, `sender`, `identifier`, `sent`, `status`, `scope`, estado, versión, digest, JWS o contrato.

El servidor fija `sender` ficticio por configuración y genera `identifier` y `sent` una vez en `create`; `sent` usa UTC ISO 8601 con tres milisegundos y `Z` (`Date.toISOString()`), y los tres textos permanecen iguales al editar. Construye un objeto de claves en orden fijo: `sender`, `identifier`, `sent`, `status:"Exercise"`, `scope:"Public"`, `msgType:"Alert"`, `info` con `scenario,event,severity,urgency,certainty,headline,description,expires,areaDesc`. Valida primero, normaliza `expires` a UTC ISO 8601 con tres milisegundos y `Z` antes de serializar, y produce `payloadBytes = UTF8(JSON.stringify(objetoValidadoEstable))`. No se exige JSON Canonicalization Scheme interoperable. Un mismo serializador de M2 crea los bytes de trabajo del borrador y los bytes finales; después de `submit` nunca se reserializan para revisión o firma.

El esquema actual exige `alerts.frozen_payload bytea NOT NULL` y `payload_sha256 bytea NOT NULL`. En `DRAFT` contienen bytes de trabajo editables y su **digest real** `SHA-256(frozen_payload)`. El congelamiento efectivo comienza en `submit`, que valida de nuevo, genera/persiste la representación final y el digest de esos bytes en una sola transacción. Desde entonces no se modifica el payload en `PENDING_APPROVAL` o `READY_TO_SIGN`. `payloadDigestHex` es hexadecimal minúsculo de 64 dígitos; no es `jws_hash`.

## Versiones, lectura y corrección

`Alert.version` inicia en 1 y aumenta exactamente en uno por cada mutación M2 efectiva: PATCH de borrador, `submit`, `approve`, `reject` y PATCH de corrección. Una petición fallida o repetida no aumenta versión. `POST /alerts` responde `201 AlertSummary` con `ETag: "v1"`. Las lecturas de una alerta visible y las mutaciones exitosas de esa alerta devuelven `ETag: "vN"` correspondiente a su versión resultante. Es un validador fuerte de la versión del recurso, no un hash del cuerpo HTTP ni del payload.

`PATCH /alerts/{id}` requiere exactamente un `If-Match: "vN"`, sin lista, comodín ni validador débil. Cabecera ausente o malformada → `422 INVALID_ALERT_PAYLOAD`; versión bien formada pero obsoleta → `409 STALE_ALERT_VERSION`. El PATCH recibe un `AlertInput` completo y sustituye solo los campos editables; conserva autor e identidad del mensaje. En `DRAFT` permanece `DRAFT`; desde `REJECTED` pasa a `DRAFT`, incrementa versión y conserva la decisión y los bytes revisados en `Approval`. Cualquier otro estado → `409 INVALID_STATE_TRANSITION`. `POST /submit` compara `expectedVersion` con la versión vigente; no usa `If-Match`.

`GET /alerts/{id}` devuelve `AlertAuthorDetail` para `AUTHOR` propietario: todos los campos de `AlertSummary`, `version`, `kind` y `info` editables. El contenido procede de los bytes de trabajo o congelados persistidos, comprobados contra `payload_sha256` antes de responder; el motivo del último rechazo se muestra como `lastRejectionReason` solo si el estado es `REJECTED`. El `APPROVER` elegible en `PENDING_APPROVAL` recibe el `AlertDetail` de ADR-006, con `authorId`, `kind`, `severity`, `version` y `reviewSnapshot:{payloadBase64Url,payloadDigestHex}`. `payloadBase64Url` es base64url canónico sin padding de **los bytes persistidos**, sin nueva serialización. `ADMIN` recibe solo `AlertSummary`. Una inconsistencia interna de bytes/digest falla cerrada con `500 INTERNAL_ERROR`, sin snapshot.

## Decisiones y persistencia futura

`POST /approve` exige cuerpo estricto `{expectedDigestHex,expectedVersion}` y `POST /reject` exige `{reason,expectedDigestHex,expectedVersion}`; digest minúsculo de 64 hex, versión entera ≥1 y motivo saneado de 3–500 caracteres. Ambos comprueban que `SHA-256(frozen_payload) = payload_sha256 = expectedDigestHex`, que versión/estado coinciden, que la cuenta `APPROVER` está `ACTIVE` y que su UUID difiere de `author_id`. No basta comparar roles o nombres. La decisión guarda el digest y una copia de los bytes efectivamente revisados. `approve` fija `approved_payload_sha256` y lleva a `READY_TO_SIGN`; `reject` lleva a `REJECTED`, sin digest aprobado. Cada transición aumenta versión.

La migración aditiva `20261021_m2_approval_snapshot` incorpora `alert_version
integer NOT NULL`, `reviewed_payload bytea NOT NULL`, `reason text NULL` y
`UNIQUE(alert_id,alert_version)`. `alert_version` es la versión en
`PENDING_APPROVAL` que se decidirá, previa al incremento de la transición.
`reviewed_payload` es copia inmutable de `alerts.frozen_payload` y su SHA-256
debe igualar `Approval.digest`; `reason` es obligatorio solo para `REJECTED`,
nulo para `APPROVED`, con longitud 3–500. La migración incorpora `CHECK` de
versión positiva, motivo y conserva el constraint de longitud del digest. Fue
aplicada y verificada en el laboratorio local sin rellenar decisiones
históricas. Al cierre del incremento 3, la igualdad criptográfica y las
decisiones seguían pendientes; la implementación local posterior se registra
en la sección de estado actual.

Crear, editar, enviar, decidir y corregir deben confirmar mutación y `appendAuditEvent` en **una misma transacción PostgreSQL**; si falla auditoría, todo se revierte. La operación crítica vuelve a comprobar sesión vigente y usuario `ACTIVE` dentro de la transacción para no decidir usando solo una identidad leída antes de una revocación concurrente. Para decidir, bloquear o efectuar compare-and-set sobre `(id,lifecycle_state,version)` y comprobar ausencia de decisión para `(alert_id,alert_version)`. Entre decisiones concurrentes solo una gana: la perdedora recibe `409 STALE_ALERT_VERSION` o `409 INVALID_STATE_TRANSITION`, sin decisión ni evento de éxito. `409 ALERT_ID_DUPLICATE` representa la terna `sender,identifier,sent` duplicada. No se mantiene un bloqueo de BD durante una operación externa. La auditoría registra actor UUID y referencia a alerta/decisión con metadatos permitidos, sin contenido, razón libre ni secretos.

## Entrega a M3 y límite de auditoría

M3 recibe mediante caso de uso interno, nunca como solicitud de firma arbitraria: alerta `READY_TO_SIGN`, UUID de autor, versión vigente, `frozen_payload` exacto, `payload_sha256`, identidad textual `sender/identifier/sent` y, si es crítica, decisión `APPROVED` de otra identidad sobre el digest y bytes de la versión inmediatamente anterior. Antes de reservar `SIGNING`, relee y comprueba estado, autor, aprobación y `SHA-256(frozen_payload)`; firma esos bytes sin reserializar. El JWS, outbox, Soroban y publicación son etapas posteriores con sus propias invariantes.

La auditoría histórica comunicada contiene 25 eventos; los hashes 4–25 coinciden con el algoritmo actual y los eventos 1–3 presentan discrepancias posiblemente relacionadas con la configuración UTC anterior. La cadena completa desde génesis **no está criptográficamente verificada**. No se reparan ni modifican eventos, hashes o `audit_chain_state`. Las conexiones nuevas conservan `TimeZone=UTC`; la bitácora local tampoco es inmutable ante un DBA.

## Autorización y riesgo

Esta decisión aprueba el contrato documental. La implementación actual de
las rutas M2 no amplía ni modifica el alcance de las decisiones. Las
operaciones PostgreSQL/Testnet, firma, frontend y commits requieren sus etapas
autorizadas. Riesgos residuales: un `APPROVER` elegible
puede leer todas las críticas pendientes, una instantánea puede caducar entre
lectura y decisión, y un administrador de BD puede alterar datos y reconstruir
la auditoría. Los controles de objeto, versión, digest y transacción
documentados responden a los dos primeros; el tercero permanece como límite
declarado.
