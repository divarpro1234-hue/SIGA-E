# ENM-002 — Reducción controlada del alcance del MVP académico de SIGA-E a cuatro semanas

**Estado:** APROBADA DOCUMENTALMENTE PARA DELIMITACIÓN DEL MVP, mediante confirmación expresa del usuario el 15/10/2026.  
**Fecha de decisión:** 15/10/2026.  
**Incorporación inicial al repositorio:** commit humano `31c30ea` del 15/10/2026; conciliación con fuentes canónicas en revisión, sin afirmar aprobación final de esa conciliación.

**Aprobación docente:** no acreditada; el perfil académico todavía debe presentarse.  
**Naturaleza de la aprobación:** exclusivamente alcance y documentación. **No autoriza** operaciones remotas, migraciones, cambios de código, habilitación de endpoints ni commits por agentes.  
**Proyecto:** SIGA-E — Seguridad de la Información, trabajo individual, cuatro semanas académicas.

## 1. Objeto, alcance y conservación del trabajo

ENM-002 reduce las **obligaciones de implementación y aceptación** de SIGA-E sin sustituir el proyecto, su arquitectura base ni los componentes de seguridad ya desarrollados. El resultado exigible es un flujo de demostración de extremo a extremo, con pruebas reproducibles: `AUTHOR` crea y congela una alerta crítica simulada; `APPROVER` diferente autoriza los bytes congelados; el backend produce un JWS ES256 inmutable; un trabajo de anclaje registra y relee su huella en Soroban Testnet; solo entonces se publica; la PWA verifica criptográficamente el JWS y una CLI externa contrasta por separado la evidencia blockchain.

**Regla de conservación:** no eliminar, reescribir ni degradar código, rutas, entidades, migraciones o pruebas ya existentes por el solo hecho de diferir una función. «Diferido» significa **no exigido para el cierre del MVP** y no implica «implementado» ni «deshabilitado con garantía» si aún no se ha probado el mecanismo de bloqueo.

La v1.2 tiene seis módulos; **se mantienen los seis**. Stellar Testnet/Soroban, JWS ES256, separación de funciones, auditoría esencial y publicación condicionada siguen siendo obligatorios.

## 2. Autoridad, precedencia y trazabilidad

Fuentes afectadas: `docs/proyecto/SIGA-E_Proyecto_Consolidado_v1.2.md`; `docs/arquitectura/SIGA-E_Arquitectura_Definitiva_v1.2.md`; `docs/arquitectura/SIGA-E_API_OpenAPI_v1.2.yaml`; `docs/adr/ADR-004-ciclo-identidad-autenticacion-m1.md`; `docs/adr/ADR-005-verificacion-local-evidencia-externa.md`; `docs/enmiendas/ENM-001-canal-invitaciones-presenciales-M1.md`; perfil académico y `AGENTS.md`.

Esta enmienda **prevalece solamente respecto del alcance obligatorio del MVP académico** en los puntos enumerados en §4–§9. En todo lo demás permanecen las invariantes de v1.2, la documentación criptográfica, la semántica de los estados y los contratos implementados. La v1.2, ENM-001 y ADR-004 **no se sobrescriben ni se declaran erróneos**: continúan siendo antecedentes históricos. Sus obligaciones avanzadas expresamente desplazadas pasan a trabajo futuro para el MVP, y se deja la referencia cruzada correspondiente.

No confundir la aprobación documental de esta decisión con aprobación del docente, autorización de despliegue o prueba superada. La revisión e incorporación de documentos al repositorio es tarea posterior y se hace de manera controlada, con commits humanos.

## 3. Línea base de implementación y evidencia conocida

