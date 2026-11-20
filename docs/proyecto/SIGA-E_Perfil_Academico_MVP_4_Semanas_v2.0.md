# SIGA-E — Perfil académico definitivo para presentación (cuatro semanas)

**Versión:** 2.0 · **Fecha:** 15 de octubre de 2026  
**Estado:** VERSIÓN DEFINITIVA PARA PRESENTACIÓN · **Pendiente de aprobación docente**  
**Mención:** Seguridad de la Información · **Modalidad:** Individual · **Duración:** Cuatro semanas  
**Naturaleza:** Prototipo académico experimental, no servicio oficial ni productivo  
**Control de alcance:** ENM-002 (aprobada documentalmente por el autor, pendiente de incorporación al repositorio).

## 1. Título

**SIGA-E: Prototipo de Emisión y Verificación Segura de Alertas Simuladas mediante Firmas Digitales y Evidencia Criptográfica en Soroban Testnet**

## 2. Descripción y contexto

SIGA-E es un prototipo web orientado a la **Seguridad de la Información** en el ciclo de emisión, aprobación y verificación de avisos digitales de emergencia **simulados**. Propone una entidad emisora ficticia, tres roles internos y un portal ciudadano sin autenticación.

Las identidades internas se protegen con contraseña y TOTP; un autor crea una alerta y, si es crítica, una identidad aprobadora diferente valida su contenido congelado. El backend la firma mediante **JWS ES256**, calcula el digest del JWS exacto y registra esa huella en el contrato `AlertRegistry` sobre **Stellar Testnet**, bajo autorización. Solo se publica cuando el backend confirma y relee una coincidencia. La PWA verifica firma, confianza en clave y vigencia **localmente**; una CLI externa permite contrastar por separado el registro en Soroban.

Se consideran escenarios ficticios de **inundaciones, deslizamientos y sismos**. El flujo principal de demostración empleará una alerta `Severe` identificada como **SIMULACRO**. No se desarrollan sensores, sistemas predictivos ni avisos reales.

## 3. Planteamiento del problema

Los avisos digitales de emergencia pueden circular con contenidos modificados, identidad aparente falsificada o sin trazabilidad de autorización. Una captura o una entrada de base de datos, por sí solas, no permiten verificar independientemente que los bytes de un mensaje corresponden a los efectivamente firmados y publicados. Asimismo, un proceso débil de aprobación puede permitir emisiones no autorizadas.

Se requiere, en un **laboratorio académico controlado**, un procedimiento comprobable que relacione identidad, roles, aprobación del contenido exacto, firma digital y evidencia criptográfica externa. El prototipo no pretende comprobar que ocurrió una emergencia ni representar a una autoridad pública.

### 3.1. Pregunta de investigación

**¿Cómo implementar y evaluar en cuatro semanas un prototipo web que controle la emisión autorizada de alertas simuladas y permita detectar alteraciones del mensaje firmado mediante verificación criptográfica y contraste de su huella en Soroban Testnet?**

### 3.2. Hipótesis o supuesto contrastable

La aplicación conjunta de MFA, RBAC, aprobación independiente de alertas críticas, JWS ES256 y un registro externo de huellas permitirá **rechazar las operaciones no autorizadas y detectar las alteraciones incluidas en un conjunto definido de pruebas**, siempre que se verifiquen correctamente las claves y el contrato confiable. El análisis comparará resultados esperados y observados; no se afirma protección universal ni porcentaje de seguridad absoluto.

## 4. Objetivos

### 4.1. Objetivo general

Desarrollar y evaluar un prototipo web de emisión, aprobación y verificación segura de alertas simuladas mediante autenticación y autorización de usuarios internos, firmas digitales JWS ES256 y registro contrastable de evidencias criptográficas en Soroban Testnet.

### 4.2. Objetivos específicos

| ID | Objetivo específico | Módulo |
|---|---|---|
| OE1 | Implementar MFA, control de acceso por roles y sesiones revocables para identidades internas. | M1 |
| OE2 | Desarrollar borradores, congelación y aprobación/rechazo de una alerta crítica por una identidad diferente del autor. | M2 |
| OE3 | Emitir y verificar JWS ES256 preservando los bytes firmados y utilizando claves públicas de confianza reconocida. | M3 |
| OE4 | Proporcionar un portal ciudadano PWA que compruebe localmente firma, política y vigencia sin afirmar evidencia blockchain no consultada. | M4 |
| OE5 | Registrar y releer de forma autorizada huellas criptográficas en Soroban Testnet, con auditoría mínima de operaciones críticas. | M5 |
| OE6 | Validar controles y comportamiento ante ataques, errores de autenticación y fallos de blockchain mediante evidencias reproducibles. | M6 |

## 5. Alcance y delimitación

