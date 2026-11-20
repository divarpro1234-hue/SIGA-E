# Composición M3

La API recibe `AlertSigningKeyProvider` por inyección en `createConfiguredApp`.
La emisión está deshabilitada por defecto. Para componerla en una instancia de
prueba se requieren conjuntamente:

- `SIGAE_M3_SIGNING_ENABLED=true`;
- un proveedor implementado e inyectado por quien crea la aplicación;
- una implementación inyectada de `LocalAlertSignerSource` junto con un
  `TrustedPublicKeyCatalog` cuando se usa `startServer`;
- `SESSION_SECRET` y `APP_ORIGIN`, que habilitan las rutas protegidas de M2.

La bandera por sí sola no configura ni carga una clave. Si falta el proveedor o
la configuración de la aplicación, el bootstrap falla antes de crear Prisma.
Un proveedor inyectado sin la bandera explícita también se rechaza. Bootstrap
no invoca `getActiveSigner()` durante el arranque. Las variables heredadas
`JWS_PRIVATE_KEY_PATH` y `JWS_KID` se rechazan: no existe un cargador de claves
seguro que las implemente y no deben aparentar habilitar firma.

`LocalAlertSignerSource` entrega una operación `AlertSigner`, nunca un
`CryptoKey` ni bytes privados. `TrustedAlertSigningKeyProvider` exige que su
`kid` exista en el catálogo confiable antes de devolver el firmante; no confía
en el identificador por el hecho de venir de la fuente. Durante la emisión, M2
vuelve a consultar el registro de claves aprobadas en PostgreSQL y verifica la
firma JWS tanto contra la clave pública activa asociada al `kid` como contra la
clave del catálogo confiable. Si ambas claves no corresponden, la emisión se
revierte. Los errores de inicialización y firma se sustituyen por diagnósticos
sanitizados.

`DpapiIpcAlertSignerSource` y `FramedDpapiSignerExchange` implementan el lado
API del protocolo v1 mediante un canal IPC inyectado. La solicitud transporta
solo `requestId`, `kid`, `alg=ES256`, signing input y su digest SHA-256; la
respuesta permite únicamente esos metadatos de correlación y una firma
`R || S` de 64 bytes. Se validan tamaños, UUID, algoritmo, kid, digest,
respuesta correlacionada, timeout y estructura; no hay reintentos. El protocolo
no transporta claves privadas. `authorizeDpapiSignerRequest` aplica una
política pura de SID de cuenta individual permitido y `kid`; no autentica una
identidad Windows por sí sola. El host debe obtener el SID de un token de
cliente validado y aplicar ACL antes de invocar esa función.

El proyecto `apps/api/m3-dpapi-signer` compila con .NET 10 para Windows sin
paquetes NuGet externos. Implementa el analizador estricto del protocolo v1,
framing big-endian, DPAPI `CryptProtectData`/`CryptUnprotectData` con ámbito
de usuario (sin `CRYPTPROTECT_LOCAL_MACHINE`) y firma ECDSA P-256 en formato
IEEE P1363 `R || S`. Estas rutas criptográficas no se invocaron en esta etapa:
no hay clave aprovisionada, lectura de blob existente ni almacenamiento en disco.
El código limpia las copias administrables de PKCS#8 y buffers nativos cuando
puede; el runtime, el importador ECDSA y la memoria administrada pueden crear
copias adicionales que no se pueden garantizar eliminadas inmediatamente.

El auxiliar permanece deshabilitado: su entrada normal retorna
`M3_SIGNER_DISABLED` y `PipeHost.RunAsync` bloquea el listener. Existe una
implementación separada `RunWithApprovedPolicyAsync`, que solo podría abrir el
pipe con política validada por huella aprobada independientemente, identidad
del proceso verificada y ACL explícita; no está conectada a `Program` ni a la
composición de la API. El puente .NET comprueba la identidad del servidor sobre
el handle conectado; `WindowsDpapiNamedPipeChannel` solo delega en ese puente
cuando se inyecta explícitamente. No hay política operativa aprobada ni
composición en `server.ts`/`bootstrap.ts`; el puente tampoco puede iniciar
`--verified-proxy`, que `Program` mantiene cerrado. SID/token reales, DACL
efectiva, rechazo remoto, pipe squatting, primera instancia y asociación
handle-proceso siguen sin validación física. No se permite conectar ni activar
el transporte hasta completar las pruebas físicas autorizadas.