| Carril | Rama | Punto de control comunicado | Evidencia y límite |
|---|---|---|---|
| Backend / documentos técnicos | `master` | `87c6603` | Autenticación HTTP M1 incorporada, pruebas con mocks; no demostración real sobre PostgreSQL |
| UI / diseño | `feat/ui-design` | `ab36be4` | D06b con verificador real y pruebas Chromium reportadas; sin flujo de alertas publicadas conectado |
| Paquete compartido | Integrado en ambos árboles hasta último merge | `@siga-e/verify` | Pruebas de fixtures públicos; no equivale a confianza operativa del emisor real |
| Soroban | Testnet | Contrato previamente desplegado, según registro del proyecto | Falta probar el circuito completo de emisión y anclaje del MVP |

La migración `20261011_initial` no se modifica. La migración aditiva `20261012_m1_identity_additive` se conserva; sus restricciones y transacciones **no están verificadas con PostgreSQL real**. No se autorizan conexiones ni escrituras en Neon por la mera aprobación de esta enmienda.

## 4. Decisión A — Aprovisionamiento local de M1, excepción limitada a ENM-001

### 4.1. Alcance simplificado

Para **la demostración académica exclusivamente en base PostgreSQL local aislada**, el alta compleja e invitación por QR presencial de ENM-001/ADR-004 se reemplaza como obligación de cierre por un **aprovisionador CLI local restringido**, sin endpoint público de creación o activación directa. Este es un cambio explícito de alcance; no declara que ENM-001 estuviera equivocada.

La CLI prepara las identidades `ADMIN`, `AUTHOR` y `APPROVER` con contraseñas **únicas** y secreto TOTP individual, sin valores predeterminados ni credenciales incorporadas al código. La cuenta no puede pasar a `ACTIVE` ni recibir sesión operativa hasta verificar realmente TOTP. El aprovisionamiento y activación generan auditoría **en la misma transacción** que los cambios críticos. El primer administrador se crea mediante bootstrap excepcional de un solo uso; su marcador nunca se restablece ni se reutiliza y la recuperación automática del único `ADMIN` continúa prohibida.

### 4.2. Restricciones que no se reducen

El aprovisionador exige habilitación explícita de **modo demostración**, operador local autorizado y verificación estricta de que la conexión es una base desechable en loopback, nunca Neon ni otro servidor remoto. Rechaza CI o contexto no interactivo en el que pudiera revelar secretos; no escribe contraseñas, tokens, secretos TOTP, QR o semillas en archivos, logs, historial ni capturas. El TOTP se cifra en reposo y solo se muestra una vez en el procedimiento autorizado. La CLI no ofrece saltos de MFA, no establece sesiones privilegiadas artificiales ni elimina controles de bloqueo.

Permanecen en alcance obligatorio: Argon2id, TOTP para los tres roles, `PENDING_ENROLLMENT`/`ACTIVE`/`DISABLED`, sesiones opacas revocables, atributos de cookie seguros, CSRF, RBAC en backend, protección ante fuerza bruta, antirreutilización TOTP y auditoría transaccional. Los tiempos y parámetros aprobados por ADR-004 permanecen vigentes salvo nueva decisión documentada.

El proceso QR, invitaciones HTTPS, cambio de contraseña, reconfiguración avanzada, reinvitación y recuperación supervisada pasan a **trabajo futuro para el cierre del MVP**; su código, esquema y rutas ya definidas se conservan sin declararlas operativas si no se han probado. **Cualquier aprovisionamiento de cuentas en Neon necesita autorización independiente.**

## 5. Decisión B — Mensajes emitidos

Solo se exige la emisión de `msgType="Alert"`, con `status="Exercise"`, `scope="Public"`, emisor ficticio y leyenda visible **SIMULACRO**. El caso principal será **una alerta de severidad `Severe`**, obligatoriamente revisada por otra identidad `APPROVER`. Para `Severe`/`Extreme` se conserva la política v1.2 de aprobación segregada; no se inventa una regla distinta para otras severidades.

