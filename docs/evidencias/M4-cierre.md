# M4 — informe de cierre local

**Estado: NO CERRADO.** La separación entre verificación criptográfica y fixtures quedó corregida y pasan build/typecheck/pruebas. No se puede declarar M4 cerrado porque la interfaz mostró una vista vacía al capturar `/` y `/verificar` en Chrome; no se completó el flujo A–H ni la entrada de JWS/archivos desde el formulario visible. La causa exacta de esa vista vacía sigue sin confirmarse.

## Evidencia y resultado

| Funcionalidad | Resultado | Evidencia |
|---|---|---|
| Bandeja pública | PASS | `GET /api/v1/public/alerts?page=1&limit=20` respondió `200`, `Cache-Control: no-store`, `{"items":[],"page":1,"total":0}`. La API solo selecciona alertas `PUBLISHED` con anclaje `CONFIRMED` y evidencia consistente en Testnet; no convierte `READY_TO_SIGN` en publicación. |
| Verificación criptográfica real | PASS en pruebas; PENDIENTE en interfaz | `packages/verify/src/verify.ts` usa `jose.compactVerify` con ES256 y claves confiables; `hashes.ts` usa `crypto.subtle.digest`. Las 37 pruebas incluyen firma válida, payload/cabecera alterados, clave desconocida, vencimiento, revocación y políticas. Las pruebas generan claves de laboratorio efímeras; no usan claves de producción. |
| A–H desde el navegador | FAIL / no ejecutados | Los ocho botones usan `verificadorDemo`, que devuelve valores fijos `SIMULADO`; no ejecuta WebCrypto ni valida JWS. Las pruebas confirman que los ocho resultados se marcan como simulados y no incluyen `kid` ni huella. La ejecución y observación individual de A–H en la interfaz no pudo completarse. |
| Etiquetado de fixtures | PASS en código y pruebas | La interfaz ahora describe cada dimensión como “Escenario de prueba”, aclara que el dato no fue calculado ni comprobado y rotula el contenido como fixture local. El texto de los botones ya no atribuye WebCrypto a la demostración. |
| Entrada JWS y archivos | PENDIENTE en interfaz | El componente acepta `.jws`, `.json` y `.txt`, limita el archivo a 128 KiB, decodifica UTF-8 estrictamente y valida el JWS compacto sin recortarlo. Las pruebas unitarias cubren forma, espacios, controles y tamaño del token; no se pudo probar la selección de archivo ni los mensajes desde el formulario visible. |
| Entradas negativas y contenido hostil | PASS en lógica/pruebas; PENDIENTE en interfaz | El verificador rechaza estructura inválida, firma/payload manipulados, clave desconocida, expiración y claves revocadas. Las pruebas del frontend confirman que etiquetas HTML quedan como texto y que controles/bidi se neutralizan. No se ejecutaron esos casos desde el navegador. |
| Evidencia blockchain | PASS en contrato | La PWA solo representa `NO_COMPROBABLE`; no consulta Stellar. La API no devuelve alertas mientras no haya publicaciones con anclaje confirmado. |
| Recarga, navegación y diseño visual | FAIL | La captura de Chrome mostró una superficie vacía tanto en `/` como en `/verificar`. En observaciones previas el árbol accesible a veces contenía el portal/formulario, discrepancia que impide atribuir el fallo a una causa concreta. No se declara PASS visual. |
| Console y Network | INCONCLUSO | La consola visible solo mostró el aviso informativo de React DevTools; no se observó un error de ejecución, pero la lectura no fue completa. Network registró solicitudes de Vite y del cliente público; la tabla accesible no expuso códigos HTTP de todas ellas. |
| Service Worker/PWA | PASS parcial | En desarrollo, `/sw.js` devuelve `404 text/plain`, `no-store` y `nosniff`; el build de producción generó `sw.js` con 13 recursos. Las pruebas cubren caché, navegación offline y exclusiones de API/SW. En Edge InPrivate no se observó registro; el registro de Chrome no se pudo confirmar. Offline, móvil y limpieza de registros no se probaron visualmente. |
| M3/M5 | PASS — no alterados | M3 y AnchorWorker/M5 permanecen fuera del alcance de los cambios; no se alteraron estados de PostgreSQL ni se inventaron publicaciones. |
| Build, typecheck y pruebas | PASS | `pnpm --filter @siga-e/web build`; `pnpm --filter @siga-e/web test` (220/220); `pnpm --filter @siga-e/verify check` (typecheck y 37/37). |

## Pantalla vacía: diagnóstico

`GET /verificar` devuelve `200 text/html` y `/src/main.tsx` devuelve `200 text/javascript`, ambos con la CSP de desarrollo configurada. `/sw.js` devuelve `404 text/plain`, por lo que Vite no está sirviendo una página HTML como worker en desarrollo. En la consola revisada no apareció un error CSP o de React que explique el blanco. La causa exacta no está demostrada; no se modificaron CSP, router ni registro PWA especulativamente. La discrepancia entre el árbol accesible y la captura visual también deja abierta una limitación del navegador/herramienta de inspección.

## Archivos cambiados para este informe

- `apps/web/src/demo/CasosDemo.tsx`
- `apps/web/src/componentes/BloqueDimension.tsx`
- `apps/web/src/componentes/PanelVerificacion.tsx`
- `apps/web/src/componentes/ContenidoAjeno.tsx`
- `apps/web/src/pantallas/Resultado.tsx`
- `apps/web/src/lib/origen-resultado.mjs`
- `apps/web/src/lib/origen-resultado.test.mjs`
- `docs/evidencias/M4-cierre.md`

No se guardó una captura PNG: la observación visual disponible quedó en la sesión de inspección. Para cerrar M4 siguen pendientes la causa reproducible de la vista vacía, Console/Network completos y la validación visible de A–H, casos negativos, carga de archivos, navegación, offline y móvil.
