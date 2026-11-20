# SIGA-E

**Prototipo web y móvil (PWA) para la emisión autenticada y verificación independiente de alertas simuladas mediante firma digital y registro criptográfico en Stellar Testnet**

**DOCUMENTO ACADÉMICO CONSOLIDADO · VERSIÓN 1.2 · 08/10/2026**

| Campo | Especificación aprobada |
|---|---|
| Proyecto | SIGA-E — Sistema de Gestión de Alertas de Emergencia Autenticadas |
| Mención | Seguridad de la Información |
| Modalidad y duración | Trabajo individual; 4 semanas |
| Entregable | Prototipo funcional de prueba de concepto; no servicio productivo |
| Emisor | Una entidad simulada, sin representación de instituciones reales |
| Escenarios | Inundación, deslizamiento, sismo; todos ficticios |
| Persistencia | Neon PostgreSQL, mediante API y ORM Prisma |
| Seguridad primaria | Firma JWS compacto ES256 (P-256 / SHA-256) |
| Blockchain obligatoria | Stellar **Testnet**, contrato Soroban `AlertRegistry` en Rust |
| Cliente | Portal interno web y portal ciudadano PWA instalable |
| Directorio de implementación | `D:\Desarrollo\SIGA-E` |
| Estado documental | Especificación aprobable; implementaciones y métricas aún **no verificadas** |

**Resumen ejecutivo.** SIGA-E aborda, mediante un escenario académico controlado, los riesgos de suplantación y modificación de mensajes sobre emergencias. Los usuarios internos utilizan autenticación multifactor y segregación de roles para redactar y aprobar alertas simuladas. El backend emite mensajes JSON inspirados en los campos de CAP 1.2, los firma con JWS ES256 y registra una huella SHA-256 del paquete firmado mediante un contrato Soroban autorizado en Stellar Testnet. Solo tras confirmar y contrastar ese registro se habilita la publicación ciudadana. La PWA verifica criptográficamente los mensajes en el dispositivo y distingue esa validación del estado de vigencia y de la comprobación en cadena. La investigación se sustenta en seis módulos, quince riesgos, dieciséis controles, seis pruebas de seguridad, cuatro pruebas específicas de blockchain y trece métricas propuestas. No verifica la verdad física del fenómeno ni afirma oficialidad, certificación, permanencia en Testnet o validez legal de la firma.

**Palabras clave:** seguridad de la información, autenticidad, integridad, JWS ES256, PWA, Soroban, Stellar Testnet, trazabilidad.

## Control de versiones y precedencia

**Nota de vigencia del MVP (15/10/2026):** Este documento v1.2 se conserva como antecedente y fuente de garantías no desplazadas. [ENM-001](../enmiendas/ENM-001-canal-invitaciones-presenciales-M1.md) documentó la invitación por QR; [ENM-002](../enmiendas/ENM-002-reduccion-alcance-MVP-4-semanas.md), aprobada para delimitar el MVP académico, prevalece solo en sus decisiones de alcance. Para la entrega de cuatro semanas exige un flujo `Alert` `Severe`, aprovisionamiento CLI restringido en PostgreSQL local aislado con TOTP confirmado, una clave ES256 inicial, anclaje y relectura obligatorios y verificación Soroban independiente mediante CLI externa. La PWA no consulta Soroban y muestra blockchain `NO_COMPROBABLE`; `Update`/`Cancel`, invitaciones QR, rotación automática y mantenimiento autónomo de TTL quedan diferidos. PS1–PS6 y PB1–PB4 siguen exigidos con evidencia reproducible; las cuotas de §1.2/§4.6, MT1–MT13 como paquete obligatorio y las cuotas de aceptación de §10 dejan de ser criterios de cierre del MVP. Las fórmulas, estados, MFA, segregación y publicación condicionada de v1.2 permanecen vigentes. El [perfil académico v2.0](SIGA-E_Perfil_Academico_MVP_4_Semanas_v2.0.md) sigue pendiente de aprobación docente. Los pasajes posteriores conservan su redacción histórica.

La presente **v1.2 sustituye el contenido funcional de v1.1** y **absorbe completamente la adenda E1.2**. La especificación técnica `SIGA-E_Arquitectura_Definitiva_v1.2.md` desarrolla este documento sin alterar sus garantías. Si una implementación o prompt contradice una regla de seguridad de este documento, se detendrá y tramitará un cambio documentado.

| Versión | Cambio esencial |
|---|---|
| 1.0 | Propuesta inicial de firma de alertas y verificador público. |
| 1.1 | Delimitación, CAP inspirado, confianza en claves, MFA, auditoría, pruebas y garantías corregidas. |
| **1.2** | Neon y Soroban obligatorios, publicación condicionada a registro confirmado, modelo de consistencia, amenazas C13–C16 / R11–R15 / PB1–PB4 / MT10–MT13, cronograma y contratos cerrados. |

# 1. Delimitación y alcance

## 1.1. Delimitaciones

