# Preparación de despliegue académico en Render

Este Blueprint no se ha aplicado. `autoDeployTrigger` está en `off`; no usarlo hasta retirar los bloqueos descritos al final. No contiene credenciales ni conecta con la base local.

## Arquitectura y seguridad

- Un servicio Node sirve `apps/web/dist` y la API bajo el mismo origen. Las rutas SPA desconocidas al API conservan el 404 JSON.
- Render debe terminar TLS; Express confía en un único proxy, redirige HTTP al `APP_ORIGIN` HTTPS y emite CSP, HSTS, `nosniff` y `Referrer-Policy`. La CSP bloquea scripts inline; `style-src 'unsafe-inline'` se mantiene porque React usa estilos inline. Reducirlo requiere una refactorización de UI aparte.
- La cookie de sesión conserva `Secure`, `HttpOnly` y `SameSite=Strict`; las rutas de escritura conservan la comprobación Origin/CSRF. La IP para límites de autenticación procede de Express tras un salto de proxy.
- `DATABASE_URL` pertenece a un rol de aplicación sin permisos DDL. `DIRECT_URL` se usa solo desde una sesión de migración, nunca en el entorno permanente del servicio web.
- M3/firma, M5/Stellar y AnchorWorker no se configuran ni se inician. Las aprobaciones siguen terminando en `READY_TO_SIGN`.
- No se configura migración automática al arrancar.

## Crear recursos cuando se autorice el despliegue

1. Revisar `render.yaml` y crear el servicio web y PostgreSQL administrado en la misma región. Usar un plan persistente; no usar una base gratuita temporal para datos que deban conservarse.
2. Desde el panel de PostgreSQL, obtener la URL interna del usuario `sigae_migrator`. Verificar base, host, región y TLS. No copiarla a Git, al servicio web ni al chat.
3. Crear un rol `sigae_app` con una contraseña nueva y guardar su URL TLS como `DATABASE_URL` del servicio web. Otorgar solo `CONNECT`, `USAGE` en `public` y `SELECT, INSERT, UPDATE` sobre las tablas de aplicación. No otorgar `CREATE`, `DELETE`, `SUPERUSER` ni membresía de roles.
4. Después de aplicar migraciones como propietario, configurar privilegios por defecto para que `sigae_app` reciba `SELECT, INSERT, UPDATE` en las tablas nuevas. Verificar los privilegios efectivos antes de iniciar la API.
5. Configurar `APP_ORIGIN` como el origen HTTPS exacto asignado por Render, sin ruta ni barra final. Configurar `SESSION_SECRET` como Base64URL canónico de al menos 32 bytes y `TOTP_ENCRYPTION_KEY` como Base64URL canónico de exactamente 32 bytes (43 caracteres). No reutilizar credenciales locales.
6. La URL PostgreSQL debe incluir `sslmode=require`. Las variables `DIRECT_URL` y la credencial migradora solo se proporcionan temporalmente al proceso de migración; retirarlas al finalizar.

Con un usuario administrador de la base administrada que pueda crear roles,
ejecutar en la base nueva (reemplazando el marcador de contraseña en una sesión
privada):

```sql
CREATE ROLE sigae_app LOGIN PASSWORD '<contraseña-aleatoria-nueva>';
GRANT CONNECT ON DATABASE sigae_academic TO sigae_app;
GRANT USAGE ON SCHEMA public TO sigae_app;
GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA public TO sigae_app;
ALTER DEFAULT PRIVILEGES FOR ROLE sigae_migrator IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE ON TABLES TO sigae_app;
```

La URL interna administrada para `sigae_migrator` se usa solo en la migración.
El servicio web recibe únicamente la URL interna de `sigae_app`, con
`sslmode=require`.

Generar los dos secretos en una estación de confianza; no guardar la salida en el repositorio:

```powershell
node -e "console.log(require('node:crypto').randomBytes(48).toString('base64url'))"
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"
```

Los nombres de variables que espera el servicio son `NODE_ENV`, `HOST`, `PORT` (inyectada por Render), `DATABASE_URL`, `APP_ORIGIN`, `SESSION_SECRET`, `TOTP_ENCRYPTION_KEY`, `SIGAE_M1_RENDER_ENABLED` y `M1_WRITES_ENABLED`. No establecer `SIGAE_M3_SIGNING_ENABLED`, variables `SIGAE_M5_*` ni `STELLAR_*`.

## Comandos

Render ejecuta, desde la raíz:

```sh
corepack enable
corepack prepare pnpm@12.10.1 --activate
pnpm install --frozen-lockfile
pnpm --filter @siga-e/web build
pnpm --filter @siga-e/api build
pnpm --filter @siga-e/api start
```

Antes del primer arranque, aplicar las cuatro migraciones una sola vez desde un entorno de operador confiable, con `DIRECT_URL` apuntando a la base administrada correcta y con TLS:

