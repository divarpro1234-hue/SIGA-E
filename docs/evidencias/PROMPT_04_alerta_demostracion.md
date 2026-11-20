# Prompt 04 — alerta ficticia de demostración

Estado inicial: JWS generado y verificado localmente. El anclaje Testnet se
documentará aparte tras confirmar transacción y lectura del contrato.

- Red prevista: `testnet`
- Leyenda: **SIMULACRO**
- `kid`: `siga-e-testnet-demo-SIGAE-DEMO-20261010135908192`
- `message_key` (hex de 32 bytes): `6b9e0d8853d0c35a8450c13bcc4ea98cc118a0fa531a52481ac378b2ca1695c2`
- `jws_hash` (hex de 32 bytes): `b1921b19f5ac2c7e76f7cd282e92ca4dae3299286800ddcae85100af676cbf14`

## Payload UTF-8 exacto firmado

```json
{"sender":"urn:siga-e:simulacro","identifier":"SIGAE-DEMO-20261010135908192","sent":"2026-10-10T13:59:08.192Z","status":"Exercise","scope":"Public","msgType":"Alert","info":{"category":"Safety","event":"Sismo ficticio","urgency":"Expected","severity":"Minor","certainty":"Possible","headline":"SIMULACRO: sismo ficticio de prueba","description":"Alerta ficticia usada únicamente para validar el anclaje en Stellar Testnet.","areaDesc":"Zona ficticia SIGA-E"}}
```

## Clave pública de prueba

```json
{
  "kty": "EC",
  "x": "544MJVnOiHcubRc0vOTL9v3e95K4DO8X5PK2W1xJJHI",
  "y": "9pOnFSSE8gbKL-VXwrYR_iGzeDv8yXHzFiCwYfeZ1Gw",
  "crv": "P-256"
}
```

La clave privada ES256 fue efímera y solo estuvo en memoria durante la firma;
este archivo no contiene material privado. La clave pública de esta prueba no
se debe tratar como autoridad oficial ni incorporarse automáticamente al
catálogo confiable de producción.

## JWS compacto exacto

```text
eyJhbGciOiJFUzI1NiIsImtpZCI6InNpZ2EtZS10ZXN0bmV0LWRlbW8tU0lHQUUtREVNTy0yMDI2MTAxMDEzNTkwODE5MiJ9.eyJzZW5kZXIiOiJ1cm46c2lnYS1lOnNpbXVsYWNybyIsImlkZW50aWZpZXIiOiJTSUdBRS1ERU1PLTIwMjYxMDEwMTM1OTA4MTkyIiwic2VudCI6IjIwMjYtMTAtMTBUMTM6NTk6MDguMTkyWiIsInN0YXR1cyI6IkV4ZXJjaXNlIiwic2NvcGUiOiJQdWJsaWMiLCJtc2dUeXBlIjoiQWxlcnQiLCJpbmZvIjp7ImNhdGVnb3J5IjoiU2FmZXR5IiwiZXZlbnQiOiJTaXNtbyBmaWN0aWNpbyIsInVyZ2VuY3kiOiJFeHBlY3RlZCIsInNldmVyaXR5IjoiTWlub3IiLCJjZXJ0YWludHkiOiJQb3NzaWJsZSIsImhlYWRsaW5lIjoiU0lNVUxBQ1JPOiBzaXNtbyBmaWN0aWNpbyBkZSBwcnVlYmEiLCJkZXNjcmlwdGlvbiI6IkFsZXJ0YSBmaWN0aWNpYSB1c2FkYSDDum5pY2FtZW50ZSBwYXJhIHZhbGlkYXIgZWwgYW5jbGFqZSBlbiBTdGVsbGFyIFRlc3RuZXQuIiwiYXJlYURlc2MiOiJab25hIGZpY3RpY2lhIFNJR0EtRSJ9fQ._NqY6qCkOPCkJwRG7D_CXv5_EGeDXCkj9uj6U4oeEsd4yB-rF-QdzrHa6U0LgunKJjcxSKipnGGdLp5xhg8tug
```

Se verificó localmente el JWS con esa clave pública y se comprobó que los
bytes recuperados son iguales a los bytes del payload mostrado. El contrato
almacenará solo `message_key -> jws_hash`, nunca este contenido completo.