Se mantienen creación y edición de borrador, congelación de bytes de payload, `SHA-256(payloadBytes)`, decisión de aprobación o rechazo vinculada al digest, firma del contenido autorizado y protección contra modificación posterior. Cambiar un byte tras congelar requiere nueva revisión y no reaprovecha aprobación previa. La firma emitida por el servidor **no** constituye firma personal ni no repudio individual del aprobador; este queda trazado por identidad, autorización y auditoría.

Se difiere la **emisión** de `Update`/`Cancel` y la reconstrucción de su historial firmado y sincronizado. Se conservan tipos, tablas de referencias, estados y funciones existentes; la PWA no debe mostrar un mensaje aislado `Update`/`Cancel` como alerta inicial activa ni inferir que otro aviso fue cancelado sin evidencia de historial suficiente.

## 6. Decisión C — Firma digital y confianza

Se utilizará una **única clave inicial de emisión ES256**, administrada mediante un firmador local restringido y separada de la credencial Stellar. No se autoriza firmar un payload arbitrario enviado por el usuario. Se conservan las definiciones exactas aprobadas:

- `payloadDigest = SHA-256(payloadBytes)` **antes de firmar**, vinculado a la aprobación.
- `jwsHash = SHA-256(ASCII(jwsCompact))`, donde `jwsCompact` son los tres segmentos **exactos** persistidos, sin `trim`, reserialización ni reconstrucción para reintentos.
- `messageKey = SHA-256(UTF8("SIGA-E-ALERT-ID-v1\n" + sender + "\n" + identifier + "\n" + sent))`, usando los valores textuales exactos del payload congelado.

El encabezado protegido fija `alg=ES256` y `kid`. La PWA verifica con **JWK públicas ancladas en una fuente de confianza establecida por un canal independiente**, no con claves sugeridas por el paquete o descargadas ciegamente de la API. El catálogo de fixtures de desarrollo es un **catálogo de demostración**; no se confunde con confianza operativa en las nuevas alertas firmadas. Se mantienen resultados de clave desconocida, revocada y fuera de política.

Diferidos: rotación automática, múltiples firmantes de operación, administración avanzada de claves y KMS/HSM. La revocación y retirada siguen estando representadas de manera comprobable para las pruebas.

## 7. Decisión D — Ratificación de ADR-005 (P4/P8)

Para el MVP se ratifica la decisión humana descrita en **ADR-005** y se autoriza su conciliación documental con los documentos de mayor precedencia:

- La PWA usa `@siga-e/verify` **solo** para firma ES256, política, confianza y vigencia local; **nunca consulta Soroban**.
- La dimensión blockchain de la PWA permanece `NO_COMPROBABLE`, aunque la API entregue metadatos del anclaje.
- Una **CLI verificadora externa e independiente** consulta mediante solo lectura el `contract_id`, la red y la generación obtenidos de configuración confiable, no de un JWS arbitrario ni de una respuesta API sin contraste.
- Solo una lectura confiable y conclusiva puede mostrar coincidencia, discrepancia o `NO_REGISTRADA`; fallo RPC, TTL, archivado, reset y estado incierto significan `NO_COMPROBABLE`, nunca ausencia probada.
- La coincidencia de huellas no garantiza verdad del evento, oficialidad del emisor ni persistencia de Testnet.

`CANCELADA`/`ACTUALIZADA` requieren historial de mensajes firmados y referencias verificadas; no se producen como conclusiones a partir de un JWS aislado. Se difiere la sincronización de historial, no el tratamiento seguro de sus límites.

La antigua asignación de consulta RPC a la PWA (§5.1/semana 3 del proyecto y §6.3/diagrama/secuencia de la arquitectura) se declara **sustituida para el MVP** por esta separación de responsabilidades.

## 8. Decisión E — Anclaje y publicación segura

Se conserva el contrato Rust `AlertRegistry` en **Stellar Testnet** con `__constructor(admin)`, `admin.require_auth()` en registro y operaciones `register_alert`, `get_alert` y `verify_hash`; el contrato no permite reemplazar o borrar una huella registrada. No añadir `register_key` ni nuevas operaciones para el MVP.