**Entorno:** una entidad simulada; usuarios `ADMIN`, `AUTHOR`, `APPROVER` y ciudadanos anónimos; datos y zonas ficticias; exclusivamente `status=Exercise`, `scope=Public` y leyenda **SIMULACRO**.  
**Plataforma:** frontend React + Vite + TypeScript/PWA; backend Node.js + Express + TypeScript; Prisma + PostgreSQL (Neon como plataforma prevista, PostgreSQL local aislado para integración); Rust/Soroban en Stellar Testnet.  
**Alcance de entrega:** una secuencia integrada de `Alert` crítica `Severe` creada, aprobada por tercero, firmada, anclada, publicada y verificada; casos negativos de seguridad.

No son obligatorios para esta entrega: emisión de `Update/Cancel`; historial firmado sincronizado; invitaciones QR, recuperación compleja y administración avanzada de usuarios; rotación automática de claves; KMS/HSM; lectura RPC desde la PWA; mantenimiento autónomo avanzado de TTL; paneles extensos, analítica y notificaciones masivas. La PWA offline ya desarrollada se conserva, pero no se amplía.

**Límites de seguridad:** la firma identifica una clave del emisor simulado, no garantiza verdad ni oficialidad. La aprobación del usuario se comprueba por identidad, digest y auditoría; el JWS firmado por servidor **no** es una firma personal del aprobador. El catálogo de claves exige un ancla de confianza establecida previamente. La bitácora en PostgreSQL no es inmutable ante control total de DBA. Soroban Testnet no garantiza disponibilidad ni permanencia; su ausencia de respuesta no demuestra ausencia de registro.

## 6. Módulos de trabajo

| Módulo | Funcionalidades mínimas | Evidencia verificable |
|---|---|---|
| **M1. Autenticación y acceso** | Tres roles, Argon2id, TOTP, sesiones opacas, cookies seguras, CSRF, RBAC, bloqueo, cuentas de laboratorio por CLI restringida. | MFA completo sobre BD real; usuario sin rol rechazado; token revocado inválido. |
| **M2. Autoría y aprobación** | Crear/editar `Alert` en `DRAFT`, congelar bytes y digest, aprobar/rechazar por `APPROVER` distinto; preservar versión. | Rechazo de autoaprobación y modificación del contenido congelado. |
| **M3. Firma y confianza** | Signer local restringido ES256, `kid`, única clave inicial y catálogo de confianza con JWK pública. | JWS verificable de forma independiente; alteración produce `INVALIDA`. |
| **M4. Portal ciudadano PWA** | Cargar/pegar JWS, verificar firma, política y vigencia; advertencias offline; blockchain `NO_COMPROBABLE`. | Prueba Chromium y clasificación correcta de fixtures y JWS emitido. |
| **M5. Auditoría y Soroban** | Auditoría crítica encadenada; outbox mínimo; anclaje autorizado de `messageKey`/`jwsHash`, confirmación y relectura; CLI externa. | Registro real Testnet y lectura coincidente, sin publicar ante fallo RPC. |
| **M6. Evaluación** | PS1–PS6 y PB1–PB4 con escenarios reproducibles; documentación de riesgos residuales. | Matriz requisito–amenaza–control–prueba–resultado–evidencia. |

## 7. Roles y seguridad

| Actor | Acciones admitidas | Restricciones |
|---|---|---|
| **ADMIN** | Aprovisionamiento mínimo supervisado, control administrativo y revisión de evidencias. | No redacta ni aprueba alertas; no dispone de firma arbitraria. |
| **AUTHOR** | Crea/edita borradores y solicita su emisión conforme al estado. | No puede aprobar su propia alerta crítica. |
| **APPROVER** | Revisa el digest congelado; aprueba/rechaza la alerta crítica. | No debe ser el autor; permisos validados en servidor. |
| **Ciudadano** | Consulta y verifica mensajes publicados de demostración, sin cuenta. | Solo lectura y verificación local; sin acceso a credenciales ni firmas privadas. |

Para el MVP, la preparación de cuentas se limita a una CLI **local y restringida** que no establece contraseñas predeterminadas ni evita la confirmación de TOTP. Una cuenta sin MFA validado no obtiene sesión operativa. Se mantienen limitación de intentos, antirreutilización TOTP, revocación y auditoría transaccional.

## 8. Requerimientos prioritarios

