# SIGA-E v1.2

SIGA-E es un prototipo académico individual para emitir y verificar alertas
simuladas. Todas las alertas son **SIMULACRO**. Stellar Testnet y el contrato
Soroban `AlertRegistry` son obligatorios; Mainnet y fondos reales están fuera
del alcance.

Este repositorio contiene el bootstrap del monorepo, la base técnica de la API
y una prueba local aislada de M3/M5: JWS ES256 y `AlertRegistry`. Todavía no
implementa los flujos funcionales completos de los módulos M1–M6.

## Fuentes de verdad

1. `docs/proyecto/SIGA-E_Proyecto_Consolidado_v1.2.md`: alcance, objetivos y
   garantías del proyecto.
2. `docs/arquitectura/SIGA-E_Arquitectura_Definitiva_v1.2.md`: decisiones de
   implementación, estados, datos y seguridad.
3. `docs/arquitectura/SIGA-E_API_OpenAPI_v1.2.yaml`: interfaz HTTP `/api/v1`.
4. `AGENTS.md`: reglas de trabajo para asistentes de desarrollo.

La relación entre estos documentos se formaliza en
`docs/adr/ADR-001-jerarquia-documental.md`.

## Requisitos de desarrollo

- Windows y PowerShell.
- Node.js `>=24.15.0 <25`; entorno validado con Node.js `24.18.0`.
- Corepack; entorno validado con Corepack `0.35.0`.
- pnpm `12.10.1`, fijado mediante `packageManager`.
- Rust, Cargo, Stellar CLI y el target `wasm32v1-none` para etapas posteriores.

## Preparación local

Desde `D:\Desarrollo\SIGA-E`:

```powershell
corepack enable pnpm
pnpm.cmd --version
pnpm.cmd install
pnpm.cmd list --recursive --depth -1
```

Si la Execution Policy impide ejecutar `pnpm.ps1`, usa `pnpm.cmd`. No es
necesario modificar la política global de PowerShell.

`pnpm install` no debe utilizarse todavía para agregar dependencias funcionales.
Las dependencias y lockfiles definitivos se incorporarán en etapas autorizadas.

## Base del backend

La API contiene TypeScript estricto, Express 5, validación de configuración con
Zod y el modelo PostgreSQL de Prisma. El único endpoint habilitado es el health
check previsto por OpenAPI: `GET /api/v1/health`.

Comprobaciones locales, ejecutadas sin conectarse a Neon:

```powershell
pnpm.cmd --filter @siga-e/api prisma:validate
pnpm.cmd --filter @siga-e/api prisma:generate
pnpm.cmd --filter @siga-e/api typecheck
pnpm.cmd --filter @siga-e/api test
pnpm.cmd --filter @siga-e/api build
```

El servidor valida `DATABASE_URL` al iniciar, pero la aplicación base no crea
un cliente Prisma ni abre conexiones automáticamente. No ejecutes comandos de
migración hasta que una etapa posterior los autorice expresamente.

## Estructura inicial

- `apps/web`: futuro cliente React + Vite + TypeScript + PWA.
- `apps/api`: futura API Express + TypeScript, monolito modular.
- `packages/shared`: contratos y utilidades compartidas sin secretos.
- `contracts/alert-registry`: contrato Soroban local de escritura única.
- `tests`: integración, seguridad y E2E.
- `docs/adr` y `docs/evidencias`: decisiones y evidencias saneadas.
- `scripts`: automatización controlada para etapas posteriores.

## Configuración y seguridad

`.env.example` contiene únicamente nombres de variables y valores públicos no
sensibles. Los archivos `.env`, claves, semillas Stellar, secretos TOTP,
cadenas Neon y claves privadas nunca deben entrar en Git, logs o capturas.

Este bootstrap no conecta Neon, no genera claves, no despliega contratos y no
realiza transacciones en Stellar.

## Prueba criptográfica local

La implementación, el modelo de confianza y sus límites están documentados en
`docs/evidencias/PROMPT_03_prueba_criptografica_local.md`.

```powershell
pnpm.cmd --filter @siga-e/api test
pnpm.cmd --filter @siga-e/api typecheck
cargo test --manifest-path contracts/alert-registry/Cargo.toml
stellar contract build --manifest-path contracts/alert-registry/Cargo.toml --locked
```

Estos comandos son locales: no despliegan el contrato ni contactan Testnet.
