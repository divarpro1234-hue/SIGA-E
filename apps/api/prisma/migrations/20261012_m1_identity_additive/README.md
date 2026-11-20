# Migración M1 aditiva preparada

Agrega `identity_invitations`, `identity_challenges`, `identity_bootstrap`, `identity_rate_limits` y `users.last_totp_step`. Las restricciones de longitud, singleton, uso único abierto y clase de desafío usan SQL explícito porque Prisma Schema no las representa por completo. Los índices parciales consideran «abierta» una fila sin `consumed_at` ni `revoked_at`; el servicio debe revocar filas caducadas antes de reemitir y comprobar tiempo en cada consumo.

`20261011_initial` no se modifica. `prisma validate` y `prisma generate` comprueban el esquema sin conectar. No se encontró PostgreSQL aislado local ni se aplicó esta migración a ninguna base. Antes de aplicarla, ejecutar pruebas en una base nueva de loopback cuya URL se suministre explícitamente y no proceda de `.env`/Neon; comprobar concurrencia, rollback, FKs, checks e índices parciales. La migración no habilita por sí sola los flujos M1.