| Dimensión | Alcance aprobado |
|---|---|
| Temática | Protección de autenticidad, integridad, trazabilidad y disponibilidad limitada de alertas simuladas durante autoría, aprobación, firma, registro y verificación. |
| Contextual | Tres escenarios ficticios: inundación, deslizamiento y sismo; lugares ficticios y leyenda **SIMULACRO**. |
| Institucional | Una entidad emisora simulada. No existe integración ni autorización de organismos públicos reales. |
| Técnica | React PWA, API REST TypeScript, Neon PostgreSQL, JWS ES256 y `AlertRegistry` en Stellar Testnet. |
| Temporal | Cuatro semanas, desarrollo individual; alcance de demostración y laboratorio controlado. |
| Formato | Modelo JSON basado en campos de CAP 1.2; **no** se afirma conformidad con CAP XML 1.2. |
| Blockchain | Registro obligatorio del hash del JWS, no del texto completo; únicamente Testnet, sin XLM reales. |

## 1.2. Dimensionamiento

Una entidad simulada; tres roles internos (autor, aprobador, administrador); portal público sin cuenta; al menos 12 mensajes ficticios (cuatro por escenario) para demostrar alta/baja severidad, actualización y cancelación; seis módulos M1–M6; seis pruebas PS1–PS6 con 20 ejecuciones controladas cada una; cuatro familias PB1–PB4 con pruebas locales y al menos una integración real Testnet por flujo crítico; dos dispositivos o perfiles móviles de prueba; cinco participantes voluntarios para comprensión de resultados (evaluación indicativa, no estadística).

## 1.3. Alcance formal

El sistema permitirá registrar usuarios internos con contraseña protegida y TOTP, crear borradores, congelar versiones, aprobar las críticas por una persona distinta, firmar el contenido aprobado, calcular el hash del **JWS compacto exacto**, registrar ese hash mediante un contrato inteligente autorizado y publicar la alerta únicamente al confirmar y contrastar la inscripción. Un usuario anónimo podrá verificar en su navegador la firma con claves públicas previamente reconocidas y consultar la comprobación blockchain cuando exista conectividad. Si ya dispone de alerta y clave confiable podrá comprobar la firma en modo offline, sin afirmar información actual de revocación, actualización ni cadena.

## 1.4. Garantías verificables y límites

| Garantía demostrable condicionada a implementación | Límite explícito |
|---|---|
| Firma válida respecto de una clave pública previamente reconocida. | No prueba que el desastre haya ocurrido ni que el emisor sea autoridad oficial. |
| Detección de modificaciones sobre el contenido JWS firmado. | No impide que un emisor autorizado origine datos falsos. |
| Aprobación distinta del autor en severidades críticas. | No elimina errores ni colusión de personas autorizadas. |
| Coincidencia entre hash del JWS firmado y valor del contrato actual, si se puede consultar. | Una transacción o registro Testnet no es evidencia permanente ni prueba de veracidad. |
| Evidencias de acceso y operaciones en una bitácora encadenada. | Sin referencia externa independiente, la bitácora no es inmutable frente a administradores de la BD. |
| Firma local en modo sin conexión con paquete y clave almacenados. | No conoce nuevas cancelaciones, revocaciones ni estado reciente de Testnet. |
| Política «solo se publica después del anclaje». | Una caída de Testnet bloquea temporalmente **nuevas** publicaciones; aceptable únicamente por tratarse de simulacros. |

## 1.5. Exclusiones

No incluye sensores IoT, pronóstico o monitoreo físico, coordinación de rescate, emisión de avisos oficiales, suscripción masiva SMS, aplicación nativa, exportación CAP XML normativa, PKI, firma certificada, custodia de activos, Mainnet, tokenización, criptomonedas reales, contratos de gobernanza, permanencia garantizada del historial blockchain, Azure Key Vault en el núcleo de cuatro semanas, notificaciones push, QR obligatorio, multilingüismo ni garantías de alta disponibilidad.

# 2. Planteamiento del problema

## 2.1. Problema central

Los mensajes que circulan por mensajería y redes pueden suplantar a un emisor o ser modificados, y una captura aislada no proporciona al receptor evidencia criptográfica verificable. Incluso una plataforma que firme alertas puede depender de su propia base de datos para demostrar qué paquete había publicado. En SIGA-E se modela este problema **como un escenario de seguridad simulado**, no como diagnóstico empírico de una institución específica. Se propone combinar autorización interna, firma digital y evidencia criptográfica registrada en un contrato externo de prueba.

## 2.2. Problemas específicos y trazabilidad

| ID | Problema específico | OE / Módulo |
|---|---|---|
| PE1 | Usuarios internos pueden intentar emitir sin identidad suficientemente protegida. | OE1 / M1 |
| PE2 | Alertas críticas podrían publicarse sin revisión independiente de su contenido exacto. | OE2 / M2 |
| PE3 | Un mensaje puede suplantarse o alterarse sin evidencia criptográfica comprobable por el receptor. | OE3 / M3 |
| PE4 | El receptor carece de verificación local comprensible cuando la conectividad es limitada. | OE4 / M4 |
| PE5 | La trazabilidad depende de registros locales modificables y no permite contrastar una huella con un registro externo. | OE5 / M5 |
| PE6 | No se ha demostrado mediante pruebas controladas que las defensas y la integración blockchain cumplan sus requisitos. | OE6 / M6 |

## 2.3. Pregunta de investigación

**¿Cómo diseñar, implementar y validar un prototipo web y móvil que permita verificar independientemente la firma y la integridad de alertas simuladas, incorporando controles de autorización y un registro criptográfico contrastable en Stellar Testnet, aun cuando la conectividad del ciudadano sea limitada?**

## 2.4. Supuesto técnico contrastable

