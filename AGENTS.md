# AGENTS.md — SIGA-E · reglas para Codex (v1.2)

## Contexto y fuente de verdad

Proyecto: **SIGA-E**, prototipo académico individual de **Seguridad de la Información** (4 semanas). Se ejecutará en Windows con VS Code, raíz **`D:\Desarrollo\SIGA-E`**. Emisor simulado; todas las alertas son **SIMULACRO**. **Stellar Testnet + Soroban son obligatorios**, no opcionales.

Lee antes de proponer o editar código, en este orden:

1. `docs/proyecto/SIGA-E_Proyecto_Consolidado_v1.2.md` — especificación histórica de base y garantías no desplazadas.
2. `docs/enmiendas/ENM-001-canal-invitaciones-presenciales-M1.md` — decisión previa de invitaciones internas.
3. `docs/enmiendas/ENM-002-reduccion-alcance-MVP-4-semanas.md` — alcance obligatorio vigente del MVP académico; prevalece solo en los puntos de implementación y aceptación que enumera.
4. `docs/proyecto/SIGA-E_Perfil_Academico_MVP_4_Semanas_v2.0.md` — versión de presentación pendiente de aprobación docente.
5. `docs/arquitectura/SIGA-E_Arquitectura_Definitiva_v1.2.md` y los ADR aplicables — contratos e invariantes no desplazados.
6. `docs/arquitectura/SIGA-E_API_OpenAPI_v1.2.yaml` — contrato HTTP de diseño, no prueba de implementación.

El objetivo de desarrollo del MVP es un flujo integrado de una `Alert` crítica `Severe`, aprobada por otra identidad, firmada, anclada y publicada solo tras relectura coincidente; la PWA verifica localmente y una CLI externa contrasta Soroban. `Update`/`Cancel`, recuperación compleja y rotación automática se conservan en diseño y quedan diferidos para el cierre de cuatro semanas. El aprovisionamiento alternativo por CLI se limita a PostgreSQL local aislado y no autoriza cuentas en Neon.

Si los archivos faltan, están incompletos o se contradicen, **señala la diferencia y detente en la parte afectada**. No inventes un requisito ni sobrescribas documentos para hacer que tu solución parezca coherente. Cambios adicionales de alcance/contrato exigen aprobación humana y ADR. `AGENTS.md` guía tu conducta, no prevalece sobre los documentos académicos y sus enmiendas aprobadas.

## Sistema previsto

- Monorepo **pnpm**, backend **Express + TypeScript** como monolito modular, cliente **React + Vite + TypeScript + PWA**. **Neon PostgreSQL + Prisma** solo desde la API.
- `M1` identidad: Argon2id + TOTP obligatorio para **AUTHOR**, **APPROVER** y **ADMIN**; sesiones opacas revocables, cookie HttpOnly y CSRF; roles comprobados por backend.
- `M2` alertas JSON **inspirado en** CAP 1.2, **no** XML CAP conforme. Mensajes `Alert`, `Update`, `Cancel`; versiones congeladas; `Severe` y `Extreme` (y referencias críticas) requieren otro aprobador.
- `M3` **JWS compacto ES256** sobre los bytes exactos del payload congelado; `kid` confiable, clave privada fuera del frontend. Firma local restringida como MVP; **Azure Key Vault no es requisito de estas cuatro semanas**.
- `M4` PWA ciudadana verifica la firma **localmente**. Muestra separadas **firma, vigencia y evidencia blockchain**. Offline no confirma nuevas revocaciones, cancelaciones, resets ni cambios on-chain.
- `M5` auditoría encadenada **con límites** + integración obligatoria Soroban. Contrato `AlertRegistry` Rust en **Stellar Testnet**, `__constructor(admin)`, `admin.require_auth()` para registrar y escritura única `message_key -> jws_hash`. La semilla Stellar es independiente de la clave ES256.
- `M6` pruebas y evidencias **PS1–PS6**, **PB1–PB4**; las métricas **MT1–MT13** de v1.2 se conservan como referencia histórica, sin exigirse como paquete de cierre del MVP; no es un microservicio.

## Invariantes de seguridad que no pueden relajarse

1. Ninguna alerta nueva se muestra `PUBLISHED` en el portal público **hasta** que se haya firmado, confirmado el anclaje y releído del **contrato configurado y confiable** un hash idéntico al del JWS. `sendTransaction`, un hash de transacción o `PENDING` RPC **no** acreditan publicación.
2. `jws_hash = SHA-256(ASCII(jws_compact))` con tres segmentos exactos. `message_key = SHA-256(UTF8("SIGA-E-ALERT-ID-v1\n" + sender + "\n" + identifier + "\n" + sent))` con valores textuales del payload congelado; rechazar saltos de línea en campos. El digest de aprobación es diferente: `SHA-256(payloadBytes)`.
3. El JWS persistido es **inmutable**; actualizaciones/cancelaciones producen mensajes y anclajes nuevos. Los reintentos de Stellar usan el mismo mensaje firmado. Usar outbox/worker y conciliación para fallos de Neon/RPC; nunca simular transacción distribuida ACID.
4. `AlertRegistry`: registrar solo si la cuenta autorizada aprueba con `require_auth`, no sobrescribir ni borrar registros, rechazar duplicados, no aceptar un `contract_id` elegido por el usuario.
5. Testnet puede reiniciarse y el storage de Soroban caducar. Conserva historia de publicación, pero marca evidencia actual como `UNVERIFIABLE`/no comprobable cuando corresponda. No anunciar permanencia ni oficialidad de las alertas.
6. Para verificar ES256, el navegador usa claves públicas de confianza ya establecida. **Nunca** confiar automáticamente en `jwk`/`jku` del JWS ni en un JWKS recién devuelto por un servidor potencialmente comprometido.
7. No publicar información personal, claves, seeds, tokens, cadenas Neon, secretos TOTP, claves privadas ni volcados de `.env` en código, logs, pruebas, capturas, chat o commits. No emplear **Mainnet**, XLM reales ni contratos que custodien fondos.

## Formato de trabajo con Codex

- Trabaja **por etapas pequeñas**. Antes de una etapa, lee el prompt correspondiente. Identifica archivos que pretendes tocar, criterios de aceptación y riesgo de seguridad. No refactorices capas ajenas para "aprovechar".
- En las etapas de implementación: crea pruebas junto a código; valida errores y autorización desde backend; no uses secretos en tests; usa mocks en pruebas unitarias y separa explícitamente pruebas reales de Testnet.
- Cada resultado debe reportar: **qué se hizo, archivos cambiados, comandos/pruebas ejecutados y resultado real, pendientes/bloqueos, siguiente paso**. No afirmar ejecución de pruebas que no se hayan realizado.
- No desplegar, crear recursos facturables, instalar herramientas globales, hacer migraciones destructivas, modificar credenciales, registrar claves o hacer commits/push sin **autorización explícita**.
- Responde y explica **en español**, con nombres de identificadores y comandos en su idioma técnico original.

## Modo especial del Prompt 00: auditoría estrictamente de lectura

En `prompts/00_Diagnostico_Entorno.md`, **solo** se permite leer documentos, comprobar existencia de rutas y ejecutar comandos de **consulta** de versiones/objetivos de compilación. **No crear carpetas, archivos, paquetes, claves, cuentas, contratos o registros; no instalar, actualizar, inicializar Git, conectar a Neon ni publicar transacciones.** Si faltan capacidades o permisos, registra "no comprobado" y solicita la información mínima necesaria. **No abras** `.env`, archivos de claves ni configuraciones con secretos para diagnosticar.
