# Prompt 03 — prueba criptográfica local

## Alcance

Esta etapa implementa dos componentes aislados: firma/verificación JWS compacto
ES256 sobre bytes congelados y el contrato local Soroban `AlertRegistry`. No
crea rutas HTTP, claves persistentes, conexiones Neon, cuentas Stellar,
transacciones ni despliegues.

## JWS y confianza

- El firmador recibe `Uint8Array` y no interpreta ni reserializa el JSON.
- La cabecera protegida contiene solamente `alg=ES256` y el `kid` configurado.
- El verificador acepta únicamente tres segmentos compactos y ES256.
- `kid` selecciona una clave pública de un catálogo suministrado explícitamente
  por la aplicación. La cabecera nunca incorpora confianza: `jwk`, `jku`,
  `x5u`, `x5c`, `crit` y cualquier parámetro adicional se rechazan.
- Las claves privadas no se persisten. Las pruebas generan pares efímeros en
  memoria y solo registran resultados, nunca material criptográfico.

## Identificadores binarios

`jws_hash` es `SHA-256(ASCII(jws_compact))` y `message_key` es
`SHA-256(UTF8("SIGA-E-ALERT-ID-v1\n" + sender + "\n" + identifier + "\n" + sent))`.
Ambos resultados son exactamente 32 bytes. Hexadecimal minúsculo es solo una
representación para interfaces y diagnóstico. `sender`, `identifier` y `sent`
rechazan CR/LF; `sent` se usa textualmente, sin normalizar zona horaria ni
formato. El digest de aprobación del payload es otro valor y no se sustituye
por ninguno de estos hashes.

## Contrato y límites

El administrador queda en instance storage y cada par de hashes en persistent
storage. Registrar exige autorización de la dirección administradora y una
segunda escritura para el mismo `message_key` devuelve `AlreadyRegistered` sin
cambiar el valor original. Las lecturas son públicas.

Instance y persistent storage tienen TTL. Las entradas persistentes archivadas
pueden requerir restauración y una Testnet reiniciada puede perder evidencia
práctica. Esta PoC no automatiza extensión/restauración; por ello una consulta
fallida no prueba ausencia histórica y debe reflejarse como `UNVERIFIABLE`.

`cargo test` y `stellar contract build` comprueban lógica y compilación local.
No demuestran despliegue, autorización real de cuenta, confirmación de ledger,
relectura desde RPC ni compatibilidad operativa en Stellar Testnet.

## Versiones y resultado local del 09/10/2026

- `jose 6.2.12`, con API ESM `CompactSign`/`compactVerify`.
- `soroban-sdk 28.0.0`, fijado exactamente; Stellar CLI `28.1.0` satisface la
  regla de que su versión mayor sea igual o superior a la del SDK.
- Node.js `24.21.0`, pnpm `12.10.1`, Rust/Cargo `1.98.1` y target
  `wasm32v1-none`.
- TypeScript: 4 archivos de prueba, 20 casos aprobados; typecheck y build
  aprobados.
- Rust: 5 pruebas aprobadas; `cargo fmt --check` y `clippy -D warnings`
  aprobados.
- Stellar CLI compiló cuatro funciones exportadas en
  `target/wasm32v1-none/release/alert_registry.wasm`: 3.752 bytes y SHA-256
  `1756407675e3cd935b6be8d76cf5b16477645f7a0c6bfd506d613f3cd19f5233`.

La CLI instalada no incluye la característica `additional-libs`, por lo que
informó que omitió su fase adicional de optimización. El WASM se generó y su
ABI se inspeccionó correctamente; queda pendiente optimizarlo antes de un
eventual despliegue autorizado. No se instaló ni actualizó globalmente la CLI.
