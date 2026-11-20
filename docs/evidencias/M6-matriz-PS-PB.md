# M6 - Matriz de requisitos, amenazas y evidencias

Alcance: cierre documental del MVP academico. Los resultados `PASS` de pruebas
unitarias o de laboratorio no sustituyen una operacion real en Stellar Testnet.

| Requisito | Amenaza | Control implementado | Prueba existente | Resultado / evidencia | Riesgo residual |
|---|---|---|---|---|---|
| PS1 | `kid` ajeno o algoritmo no permitido aceptado como confiable | Catalogo de claves confiable, `alg=ES256` y rechazo fail-closed | Pruebas M3 de confianza/JWS | PASS; pruebas M3 especificas | La activacion operativa del firmador DPAPI aun requiere aprovisionamiento aprobado |
| PS2 | JWS alterado presentado como valido | Verificacion ES256 sobre bytes exactos y rechazo de alteraciones | Pruebas M3 de tamper y verificacion | PASS; pruebas M3 especificas y laboratorio criptografico real | No se ha repetido evidencia de navegador en esta etapa |
| PS3 | Firma vencida o identificador duplicado aceptado | Separacion de firma/vigencia, payload congelado e identificadores inmutables | Pruebas de alertas y firma | PASS; pruebas M1-M3 ya ejecutadas | La demostracion integrada depende de la activacion operativa de M3 |
| PS4 | Autor se autoaprueba o rol incorrecto publica | Autorizacion backend por rol, identidad y transicion de estado | Pruebas de aprobacion y permisos | PASS; pruebas M1/M2 reportadas por el operador | No se repitieron por alcance de esta etapa |
| PS5 | Credenciales/MFA invalidos o sesion revocada reutilizada | Argon2id, TOTP, sesiones revocables y controles de autenticacion | Pruebas de identidad y sesiones | PASS; pruebas M1 reportadas por el operador | No se repitieron por alcance de esta etapa |
| PS6 | Bitacora alterada o confianza excesiva en DBA | Cadena de auditoria, eventos criticos y limite documentado frente a DBA | Pruebas de auditoria y cadena | PASS; pruebas M1/M2 reportadas por el operador | Un DBA con control total de la base sigue siendo una amenaza residual |
| PB1 | Cuenta Stellar no autorizada registra un hash | `require_auth`, admin confiable y deployment Testnet validado | Pruebas de gateway/submitter y PB3 | PASS en pruebas controladas; sin transaccion Testnet ejecutada | Falta evidencia de red real |
| PB2 | Reutilizacion de `messageKey` sobrescribe otro valor | Escritura unica del contrato, reconciliacion por hash y estado de conflicto | Pruebas de worker/gateway | PASS; 130 pruebas M5 especificas | Falta confirmacion real contra el contrato desplegado |
| PB3 | Hash del contrato no coincide con JWS | Relectura confiable de `get_alert`, comparacion exacta y confirmacion solo con `SUCCESS` | Pruebas de worker, gateway y reconciliacion | PASS en pruebas offline; 130 PASS y 3 SKIPPED | Falta lectura de una transaccion real de Testnet |
| PB4 | RPC fallido o transaccion incierta publica falsamente | Estados `SUBMITTED`, `RETRYABLE`, `REVIEW_REQUIRED`, limites de reintento y fail-closed | Pruebas PB3 de fallos, incertidumbre y presupuesto | PASS en pruebas offline; no publica ante incertidumbre | Falta evidencia operacional con RPC y cuenta reales |

## Evidencia y limites

- M5: `130 PASS`, `3 SKIPPED`, `7` archivos de prueba pasados y `1` archivo
  omitido en la ejecucion aislada. No se realizaron escrituras PostgreSQL ni
  llamadas de envio a Stellar.
- El worker exige deployment Testnet confiable, contrato configurado, cuenta
  administrativa coincidente y lectura coincidente de `jws_hash` antes de
  publicar.
- La confirmacion real requiere una cuenta Stellar Testnet autorizada, el
  `contract_id` y `wasmHash` confiables, RPC de Testnet disponible, firmador
  administrativo y autorizacion explicita para enviar la transaccion.
- No se declara confirmacion Stellar real en esta matriz.


## Evidencia de integracion - 18/11/2026

- M1: login con contraseña y MFA completado desde SIGNATURE.
- M2: AUTHOR crea y envia alertas; APPROVER aprueba o rechaza.
- M2: se comprobo tambien la edicion y el reenvio de alertas rechazadas.
- M2: una aprobacion produjo READY_TO_SIGN; no implica firma ni publicacion.
- M4: API publica HTTP 200; proxy HTTP 200; portal HTTP 200.
- M4: consulta real devolvio items=[], total=0; no hay alertas publicadas.
- Frontend: typecheck y build de produccion PASS.
- Git: diff --check de ambos repositorios con codigo de salida 0.
- M3: activacion operativa del firmador DPAPI pendiente de autorizacion.
- M5: pruebas offline documentadas; sin transaccion E2E nueva en Testnet.
- M6: cierre documental parcial; E2E M2-M3-M5-M4 pendiente.