El backend persiste de manera **atómica en PostgreSQL** los bytes del JWS inmutable y el trabajo `anchor_job` asociado (patrón outbox). Un ejecutor mínimo puede procesar un trabajo controlado cada vez; ante incertidumbre consulta primero el estado de transacción y la huella on-chain **antes de cualquier reenvío**. No se exige una plataforma avanzada de colas, paneles, escalado, vigilancia permanente o gestión automática de TTL.

**Invariante obligatoria:** una nueva alerta **NO** puede pasar a `PUBLISHED` ni aparecer en el catálogo público hasta confirmación y relectura coincidente del `jwsHash` para el `messageKey` en el **deployment configurado y confiable**. `PENDING`, `sendTransaction`, `txHash`, timeout y `NOT_FOUND` ambiguo no constituyen prueba de éxito. Hash diferente → `CONFLICT` y sin publicación. Falta de evidencia → publicación pendiente. Si la red pierde luego el registro, distinguir publicación histórica de evidencia actual `UNVERIFIABLE`.

Las operaciones reales en Testnet requerirán autorización humana adicional; no se atribuirá éxito a mocks ni a metadatos internos.

## 9. Decisión F — Validación y criterios medibles

Se conservan las familias de prueba canónicas **PS1–PS6** y **PB1–PB4**, sin renumerarlas. Se **retiran como obligaciones de cierre**: 12 mensajes (4 por escenario), veinte repeticiones de cada PS, dos perfiles móviles distintos como cuota formal, cinco participantes y las trece métricas MT1–MT13 como conjunto de cumplimiento obligatorio. Se podrán ejecutar más pruebas si el tiempo lo permite y reportarlas, pero no prometerlas por adelantado.

| Prueba | Evidencia mínima exigible |
|---|---|
| PS1 | Clave ajena o `kid` desconocido y algoritmo no permitido sin resultado de confianza válido |
| PS2 | Alteración de JWS produce `INVALIDA` en casos controlados |
| PS3 | Firma auténtica vencida mantiene estado de firma separado; duplicados son rechazados según contrato |
| PS4 | Autor no se autoaprueba; identidad sin rol recibe error apropiado |
| PS5 | Contraseña/TOTP incorrectos, bloqueo, antirreutilización y sesión revocada |
| PS6 | Eventos críticos auditados; verificación de cadena y declaración de límite frente a DBA |
| PB1 | Registro con credencial no autorizada rechazado |
| PB2 | Registro repetido no sustituye valor; conciliación solo con hash igual |
| PB3 | Comparación exacta de huella calculada localmente con lectura confiable; manipulación discrepante |
| PB4 | Fallo RPC o resultado incierto no marca alerta publicada; recuperación controlada |

Cada escenario tendrá identificador, amenaza, control, entrada ficticia, resultado esperado/observado, versión de código, método de prueba, evidencia y riesgo residual. Los porcentajes de éxito se refieren **solo al conjunto explícito de pruebas**, nunca a protección universal. Las pruebas integrales de persistencia requieren PostgreSQL real aislado; los mocks se etiquetan como tales.

## 10. Funcionalidades conservadas pero diferidas

No son criterios de cierre: invitaciones QR y enrolamiento completo; recuperación y cambios avanzados de factores; gestión compleja de usuarios; emisión `Update`/`Cancel`; historial sincronizado; firma personal del aprobador; rotación automática/HSM; paneles administrativos avanzados; consulta RPC en PWA; actualizaciones avanzadas offline; mantenimiento autónomo de TTL; monitorización continua de trabajos; métricas y evaluaciones de UX extensivas.

La PWA offline ya implementada y sus pruebas se **conservan**, sin ampliar alcance. El código existente de funcionalidades diferidas permanece sin cambios salvo defectos de seguridad verificables tratados en tareas separadas.

## 11. Criterios de cierre del MVP