| ID | Requerimiento verificable |
|---|---|
| RF01 | Autenticación en dos fases (Argon2id y TOTP) y sesiones seguras revocables. |
| RF02 | RBAC servidor que rechaza permisos incorrectos y autoaprobación de alerta crítica. |
| RF03 | Alta de borrador, edición previa y congelación del contenido exacto. |
| RF04 | Aprobación o rechazo ligado al SHA-256 de `payloadBytes`, por otra identidad. |
| RF05 | Emisión de JWS ES256 conforme al contenido aprobado, sin reescribirlo para reintentos. |
| RF06 | Cálculo reproducible de `messageKey` y `jwsHash` conforme al protocolo v1.2. |
| RF07 | Anclaje en Soroban autorizado, con confirmación y relectura previa a publicación. |
| RF08 | Verificación local en PWA de firma, confianza, política y vigencia, incluso sin conectividad cuando ya dispone del material de confianza. |
| RF09 | CLI externa independiente que coteja la evidencia blockchain en Testnet. |
| RF10 | Auditoría transaccional de operaciones sensibles y evidencias de pruebas negativas. |

**Requisitos no funcionales:** secretos fuera de Git y frontend; cookies `HttpOnly`, `Secure`, `SameSite=Strict` y CSRF; validación y errores HTTP saneados; JWS inmutable; no publicaciones ante RPC incierto; exactitud de los bytes procesados; trazabilidad reproducible; controles CSP para la PWA.

## 9. Arquitectura y flujo de operación

**Contenedores:** (1) React/PWA y `@siga-e/verify`, (2) API Express monolítica modular, (3) PostgreSQL mediante Prisma, (4) firmador ES256 local restringido, (5) ejecutor de anclaje sobre Testnet, (6) CLI externa de lectura. Blockchain registra **solo huellas** y metadatos mínimos; no almacena texto de alertas ni identidades.

**Flujo principal:**

1. `AUTHOR` completa contraseña y TOTP.
2. Crea `Alert` `Severe` de simulacro; modifica borrador si corresponde.
3. Congela `payloadBytes` y digest de aprobación; la alerta pasa a `PENDING_APPROVAL`.
4. `APPROVER` autenticado y diferente valida el mismo digest y aprueba, o rechaza.
5. El autor solicita emisión; servidor firma bytes aprobados con ES256 y persiste el JWS **sin cambios** junto con `anchor_job`.
6. El ejecutor calcula/usa `messageKey` y `jwsHash`, registra en Soroban bajo cuenta autorizada y consulta resultado final y registro correspondiente.
7. Solo con relectura coincidente se marca `PUBLISHED` y aparece el mensaje en portal público.
8. El visitante verifica firma y vigencia localmente; blockchain permanece `NO_COMPROBABLE` en PWA. La CLI externa puede contrastar el registro confiable.

**Estados de ciclo:** `DRAFT → PENDING_APPROVAL → READY_TO_SIGN → SIGNING → SIGNED_PENDING_ANCHOR → PUBLISHED`; `REJECTED` para revisión denegada. **Estados de anclaje independientes:** `NOT_REQUESTED`, `PENDING`, `SUBMITTED`, `CONFIRMED`, `RETRYABLE_ERROR`, `CONFLICT`, `UNVERIFIABLE`. Ningún estado de envío equivale por sí solo a publicación.

## 10. Modelo de datos resumido

| Entidad | Responsabilidad |
|---|---|
| `users`, `sessions` | Cuentas, factores y sesiones revocables. |
| `alerts`, `approvals` | Mensajes congelados y decisiones sobre digest. |
| `public_keys` | Identificación `kid`, JWK pública y estados de confianza. |
| `anchor_deployments`, `anchor_jobs` | Contrato confiable y trabajos persistentes de anclaje. |
| `audit_events`, `audit_chain_state` | Eventos críticos encadenados y estado de cabeza. |
| `alert_references` | Estructura conservada para futuras `Update/Cancel`. |
| Estructuras M1 adicionales | Invitaciones/desafíos, antirreutilización, límite distribuido y bootstrap existente. |

Se **preserva el esquema físico actual**. No se propone eliminar tablas ni modificar migraciones históricas a causa de esta reducción. Las pruebas de concurrencia y atomicidad de M1 requieren PostgreSQL real y no se consideran aprobadas solo por mocks.

## 11. Seguridad de la Información y amenazas (STRIDE)

| Categoría | Caso de prueba | Control principal |
|---|---|---|
| Suplantación (S) | Usuario o `kid` que pretende ser confiable. | MFA, RBAC, validación de clave ES256. |
| Alteración (T) | Cambio en JWS, payload congelado o huella. | Firma, hashes, inmutabilidad y control de versiones. |
| Repudio (R) | Desconocimiento de una aprobación registrada. | Identidad autenticada, digest y bitácora; sin no repudio legal. |
| Divulgación (I) | Credenciales y claves en logs o frontend. | Cifrado TOTP, aislamiento de claves y revisión de secretos. |
| Denegación (D) | Fuerza bruta y RPC no disponible. | Contadores, bloqueo y publicación pendiente. |
| Elevación (E) | Autoaprobación, rol inadecuado o acceso administrativo. | RBAC backend, separación de funciones y CSRF. |

