# SIGA-E v1.2 — Evidencia de despliegue de `AlertRegistry` en Stellar Testnet

Fecha: 2026-10-10. Red: **Stellar Testnet**, protocolo 29. Solo se usó el contrato `AlertRegistry`; no se utilizó Mainnet, Neon ni la identidad preexistente `deployer`.

## Artefacto y herramientas

- WASM validado: `contracts/alert-registry/target/wasm32v1-none/release/alert_registry.wasm` (3752 bytes).
- SHA-256 del WASM local y hash del WASM desplegado: `90c0f8c2be7a1a3a1d971574fb939cf55cbd6326ff513112198e2fdda18ac66f`.
- Stellar CLI 28.1.0 aislada en `D:\CTF-LAB\temp\opencode\sigae-stellar-cli\bin\stellar.exe`, compilada desde el paquete oficial con `additional-libs`; la instalación existente y el PATH permanente no se modificaron.
- `stellar doctor` confirmó soporte de **Secure store (OS keyring)** y conectividad Testnet.
- La ABI del WASM local y la del contrato desplegado coinciden, incluidas `__constructor(admin)`, `register_alert(message_key,jws_hash)`, `get_alert(message_key)` y `verify_hash(message_key,jws_hash)`.

## Identidad y contrato públicos

- Identidad administradora exclusiva `siga-e-testnet-admin`: `GDTTA7YMMQGV3NZ37VBKIIQAVG5NGLCCVMEBKVPTGAPTPRWH3E2AXNNA`.
- Creada mediante `keys generate --secure-store`; semilla en el almacén seguro de Windows, nunca impresa ni exportada. Financiación únicamente mediante Friendbot de Testnet; saldo observado: 10000 XLM de prueba.
- Contract ID: `CBHNE7QTOJEKF3WAHLKBS7UEEY4BGR533PSHLDFCWVVIQOYOEVBJFQWG`.

## Transacciones confirmadas

| Acción | Hash de transacción | Ledger | Estado RPC `getTransaction` |
| --- | --- | ---: | --- |
| Carga del WASM | `d4ddba892949e7e05a1c1d15823a70f5711da9416e9c6656213d60463363ab61` | 5123987 | `SUCCESS` |
| Despliegue e inicialización | `0bc98f7f6abd5de3e06dc2c4011d97f28ee242976ae50c0bdeda0ed62c5979fa` | 5123988 | `SUCCESS` |
| Registro autorizado de la alerta de demostración | `bdfc5fd6fa8d15c0bd5c3fd620e5b555805b58c568cbab953b776c8d666da11c` | 5124002 | `SUCCESS` |

## Alerta ficticia y anclaje

El [JWS compacto, payload y JWK pública de demostración](PROMPT_04_alerta_demostracion.md) son públicos. La clave privada ES256 fue temporal y permaneció en memoria; no se conservó. La alerta es `Exercise/SIMULACRO`, de emisor simulado, y no representa una alerta oficial.

- `messageKey`: `6b9e0d8853d0c35a8450c13bcc4ea98cc118a0fa531a52481ac378b2ca1695c2`.
- `jwsHash`: `b1921b19f5ac2c7e76f7cd282e92ca4dae3299286800ddcae85100af676cbf14`.
- Antes de registrar, `get_alert` devolvió `null`.
- Tras la transacción confirmada, `get_alert` devolvió exactamente el `jwsHash` anterior; `verify_hash` devolvió `true` con él y `false` con un hash distinto.
- Una lectura separada del storage persistente del contrato mediante `contract read --key-xdr` devolvió la pareja `messageKey`/`jwsHash` exacta. Entrada creada en el ledger 5124002 y `live_until_ledger` 5244961. La evidencia en Testnet puede caducar o quedar no verificable tras un reset; esto no garantiza permanencia.

## Pruebas negativas sin transacciones de fallo

- Duplicado del mismo `messageKey` y `jwsHash`: simulación `--send=no --no-cache`, rechazado con `HostError: Error(Contract,#1)` (`AlreadyRegistered`).
- Intento de sobrescritura del mismo `messageKey` con hash distinto: simulación `--send=no --no-cache`, rechazado con el mismo error.
- Autorización: se probó una simulación de `register_alert` con un origen ajeno al administrador, pero el modo predeterminado de la CLI **registra hipotéticas autorizaciones** y devolvió `null`; eso **no prueba** un rechazo. El modo `--auth-mode enforce` rechazó la preparación de la transacción por carecer de entradas de autorización previas, antes de simular el contrato. Por tanto, la prueba negativa de autorización sobre este despliegue queda **inconclusa**; no se envió ninguna transacción fallida. La prueba unitaria Soroban de origen no administrador pasó en la validación local previa, pero no sustituye una simulación remota concluyente.

No se hicieron commits automáticos, no se generaron ni almacenaron claves privadas en el repositorio y no se avanzó al Prompt 05. La relectura posterior a las dos simulaciones negativas y la revisión final de Git no pudieron repetirse porque la herramienta de terminal dejó de iniciar procesos al cerrar esta etapa; la lectura previa y la transacción confirmada sí quedaron comprobadas.
