# Integracion PostgreSQL M5 AnchorWorker

La suite es opt-in y no forma parte del descubrimiento normal de Vitest. Para una
ejecucion autorizada futura, el operador debe provisionar previamente una base
dedicada y aislada con el esquema ya migrado. Este cambio no crea la base, roles,
credenciales ni aplica migraciones.

Perfil admitido por el harness:

- Base: `sigae_m5_anchor_itest`
- Rol: `sigae_m5_itest`
- Endpoint PostgreSQL efectivo: `127.0.0.1:55432`
- Zona horaria: `UTC`
- URL: `SIGAE_M5_POSTGRES_URL`
- URL directa opcional: `SIGAE_M5_POSTGRES_DIRECT_URL`; si existe, debe ser
  exactamente igual a la URL principal.
- Opt-in independiente: `SIGAE_RUN_M5_POSTGRES_ANCHOR=I_ACKNOWLEDGE_M5_ANCHOR_WRITES`

Las URL solo admiten el perfil literal anterior y una contrasena URL sin escapes
ni caracteres reservados. El harness no usa `DATABASE_URL`, `DIRECT_URL`, URLs de
M2/M3 ni carga un archivo de entorno como fallback. No se deben imprimir ni
registrar las URL.

Comando futuro, una vez aprobado y preparada la base:

```powershell
pnpm exec vitest run --config vitest.m5-postgres-anchor.config.ts
```

El harness verifica el destino efectivo en transacciones antes de las escrituras,
rechaza cualquier trabajo activo preexistente y exige que cada invocacion real de
`processNext()` tenga como unico candidato elegible el fixture esperado. La base
debe reservarse exclusivamente para esta suite durante toda la ejecucion; no se
debe apuntar ningun worker o servicio de aplicacion a ella. La suite no borra
fixtures. Una interrupcion puede dejar jobs activos y la suite siguiente abortara
en el preflight; para repetirla se requiere una base M5 nueva provisionada de
forma autorizada, no limpiar o reutilizar filas.
Un advisory lock de sesion impide que dos instancias de esta suite se ejecuten a
la vez; no sustituye la reserva exclusiva de la base frente a servicios ajenos al
harness.

El gateway de estas pruebas es un doble local. Cualquier evidencia de
confirmacion queda marcada como `SIMULACRO_M5_POSTGRES_EVIDENCE` y no acredita
Soroban, Stellar Testnet ni una transaccion real.

Para ejecutar en el futuro se necesitan permisos administrativos aprobados para
provisionar una base y un rol exclusivos, aplicar el esquema vigente y otorgar al
rol de pruebas acceso de conexion y los privilegios de lectura/escritura que
requieren las tablas del backend. No se necesita ni se autoriza acceso a Mainnet,
semillas Stellar o claves blockchain.
