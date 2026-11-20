# ADR-008 (borrador): Protección local de la clave de firma M3

- **Estado:** DECISIÓN B APROBADA PARA EL PROTOTIPO ACADÉMICO por instrucción expresa del usuario el 2026-10-26; implementación DPAPI real pendiente.
- **Fecha de decisión:** 2026-10-26.
- **Ámbito:** almacenamiento local y operación de la única clave ES256 inicial de M3 en Windows 11.
- **No autoriza:** cargar o generar una clave real, activar emisión, cambiar confianza pública, desplegar un servicio, ni alterar el contrato Soroban.

## Contexto y requisitos no desplazados

ENM-002 requiere una clave inicial ES256 administrada por un firmador local
restringido. El encabezado JWS conserva `alg=ES256` y un `kid` ya reconocido
por el catálogo de confianza; el backend verifica la firma contra la clave
pública activa y vincula la emisión a la aprobación de M2. KMS/HSM, Azure Key
Vault y rotación automática están diferidos para el cierre del MVP. Ningún
documento aprobado concreta el almacenamiento de la clave privada.

La arquitectura v1.2 hace referencia a “ADR-08”, pero no existe un archivo con
ese identificador en `docs/adr/`. Este ADR-008 documenta la decisión de
prototipo aprobada y la discrepancia; no modifica por sí mismo la referencia
canónica en la arquitectura.

## Contratos existentes y hallazgo

`AlertSigningKeyProvider` entrega `AlertSigner`; `AlertSigner.sign()` produce
un JWS compacto. `JoseAlertSigner` usa `jose` `CompactSign.sign(key)`, que
requiere un `CryptoKey`, `KeyObject`, JWK o secreto. No hay una API callback de
firma externa en `CompactSign`. Por ello, una clave CNG no exportable no se
puede conectar a esa clase como si fuera un `CryptoKey` normal.

El contrato experimental `PrivateSigningKeySource` de Paso 168.41 devolvía
`CryptoKey` privado directamente. Eso describe una clave usable en proceso,
pero no garantiza no exportabilidad; además ata la fuente a una clave que
`jose` puede consumir. Se reemplazó por `LocalAlertSignerSource`, que entrega
solo una operación `AlertSigner`. La clave no se expone a `server.ts`,
bootstrap ni `TrustedAlertSigningKeyProvider`.

`TrustedAlertSigningKeyProvider` solo devuelve un firmante cuyo `kid` existe
en el catálogo público confiable y valida que esa clave sea ECDSA P-256 de
verificación. M2 conserva la segunda verificación contra el registro activo
de PostgreSQL al emitir. Un fallo de inicialización o de operación se
sanitiza; una firma incorrecta no se persiste.

## Alternativas

### A. Clave CNG P-256 no exportable y firmador local aislado

- Crear/abrir una clave CNG bajo un principal local dedicado, aplicar ACL y
  política de exportación del KSP seleccionado, y no conceder exportación de
  la privada. No se presume que cualquier clave CNG esté respaldada por TPM
  ni que cualquier proveedor/KSP garantice las mismas propiedades.
- Aislar las operaciones en un firmador local (por ejemplo, proceso Windows
  dedicado) y comunicarse desde Node por una named pipe local con ACL limitada
  al SID del servicio/API. El protocolo debe ser acotado, con framing de
  longitud, versión, timeout, un `kid` aprobado y bytes exactos del input JWS;
  debe autenticar el extremo servidor por los controles del pipe y no invocar
  shells ni interpolar comandos.
- `NCryptSignHash`/`BCryptSignHash` recibe el hash para ECDSA. Para ES256 se
  exige exactamente SHA-256 del JWS Signing Input ASCII. El formato de firma
  entregado por el KSP concreto debe comprobarse: JWS ES256 necesita
  `R || S` de 32 bytes big-endian cada uno (64 bytes total); cualquier DER
  debe convertirse con una rutina probada antes de formar el segmento JWS.
  No se debe asumir compatibilidad sin prueba de interoperabilidad con el
  verificador de producción.
- `jose` sigue siendo adecuado para verificar el JWS. `CompactSign` no ofrece
  operación con callback/HSM; el adaptador del firmador tendría que construir
  el Signing Input y el serializado compacto exactos o usar un servicio que
  entregue el JWS compacto. Ese serializador necesita pruebas de formato,
  límites y verificación criptográfica end-to-end antes de producción.