Se espera que MFA y aprobación dual reduzcan emisiones no autorizadas, JWS ES256 permita verificar el origen criptográfico e integridad respecto de claves confiables, y el contrato `AlertRegistry` aporte una referencia externa adicional para comparar el hash de paquetes publicados. La hipótesis se evaluará con PS1–PS6, PB1–PB4 y MT1–MT13. Las métricas representan **metas de diseño, no resultados ya alcanzados**.

# 3. Objetivos

## 3.1. Objetivo general

Diseñar, implementar y validar un prototipo web y móvil para emitir alertas simuladas mediante controles de acceso y firma digital, registrar su huella criptográfica en Stellar Testnet y permitir la comprobación pública independiente de integridad, origen criptográfico y evidencia blockchain disponible.

## 3.2. Objetivos específicos

| ID | Objetivo específico | Módulo |
|---|---|---|
| OE1 | Implementar autenticación multifactor, control de acceso por roles y revocación de sesiones internas. | M1 |
| OE2 | Implementar creación, congelación, aprobación dual y transiciones seguras de alertas simuladas, incluidas Update y Cancel. | M2 |
| OE3 | Implementar firmas JWS ES256 y gestión de claves públicas confiables para comprobar origen criptográfico e integridad. | M3 |
| OE4 | Desarrollar un verificador público en PWA que valide firmas localmente y muestre por separado vigencia y anclaje, incluso con avisos correctos en modo offline. | M4 |
| OE5 | Implementar auditoría local con detección limitada de alteraciones y registro obligatorio, autorizado y contrastable de huellas de alertas firmadas mediante Soroban en Stellar Testnet. | M5 |
| OE6 | Validar controles de identidad, aprobación, firma, auditoría, comportamiento offline y anclaje blockchain mediante pruebas reproducibles y métricas documentadas. | M6 |

# 4. Módulos y aceptación

| Módulo | Núcleo obligatorio | Evidencia mínima |
|---|---|---|
| M1 Identidad y accesos | Argon2id, TOTP tres roles, RBAC, sesiones revocables, 5 fallos/bloqueo. | Pruebas de sesión, MFA y permisos. |
| M2 Autoría y aprobación | JSON inspirado en CAP, contenido congelado, segregación, Update/Cancel, cola de publicación. | Autoría → aprobación → estado de publicación. |
| M3 Firma y confianza | JWS ES256, `kid` reconocido, claves pública/privada separadas, firmador local restringido. | Script externo valida JWS y casos alterados. |
| M4 Portal ciudadano/PWA | Verificación local, PWA offline, tres resultados independientes, advertencias de Testnet. | Prueba en dispositivo desconectado y consulta online. |
| M5 Auditoría y Soroban | Bitácora encadenada, contrato protegido, outbox, confirmación y conciliación. | Hash JWS = registro consultado y pruebas PB. |
| M6 Validación | PS1–PS6, PB1–PB4, métricas y pruebas de UX. | Informe con trazabilidad y hallazgos. |

## 4.1. M1. Identidad y accesos

El administrador crea usuarios sin autorregistro; `AUTHOR`, `APPROVER` y `ADMIN` son mutuamente excluyentes por sesión. Contraseña Argon2id, TOTP obligatorio para todos, secretos TOTP cifrados en reposo, cookie HttpOnly+Secure+SameSite, protección CSRF y revocación de sesiones al desactivar una cuenta. La API comprueba RBAC en cada solicitud. El administrador nunca crea, aprueba ni firma manualmente alertas; sí puede solicitar **reconciliación de trabajos previamente autorizados** sin cambiar el JWS ni su hash. Criterio: ninguna operación protegida prospera sin el rol y el MFA requeridos.

Una cuenta creada por invitación inicia en `PENDING_ENROLLMENT` y carece de acceso operativo hasta completar contraseña y verificación TOTP. Los usuarios históricos se deshabilitan en lugar de eliminarse para preservar referencias de auditoría.

## 4.2. M2. Autoría, aprobación y política de publicación

Todo mensaje debe incluir `status=Exercise`, `scope=Public` y leyenda visible **SIMULACRO**. El emisor ficticio identifica el contexto, no una autoridad real. Se calcula la huella SHA-256 de la **carga UTF-8 congelada**. Para `Severe` o `Extreme`, o cuando un `Update` o `Cancel` referencia una alerta crítica, se exige aprobación de otra identidad, vinculada a esa huella concreta. Cambiar un byte exige nueva revisión. Cada Update/Cancel constituye un mensaje nuevo con terna `sender,identifier,sent` propia y `references` de mensajes anteriores; el JWS previo no se reescribe.

Al aprobar y solicitar emisión, se transita por `SIGNED_PENDING_ANCHOR`, `ANCHOR_SUBMITTED` (estado técnico), `RETRYABLE_ERROR` y finalmente `PUBLISHED`, según la confirmación. Una alerta firmada sin anclaje **no aparece en el portal público**. Tras un reset/TTL puede conservarse el hecho histórico de publicación, pero se cambiará la evidencia actual a **NO_COMPROBABLE**: no se mostrará «anclaje vigente confirmado».

## 4.3. M3. Firma digital y claves