Para compilar sin consultar fuentes NuGet externas, el proyecto tiene un
`NuGet.Config` local con fuentes vacías. La restauración requiere solo los
reference packs instalados con el SDK .NET 10. En el entorno aislado se fijó
`APPDATA` a `obj/appdata` para evitar leer una configuración NuGet de usuario
inaccesible; no se instaló ningún paquete.

## Paso 168.47: transporte preparado, conexión operativa bloqueada

`BoundedDpapiPipeChannel` implementa una conexión por solicitud con plazo de
3 segundos como máximo. Antes de escribir exige que un verificador inyectado
apruebe la identidad del servidor conectado; limita la solicitud y la respuesta,
reconstruye una única trama big-endian, espera el EOF para rechazar bytes
adicionales, cierra el socket y sanitiza fallos, cortes y timeouts. El
`FramedDpapiSignerExchange` rechaza `requestId` duplicados y se detiene tras
4096 IDs sin reciclar autorizaciones. Un fixture JSON público se valida en
TypeScript y en la autoprueba C#; su firma de ceros es solo dato de protocolo,
no una firma criptográfica.

`WindowsDpapiNamedPipeChannel` sigue rechazando cualquier intercambio antes
de llamar a `net.createConnection`. Node no verifica directamente la identidad
del servidor; el transporte preparado usa `DotnetVerifierBridgeChannel`, que
entrega una trama al auxiliar y requiere que .NET verifique handle, PID, SID,
sesión, ruta/hash del apphost y hash del assembly sobre la misma conexión. La
política no está aprobada ni compuesta y `Program` aún rechaza
`--verified-proxy`; el puente no habilita firma ni está conectado a `server.ts`.

En C#, la DACL prevista concede `ReadWrite | CreateNewInstance` solo al SID
del servidor actual y `ReadWrite` al SID cliente diferente; no concede al
cliente `CreateNewInstance`. El descriptor no hereda ACE. La función nativa de
creación preparada usa `FILE_FLAG_FIRST_PIPE_INSTANCE`,
`PIPE_REJECT_REMOTE_CLIENTS` y una sola instancia. No usa
`PipeOptions.CurrentUserOnly`, que en .NET 10 sustituiría la DACL suministrada.
El SID cliente se obtiene exclusivamente del token impersonado y exige nivel
`Impersonation`. `PipeHost.RunAsync` continúa lanzando
`IPC_LISTENER_NOT_APPROVED`: ni la DACL ni esas banderas se han probado al
abrir un pipe real, y no existe aún autenticación del servidor en Node.

## Paso 168.48: verificación Win32 del servidor preparada

`WindowsServerIdentity.cs` añade un verificador C# para un cliente que posea
el handle conectado. Consulta `GetNamedPipeServerProcessId` sobre ese handle,
abre y conserva el proceso asociado mediante `OpenProcess`, obtiene el SID y la
sesión del token con `OpenProcessToken`/`GetTokenInformation`, consulta la ruta
del ejecutable con `QueryFullProcessImageNameW` y la hora de creación con
`GetProcessTimes`. Compara esos datos y los hashes SHA-256 del apphost `.exe` y
su DLL frente a una política independiente que exige SID, sesión, directorio,
ruta y ambos hashes. Antes de escribir, vuelve a leer identidad y PID sobre
los mismos objetos; rechaza un cambio de handle, proceso o contenido. Los
fallos se convierten en errores sanitizados y cierran ambos handles.

El programa no tiene política de confianza instalada ni un adaptador Node que
delegue la conexión completa al cliente C#. `WindowsDpapiNamedPipeChannel`
sigue bloqueado y `Program` solo admite autopruebas; ninguna solicitud real
puede alcanzar el pipe. La política futura no debe cargarse del JSON del servidor, una variable de
entorno arbitraria ni una ubicación modificable por el usuario que pueda
sustituir simultáneamente binario y hashes. El directorio
de instalación, DLL, apphost y manifiesto aprobado deben estar protegidos por
ACL verificadas y el manifiesto debe proceder de un canal de confianza
independiente. El hash de archivo leído por ruta no demuestra por sí solo qué
imagen está ejecutándose, y `QueryFullProcessImageNameW` de un `dotnet.exe`
genérico no distingue la DLL cargada: la política exige específicamente el
apphost `Sigae.M3.DpapiSigner.exe`. Estos límites impiden declarar autenticación
completa antes de pruebas físicas de la asociación handle-proceso, integridad
de instalación y control de sustitución.

