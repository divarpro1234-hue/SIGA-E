# AlertRegistry

Contrato Soroban mínimo de SIGA-E. Almacena únicamente la relación
`BytesN<32> message_key -> BytesN<32> jws_hash`.

- El constructor guarda una dirección administradora en instance storage.
- `register_alert` exige `admin.require_auth()` y rechaza toda clave ya presente.
- `get_alert` y `verify_hash` son lecturas públicas.
- No existen métodos de edición o borrado y no se guarda contenido de alertas.

La persistencia Soroban tiene TTL y puede archivarse; Testnet también puede
reiniciarse. El contrato no promete permanencia. El mantenimiento/restauración
de TTL y la conciliación se implementarán fuera de esta prueba. Una ausencia o
una consulta imposible debe tratarse como evidencia `UNVERIFIABLE`, nunca como
permiso para sobrescribir ni como confirmación de publicación.

Comprobación local, sin red ni cuenta Stellar:

```powershell
cargo test --manifest-path contracts/alert-registry/Cargo.toml
stellar contract build --manifest-path contracts/alert-registry/Cargo.toml --locked
```