Se utiliza exclusivamente JWS compacto ES256 (ECDSA P-256 con SHA-256) y encabezado protegido `alg=ES256`, `kid` conocido. El `JWS Signing Input` es `ASCII(BASE64URL(UTF8(header)) + "." + BASE64URL(payloadBytes))` según RFC 7515. La firma se codifica como `R || S` de 64 bytes. El **paquete completo** JWS se almacena sin reserializar ni sustituir su carga útil. Se rechazan `alg=none`, algoritmos distintos, `jku`, `jwk`, `x5u` y fuentes de clave impuestas por la entrada. Se utilizará firmador local protegido en desarrollo y MVP, sin prometer una clave HSM no exportable; Azure Key Vault queda como trabajo futuro. `kid`, JWK público, huella RFC 7638, retiro y revocación forman parte del catálogo de confianza.

## 4.4. M4. Verificación pública y PWA

La PWA ofrece: portal público, detalle, entrada de JWS pegado/cargado, historial local, pantalla de confianza y última sincronización. Firma, estado temporal y evidencia blockchain se muestran **independientemente**. La firma local funciona offline cuando ya existe paquete y clave pública confiable; offline la vigencia se calcula mediante el reloj local y se advierte que nuevas revocaciones/cancelaciones y datos de cadena no pueden verificarse. Nunca se presenta una alerta ficticia como «oficial». El navegador no puede aceptar claves ofrecidas por el paquete JWS ni un contract ID procedente de mensajes externos; ambos se anclan en configuración de confianza instalada y auditada.

## 4.5. M5. Auditoría y registro Soroban obligatorio

Registra operaciones críticas en cadena de hashes con limitación expresa frente a borrado/reconstrucción por DBA. Incorpora contrato `AlertRegistry` en Rust y administración fija por constructor; `register_alert(BytesN<32>, BytesN<32>)` exige `admin.require_auth()`, registra **una sola vez** por identificador-hash, y `get_alert` / `verify_hash` son consultas públicas. El backend crea un trabajo outbox en la misma transacción de BD que guarda el JWS inmutable, lo transmite a Testnet, consulta estado final y lee el valor vigente del contrato antes de publicarlo. El contrato no almacena texto, usuarios ni claves privadas. Se registra la época/identidad del despliegue; Testnet puede resetearse y la información almacenada en Soroban puede archivarse por TTL.

## 4.6. M6. Validación

Las seis pruebas PS y cuatro PB incluirán casos positivos, negativos, fallos y recuperación. Las seis PS emplean 20 ejecuciones cada una; las PB emplean casos unitarios repetibles y una comprobación de integración real Testnet por operación crítica, sin prometer 20 envíos externos. Para cada prueba: entrada, versión Git, configuración, salida esperada, salida observada y evidencia. Se reportarán hallazgos abiertos y riesgos residuales.

## 4.7. Funcionalidades diferidas

No son criterios de cierre: código QR, notificaciones push, Azure Key Vault, multilingüismo, panel avanzado de auditoría, renovación totalmente automática de TTL y exportación XML CAP. El anclaje Soroban, su autorización, la reconciliación y la consulta **no son diferibles**.

# 5. Interfaz ciudadana, confianza y conectividad

## 5.1. Experiencia del ciudadano

| Pantalla | Resultado | Sin conexión |
|---|---|---|
| Inicio | Solo mensajes que alcanzaron publicación autorizada; marca «SIMULACRO». | Últimas alertas guardadas; se marca caché y fecha. |
| Detalle | Mensaje, emisor ficticio, JWS, fechas, referencias Update/Cancel. | Solo mensajes descargados. |
| Verificar | Pegar o cargar JWS; verificar ES256 y fecha. | Sí, con clave reconocida precargada. |
| Evidencia Stellar | `contract_id` confiable, época, ID-hash, hash JWS, consulta a RPC. | No actualizable: «No comprobable sin conexión». |
| Confianza | `kid`, huella y última actualización de claves y contrato. | Vista almacenada, sin validación de novedades. |

## 5.2. Tres dimensiones de resultado

| Dimensión | Estados presentados | Criterio |
|---|---|---|
| **Firma** | `VALIDA`, `INVALIDA`, `CLAVE_DESCONOCIDA`, `CLAVE_REVOCADA` | ES256 local con conjunto confiable. |
| **Temporal** | `VIGENTE`, `VENCIDA`, `CANCELADA`, `ACTUALIZADA`, `DESCONOCIDA` | Metadatos firmados y referencias disponibles; «CANCELADA/ACTUALIZADA» requiere información sincronizada. |
| **Blockchain** | `COINCIDE`, `NO_COINCIDE`, `NO_REGISTRADA`, `NO_COMPROBABLE` | Lectura del contrato desplegado confiable; hash de bytes exactos del JWS. |

Una firma válida y un registro coincidente **no garantizan** veracidad ni oficialidad. Una clave retirada puede servir para validar mensajes históricos; una clave revocada no se considera confiable tras sincronización. En modo offline se informa que el estado se refiere a la última sincronización, no al momento actual.

# 6. Seguridad y amenazas

## 6.1. Activos

A1 mensajes y borradores; A2 clave privada JWS; A3 cuentas y sesiones; A4 JWK/JWKS y material de confianza; A5 bitácora; A6 aplicación y bundle PWA; A7 clave autorizada Stellar; A8 contrato, configuración de red y registros de anclaje. La integridad de A1, A4, A5 y A8 se considera crítica; la confidencialidad de A2, A3 y A7, alta.

## 6.2. Controles verificables