## Paso 168.49: puente Node↔cliente C# preparado

`DotnetVerifierBridgeChannel` acepta la misma trama v1 que
`FramedDpapiSignerExchange`. Exige una política inyectada fuera de las
solicitudes con ruta absoluta del apphost, directorio y hashes esperados de
`.exe` y DLL; lee y compara ambos archivos antes de iniciar un único proceso
con `spawn`, `shell:false`, argumentos fijos, `env:{}` y stdio acotado. Cierra
el proceso ante timeout, aborto, salida distinta de cero o respuesta fuera de
límite. Descarta stderr sin registrarlo. La capa M3 existente vuelve a validar
versión, `requestId`, `kid`, ES256, digest y formato de firma. No hay reintento.

`VerifiedProxyBridge` en C# recibe una sola trama por stdin hasta EOF, la
valida, abre un solo handle cliente mediante una fábrica inyectada, lo pasa a
`VerifiedServerPipe`, comprueba la identidad y el proceso de nuevo antes de
escribir, recibe una trama de respuesta del mismo handle y la valida antes de
escribirla por stdout. Las autopruebas usan streams, procesos y handles falsos.
`Program` **no** invoca `VerifiedProxyBridge` para `--verified-proxy`:
no hay valores aprobados de SID/ruta/hashes ni un canal de aprovisionamiento
protegido, y faltan pruebas físicas de Windows. Por tanto, un intento real de
spawn recibe `M3_SIGNER_DISABLED`; `server.ts` no crea el puente ni habilita M3.

El hash del archivo antes de `spawn` puede sufrir sustitución entre comprobación
y ejecución si el directorio no está protegido. La lectura síncrona del pipe
en el cliente C# aún depende del límite externo del proceso hijo y no ha sido
probada con cancelación física. La política deberá fijarse por un canal
independiente y auditar ACL de instalación, identidad de la imagen ejecutada,
token y comportamiento del handle real antes de abrir el modo operativo.

El arranque de servidor predeterminado no inyecta un proveedor; por ello la
firma real permanece bloqueada hasta que se defina y apruebe una fuente segura
de claves. No se generan claves al arrancar. La emisión existente verifica el
`kid` frente a la clave pública activa, valida el JWS ES256 y persiste la
alerta firmada junto con su trabajo outbox dentro de la misma transacción
Prisma. El bootstrap no inicia ni conecta `AnchorWorker`.

En pruebas, los proveedores y verificadores deben ser dobles locales. Una
serialización JWS sintética sirve para probar la composición y la atomicidad,
pero no acredita una firma criptográfica.

La decisión B (DPAPI de usuario con exposición temporal en memoria) fue
aprobada para el prototipo, no la implementación real ni la activación de M3.
El estado, alternativas y bloqueos están en
`docs/adr/ADR-008-firma-local-m3.md`. El ADR-08 citado por la arquitectura no
está presente en `docs/adr/`; el ADR-008 documenta la discrepancia, sin
modificar el documento canónico.

## Paso 168.50: preflight de instalación y política

El auxiliar .NET incorpora un validador cerrado de política y comprobaciones
offline de ACL/hash con los modos `--preflight-simulated` y
`--preflight-readonly`. El modo físico es explícito, solo lectura y exige la
huella de política obtenida por un canal independiente; no se ejecutó aquí.
Rutas, cuentas y ACL de la instalación son propuestas, no valores aprobados.
Los resultados desconocidos quedan `NOT_VERIFIED`; el pipe real y la
identidad/sesión efectiva siguen sin prueba física.