- **Ventaja:** la privada puede no salir del proveedor CNG y nunca se entrega
  al proceso API.
- **Límites/costo:** no es HSM por el solo hecho de ser CNG; el nivel depende
  del KSP y del hardware. Añade binario, IPC, ACL, endurecimiento, operación
  de servicio y una frontera criptográfica que requiere más pruebas. No es la
  ruta de menor riesgo de calendario para cuatro semanas.
- Node 24 tiene IPC por named pipe en `node:net`; eso resuelve el transporte,
  no la autenticación/ACL ni la seguridad del protocolo. La API Win32 CNG no
  queda expuesta directamente como `CryptoKey`/`KeyObject` de Node.

### B. Auxiliar local con clave PKCS#8 protegida en reposo mediante DPAPI

- Persistir solo el blob cifrado por `CryptProtectData` con alcance de usuario
  actual (no `CRYPTPROTECT_LOCAL_MACHINE`), bajo ACL NTFS restrictiva para la
  identidad local del proceso firmador. La ruta y el formato deben ser
  administrados por una futura implementación fija; no se habilita una ruta
  arbitraria por variable de entorno.
- La implementación prevista usará un proceso auxiliar separado que invoque
  `CryptUnprotectData`, importe el PKCS#8 en un objeto ECDSA P-256 temporal y
  llame a una API criptográfica estándar con `SHA-256(signingInput)`. La clave
  no se considera no exportable: mientras el objeto exista, código que
  comprometa el auxiliar puede intentar extraerla o usarlo para firmar. Solo el
  auxiliar contendrá el plaintext/objeto clave temporal; la API Node no recibirá
  PKCS#8, JWK privado ni buffers descifrados.
- Para producir el segmento JWS, el auxiliar debe devolver únicamente firma
  `R || S` IEEE P1363 exactamente de 64 bytes, y la API forma el compacto con
  los bytes exactos de header/payload que envió. La API verifica después el
  JWS completo contra su catálogo/registro confiable; el auxiliar no declara
  `kid` confiable por sí mismo.
- `jose` `CompactSign` no es reutilizable con la clave DPAPI porque necesita
  material `CryptoKey`/`KeyObject` y no ofrece callback de firma. La
  implementación del auxiliar debe usar `ECDsa.SignHash`/API estándar para
  ECDSA y Base64URL para el segmento, sin implementar matemáticas ECDSA.
- **Ventaja:** la clave privada queda confinada al proceso firmador; se
  reutiliza el contrato `AlertSigner` en Node y no se altera el verificador
  público ni la representación JWS.
- **Costo:** requiere auxiliar Windows/.NET o nativo, formato binario de
  firma probado, IPC autenticado, ACL, identidad dedicada y ciclo de vida del
  proceso.
- **Límites/costo:** DPAPI protege datos en reposo bajo el contexto de usuario,
  no ofrece clave criptográfica no exportable ni protección frente a ejecución
  arbitraria como esa identidad. La privada sigue expuesta en memoria del
  auxiliar y a cualquier código que comprometa esa identidad. Node.js no
  proporciona API DPAPI directa; se necesita un auxiliar Windows aprobado. No
  se permiten PowerShell ad hoc, stdout, archivos temporales plaintext ni
  variables de entorno como canales de claves.

## Decisión aprobada para el prototipo

Se selecciona **B: auxiliar local con blob PKCS#8 protegido por DPAPI de
usuario**, expresamente aceptando que la privada existe temporalmente en
memoria del auxiliar y **no es una clave no exportable**. Node conserva el
contrato JWS actual de tres segmentos y su verificación; el auxiliar solo
retorna `R || S`. La biblioteca `jose` no se usa para la firma externa, porque
no admite callback de firma; ECDSA debe delegarse a la API criptográfica
estándar del auxiliar.

Si el criterio de seguridad exige que la privada no sea accesible al proceso
API, B no satisface ese criterio: se debe seleccionar A y aceptar el costo
adicional, o mantener M3 deshabilitado. No se debe presentar DPAPI como CNG,
TPM, HSM o no exportabilidad.

