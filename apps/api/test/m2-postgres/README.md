# Harness PostgreSQL M2: `submit`

Este perfil es opt-in y escribe solo en el laboratorio local `sigae_m2_submit_itest`.
Requiere `SIGAE_RUN_M2_POSTGRES_SUBMIT=I_ACKNOWLEDGE_M2_WRITES`, `DATABASE_URL`
validada por `validateM2IntegrationDatabase` y `DIRECT_URL` ausente o idéntica.
No carga `.env`. La configuración dedicada descubre únicamente `*.m2pg.ts`;
la suite habitual de Vitest no descubre este archivo. Importarlo no conecta.

La validación de URL precede a construir ambos clientes. Cada transacción
verifica en su conexión efectiva base, rol, dirección, puerto y `TimeZone`
antes de cualquier escritura. El guard de URL fija el destino configurado por
el cliente en `127.0.0.1:55432`; `inet_server_addr()` e `inet_server_port()`
informan el extremo del servidor PostgreSQL, que puede ser distinto si hay
redirección de puertos. Este harness exige también `127.0.0.1:55432` en ese
extremo: una redirección legítima falla cerrada hasta documentar su topología
y aprobar una política alternativa. No se infiere la topología de la URL.
El servicio recibe un cliente real cuya entrada
`$transaction` antepone esa comprobación dentro de la misma transacción.
El segundo cliente observa el resultado del rollback. No se usa Neon ni
se consulta Testnet. El guard limita el destino, pero no prueba aislamiento
completo de privilegios PostgreSQL: el rol M2 todavía hereda CONNECT sobre M1
por PUBLIC. Este harness no modifica esos permisos.

Cada caso crea un autor y una sesión sintéticos nuevos. Los campos de usuario
exigidos por el esquema contienen valores de relleno no aptos para login.
La sesión permite probar el servicio y **no acredita MFA real**. Los textos
son SIMULACRO, el correo usa `example.invalid` y se genera un UUID de ejecución.
El reporte emite solo UUID y clasificación de resultado; no imprime tokens,
contraseñas, cookies ni URL. No hay limpieza automática: usuarios, sesiones,
alertas y eventos de auditoría se conservan para revisión. La eliminación
del laboratorio exige autorización independiente. No ejecutar contra una base
con datos históricos o credenciales reales.

En B y C una barrera de lectura antes del bloqueo del autor acredita que las
dos transacciones han entrado en PostgreSQL antes de continuar. Ambas usan el
mismo autor; el servicio bloquea su fila antes de leer la alerta. Por ello las
pruebas comprueban intercalación serializada y un único resultado, **no** una
carrera demostrada en el CAS de la alerta. Acreditar ese solapamiento exigiría
otra interfaz o instrumentación productiva, fuera de este paso. La barrera
tiene un plazo de fallo y no se mantiene dentro de un bloqueo de escritura.
El código público `STALE_ALERT_VERSION` puede corresponder a CAS o a `P2034`;
el harness informa `P2034` solo si lo observó antes de la traducción del servicio.

A compara los bytes antes y después del submit con el serializador contractual
y calcula por separado SHA-256. Los casos de escritura verifican la continuidad
del tramo nuevo de auditoría desde la cabeza previa, incluidos secuencia,
`previous_hash`, hash recalculado y cabeza final. No validan ni reparan eventos
históricos anteriores a esa cabeza. D exige una señal activada únicamente tras
la actualización real de `audit_chain_state` dentro de la transacción, y otra
conexión comprueba que la operación fallida no dejó cambios. E usa un reloj
controlado desde la creación y un submit de control con expiración posterior:
la entrada vencida es válida antes de su plazo y se rechaza después. E no
demuestra vigencia hasta el instante físico de COMMIT.

Comando para una **etapa posterior autorizada**, desde `apps/api` (no ejecutado):

```powershell
$env:SIGAE_RUN_M2_POSTGRES_SUBMIT = 'I_ACKNOWLEDGE_M2_WRITES'
pnpm exec vitest run --config vitest.m2-postgres.config.ts
```