| Control | Medida | Evidencia esperada |
|---|---|---|
| C1 | Argon2id, TOTP cifrado y rate limit. | PS5; revisión de almacenamiento. |
| C2 | RBAC servidor y segregación. | PS4 y pruebas de permisos. |
| C3 | Aprobación dual vinculada a huella de versión. | PS4 y MT6. |
| C4 | JWS ES256, algoritmo fijo y verificación. | PS1, PS2. |
| C5 | Catálogo `kid`, retiro/revocación y JWKS. | Rotación de prueba y MT2. |
| C6 | Clave JWS fuera de repositorio, bundle y logs; permisos mínimos. | Escaneo de secretos y revisión de configuración. |
| C7 | Verificación local con claves conocidas; sin `jku` arbitrario. | PS1/PS2 y prueba offline. |
| C8 | Identificadores únicos, fechas y estados Update/Cancel. | PS3. |
| C9 | Huella de clave verificable por canal independiente. | Pantalla de confianza + prueba manual. |
| C10 | Auditoría con hash previo, verificación y control de acceso. | PS6. |
| C11 | HTTPS, CSP, CSRF, validación y límites. | Revisión de cabeceras y tests API. |
| C12 | Dependencias, CI, escaneo de secretos y análisis estático. | Registro de pipeline. |
| C13 | Constructor de admin fijo, `require_auth`, unicidad de registro. | PB1/PB2. |
| C14 | Outbox, estado final y relectura del hash antes de publicar. | PB2/PB4, MT10. |
| C15 | Configuración confiable de red/contrato, TTL, reset y estado no comprobable. | PB3/PB4. |
| C16 | Clave Stellar separada de la JWS y fuera de código, logs y frontend. | Revisión de secretos/roles. |

## 6.3. Registro de riesgos (1=menor, 3=mayor)

Nivel `P × I`: 1–2 bajo, 3–4 medio, 6–9 alto. Es una estimación de laboratorio, no un estudio de un organismo real.

| Riesgo | Amenaza (activo) | P×I | Control(es) y residual |
|---|---|---|---|
| R1 | Suplantación de mensajes (A1). | 3×3=9 Alto | C4/C7/C9; residual medio, depende de consulta. |
| R2 | Alteración del JWS (A1). | 2×3=6 Alto | C4/C7; residual bajo. |
| R3 | Emisión unilateral o error de dos personas (A1). | 2×3=6 Alto | C1/C2/C3; residual medio por colusión. |
| R4 | Robo de credenciales (A3). | 3×3=9 Alto | C1/C2/C11; residual medio. |
| R5 | Exposición de clave JWS local (A2). | 2×3=6 Alto | C6/C12; residual medio, no es HSM. |
| R6 | Sustitución de JWKS (A4). | 2×3=6 Alto | C7/C9; residual medio, sin PKI. |
| R7 | Reenvío de aviso vencido/cancelado (A1). | 2×2=4 Medio | C8; residual medio offline. |
| R8 | Edición/reconstrucción de auditoría (A5). | 2×2=4 Medio | C10; residual medio-alto frente a DBA. |
| R9 | XSS/dependencia maliciosa en PWA (A6). | 2×3=6 Alto | C11/C12; residual medio. |
| R10 | Caída de API / Denegación de servicio (A6). | 2×2=4 Medio | C11; residual medio. |
| R11 | Robo de cuenta firmante Stellar (A7). | 2×3=6 Alto | C13/C16; residual medio. |
| R12 | Reinicio o archivado Testnet (A8). | 3×2=6 Alto | C15; residual alto respecto de permanencia. |
| R13 | Fallo RPC/transacción incierta (A8). | 2×3=6 Alto | C14; residual medio. |
| R14 | Escritura ajena o duplicada en contrato (A8). | 2×3=6 Alto | C13; residual bajo/medio. |
| R15 | Falsa indicación de anclaje sin consulta (A8). | 2×2=4 Medio | C14/C15; residual medio. |

## 6.4. Confianza, no repudio y claves

La clave de firma ES256 identifica criptográficamente al emisor **simulado** tras la comprobación de su asociación mediante huella confiable. No se garantiza reconocimiento legal, no repudio institucional absoluto ni sellado independiente del tiempo. La cuenta Stellar usada para autorizar `register_alert` es **distinta** y no se revela al cliente; la PWA conoce la dirección pública, el contrato y la huella de su versión de despliegue. Las cuentas no se infieren de entradas suministradas por el ciudadano.

# 7. Arquitectura de referencia y contratos

## 7.1. Descripción lógica

La arquitectura definitiva conserva una aplicación React/PWA separada de la API Express/TypeScript en un monorepo; la API es un monolito modular. Prisma accede a Neon PostgreSQL. La verificación ES256 ocurre en navegador. Un adaptador `StellarAnchorGateway` consulta e invoca el contrato Rust `AlertRegistry` en Testnet; el módulo de auditoría registra las operaciones. El dominio desconoce HTTP, Prisma y Stellar SDK mediante interfaces específicas. El worker de anclaje puede ejecutarse como proceso separado del mismo código backend, **sin ser un microservicio**.

## 7.2. Identificadores y protocolo de huellas

- **Paquete:** `jws_compact` es la cadena ASCII `base64url(header).base64url(payload).base64url(signature)` exactamente como fue generada; no añadir espacios ni saltos.
- **`jws_hash`:** `SHA-256(ASCII(jws_compact))`, 32 bytes; se guarda en BD y en Soroban `BytesN<32>`.
- **`message_key`:** `SHA-256(UTF-8("SIGA-E-ALERT-ID-v1\n" + sender + "\n" + identifier + "\n" + sent))`, 32 bytes, donde los tres campos son **los valores textuales exactos del payload congelado**, con marca `sent` ISO 8601 original. Rechazar saltos de línea en los campos.
- **No confundirse:** el hash de aprobación se calcula sobre los bytes del payload **antes de firmar**; `jws_hash` incluye encabezado, payload y firma. No son intercambiables.
- **Contrato:** almacena `message_key -> jws_hash`, sin datos completos. Update/Cancel generan nuevos `message_key` y nuevos anclajes.