La decisión de arquitectura B está aprobada; no están aprobados los detalles
operativos. No se implementa DPAPI real, acceso a disco, auxiliar .NET, pipe
listener, aprovisionamiento de clave ni activación. Siguen pendientes identidad
Windows dedicada, ACL, despliegue, puente nativo y validación física. La fuente
de confianza del `kid` y la clave pública permanecen independientes de la
privada.

## Estado de implementación del Paso 168.44

**Implementado y probado con dobles:** un contrato de fuente que solo expone
`AlertSigner`, framing de protocolo v1 con límite de longitud, timeout,
correlación por UUID, `kid` y `alg` fijados, digest SHA-256 del signing input,
validación estricta de la entrada JWS y respuesta raw `R || S` de 64 bytes.
La política pura rechaza el SID autenticado si no coincide con el permitido.
La respuesta no admite campos extra; un error de transporte/firmador se
sanitiza y no se reintenta automáticamente. La composición no abre pipes ni
inicia procesos. La autenticación real de SID depende del futuro host de pipe;
no se prueba simulando un SID como si fuera token Windows.

**No implementado/no probado:** llamada `CryptUnprotectData`, lectura de blob
cifrado, importación PKCS#8, auxiliar de firma, named pipe real ni ACL. En el
entorno de trabajo no se encontró `dotnet` ni SDK .NET instalado; no se agregó
ninguna dependencia. Por ello no se creó código C# no compilado ni se afirma
que DPAPI funcione. No se accedió a almacenes Windows ni se cargaron claves.

Antes de habilitar listener, crear un principal local restringido para el
firmador. El proceso de firma debe comprobar el SID del cliente obtenido del
token impersonado/`GetNamedPipeClientProcessId`, rechazar conexiones remotas y
crear la instancia del pipe evitando squatting. La API debe conectarse a un
endpoint fijo, validar la identidad del servidor y no invocar shells. Estos
el listener nativo se implementó posteriormente como una ruta aislada y
condicionada a política independiente; estos controles no se han verificado
físicamente. La entrada normal del programa sigue bloqueada y no abre el
listener.

**Aclaración de ACL M3-B2-CODE (2026-11-08):** por confirmación expresa del
usuario, la DACL del pipe autorizará únicamente el SID individual del firmador
y el SID individual de la API. El firmador conserva `ReadWrite` y
`CreateNewInstance` para crear/usar la instancia; la API recibe `ReadWrite` y
no puede crear instancias. `SYSTEM` queda explícitamente excluido de la DACL del
pipe; su administración de rutas de instalación/política debe gestionarse en
las ACL de esos recursos por separado. Esta aclaración sustituye la mención
anterior de `SYSTEM` como principal con acceso al pipe. No autoriza configurar
ACL, crear cuentas, iniciar el listener ni efectuar pruebas físicas.

## Pruebas y criterios de salida

Antes de activar una fuente real, pruebas locales con dobles deben comprobar:

1. fuente ausente o inicialización fallida => arranque/emisión fail-closed y
   mensajes sin materiales privados;
2. `kid` desconocido, curva/uso incompatible o clave no asociada al registro
   activo => rechazo;
3. firma incorrecta => verificación M2 fallida, rollback de alerta/outbox;
4. bytes exactos de `payloadBytes`, JWS compacto de tres segmentos,
   `alg=ES256`, `kid` confiable y hash calculado sobre ASCII del JWS persistido;
5. emisor y outbox atómicos, sin duplicados, sin inicializar AnchorWorker.

La validación física de DPAPI o CNG solo se hará en una etapa aprobada separada,
con una clave sintética descartable y verificador de interoperabilidad; nunca
con la identidad ni secretos reales de Stellar.

## Referencias técnicas

