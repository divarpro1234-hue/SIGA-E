# ADR-002: Límites del modelo Prisma y nombre de usuarios internos

- **Estado:** Aceptado para `users.name` por instrucción humana del 11/10/2026; referencias de enrolamiento M1 actualizadas documentalmente por ENM-001 y ADR-004 aprobados el 12/10/2026
- **Fecha:** 2026-10-09
- **Etapa:** Prompt 02

**Nota de alcance del MVP (15/10/2026):** El diseño de invitación por QR descrito abajo permanece como antecedente y trabajo futuro. [ENM-002](../enmiendas/ENM-002-reduccion-alcance-MVP-4-semanas.md) permite para la demostración una CLI restringida, todavía sin implementar ni probar, solo sobre PostgreSQL local aislado y nunca Neon. No activa cuentas antes de comprobar TOTP; el primer ADMIN conserva bootstrap de un solo uso, las escrituras sensibles requieren auditoría transaccional y la recuperación excepcional del único ADMIN sigue bloqueada. El contrato HTTP de enrolamiento no cambia.

## Contexto

El modelo relacional de SIGA-E v1.2 define las entidades y atributos obligatorios,
pero algunas garantías cruzan filas, tablas y sistemas externos. Prisma Schema
puede expresar tipos, relaciones, índices y unicidad; no puede demostrar por sí
solo que una lectura final de Soroban ocurrió ni hacer atómica una operación
entre Neon y Stellar Testnet.

`POST /admin/users` recibe `name` en OpenAPI, mientras los diccionarios
relacionales de v1.2 y Prisma no lo incluían. La instrucción humana del
11/10/2026 decide conservarlo como atributo obligatorio de usuarios internos.
La misma operación solo recibe `name`, `email` y `role`; el enrolamiento
seguro posterior aún no tiene intercambio HTTP definido. ADR-003 permite que
`password_hash` y `totp_secret_ciphertext` sean nulos mientras la cuenta no
esté activa.

## Decisiones aplicadas en esta etapa

1. Se añade `users.name` obligatorio a Prisma y a los documentos canónicos.
   La API quita espacios exteriores antes de validar y guardar, exige 1–120
   caracteres y rechaza el vacío. PostgreSQL añade `CHECK` de longitud y de
   ausencia de espacios exteriores. El nombre es dato interno: no aparece
   en alertas públicas ni en el contrato Soroban.
   Al redactarse este ADR, el endpoint de alta seguía sin implementarse por
   falta del contrato de enrolamiento; ADR-004 lo cierra documentalmente,
   sin afirmar implementación.
2. La evidencia blockchain no crea una entidad adicional: se representa con
   `alerts.anchor_status`, `anchor_deployments` y `anchor_jobs`, tal como definen
   los documentos canónicos.
3. Se modelan claves, relaciones, enums, índices y restricciones `UNIQUE` en
   Prisma. Los hashes se almacenan como `bytea`; su longitud de 32 bytes deberá
   reforzarse con `CHECK` SQL en la primera migración aprobada.
4. Las transiciones a `PUBLISHED`, la coincidencia después de releer el contrato,
   la inmutabilidad del JWS, la igualdad de hashes y la prohibición
   autor-aprobador se impondrán en casos de uso transaccionales y pruebas. No se
   declara que el schema Prisma aislado garantice esos hechos.
5. La migración inicial se prepara localmente con `prisma migrate diff`
   desde un modelo vacío y se complementa con `CHECK` SQL revisados. No se
   ejecuta contra Neon hasta recibir una autorización posterior explícita.

## Diseño posterior del alta y enrolamiento TOTP (M1, no implementado)

1. Un ADMIN autenticado con MFA usa `POST /admin/users` para crear **solo** la
   cuenta `PENDING_ENROLLMENT` con `name`, email y rol. El servicio normaliza
   el email y comprueba unicidad; la API no emite ni entrega una invitación
   en esta operación. Después, una CLI local restringida invoca el caso de uso
   M1 autorizado, emite un token aleatorio de 32 bytes y guarda solo su hash
   y caducidad de 24 horas. Tras verificar presencialmente al destinatario,
   muestra un QR generado localmente durante 60 segundos; no guarda QR ni
   registra token o URL. Ocultar el QR no revoca la invitación. La emisión,
   revocación y reemisión son auditadas. Véanse ENM-001 y ADR-004.
2. El destinatario demuestra posesión de la invitación vigente y establece
   su propia contraseña. El backend la transforma con Argon2id y jamás
   persiste ni registra el texto original. Se genera un secreto TOTP único
   en el servidor y se cifra en reposo. Su presentación al usuario ocurre
   solo durante un canal HTTPS autenticado de enrolamiento, con controles
   de caché y sin telemetría sensible.
3. La cuenta se activa únicamente después de verificar un código TOTP válido
   del secreto recién generado. La invitación se consume de forma atómica;
   los desafíos tienen caducidad, límite de intentos y respuesta que evita
   enumeración de usuarios. La sesión operativa se emite solo tras contraseña
   y TOTP correctos. Deshabilitar la cuenta revoca sesiones existentes.
4. ADR-003 define el estado provisional y permite credenciales nulas antes de
   activar la cuenta. ADR-004 especifica el almacenamiento de invitaciones y
   desafíos, las rutas de contraseña/TOTP y el bootstrap excepcional del primer
   ADMIN, sujeto a una **futura migración aditiva** y al servicio de auditoría
   transaccional previo a escrituras críticas. La migración inicial no crea
   cuentas ni inserta credenciales provisionales.

## Consecuencias

- El esquema puede validarse y el cliente puede generarse sin conectarse a Neon.
- Ningún módulo funcional debe escribir directamente con Prisma eludiendo casos
  de uso y repositorios.
- La etapa que cree la primera migración deberá incluir los `CHECK` de longitud,
  el estado singleton de `audit_chain_state` y pruebas de las invariantes
  transaccionales, sin simular ACID distribuido.
