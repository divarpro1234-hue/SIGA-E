# ADR-006: Lectura verificable y decisión concurrente de alertas M2

- **Fecha:** 15/10/2026.
- **Estado:** APROBADO DOCUMENTALMENTE POR DECISIÓN HUMANA.
- **Ámbito:** contrato HTTP interno de revisión, aprobación y rechazo de M2.
- **Alcance:** MVP de cuatro semanas delimitado por [ENM-002](../enmiendas/ENM-002-reduccion-alcance-MVP-4-semanas.md). No acredita aprobación docente.

## Problema

La auditoría de Prompt 07-A comprobó que `GET /api/v1/alerts/{id}` prometía solo `AlertSummary`, mientras `POST /api/v1/alerts/{id}/approve` exigía `expectedDigestHex`. El aprobador no disponía, mediante el contrato HTTP, de los bytes congelados ni de la identidad autora, severidad y versión para revisar lo que iba a autorizar. Un digest sin versión tampoco distingue una solicitud antigua de una nueva versión que contenga los mismos bytes.

## Alternativas consideradas

| Alternativa | Resultado |
|---|---|
| A. Ampliar la lectura interna existente | **Elegida:** conserva ruta y campos del resumen; entrega una instantánea solo al rol y estado autorizados. |
| B. Reutilizar otro contrato | El listado interno es resumido y el detalle público solo corresponde a alertas publicadas; ninguno sirve para revisar una alerta pendiente. |
| C. Crear una ruta específica de revisión | Añade superficie HTTP y política duplicada sin necesidad técnica para el MVP. |

La decisión humana aprobó **A**. No se crea otra ruta ni se cambia el esquema Prisma, las migraciones o los estados canónicos.

## Contrato decidido

`GET /api/v1/alerts/{id}` mantiene los campos `id`, `identifier`, `lifecycleState`, `anchorStatus` y `notice` de `AlertSummary`. Para un `APPROVER` elegible devuelve `AlertDetail`, que añade `authorId` (UUID), `kind` (`Alert|Update|Cancel`), `severity` (`Extreme|Severe|Moderate|Minor|Unknown`), `version` (entero ≥1) y `reviewSnapshot` obligatorio. Este último contiene `payloadBase64Url`, base64url canónico sin padding de los bytes exactos de `alerts.frozen_payload`, y `payloadDigestHex`, SHA-256 de esos bytes como 64 dígitos hexadecimales minúsculos. Los bytes proceden de la persistencia; no se reserializa JSON. El servidor recalcula el digest y lo compara con `alerts.payload_sha256` antes de responder o permitir aprobación. Una discrepancia falla de forma cerrada con error saneado y sin instantánea válida.

`POST /api/v1/alerts/{id}/approve` exige cuerpo estricto `{expectedDigestHex,expectedVersion}`: digest hexadecimal minúsculo de 64 caracteres y versión entera ≥1. `POST /api/v1/alerts/{id}/reject` exige `{reason,expectedVersion}`; `reason` conserva longitud 3–500. Los demás campos, verbos y respuestas del contrato permanecen como en [OpenAPI](../arquitectura/SIGA-E_API_OpenAPI_v1.2.yaml). Las respuestas internas sensibles usan `Cache-Control: no-store`.

## Acceso y transiciones

Solo sesiones MFA de usuarios `ACTIVE` acceden a la lectura interna. `AUTHOR` consulta sus propias alertas conforme a la política vigente y recibe el resumen; conocer un UUID ajeno no le da acceso a borradores. `ADMIN` conserva únicamente el resumen y no puede aprobar ni emitir. `APPROVER` recibe `AlertDetail` con `reviewSnapshot` para alertas críticas `Severe` o `Extreme` en `PENDING_APPROVAL` elegibles para revisión. La regla v1.2 de aprobación de referencias críticas `Update`/`Cancel` sigue vigente como diseño diferido. El modelo actual no contiene asignación individual de revisores; no se introduce una. Usuarios anónimos, inactivos o con sesión inválida reciben 401. Un recurso no visible se oculta con 404 según política, sin confirmar su existencia. Rol indebido o autoaprobación se rechazan con 403. Se mantienen cookie, RBAC, MFA, `Origin` y CSRF de las mutaciones.

En una transacción PostgreSQL, la aprobación comprueba rol, actor distinto del autor, `PENDING_APPROVAL`, versión exacta, digest de los bytes congelados y ausencia de una transición ya consumida. Rechazar comprueba actor, estado y versión. El control concurrente por estado y versión permite una sola decisión efectiva entre aprobaciones y rechazos simultáneos: la ganadora registra decisión, auditoría y transición a `READY_TO_SIGN` o `REJECTED`; la perdedora obtiene 409 sin decisión ni evento de éxito duplicados. `STALE_ALERT_VERSION` cubre versión o digest obsoletos e `INVALID_STATE_TRANSITION` cubre estado inválido. Tras `REJECTED`, una corrección pasa a `DRAFT` como versión nueva que debe congelarse y revisarse de nuevo.

La aprobación enlaza `Approval.digest` y `approved_payload_sha256` con `SHA-256(payloadBytes)`; antes de firmar se verifica de nuevo la coincidencia y se firman los bytes persistidos sin reconstruir el JSON. `jws_hash` es SHA-256 del JWS compacto final y no sustituye el digest de aprobación. No se mantienen bloqueos de BD durante operaciones externas. Se preservan la prohibición de autoaprobación y la publicación únicamente tras confirmación y relectura Soroban coincidente.

## Consecuencias y riesgos residuales

- Backend: la implementación local actual aplica autorización por objeto, bytes exactos, verificación de integridad y decisiones transaccionales con auditoría. Las pruebas HTTP usan un servicio simulado; las pruebas PostgreSQL M2 ejercitan el servicio directamente. No se acredita integración HTTP con PostgreSQL ni disponibilidad de un servidor desplegado.
- Frontend: debe mostrar el contenido decodificado como texto no confiable, vincular la decisión a `payloadDigestHex` y `version`, y tratar 401, 403, 404 y 409 sin inventar un resultado de aprobación. El [handoff actualizado](../handoff-ui/HANDOFF_168_64_B_M2_HTTP.md) describe el contrato para la rama UI.
- Riesgos: un `APPROVER` autorizado puede ver el contenido de todas las alertas críticas pendientes elegibles porque no hay asignación individual; un UUID filtrado no debe ampliar visibilidad; una instantánea caduca entre lectura y decisión y debe rechazarse por versión, digest o estado. Los datos de la alerta son entrada no confiable y requieren representación segura. La auditoría local no protege contra un DBA con control total.

Esta aprobación es **solo documental**. No autoriza implementación, migraciones, conexión a Neon, operaciones Stellar, despliegue ni commits por agentes. `Update`/`Cancel` permanecen diseñados y diferidos como emisión obligatoria del MVP según ENM-002.
