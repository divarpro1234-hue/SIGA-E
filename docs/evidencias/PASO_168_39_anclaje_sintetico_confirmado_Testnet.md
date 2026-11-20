# Paso 168.39 — Anclaje sintético confirmado en Stellar Testnet

Esta ficha conserva el resultado público comunicado para una operación sintética `register_alert`. En este paso no se repitió la consulta a Testnet; los datos de resultado proceden del reporte del operador. No corresponden a una alerta real firmada por M3, a un trabajo de AnchorWorker ni a una publicación M4.

| Campo | Valor comunicado |
| --- | --- |
| Red | Stellar Testnet |
| Contrato confiable fijado en backend | `CAQLM6JQLLWCNZ5JSZRQ522VAL34DU2C7HXTLLQU7GXNGNLDLDETQZS5` |
| Transacción | `ea27b5f2bae72f06ea6e894d2128fb9195dd5e81f36f8d4caa9e3549bcdc7a3c` |
| `message_key` | `6ad177a7ad82d2f45b489b3ac3f70498c243ac7948a712bb9ff7209af1500a7d` |
| `jws_hash` | `db4ec1437caae68751001d2f59911111bdd3c7925587bd240aff5efc261c48cd` |
| Resultado | `CONFIRMED`: `getTransaction` en `SUCCESS` y `get_alert(message_key)` coincidente con `jws_hash` |
| Salida de reconciliación | `RECONCILIACION_EXIT_CODE: 0` |

La confirmación exige la lectura coincidente del contrato. Una respuesta `PENDING`, `NOT_FOUND` o `ERROR` de transacción por sí sola no confirma nada. Si una transacción no está indexada, una lectura independiente coincidente puede acreditar un registro preexistente; en ese caso el gateway lo etiqueta `existing_matching_read`, sin atribuirlo a ese hash de transacción ni inventar ledger. Testnet puede reiniciarse y el almacenamiento Soroban puede caducar, por lo que esta evidencia histórica no acredita disponibilidad actual permanente.

El contrato fijado actualmente en `TRUSTED_TESTNET` difiere del contrato de la evidencia histórica `PROMPT_04_despliegue_Testnet.md` (`CBHNE7QTOJEKF3WAHLKBS7UEEY4BGR533PSHLDFCWVVIQOYOEVBJFQWG`). Son hitos de despliegues distintos y sus registros no deben mezclarse. El reporte recibido no incluye ledger, fecha de cierre ni respuesta RPC cruda; esta ficha no los infiere.

## Alcance frente al flujo M4–M5

- El runner manual empleó sus propias aprobaciones humanas y firmante interactivo. No hay evidencia de ejecución por AnchorWorker ni de integración con una fila `Alert`/outbox real.
- La API pública `GET /api/v1/public/alerts`, `GET /api/v1/public/alerts/:id`, `GET /api/v1/public/alerts/:id/anchor`, `GET /api/v1/public/jwks` y `GET /api/v1/public/trust` se sirve desde PostgreSQL. La metadata de anclaje declara `verificationSource: backend_metadata` y `checkedAt: null`; no consulta el gateway Soroban en cada solicitud.
- `/public/trust` obtiene las huellas de claves y el deployment activo de PostgreSQL. `/public/alerts/:id/anchor` obtiene el contrato del deployment asociado al trabajo en PostgreSQL. Estas rutas no contrastan ese contrato con la configuración independiente `TRUSTED_TESTNET`; la suma de una huella autoconsistente en BD y un JWKS servido por la misma API tampoco establece confianza inicial en el navegador.
- `createReadOnlyTestnetGateway` ya existe y compara contrato, red, administrador y WASM con identificadores públicos fijos antes de leer RPC, pero no está conectado a la API pública. `PrismaAnchorWorker` sí valida el deployment de BD contra `TRUSTED_TESTNET` antes de operar, pero no se instancia ni se arranca desde `bootstrap.ts`.
- `bootstrap.ts` construye `PrismaDraftAlertService` con el proveedor de firma M3 en `undefined`. Por tanto, el arranque actual tampoco puede completar la emisión JWS y crear el trabajo outbox de una alerta real, aunque el servicio y sus pruebas aisladas implementen ese camino.
- El firmante Stellar CLI/Secure Store está diseñado para autorización TTY por transacción. No constituye un mecanismo de firma no interactiva para AnchorWorker y su aprobación manual no debe reutilizarse.

El alcance aprobado en ENM-002 mantiene la dimensión blockchain de la PWA en `NO_COMPROBABLE` y asigna el contraste independiente a una CLI externa. El siguiente cambio funcional recomendado es conectar primero un proveedor M3 de firma ES256 restringido al arranque de la API, con pruebas de emisión y creación atómica del outbox, para que exista una alerta real que el worker pueda procesar. Después se requiere un firmante Stellar no interactivo específico del worker, con custodia y autorización acotadas, y pruebas integradas de reconciliación y publicación condicionada antes de habilitarlo. El contrato mostrado por las rutas públicas debe cotejarse contra `TRUSTED_TESTNET` o tratarse únicamente como metadata no confiable. Este paso no habilita el worker ni cambia las rutas públicas.