## 7.3. Consistencia de publicación

1. La solicitud autorizada y la versión aprobada se validan mediante bloqueo optimista/compare-and-set.
2. El backend reserva temporalmente la emisión (`SIGNING` interno), genera el JWS una sola vez y calcula `jws_hash` y `message_key`.
3. Una **transacción Neon** escribe el JWS inmutable y un `anchor_job` pendiente (outbox), antes de cualquier publicación. No existe transacción ACID distribuida con Testnet.
4. El worker consulta si ya existe `message_key` en el contrato. Si coincide, reconcilia; si existe con otro hash, detiene en conflicto; si no existe, simula, autoriza, firma con cuenta Stellar independiente y envía transacción.
5. Tras envío se guarda `tx_hash` y se sondea hasta resultado final; `PENDING` no equivale a éxito. Si el resultado es incierto, se consulta **primero** el registro on-chain antes de cualquier reenvío.
6. Solo después de confirmar éxito (o existencia previa coincidente autorizada) y **releer** el hash actual se marca la alerta `PUBLISHED` en Neon mediante transición controlada.
7. Si se pierde Testnet luego de publicar, se mantiene el hecho histórico en BD pero `anchor_status` cambia a `UNVERIFIABLE`; la UI informa que el anclaje **actual** no puede comprobarse.

## 7.4. Esquema de datos lógico cerrado

| Tabla | Claves y atributos obligatorios |
|---|---|
| `users` | UUID PK, `name` obligatorio (1–120 caracteres tras quitar espacios exteriores), email único, role, password_hash y totp_ciphertext opcionales mientras la cuenta no esté `ACTIVE`, state, fails, locked_until, timestamps; `ACTIVE` exige ambas credenciales y TOTP previamente verificado. |
| `sessions` | UUID PK, user FK, token_hash único, expires_at, revoked_at, last_seen_at. |
| `alerts` | UUID PK, `sender`, `identifier`, `sent_text` (conservado), message_type, severity, lifecycle_state, anchor_status, payload_bytes, payload_sha256, approved_payload_sha256, author_id, `jws_compact` (nullable, inmutable tras firma), `kid`, `message_key` (32B único), `jws_hash` (32B único nullable), timestamps; constraint de unicidad de terna. |
| `alert_references` | alert_id FK y `ref_sender`, `ref_identifier`, `ref_sent` de cada referencia. |
| `approvals` | alert FK, approver FK, payload_sha256, decision, reviewed_at; prohibición de autor==aprobador para crítica. |
| `public_keys` | kid único, public_jwk, thumbprint, status, valid_from, retired_at, revoked_at. |
| `anchor_deployments` | UUID PK, network, network_passphrase, contract_id, wasm_hash, admin_public_address, generation, state, deployed_at, trusted_config_version; historial inmutable. |
| `anchor_jobs` | UUID PK, alert FK, deployment FK, message_key, jws_hash, status, tx_hash, confirmed_ledger, attempts, retry_at, lease_until, sanitized_error, timestamps; UNIQUE(alert_id,deployment_id). |
| `audit_events` | BIGINT secuencial PK, action, actor_id, entity_ref, redacted_meta, previous_hash, event_hash, occurred_at. |
| `audit_chain_state` | Fila génesis `(id=1, last_seq=0, last_hash=32 bytes cero)` para serializar inserciones y asignar secuencias; no garantiza inmutabilidad frente a DBA. |

Se utilizarán restricciones reales SQL y transacciones; valores binarios `bytea` de 32 bytes se verificarán en base de datos. Ningún secreto se almacena en `anchor_jobs` ni en las tablas públicas. `anchor_deployments` conserva generaciones anteriores para explicar pérdida de evidencia tras reset.

## 7.5. Contrato y API

El ABI mínimo `AlertRegistry` usa `__constructor(admin: Address)`, `register_alert(message_key: BytesN<32>, jws_hash: BytesN<32>)`, `get_alert(message_key: BytesN<32>) -> Option<BytesN<32>>` y `verify_hash(message_key, jws_hash) -> bool`. `register_alert` carga al administrador almacenado y ejecuta `require_auth()`; no admite sobrescritura ni duplicado, aunque el hash coincida. Entradas en almacenamiento **persistent** con vigilancia de TTL; constructor y contrato también requieren mantenimiento de TTL. El MVP no promete que el anclaje sobreviva a un reset.

Las rutas REST usarán prefijo `/api/v1` y `application/json`, respuesta de error estructurada y roles comprobados en el servidor. El documento técnico adjunto especifica esquema de solicitudes, respuestas y estados HTTP, incluidos 202 para solicitud de emisión en proceso, 403, 409 y 503. No se expone un endpoint de firma privada arbitraria ni se acepta un `contract_id` indicado por el consumidor.

# 8. Cronograma y viabilidad (4 semanas)

