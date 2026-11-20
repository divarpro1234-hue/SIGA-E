# ADR-001: Responsabilidad y precedencia de las fuentes documentales

- **Estado:** Aceptada
- **Fecha:** 2026-10-09
- **Proyecto:** SIGA-E v1.2

## Contexto

SIGA-E utiliza tres fuentes canónicas con propósitos distintos. Exigir que cada
una repita todo el contenido de las demás crea duplicación y riesgo de deriva,
especialmente en el contrato OpenAPI, cuyo alcance es describir la interfaz
HTTP y no toda la arquitectura interna.

## Decisión

1. `SIGA-E_Proyecto_Consolidado_v1.2.md` define el alcance, los objetivos, las
   garantías y los límites académicos. Tiene la máxima prioridad funcional.
2. `SIGA-E_Arquitectura_Definitiva_v1.2.md` desarrolla la implementación:
   decisiones ADR, componentes, estados, persistencia, seguridad e integración
   con Neon PostgreSQL y Stellar Testnet/Soroban.
3. `SIGA-E_API_OpenAPI_v1.2.yaml` define exclusivamente las interfaces HTTP
   públicas e internas bajo `/api/v1`, incluidos esquemas, autorización,
   respuestas y errores.
4. OpenAPI no necesita enumerar los seis módulos M1–M6 ni repetir proveedores
   de infraestructura como Neon, siempre que sus operaciones y esquemas no
   contradigan el proyecto ni la arquitectura.
5. La ausencia de detalles internos en OpenAPI no relaja ninguna garantía. En
   particular, una alerta nueva solo puede llegar a `PUBLISHED` tras confirmar
   y releer del contrato configurado y confiable un hash idéntico al JWS.

## Consecuencias

- Cada cambio se realiza en la fuente responsable y se propaga a las demás
  únicamente cuando altera su contrato o sus garantías.
- Una contradicción se resuelve respetando primero el documento académico y
  deteniendo la implementación afectada hasta aprobar el cambio documental.
- OpenAPI permanece enfocado y no se considera incompleto por omitir detalles
  de módulos internos o proveedores que no formen parte de la interfaz HTTP.
- Este ADR aclara responsabilidades documentales; no modifica el alcance, el
  contrato HTTP ni los invariantes de seguridad de SIGA-E v1.2.