- [ENM-002, decisión C — Firma digital y confianza](../enmiendas/ENM-002-reduccion-alcance-MVP-4-semanas.md).
- [Arquitectura definitiva v1.2, ADR-08 citado](../arquitectura/SIGA-E_Arquitectura_Definitiva_v1.2.md).
- [Node.js 24 `node:crypto`](https://nodejs.org/docs/latest-v24.x/api/crypto.html): los `KeyObject` son representaciones de claves del subsistema OpenSSL de Node.
- [Node.js 24 Web Crypto](https://nodejs.org/docs/latest-v24.x/api/webcrypto.html): Node implementa la Web Crypto API.
- [Node.js 24 `node:net` IPC](https://nodejs.org/docs/latest-v24.x/api/net.html#ipc-support): admite named pipes en Windows.
- [`jose` v6.2.12 `CompactSign`](https://github.com/panva/jose/blob/v6.2.12/docs/jws/compact/sign/classes/CompactSign.md): firma compacta con `KeyInput`; no documenta callback de operación.
- [`jose` v6.2.12 `KeyInput`](https://github.com/panva/jose/blob/v6.2.12/docs/types/type-aliases/KeyInput.md): `CryptoKey | KeyObject | JWK | Uint8Array`.
- [`jose` v6.2.12 `importPKCS8`](https://github.com/panva/jose/blob/v6.2.12/docs/key/import/functions/importPKCS8.md): importa PEM PKCS#8 como `CryptoKey`.
- [Microsoft `CryptProtectData`](https://learn.microsoft.com/en-us/windows/win32/api/dpapi/nf-dpapi-cryptprotectdata): protección ligada normalmente a credenciales de usuario y al equipo.
- [Microsoft `NCryptSignHash`](https://learn.microsoft.com/en-us/windows/win32/api/ncrypt/nf-ncrypt-ncryptsignhash) y [CNG](https://learn.microsoft.com/en-us/windows/win32/seccng/cng-portal): operación Windows de firma de hashes mediante CNG.
- [Microsoft `BCryptSignHash`](https://learn.microsoft.com/en-us/windows/win32/api/bcrypt/nf-bcrypt-bcryptsignhash): la rutina ECDSA recibe el hash del input original.

## Alcance de la aprobación

La aprobación cubre escoger B para el prototipo y aceptar exposición temporal
de la clave privada en memoria del proceso firmador. No aprueba generar,
importar, aprovisionar o utilizar una clave real, ni configurar identidad/ACL,
activar M3, ni afirmar equivalencia a CNG, TPM o HSM. Esos trabajos requieren
validación y autorización de etapa separada.

## Actualización del Paso 168.46

Se encontró el SDK .NET 10.0.403 instalado fuera de `PATH` y se compiló un
auxiliar `net10.0-windows` en `apps/api/m3-dpapi-signer` sin NuGet externo.
La implementación incluye parsing del protocolo, DPAPI por usuario y firma
ECDSA P-256/P1363, pero no se ejecutó DPAPI ni firma, no se creó una clave ni
se leyó un secreto. El host bloquea toda apertura de listener. La DACL y la
extracción de SID del token impersonado están preparadas en código y siguen
sin comprobación dinámica; faltan identidad autenticada del servidor para el
cliente Node, rechazo de clientes remotos y defensa verificada ante pipe
squatting. Por tanto, esta compilación no acredita seguridad operativa ni
autoriza activar M3. Las frases anteriores de estado del Paso 168.44 sobre
ausencia de SDK y auxiliar describen únicamente aquel momento.

## Actualización del Paso 168.47

Se implementó un adaptador Node de intercambio acotado y cierre obligatorio,
probado con sockets dobles, y un fixture común al parser C# y al cliente
TypeScript. La conexión operativa continúa bloqueada: no existe una atestación
Windows del proceso servidor conectado que pueda imponerse desde Node sin
añadir mecanismos nativos o una autenticación criptográfica del canal. Un PID,
SID propietario del pipe o ruta de ejecutable por sí solos son insuficientes
frente a instancias impostoras. No se agregó un secreto compartido.

La política C# reserva `CreateNewInstance` al SID del servidor, limita a una
instancia y prepara `FILE_FLAG_FIRST_PIPE_INSTANCE` y
`PIPE_REJECT_REMOTE_CLIENTS`. `CurrentUserOnly` no se usa porque anula la DACL
explícita necesaria para identidades Windows distintas. Estas propiedades
solo se inspeccionaron estáticamente; no se abrió ningún named pipe. La
autenticación real del SID cliente, la creación exclusiva, el rechazo remoto,
la identidad del servidor y el cierre del canal requieren pruebas físicas
separadas antes de habilitar M3.

## Actualización del Paso 168.48

El auxiliar ahora contiene un verificador Win32 del servidor asociado al mismo
handle de pipe que se usaría para escribir. Compara PID, SID del token, sesión,
ruta del apphost, hash del `.exe`, hash de la DLL y tiempo de creación contra
una política independiente; mantiene abierto el handle del proceso y repite
las consultas inmediatamente antes de escribir. Las pruebas offline con
dobles cubren suplantación, cambio de handle/PID/proceso y fallos de consulta.
No se abrió un pipe real ni se ejecutó una firma.

No hay todavía una política aprovisionada desde un origen protegido ni un
puente Node→auxiliar que entregue y utilice ese mismo handle. Tampoco se ha
probado físicamente el comportamiento de `GetNamedPipeServerProcessId` sobre
un handle cliente, la ACL de instalación ni la correspondencia entre archivo
hasheado e imagen cargada. Por tanto, la conexión operativa permanece
bloqueada. La ruta y los hashes no pueden tomarse de la conexión ni de un
archivo reemplazable junto con el binario; se requiere aprovisionamiento
independiente y revisión de ACL antes de activarlos.

## Actualización del Paso 168.49

Existe código de puente Node↔cliente C# con el mismo framing v1 en stdin/stdout
y un solo proceso por solicitud. Node comprueba hashes de apphost/DLL antes de
un `spawn` sin shell ni entorno heredado; C# conserva el handle que autentica,
vuelve a comprobar identidad antes de escribir y valida la respuesta. Las
pruebas offline cubren el recorrido con dobles. No se modificó la composición
normal de `server.ts` ni el contrato `LocalAlertSignerSource`.

El modo `--verified-proxy` sigue rechazado por `Program`: aún no existe una
política independiente aprobada ni pruebas físicas de instalación protegida,
token Windows y pipe. La comprobación previa del archivo no impide por sí sola
su sustitución antes de ejecutarlo. El código preparado no constituye
autorización para firmar ni acredita autenticación operativa.

## Actualización del Paso 168.50

Se agregó un preflight independiente al auxiliar .NET: política JSON cerrada
con esquema versionado, SIDs separados para instalador/firmador/API, rutas
segregadas, hashes de apphost/DLL, sesiones, `kid`, ES256 y pipe fijo. La huella
de los bytes de la política debe suministrarse por un canal administrativo
independiente; no se acepta una huella declarada por el propio servidor. El
esquema no incluye configuración operativa ficticia.

El preflight ofrece simulación con fixtures y un modo de solo lectura que se
invoca expresamente. Comprueba hashes, propietarios, DACL protegidas y ACE,
herencia, modificación de binarios/política, aislamiento del directorio DPAPI,
derechos de pipe, rutas y ancestros. ACE desconocidas, grupos efectivos,
identidad/sesión del proceso y ACL real del pipe no verificables permanecen
`NOT_VERIFIED`; el modo físico no abre pipes ni carga DPAPI. Los diagnósticos
no serializan la política ni muestran valores sensibles.

La compilación y autopruebas offline no habilitan M3. `Program` continúa
rechazando `--verified-proxy`; `server.ts` no compone el firmador y el bootstrap
no inicia `AnchorWorker`. La instalación propuesta y el procedimiento de
validación están en
[`apps/api/m3-dpapi-signer/TRUST-PREFLIGHT.md`](../../apps/api/m3-dpapi-signer/TRUST-PREFLIGHT.md).
No se ejecutó el modo físico ni se modificaron cuentas, ACL, servicios,
secretos, claves o registros.

## Enmienda M3-B2 de separación de políticas y fases (Paso 7.61.93)

Esta aclaración aplica únicamente al laboratorio IPC no criptográfico. La
política operativa `InstallationTrustPolicy` y el preflight operativo
conservan íntegros sus campos y garantías, incluidos `allowedKid`, ES256 y
DPAPI. La entrada `--verified-proxy` continúa cerrada con
`M3_SIGNER_DISABLED`.

El laboratorio usa una política experimental separada que describe SIDs,
sesiones, rutas/hashes de los binarios, pipe fijo y restricciones DACL. No
contiene ni implica `kid`, clave, firma o almacén DPAPI. Su huella se aprueba
por canal independiente; `approvalReference` es solo trazabilidad.

La validación se divide en A) preflight estático, sin abrir pipe; y B) pruebas
físicas sujetas a autorización específica. En A, las evidencias que dependen
de una conexión real, tokens de los procesos o lectura de la DACL efectiva del
pipe permanecen `NOT_VERIFIED`, nunca PASS. Ese estado no certifica el control
ni impide solicitar autorización de B después de resolver los bloqueos
estáticos. B no habilita firma ni modifica la decisión de seguridad operativa.