## 12. Plan de validación

| ID | Escenario | Resultado esperado |
|---|---|---|
| PS1 | Clave ajena/algoritmo prohibido. | Firma no aceptada como confiable. |
| PS2 | JWS manipulado. | `INVALIDA` o rechazo de formato correspondiente. |
| PS3 | Firma vencida, identificador repetido. | Separación firma/vigencia; duplicados rechazados. |
| PS4 | Autoaprobación de alerta `Severe` o rol incorrecto. | Rechazo por autorización/estado. |
| PS5 | Contraseña/TOTP erróneos y token revocado. | Bloqueo/rechazo conforme a política. |
| PS6 | Eventos y alteraciones controladas de bitácora. | Trazabilidad y límite ante DBA documentado. |
| PB1 | Registro de hash por cuenta Stellar no autorizada. | Rechazo. |
| PB2 | Reutilizar `messageKey` con mismo u otro `jwsHash`. | Sin sobrescritura; conciliación segura. |
| PB3 | Comparar JWS real y huella del contrato. | Coincidencia para mensaje legítimo y discrepancia para alterado. |
| PB4 | Fallo RPC o transacción incierta. | No se publica falsamente; recuperación controlada. |

Para cada escenario se consignarán amenaza, requisito, entrada, resultado esperado/observado, ambiente, versión Git, evidencia y limitación. **No se fijan cuotas irreales de repeticiones ni se exige validar las trece métricas anteriores.** Se reportarán porcentajes únicamente respecto de los casos definidos y realmente ejecutados.

## 13. Cronograma de cuatro semanas

| Semana | Trabajo delimitado | Entregable verificable |
|---|---|---|
| **1. Identidad segura** | Modelo de amenazas, PostgreSQL local aislado, migraciones, MFA, sesiones, roles y auditoría mínima. | Login real de roles y rechazo de acceso indebido con BD real. |
| **2. Emisión y firma** | Borrador, congelación, tercero aprobador, ES256, hashes y conexión con verificador existente. | Una alerta `Severe` aprobada por tercero, firmada y manipulaciones detectadas. |
| **3. Evidencia externa** | Anclaje mínimo, autorización en Testnet, outbox, confirmación, relectura, publicación y CLI independiente. | Un mensaje registrado y releído en contrato configurado; consulta externa reproducible. |
| **4. Validación y defensa** | PS1–PS6/PB1–PB4, correcciones prioritarias, capturas, documentación y demostración. | MVP integrado y dossier de resultados, riesgos y límites. |

Este cronograma es **académico**, no una afirmación de que las semanas estén disponibles todavía. La ejecución efectiva debe seguir el estado real del repositorio y la fecha de entrega. Las pruebas de seguridad empiezan desde la semana 1.

## 14. Entregables y aceptación

**Entregables:** repositorio documentado; API y UI de autenticación; flujo real de creación/aprobación; JWS ES256 y verificador PWA; contrato/test de Soroban; CLI externa de contraste; auditoría; matriz de pruebas y defensa con capturas y registros reproducibles.

**Cierre demostrable:** (1) MFA y permisos respaldados por BD real; (2) digest aprobado por tercero coincide con contenido firmado; (3) JWS se verifica localmente y detectar cambios; (4) hash del paquete registrado y releído; (5) `PUBLISHED` exclusivamente tras lectura coincidente; (6) CLI de verificación sin dependencia de metadatos de backend; (7) pruebas negativas y auditoría. Toda falta se informa como pendiente, sin sustituir la integración por mocks.

## 15. Consideraciones éticas, límites y trabajo futuro

SIGA-E no reemplaza sistemas oficiales de alerta. Utiliza lugares, mensajes e identidades ficticias y visualiza **SIMULACRO**. No maneja datos ciudadanos, no ordena acciones de emergencia ni realiza operaciones en Mainnet. No se expone material secreto en presentaciones o repositorios. La validez criptográfica no prueba hechos físicos; el contrato Testnet no garantiza persistencia.

Ampliaciones diferidas: enrolamiento presencial por QR, recuperación/reconfiguración avanzada, múltiples claves y rotación automática, HSM/KMS, `Update/Cancel` y su historial, sincronización PWA más extensa, gestión avanzada de jobs, TTL automático, panel de administración/auditoría y métricas de UX extensivas.

## 16. Estado de aprobación

**Perfil definitivo preparado para entrega y revisión docente.** Su contenido fue confirmado por el autor el 15/10/2026; **todavía no consta aprobación del docente**. El estado técnico de cada criterio se verificará mediante pruebas y evidencias posteriores; esta propuesta no certifica que el sistema ya esté completo.
