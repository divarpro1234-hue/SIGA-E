# Prompt 04 — punto de control previo a Testnet

Fecha de revisión: 10/10/2026. Estado: pendiente de autorización explícita
para cualquier identidad nueva, financiación Friendbot, despliegue o escritura
en Stellar Testnet.

## Revisión y corrección local

- Se normalizó el nombre del segundo parámetro de `verify_hash` a `jws_hash`,
  conforme a la arquitectura v1.2. No cambió el comportamiento.
- `cargo test --locked`: 5 pruebas aprobadas; `cargo fmt --check` y
  `cargo clippy --all-targets -- -D warnings`: aprobados.
- `pnpm --filter @siga-e/api test`: 20 pruebas aprobadas.
- `stellar contract build --locked`: aprobado; cuatro funciones exportadas.
  `stellar contract info interface --wasm` confirma
  `verify_hash(message_key: BytesN<32>, jws_hash: BytesN<32>) -> bool`.
- WASM local: `contracts/alert-registry/target/wasm32v1-none/release/alert_registry.wasm`,
  3752 bytes, SHA-256
  `90c0f8c2be7a1a3a1d971574fb939cf55cbd6326ff513112198e2fdda18ac66f`.
- La CLI omite optimización adicional porque fue compilada sin `additional-libs`.

## Entorno y resguardo

- Node.js 24.21.0; pnpm 12.10.1; Rust/Cargo 1.98.1; Stellar CLI 28.1.0;
  `soroban-sdk` 28.0.0 y target `wasm32v1-none` instalado.
- `stellar network health --network testnet`: saludable, ledger 5123093 al
  consultar. `stellar network info`: protocolo 29, passphrase
  `Test SDF Network ; September 2015`, URL pública de Friendbot anunciada.
  No se invocó Friendbot.
- `stellar keys ls` lista solamente `deployer`. No se comprobó que sea una
  identidad exclusiva de SIGA-E ni que carezca de fondos reales; no se usará.
- `stellar doctor` informa que `secure-store` está deshabilitado en la CLI
  actual. El servicio de credenciales `VaultSvc` de Windows está activo.
- La CLI utiliza su configuración externa en `D:\CTF-LAB\config\stellar`.
  No se inspeccionó ninguna semilla ni archivo de identidad.
- `git ls-files` no devuelve archivos: aún no hay contenido versionado. Las
  reglas Git ignoran `.env`, `*.pem`, `*.key` y `*.seed`. Una búsqueda de
  patrones de secretos encontró solamente una URL PostgreSQL de marcador de
  posición en `apps/api/test/environment.test.ts`; no se abrió `.env`.
- Los hashes SHA-256 de AGENTS.md, proyecto, arquitectura y OpenAPI siguen
  siendo los registrados al iniciar las etapas anteriores.

## Acciones propuestas tras autorización

1. Tras autorización, instalar una copia aislada de Stellar CLI 28.1.0 con
   `additional-libs` fuera del repositorio, en
   `D:\CTF-LAB\temp\opencode\sigae-stellar-cli`, mediante `cargo install
   --locked stellar-cli --version 28.1.0 --features additional-libs --root
   <DIRECTORIO>`. Usar explícitamente esa copia y comprobar `stellar doctor`
   antes de crear identidades. No reemplazar la CLI global. Si `secure-store`
   no queda disponible, detener la creación.
2. Crear `siga-e-testnet-admin` y `siga-e-testnet-outsider` mediante
   `stellar keys generate <NOMBRE> --network testnet --secure-store`, sin
   mostrar ni copiar secretos. Obtener sus direcciones con
   `stellar keys public-key <NOMBRE>`.
3. Financiar exclusivamente ambas direcciones de prueba mediante
   `stellar keys fund <NOMBRE> --network testnet` (Friendbot). La segunda
   identidad solo se usará para la simulación negativa de autorización.
4. Volver a comprobar el hash local y desplegar ese WASM exacto con
   `stellar contract deploy --wasm <WASM> --optimize=false
   --source-account siga-e-testnet-admin --network testnet -- --admin <G_PUBLICA>`.
   No usar `--alias` para evitar sobrescribir aliases existentes.
5. Confirmar el despliegue con la transacción y la interfaz leída desde el
   contrato real. Registrar contract ID, administrador público, hash WASM,
   transacción y ledger, si la CLI/RPC los devuelve de manera verificable.
6. Crear en memoria una alerta ficticia `Exercise`/`SIMULACRO`, firmarla con
   ES256 efímero, calcular `message_key` y `jws_hash`, y enviar un único
   `register_alert` autorizado. Consultar `get_alert` y `verify_hash` con
   `--send=no`. Verificar la transacción como `SUCCESS` mediante RPC/CLI y
   releer el valor del contrato antes de informar coincidencia.
7. Probar hash incorrecto, duplicado, sobrescritura y la identidad
   `siga-e-testnet-outsider` no autorizada mediante simulaciones `--send=no`
   cuando baste; no enviar fallos conocidos.

Testnet usa XLM de prueba, sin fondos reales. Friendbot no cobra; despliegue y
registro consumen XLM de prueba. Testnet puede reiniciarse y las entradas de
Soroban pueden archivarse por TTL. Un envío pendiente o un hash de transacción
no demuestra confirmación. No se habilitará una publicación de alerta en esta
etapa.

## Decisión pendiente del prompt

La fase 5 solicita una lectura independiente de Neon, mientras la restricción
final prohíbe conectarlo. Se aplica la restricción: esta etapa verificará
directamente el contrato y no afirmará una comparación con Neon. Cualquier
prueba con Neon requiere un cambio o aclaración del alcance aprobado.

No se ha creado identidad, financiado cuenta, desplegado contrato ni enviado
ninguna transacción a Testnet. La evidencia posterior debe distinguir
simulación, transacción confirmada y relectura del contrato.