Un flujo **integral de demostración**, sin mocks de persistencia, deberá probar que:

1. Tres roles de demostración activados de forma segura pueden completar MFA y operar con sesiones reales en PostgreSQL.
2. `AUTHOR` crea y congela un mensaje `Alert` `Severe`; la autoaprobación es rechazada.
3. Un `APPROVER` diferente aprueba **exactamente** el digest de `payloadBytes` congelado.
4. El backend emite y conserva el JWS ES256 vinculado a ese contenido aprobado.
5. El backend crea el trabajo outbox, confirma y **relee** el anclaje confiable en Testnet sin cambiar el JWS.
6. `PUBLISHED` solo sucede después de coincidencia verificada; fallos dejan estado pendiente.
7. La PWA verifica firma, política y vigencia del mismo JWS y no afirma resultado blockchain.
8. Una CLI externa coteja `messageKey` y `jwsHash` contra Soroban sin utilizar los metadatos del backend como única fuente.
9. La auditoría y las pruebas negativas acompañan las operaciones críticas.

Cualquier criterio no demostrado se reporta como **pendiente/no cumplido**, sin inventar evidencias ni transformar pruebas con mocks en pruebas de integración.

## 12. Propagación documental controlada

Antes de nuevas implementaciones, registrar el nuevo alcance en el perfil académico y **conciliar documentalmente** las contradicciones siguientes:

| Documento | Acciones acotadas |
|---|---|
| Proyecto consolidado v1.2 | Conservar archivo histórico, enlazar ENM-002 en un índice o nota de vigencia sin alterar su texto sustantivo |
| Arquitectura definitiva v1.2 | Incorporar nota de alcance de MVP y sustituir referencias normativas a RPC desde PWA por CLI externa; mantener fórmulas, estados e invariantes |
| ADR-004 y ENM-001 | Adjuntar nota de excepción de **aprovisionamiento local de demostración**; mantener decisiones de seguridad y registro histórico |
| ADR-005 | Registrar ratificación por ENM-002; conciliar su sección «pendiente» con esta aprobación |
| OpenAPI | Conservar rutas y schemas aprobados; anotar clasificación MVP vs diferido sin afirmar implementación, **sin cambios de shape, verbo, status o code** |
| AGENTS.md | Señalar que la enmienda aprobada solo modifica alcance MVP y que todas las demás invariantes conservan prioridad; revisión separada antes de editar |
| Perfil académico | Publicar versión 2.0 reducida; indicar estado **pendiente de aprobación docente** |

No aplicar cambios por lotes ni reemplazos masivos de la v1.2. Cada cambio deberá contener referencia a esta ENM-002 y ser revisable por `git diff`.

## 13. Prohibiciones y alcance de la autorización

Esta decisión **NO autoriza**: escribir ni migrar Neon `development`/`production`; operaciones Testnet adicionales; modificaciones de `.env`, claves, seeds o contraseñas; crear cuentas remotas; editar migraciones históricas; refactorizar código por reducción de alcance; habilitar endpoints por defecto; cambios en `apps/web` desde Codex o `apps/api` desde Claude; commits/merges/push por agentes.

La aprobación de alcance no implica autorización para instalar PostgreSQL, crear recursos externos ni ejecutar acciones remotas. La validación PostgreSQL local se planificará en una etapa posterior y con controles explícitos de host/base aislada.

## 14. Control de versión y aprobación

- **Versión documental:** ENM-002 v1.0.
- **Contenido del alcance:** confirmado por el usuario el 15/10/2026; seis decisiones A–F ratificadas para el MVP.
- **Incorporación inicial al repositorio:** commit humano `31c30ea` del 15/10/2026. La conciliación con las fuentes canónicas requiere revisión humana del diff y no se declara concluida por este dato.
- **Aprobación académica externa:** pendiente.
- **Autorización de modificación de código o infraestructura:** no otorgada por esta enmienda.

**Fin de ENM-002.**