| Semana | Compromisos de implementación | Hito verificable |
|---|---|---|
| **1: cimientos y pruebas verticales** | Repositorio, Neon/Prisma, JWS ES256 y verificador independiente; contrato Rust con constructor/`require_auth`, tests de contrato y despliegue Testnet; estructura MFA básica. | JWS probado y contrato lee/escribe un hash de prueba en Testnet. |
| **2: publicación end-to-end** | MFA y roles, autoría, congelación, aprobación, firma, outbox, worker Stellar, confirmación, relectura e idempotencia. | Una alerta Severe creada, aprobada por otro usuario, firmada, registrada y publicada. |
| **3: ciudadano y auditoría** | Portal público y PWA offline, consulta de evidencia on-chain, tres dimensiones de resultado, bitácora encadenada, Update/Cancel y endurecimiento web. | Verificación offline y comparación online con mensajes de límites. |
| **4: aseguramiento y defensa** | PS1–PS6, PB1–PB4, MT1–MT13; simulación de fallo RPC y reset; accesibilidad básica, documentación, ensayo y capturas. | Demostración reproducible y expediente de evidencias. |

## 8.1. Priorización y contingencias

Si aparecen retrasos, **posponer** QR, Azure, push, panel complejo, automatizaciones de TTL avanzadas y analíticas. **No eliminar:** MFA, autorización segregada, JWS ES256, contrato Soroban protegido y desplegado, outbox/reconciliación, publicación condicionada, verificación pública con caché, bitácora mínima y pruebas PS/PB. Si Testnet permanece caída, el prototipo muestra trabajos pendientes y se declara incumplido el criterio de publicación hasta restaurar la integración; no se informa éxito ficticio.

# 9. Validación y métricas

## 9.1. Seis pruebas de seguridad

| Prueba | Casos y expectativa |
|---|---|
| PS1 Suplantación | Firma con clave ajena, `kid` desconocido, ausencia de firma o `alg=none`; ningún caso inválido aparece como válido. |
| PS2 Alteración | Modificar payload o encabezado con clave conocida produce invalidez; una clave desconocida se informa como tal. |
| PS3 Reutilización y vencimiento | JWS auténtico vencido mantiene firma válida y vigencia vencida; identificador duplicado es rechazado. |
| PS4 Segregación | Autor se autoaprueba / usuario sin rol intenta aprobación; 403, o 409 para carrera de versión. |
| PS5 Fuerza bruta | Intentos repetidos contra contraseña y TOTP; bloqueo al umbral y rate limit. |
| PS6 Bitácora | Alteración/eliminación interna detectable respecto de una referencia íntegra; demostrar límite de truncamiento/reconstrucción. |

## 9.2. Cuatro pruebas blockchain

| Prueba | Casos y expectativa |
|---|---|
| PB1 Autorización | Intentos no autorizados al contrato son rechazados; integración con una cuenta autorizada. |
| PB2 Unicidad e idempotencia | Duplicado (hash idéntico o distinto) no sobrescribe; backend concilia resultado coincidente sin volver a firmar. |
| PB3 Coincidencia | `SHA-256(ASCII(JWS))` coincide con registro; paquete manipulado y contrato ajeno no se muestran como coincidentes. |
| PB4 Fallos y recuperación | RPC caído, transacción incierta, TTL/no disponible y redepliegue simulado; no publicar sin confirmación, comunicar límites y registrar recuperación. |

## 9.3. Métricas de aceptación propuestas

| Métrica | Meta o interpretación (no resultado real) | Objetivo |
|---|---|---|
| MT1 | 100 % de entradas maliciosas de PS1, PS2 y PS4 rechazadas/clasificadas correctamente; PS3 se mide aparte. | OE6 |
| MT2 | 0 falsos negativos de firma para 20 JWS legítimos con clave activa/retirada conocida y no revocada. | OE3/4 |
| MT3 | Mediana de firma local <2 s con 20 mediciones, **sin incluir blockchain**; reportar p95. | OE3 |
| MT4 | Verificación criptográfica local <1 s objetivo indicativo, 20 mediciones en dos perfiles; reportar p95. | OE4 |
| MT5 | 100 % de los JWS+claves precargados verificables offline en los casos definidos. | OE4 |
| MT6 | 0 alertas Severe/Extreme publicadas sin aprobador distinto y hash congelado igual. | OE2 |
| MT7 | 100 % de alteraciones interiores provocadas en PS6 detectadas con referencia íntegra; reportar límites. | OE5 |
| MT8 | 4/5 participantes interpretan firma-vigencia-anclaje correctamente (evaluación indicativa). | OE4 |
| MT9 | Evidencia disponible para **16 de 16** controles C1–C16 o incumplimiento documentado sin declarar aceptación. | OE6 |
| MT10 | 100 % de nuevas transiciones a `PUBLISHED` respaldadas por lectura de hash correspondiente en contrato configurado. | OE5 |
| MT11 | 0 registros no autorizados y 0 sobrescrituras en casos de PB1/PB2, con al menos 10 ensayos locales por categoría. | OE5 |
| MT12 | 100 % de 10 JWS modificados de PB3 identificados como discrepantes; corroboración Testnet de un caso. | OE4/5 |
| MT13 | Demostración reproducible de pendiente y reconciliación tras fallo, más simulación documentada de re-despliegue. | OE5/6 |

La latencia de **anclaje** (emisión → confirmación → lectura) se reporta separada de MT3 como diagnóstico de Testnet, sin SLA obligatorio. La metodología explica dispositivos, tamaño muestral, fecha, versiones, entorno y posibles limitaciones.

