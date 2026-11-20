# Paso 6A — Verificación independiente del anclaje en Stellar Testnet

## Resultado

Verificación realizada el **2026-11-04 18:32:29 UTC** mediante consultas RPC de lectura al endpoint fijado en `TRUSTED_TESTNET`. La lectura de `get_alert` devolvió el digest esperado byte a byte. La consulta independiente de la transacción devolvió `SUCCESS`.

No se enviaron transacciones, no se invocó `register_alert` y no se firmó ninguna operación.

## Identidad confiable consultada

| Campo | Valor |
|---|---|
| Red | Stellar Testnet |
| Passphrase esperada y observada | `Test SDF Network ; September 2015` |
| Endpoint | `https://soroban-testnet.stellar.org/` |
| Contract ID | `CAQLM6JQLLWCNZ5JSZRQ522VAL34DU2C7HXTLLQU7GXNGNLDLDETQZS5` |
| Administrador público fijado | `GDTTA7YMMQGV3NZ37VBKIIQAVG5NGLCCVMEBKVPTGAPTPRWH3E2AXNNA` |
| Hash WASM esperado (TRUSTED_TESTNET) | `90c0f8c2be7a1a3a1d971574fb939cf55cbd6326ff513112198e2fdda18ac66f` |
| Hash WASM observado | `90c0f8c2be7a1a3a1d971574fb939cf55cbd6326ff513112198e2fdda18ac66f` |
| WASM coincide | Sí |

La passphrase, contrato y hash WASM observados se contrastaron con la configuración local confiable antes de leer el registro.

## Lectura del registro

| Campo | Valor |
|---|---|
| Método | `get_alert` |
| Message Key | `728996f94d8c5e32198813049d81693c1b2ef80f7a35167e6142763919aa220c` |
| Digest esperado | `4a80d7ae79a234e74e7305636c9bd8c7d2a1971dec68a390bdefce9193f52d4f` |
| Digest observado | `4a80d7ae79a234e74e7305636c9bd8c7d2a1971dec68a390bdefce9193f52d4f` |
| Comparación de los 32 bytes | Coincide |
| Resultado | El registro está presente y su digest coincide |
| Duración observada | 6.519 ms |

## Consulta de transacción

| Campo | Valor |
|---|---|
| Transaction Hash | `24a12b2744ca52c542efffdae276f90d75c89325299f2396ca6b08c3bc6eab9a` |
| Estado RPC | `SUCCESS` |
| Hash devuelto | Coincide con el consultado |
| Ledger devuelto por RPC | `5558619` |
| Duración observada | 175 ms |

El número de ledger se informa porque fue devuelto por RPC; no se infirió a partir de otra fuente. En esta consulta no hubo `NOT_FOUND`, por lo que la limitación de retención no afectó este resultado. La prueba principal de que el digest está registrado es la lectura contractual coincidente, no el estado de la transacción por sí solo.

## Tiempos de las lecturas previas

| Fase | Resultado | Duración |
|---|---|---:|
| NETWORK (`getNetwork`) | Passphrase coincide con Testnet | 6.273 ms |
| WASM (`getContractWasmByContractId`) | Hash coincide con TRUSTED_TESTNET | 5.728 ms |
| CONTRACT_READ (`get_alert`) | Digest coincide | 6.519 ms |
| TRANSACTION_LOOKUP (`getTransaction`) | `SUCCESS` | 175 ms |

## Alcance y bloqueos para el flujo automático

Esta comprobación acredita el estado observado directamente en el contrato durante la consulta; no demuestra que la aplicación lo haya persistido ni que todo el flujo automático esté conectado. Antes de considerar integrado el flujo automático aún se debe:

- acreditar la persistencia del JWS y sus metadatos asociados en PostgreSQL mediante la API y Prisma;
- conectar e iniciar el `PrismaAnchorWorker` con el proveedor RPC confiable, su manejo de outbox, lease y conciliación;
- definir y validar una estrategia operativa de firma del worker que mantenga la clave ES256 fuera del frontend y de los logs;
- verificar que la publicación pública solo refleje `PUBLISHED` después de la relectura RPC coincidente del contrato confiable;
- conservar pruebas y evidencia separadas para fallos de PostgreSQL, RPC, reinicio/caducidad de Testnet y resultados inciertos.

Esta evidencia no afirma permanencia del registro ni oficialidad de la alerta. Testnet y su almacenamiento pueden reiniciarse o caducar.
