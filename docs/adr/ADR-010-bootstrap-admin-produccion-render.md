# ADR-010: Bootstrap único del ADMIN inicial para Render

- **Estado:** autorización de alcance otorgada explícitamente por el usuario el 2026-11-20 para preparar el aprovisionamiento del primer ADMIN en PostgreSQL administrado de Render.
- **Fecha:** 2026-11-20.
- **Ámbito:** preparación del despliegue académico SIGA-E; no autoriza crear recursos, migrar una base Render, desplegar ni publicar el repositorio.
- **Fuentes relacionadas:** v1.2, ENM-001, ENM-002, ADR-004 y ADR-009.

## Contexto y contradicción de alcance

ENM-002 §4 y ADR-004 limitan actualmente el aprovisionador de cuentas a
PostgreSQL local aislado y declaran que no autorizan crear cuentas en Neon.
Este ADR registra la autorización posterior, expresa y específica del usuario
del 2026-11-20 para implementar un bootstrap operacional del primer ADMIN en
una base PostgreSQL administrada de Render. No cambia el alcance del MVP
académico, no afirma aprobación docente y no habilita la aplicación pública.

## Decisión

Se permite una única operación de inicialización de la identidad ADMIN
mediante una CLI administrativa interactiva ejecutada por un operador local
autorizado. No se expone ruta HTTP. La CLI reutiliza
`LabProvisioningService.bootstrap` y `confirm`, el esquema vigente, Argon2id,
TOTP, la invitación/challenge de uso único y la auditoría transaccional.

La operación solo procede cuando:

1. El operador invoca explícitamente la CLI y confirma en terminal el nombre
   exacto de la base.
2. El operador está en la lista local del sistema operativo; se rechazan CI,
   terminales no interactivos y argumentos que no sean el nombre de la acción.
3. La habilitación tiene un vencimiento canónico, futuro y no mayor a 15
   minutos. La API HTTP rechaza variables del bootstrap.
4. El host y base de `DATABASE_URL` coinciden con la allowlist explícita del
   operador, la conexión PostgreSQL usa TLS y el comentario preexistente de la
   base contiene un UUID de target autorizado.
5. El rol conectado no es superusuario, no crea roles/bases, no hereda roles,
   no puede crear objetos y tiene solo los privilegios DML requeridos para
   completar bootstrap, enrolamiento y auditoría.
6. El esquema existe, la cabeza de auditoría está disponible y no hay usuarios
   ni marcador de bootstrap previo. La transacción del servicio vuelve a
   comprobar la unicidad; una ejecución repetida falla sin crear otro ADMIN.

La cuenta se crea `PENDING_ENROLLMENT`; la contraseña se almacena con Argon2id
y solo se activa cuando el operador confirma un código TOTP generado para el
secreto recién creado. El URI de enrolamiento se muestra una sola vez en una
terminal interactiva; tokens de invitación y enrolamiento permanecen solo en
memoria de la CLI y no se imprimen. No se crea sesión.

La puerta de bootstrap expira al finalizar el proceso y la CLI elimina de su
entorno las variables de habilitación. El marcador persistente `identity_bootstrap`
no se elimina ni restablece. La recuperación de un único ADMIN activo sigue
bloqueada. Si la ejecución se interrumpe después de consumir el marcador, se
requiere revisión humana separada; no se reabre el bootstrap ni se borra el
historial para reintentar.

## Secretos y límites

Contraseña y código TOTP se leen sin eco desde TTY; no se aceptan como
argumentos. El URI TOTP se presenta localmente para enrolamiento y no se escribe
a archivos ni logs. La conexión PostgreSQL se recibe únicamente en una
variable de entorno privada durante la operación, nunca en argumentos,
mensajes de error o logs. La API HTTP no lee ni ejecuta este procedimiento.

La implementación debe probarse exclusivamente en un clúster PostgreSQL
desechable con marker sintético. No se autoriza usar la base de demostración ni
la base administrada de Render durante esta etapa.

## Consecuencias y no objetivos

- Las verificaciones de destino son defensa en profundidad, no sustituyen la
  aprobación de infraestructura ni la verificación humana del recurso creado.
- El nombre de host, base, rol y UUID de marker deben cotejarse fuera de banda
  antes de activar la ventana temporal.
- Este ADR no habilita M3, M5, AnchorWorker, operaciones Stellar, despliegues,
  creación de recursos remotos ni push GitHub.
- La evaluación PS5/PS6 permanece independiente; el bootstrap no cierra M6.