# 10. Factibilidad, ética y criterios de finalización

**Factibilidad.** React, Express, Prisma, Rust, Soroban SDK y Neon facilitan un prototipo sin infraestructura física adicional; Testnet utiliza XLM de prueba. Los niveles gratuitos, límites y accesos deben comprobarse al crear cuentas. La dependencia externa de Testnet, reintentos y documentación intensiva aumenta el riesgo de cronograma; la semana 1 contiene una prueba de extremo a extremo para reducirlo.

**Se acepta el cierre únicamente si:** (i) existen los tres roles y MFA; (ii) no hay emisión crítica unilateral ni cambios posteriores a la aprobación; (iii) JWS ES256 es comprobable fuera del backend; (iv) `AlertRegistry` está desplegado y requiere autorización; (v) alertas publicadas de prueba tienen huella leída del contrato correspondiente; (vi) el ciudadano puede verificar firma offline de paquetes almacenados y visualiza correctamente «no comprobable» para cadena offline; (vii) hay evidencia de 16 controles y 10 pruebas, con las metas cumplidas o desviaciones explícitas; (viii) se entrega repositorio, guía, documentos y demo.

**Ética.** Toda comunicación mostrará **SIMULACRO**; no utilizar nombres de autoridades reales ni recomendaciones operativas de evacuación. Las credenciales y claves se mantendrán fuera de código, Git, videos y capturas. El proyecto no enviará avisos reales ni ejecutará pruebas sobre terceros.

# 11. Fuentes técnicas de referencia

[R01] OASIS (2010). *Common Alerting Protocol Version 1.2*. https://docs.oasis-open.org/emergency/cap/v1.2/os/CAP-v1.2-os.html

[R02] IETF (2015). *JSON Web Signature (JWS)*, RFC 7515. https://www.rfc-editor.org/rfc/rfc7515

[R03] IETF (2015). *JSON Web Algorithms (JWA)*, RFC 7518. https://www.rfc-editor.org/rfc/rfc7518

[R04] IETF (2015). *JSON Web Key Thumbprint*, RFC 7638. https://www.rfc-editor.org/rfc/rfc7638

[R05] Stellar Developers. *Smart contract authorization*. https://developers.stellar.org/docs/build/guides/auth/contract-authorization

[R06] Stellar Developers. *Contract constructor at deployment*. https://developers.stellar.org/docs/build/guides/dapps/initialization

[R07] Stellar Developers. *sendTransaction and getTransaction*. https://developers.stellar.org/docs/data/apis/rpc/api-reference/methods/sendTransaction ; https://developers.stellar.org/docs/data/apis/rpc/api-reference/methods/getTransaction

[R08] Stellar Developers. *Networks and reset*. https://developers.stellar.org/docs/networks

[R09] Stellar Developers. *Persisting data and state archival*. https://developers.stellar.org/docs/learn/fundamentals/contract-development/storage/persisting-data ; https://developers.stellar.org/docs/learn/fundamentals/contract-development/storage/state-archival

[R10] Neon. *PostgreSQL platform documentation*. https://neon.com/docs

[R11] OWASP. *Application Security Verification Standard* and *Authentication Cheat Sheet*. https://owasp.org/www-project-application-security-verification-standard/ ; https://cheatsheetseries.owasp.org/cheatsheets/Authentication_Cheat_Sheet.html

# Anexo A. Matriz título–problema–objetivo–módulo–prueba

| Eje | PE | OE | M | Pruebas | Métricas |
|---|---|---|---|---|---|
| Emisión autenticada | PE1 | OE1 | M1 | PS5, PS4 | MT9 |
| Aprobación de alerta crítica | PE2 | OE2 | M2 | PS4, PS3 | MT6 |
| Integridad y firma | PE3 | OE3 | M3 | PS1, PS2 | MT2, MT3 |
| Verificador y PWA | PE4 | OE4 | M4 | PS1, PS2, PB3 | MT4, MT5, MT8, MT12 |
| Auditoría + Soroban | PE5 | OE5 | M5 | PS6, PB1–PB4 | MT7, MT10–MT13 |
| Pruebas reproducibles | PE6 | OE6 | M6 | PS1–PS6, PB1–PB4 | MT1, MT9, MT13 |

# Anexo B. Decisiones arquitectónicas cerradas y puntos de control

1. `D:\Desarrollo\SIGA-E`, monorepo pnpm, Node/Express y React/PWA.
2. Neon PostgreSQL es fuente de datos de aplicación; Soroban mantiene **solo** los pares de huellas.
3. Contrato con constructor que fija administrador, escritura autorizada y sin posibilidad de sobrescritura.
4. No se publica antes de confirmación y relectura; nunca se reconstruye un JWS para reintentar.
5. Dominio permite `Update` y `Cancel` como mensajes nuevos y anclados de forma independiente.
6. El portal muestra firma, tiempo y cadena como ejes separados; Testnet no se anuncia como almacenamiento permanente.
7. Firmador local restringido es MVP; Azure no es condición de cierre.
8. Los mecanismos de reparación de Testnet son manuales/documentados en MVP; no garantizan permanencia.
9. Todo ajuste posterior debe actualizar doc académico, especificación técnica y pruebas afectadas.

**Control de calidad documental:** este archivo define comportamiento esperado; aún no demuestra que las funciones hayan sido programadas o validadas. No se han inventado resultados medidos, tiempos de Testnet ni direcciones reales de contratos.