```sh
pnpm --filter @siga-e/api exec prisma migrate deploy --config prisma7.config.ts
```

No ejecutar `migrate dev`, `db push`, `reset` ni comandos destructivos en la base Render. Después de verificar la migración y el rol de aplicación, iniciar el servicio. Render asignará la URL HTTPS; establecer ese origen exacto en `APP_ORIGIN`, desplegar manualmente y probar `/`, `/verificar`, `/interno/acceso`, `/interno` y `/interno/administracion`.

## Aprovisionamiento inicial de ADMIN

`pnpm --filter @siga-e/api m1:admin-bootstrap` ejecuta la CLI interactiva de un
solo uso. No hay endpoint HTTP para esta operación. La CLI requiere TTY,
operador de sistema operativo autorizado, ventana de activación de hasta 15
minutos, PostgreSQL TLS, coincidencia exacta de host/base/rol, un marcador
fuera de banda y un rol no privilegiado con solo los permisos DML requeridos.
La propia API rechaza las variables de operador.

Solo después de aplicar y verificar las migraciones y los permisos anteriores:

1. Generar un UUID nuevo para `SIGAE_M1_ADMIN_BOOTSTRAP_TARGET_ID`. Desde una
   sesión privada de `sigae_migrator`, marcar la base exacta:

   ```sql
   COMMENT ON DATABASE sigae_academic IS
     'SIGAE_M1_ADMIN_BOOTSTRAP:<UUID-nuevo>';
   ```

2. En la terminal local del operador autorizado, establecer temporalmente
   `DATABASE_URL` (URL TLS del rol `sigae_app`), `TOTP_ENCRYPTION_KEY`,
   `SIGAE_M1_ADMIN_BOOTSTRAP_ENABLED=true`,
   `SIGAE_M1_ADMIN_BOOTSTRAP_EXPIRES_AT` (UTC ISO-8601, no más de 15 minutos),
   `SIGAE_M1_ADMIN_BOOTSTRAP_DATABASE_HOST`,
   `SIGAE_M1_ADMIN_BOOTSTRAP_DATABASE_NAME`,
   `SIGAE_M1_ADMIN_BOOTSTRAP_DATABASE_USER`,
   `SIGAE_M1_ADMIN_BOOTSTRAP_TARGET_ID` y
   `SIGAE_M1_ALLOWED_OPERATOR` (nombre exacto de la cuenta del sistema
   operativo). No establecer `SIGAE_M1_LAB`, variables Stellar ni variables
   `SIGAE_M5_*`.
3. Ejecutar el comando en una terminal interactiva. Confirmar host y base
   fuera de banda, proporcionar una referencia de autorización registrada,
   nombre/correo ficticios y la contraseña de ADMIN mediante el prompt oculto.
   Escanear el URI de enrolamiento TOTP directamente desde la terminal; no
   copiarlo a archivos, capturas, tickets ni logs. El ADMIN queda
   `PENDING_ENROLLMENT` hasta verificar un TOTP actual. La CLI no crea sesión.
4. Cerrar el proceso y eliminar de la sesión del operador todas las variables
   temporales de activación y conexión. No copiarlas al servicio HTTP. Una
   segunda ejecución se rechaza porque la base ya contiene el marcador de
   bootstrap/usuario inicial.

La CLI no debe ejecutarse hasta que la prueba de integración indicada abajo
haya pasado sobre una base desechable independiente. El bootstrap no se ha
ejecutado en la base de demostración ni en un recurso administrado.

## Bloqueos de publicación

- **Bloqueo del bootstrap:** las pruebas unitarias del perfil y las pruebas
  existentes de provisión pasan, pero no se pudo ejecutar el flujo completo
  contra una instancia PostgreSQL desechable nueva en este entorno. El único
  listener PostgreSQL detectado corresponde a un proceso preexistente y no se
  utilizó. No ejecutar el bootstrap real hasta completar la prueba en una
  base temporal independiente.
- **Bloqueo de publicación del repositorio:** instalación congelada y builds de
  API/frontend pasaron desde una copia temporal que contenía solo 267 entradas
  de build permitidas, sin `.env` ni archivos ignorados. La allowlist GitHub
  más amplia (397 rutas, con pruebas y documentos) aún requiere revisión de
  contenido antes de staging; no hubo `git add`, commit ni push.
- La autenticación, el bloqueo persistente y el MFA se comprobaron previamente
  en una base PostgreSQL desechable; eso no valida un despliegue real dentro
  del proxy/entorno Render. No se ha creado recurso, aplicado Blueprint,
  subido código ni desplegado.
- PS5/PS6 permanecen documentadas como parciales. Esto no sustituye la
  evaluación de seguridad ni habilita un despliegue público.

La URL HTTPS solo se obtiene después de crear y desplegar el servicio autorizado. No hay una URL Render creada para este repositorio en este momento.