La herramienta no conecta con el bootstrap de la API. `M3` continúa
deshabilitado y `AnchorWorker` no se inicia. Ver
[`TRUST-PREFLIGHT.md`](../../../m3-dpapi-signer/TRUST-PREFLIGHT.md) para el modelo
de identidades, distribución propuesta, comandos manuales y validación física
pendiente.

## M3-B1: endurecimiento offline del canal

La autorización de cliente y las políticas .NET ahora requieren un SID
canónico de cuenta `S-1-5-21-...-RID`; SIDs bien conocidos y formatos
incompletos se rechazan. El auxiliar mantiene `--verified-proxy` deshabilitado.
La autoprueba usa identidades sintéticas solo para evaluar controles; no abre
Named Pipes ni ejecuta DPAPI o firma.

Validación M3-B1 ejecutada:

- `pnpm exec vitest run test/signing`: 7 archivos, 62 pruebas aprobadas (incluye las 34 pruebas focalizadas del canal/protocolo/puente).
- `pnpm typecheck`: aprobado.
- `dotnet build apps\api\m3-dpapi-signer\Sigae.M3.DpapiSigner.csproj --no-restore`: aprobado, 0 advertencias y 0 errores.
- `dotnet run --no-build --no-restore --project apps\api\m3-dpapi-signer\Sigae.M3.DpapiSigner.csproj -- --self-test`: todas las autopruebas offline aprobadas.
- La misma invocación con `--verified-proxy` respondió `M3_SIGNER_DISABLED` y código 1.

Esto no valida ACL efectiva, tokens/SIDs Windows, rechazo de clientes remotos,
pipe squatting, asociación física handle-proceso ni identidad de la imagen
cargada. Esos controles y la política aprobada independientemente siguen
pendientes de M3-B2; el canal no está compuesto en `server.ts`.

## M3-B2-CODE: implementación offline; activación bloqueada

El puente valida una trama v1 completa y su JSON estricto antes de leer
binarios o iniciar un proceso; también valida la respuesta correlacionada,
incluidas propiedades duplicadas, UTF-8 y firma de 64 bytes. El guard de
`requestId` normaliza mayúsculas para impedir replay del mismo UUID. El wrapper
Windows delega solo a un `DotnetVerifierBridgeChannel` inyectado; si falta el
puente o la plataforma no es Windows, falla cerrado. La ruta normal de
`Program` sigue rechazando `--verified-proxy`.

`PipeHost.RunWithApprovedPolicyAsync` implementa un listener nativo local con
ACL explícita para los SIDs individuales de firmador y API, SID/sesión del
cliente desde token impersonado, rechazo remoto, primera instancia exclusiva,
una conexión y un mensaje por instancia, límites y timeout. La aprobación
explícita de ACL excluye `SYSTEM` del pipe y está registrada en ADR-008 y en
`TRUST-PREFLIGHT.md`. `PipeHost.RunAsync` continúa bloqueado; el listener
preparado no se expone desde `Program`, y no se abrió ningún Named Pipe.

`PipeHostSelfTest` añade comprobaciones offline de política/huella, SID
rechazado, solicitud malformada, cliente y sesión no autorizados, replay,
timeout de lectura y error del callback. El callback de prueba es un doble y
produce bytes sintéticos; no realiza una firma criptográfica.

Validación final ejecutada:

- `pnpm exec vitest run test/signing`: 7 archivos, 66 pruebas aprobadas.
- `pnpm typecheck`: aprobado.
- `dotnet build apps\api\m3-dpapi-signer\Sigae.M3.DpapiSigner.csproj --no-restore`:
  aprobado, 0 advertencias y 0 errores.
- `dotnet run --no-build --no-restore --project apps\api\m3-dpapi-signer\Sigae.M3.DpapiSigner.csproj -- --self-test`:
  aprobadas las autopruebas offline de protocolo, identidad, preflight, PipeHost
  e IPC sintético.
- La misma invocación con `--verified-proxy` produjo `M3_SIGNER_DISABLED` y
  código 1.

No se abrió un pipe, no se aprovisionaron claves y no se ejecutó una firma
criptográfica. Los dobles no acreditan SID/token reales, ACL efectiva, primera
instancia, rechazo remoto, resistencia a squatting ni asociación física del
handle; esos controles siguen pendientes en Windows 10-LAB aislado.
