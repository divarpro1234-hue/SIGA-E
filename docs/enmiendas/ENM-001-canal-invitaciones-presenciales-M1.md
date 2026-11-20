# ENM-001: Canal presencial de invitaciones M1

- **Estado:** APROBADA documentalmente por instrucción humana del 12/10/2026 (Prompt 06-D).
- **Fecha:** 2026-10-12.
- **Documento afectado:** `docs/proyecto/SIGA-E_Proyecto_Consolidado_v1.2.md`, versión 1.2 del 08/10/2026.
- **Ámbito:** exclusivamente invitaciones de enrolamiento de usuarios internos de M1.
- **Decisión relacionada:** ADR-004, ciclo de identidad y autenticación M1.

**Nota de vigencia del MVP (15/10/2026):** El procedimiento presencial por QR de esta enmienda permanece documentado como decisión histórica y trabajo futuro. [ENM-002](ENM-002-reduccion-alcance-MVP-4-semanas.md) sustituye únicamente su obligatoriedad de cierre para la demostración académica en PostgreSQL local aislado por una CLI restringida, todavía pendiente de implementación y pruebas. La excepción no permite aprovisionar en Neon ni activar una cuenta antes de confirmar TOTP; el primer ADMIN conserva bootstrap de un solo uso, las operaciones sensibles exigen auditoría transaccional y la recuperación excepcional del único ADMIN sigue bloqueada.

## Cláusulas originales conservadas

**§1.5, Exclusiones:**

> No incluye sensores IoT, pronóstico o monitoreo físico, coordinación de rescate, emisión de avisos oficiales, suscripción masiva SMS, aplicación nativa, exportación CAP XML normativa, PKI, firma certificada, custodia de activos, Mainnet, tokenización, criptomonedas reales, contratos de gobernanza, permanencia garantizada del historial blockchain, Azure Key Vault en el núcleo de cuatro semanas, notificaciones push, QR obligatorio, multilingüismo ni garantías de alta disponibilidad.

**§4.7, Funcionalidades diferidas:**

> No son criterios de cierre: código QR, notificaciones push, Azure Key Vault, multilingüismo, panel avanzado de auditoría, renovación totalmente automática de TTL y exportación XML CAP. El anclaje Soroban, su autorización, la reconciliación y la consulta **no son diferibles**.

**§8.1, Priorización y contingencias:**

> Si aparecen retrasos, **posponer** QR, Azure, push, panel complejo, automatizaciones de TTL avanzadas y analíticas. **No eliminar:** MFA, autorización segregada, JWS ES256, contrato Soroban protegido y desplegado, outbox/reconciliación, publicación condicionada, verificación pública con caché, bitácora mínima y pruebas PS/PB. Si Testnet permanece caída, el prototipo muestra trabajos pendientes y se declara incumplido el criterio de publicación hasta restaurar la integración; no se informa éxito ficticio.

## Motivo y decisión normativa

La redacción original usa «QR» sin distinguir finalidad. La decisión humana del 12/10/2026 aprueba la arquitectura M1 de los Prompts 06-A, 06-B y 06-C y elige la **presentación presencial de un QR temporal generado localmente por una CLI administrativa restringida** para entregar invitaciones de enrolamiento. Esta enmienda aclara el alcance de la excepción sin reescribir el documento histórico.

Desde esta enmienda, **el QR de invitación de M1 forma parte obligatoria del procedimiento de seguridad de enrolamiento interno**. `POST /admin/users` crea solo una cuenta `PENDING_ENROLLMENT`; la CLI autorizada emite después un token CSPRNG de 32 bytes, conserva únicamente su hash, construye el QR localmente sin proveedores externos y lo muestra por un máximo de 60 segundos al destinatario cuya identidad se verificó presencialmente. La invitación caduca a las 24 horas, salvo consumo o revocación anterior; ocultar el QR no la revoca. La activación requiere contraseña y TOTP confirmados. El contrato detallado, el bootstrap excepcional, los límites y la auditoría están en ADR-004.

**El QR de verificación ciudadana de M4** para acceder al enlace o paquete de una alerta simulada conserva su carácter opcional/diferible bajo §1.5, §4.7 y §8.1. Esta enmienda no lo convierte en criterio de cierre ni altera la verificación local de firma, vigencia o evidencia blockchain de M4. Cada referencia genérica a «QR» en esas tres cláusulas debe leerse con esta distinción de M1 y M4.

## Impacto, trazabilidad y límites

- El alcance académico agrega un procedimiento presencial de seguridad para M1 dentro de los módulos existentes; requiere operador y destinatario físicamente presentes, además de navegador con acceso HTTPS al frontend SIGA-E. Puede afectar la planificación de la semana 2; se debe reflejar en la arquitectura sin prometer disponibilidad remota.
- Se actualizan ADR-002, ADR-003, ADR-004, arquitectura definitiva v1.2, OpenAPI v1.2 y la evidencia M1 para mantener coherencia. El documento original permanece íntegro como registro histórico.
- El QR no prueba identidad por sí solo ni impide fotografía o copia del token. La verificación presencial, uso único, expiración, revocación y auditoría reducen ese riesgo. La pantalla de 60 segundos limita exposición visual, no la vigencia del token.
- La aprobación es **documental**: no autoriza código, Prisma, migraciones, escrituras en Neon, recursos Stellar ni recuperación excepcional del único ADMIN. Argon2id conserva calibración local pendiente; las escrituras críticas M1 dependen del servicio mínimo de auditoría transaccional.
- No cambian OE1–OE6, los seis módulos, JWS ES256, Soroban/Stellar Testnet ni la política de publicación condicionada.
