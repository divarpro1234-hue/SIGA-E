# ADR-003: Unicidad del JWS, enrolamiento pendiente y actor de auditoría

- **Estado:** Aceptado para la propuesta de esquema y migración inicial por instrucción humana del 11/10/2026; contrato M1 precisado documentalmente por ENM-001 y ADR-004 el 12/10/2026. Su estado histórico de aplicación en Neon no se infiere aquí.
- **Fecha:** 2026-10-11
- **Etapa:** Revisión correctiva previa a la primera migración

**Nota de alcance del MVP (15/10/2026):** La frase histórica «Solo el flujo M1 de invitación y TOTP verificado puede activar» de la decisión 2 se lee, para el MVP académico, junto con [ENM-002](../enmiendas/ENM-002-reduccion-alcance-MVP-4-semanas.md): una CLI restringida podrá aprovisionar cuentas de demostración exclusivamente en PostgreSQL local aislado, sin ruta de activación pública ni acceso a Neon. `ACTIVE` y la sesión operativa siguen prohibidos antes de confirmar TOTP. El primer ADMIN mantiene bootstrap de un solo uso, auditoría transaccional y prohibición de recuperación excepcional. La CLI continúa pendiente de implementación y pruebas; la vía de invitación se conserva en diseño.

## Contexto

La primera migración todavía no se ha aplicado. La revisión humana pide
reemplazar la unicidad directa del texto JWS por la de su hash de 32 bytes,
impedir acceso de cuentas aún no enroladas y conservar el actor de eventos
históricos. La fila de control de la cadena auditora carecía de inicialización
y `BIGSERIAL` podía crear saltos al abortar una transacción.

## Decisiones

1. `alerts.jws_compact` sigue siendo nullable e inmutable tras firmar, sin
   índice único. `alerts.jws_hash` es `bytea` nullable con índice único y
   `CHECK (octet_length(jws_hash)=32)` para valores no nulos. El servicio
   conserva el cálculo `SHA-256(ASCII(jws_compact))`, verifica los tres
   segmentos exactos y no reserializa ni reemplaza el JWS persistido.
2. `users.status` inicia en `PENDING_ENROLLMENT`. `password_hash` y
   `totp_secret_ciphertext` admiten `NULL` mientras la invitación y el
   enrolamiento no estén completos; se prohíben valores vacíos y la BD exige
   ambos para `ACTIVE`. Esta nulabilidad no autoriza login: la API debe exigir
   `ACTIVE` al autenticar y en **cada** petición interna, además de MFA,
   rol, sesión y CSRF. Solo el flujo M1 de invitación y TOTP verificado puede
   activar. `PATCH /admin/users/{id}/status` solo acepta `DISABLED` y revoca
   sesiones; no existe activación administrativa directa.
3. El token de invitación será aleatorio, corto en vigencia, de uso único y
   guardado por hash. ENM-001 y ADR-004 precisan posteriormente su entrega
   presencial mediante QR local temporal y CLI restringida, la persistencia
   de invitaciones/desafíos, los límites de intentos y las rutas de
   contraseña/TOTP. El servicio debe consumir la invitación y activar la
   cuenta de modo transaccional tras verificar el TOTP. La migración inicial
   no introduce una tabla de invitaciones ni implementa M1.
4. `audit_events.actor_id` permanece nullable para eventos del sistema, pero
   su FK usa `ON DELETE RESTRICT ON UPDATE RESTRICT`. Un identificador de
   usuario que ya consta como actor no puede cambiar sin invalidar la
   atribución histórica; las cuentas históricas se deshabilitan, no se
   eliminan. Esto es compatible con las demás FKs hacia `users`, que
   restringen el borrado. La actualización del identificador de un usuario
   con eventos de auditoría queda impedida aunque otras relaciones admitan
   `ON UPDATE CASCADE`. `audit_chain_state` recibe una única fila
   génesis `(1,0,32 bytes cero)` en la migración. El servicio futuro bloquea
   esa fila, asigna `seq=last_seq+1`, inserta el evento y actualiza la cabeza
   en una transacción. `audit_events.seq` ya no usa `BIGSERIAL` y su
   `CHECK (seq > 0)` impide números de evento no positivos.

## Garantías y límites

- La unicidad del hash no sustituye la comprobación de su cálculo ni prueba
  que el anclaje Soroban esté confirmado.
- El `CHECK` de credenciales solo impide `ACTIVE` con campos nulos o vacíos;
  no demuestra Argon2id, cifrado ni TOTP verificado. Esas garantías dependen
  de M1 y sus pruebas. No se pueden prohibir sesiones de pendientes mediante
  un `CHECK` que abarque `users` y `sessions`; el servicio debe aplicarlo.
- La fila génesis permite iniciar la cadena local, pero un DBA puede
  reconstruirla. No se declara inmutabilidad externa.
- El cambio concreta controles técnicos de M1/M5 sin eliminar el TOTP
  obligatorio ni alterar el alcance académico. Las rutas de enrolamiento y
  cualquier mecanismo de rehabilitación se revisaron documentalmente en
  ADR-004 y OpenAPI v1.2; su implementación sigue pendiente. El bootstrap
  excepcional del primer ADMIN es local y de un solo uso; la recuperación
  del único ADMIN permanece bloqueada. La auditoría transaccional debe
  existir antes de habilitar escrituras críticas M1.
