# ADR-005: Firma local y evidencia Soroban externa (P4/P8)

- **Estado:** decisión humana registrada en P11 y ratificada para el MVP académico por ENM-002 el 15/10/2026; conciliación documental con proyecto v1.2 y arquitectura v1.2 en revisión.
- **Fecha:** 2026-10-12.
- **Ámbito:** verificación ciudadana y evidencia blockchain; no cambia JWS ni el contrato Soroban.

## Decisión

La PWA usa `@siga-e/verify` para verificar localmente firma ES256, catálogo confiable, política y vigencia de los bytes recibidos. No consulta Soroban. Muestra la dimensión blockchain como `NO_COMPROBABLE` y no infiere registro ni ausencia desde metadatos del backend. `CANCELADA` y `ACTUALIZADA` requieren historial sincronizado de mensajes firmados con referencias verificadas a `(sender, identifier, sent)`; sin él no se afirman ni se descartan.

Una CLI verificadora externa, independiente de este paquete y de la PWA, consultará el `contract_id` y la red configurados por una fuente confiable. Solo podrá concluir `NO_REGISTRADA` tras una lectura confiable que demuestre ausencia de `messageKey` en el deployment aplicable. Un RPC caído, TTL, archivo o reset Testnet producen evidencia no comprobable, no ausencia demostrada. Un registro coincidente prueba únicamente una huella criptográfica contrastable; no demuestra permanencia, veracidad del evento ni oficialidad del emisor.

## Ratificación y conciliación documental del MVP

La [ENM-002](../enmiendas/ENM-002-reduccion-alcance-MVP-4-semanas.md) aprobada documentalmente el 15/10/2026 ratifica esta separación para el MVP y autoriza conciliar las referencias anteriores del proyecto consolidado v1.2 (§5.1 y semana 3) y de la arquitectura v1.2 (§2, §6.3 y §8). La PWA conserva blockchain `NO_COMPROBABLE`; solo la CLI externa podrá concluir coincidencia, discrepancia o `NO_REGISTRADA` tras lectura confiable. Los metadatos de la API no son prueba independiente. Fallo RPC, TTL, archivo o reset no demuestran ausencia. Esta ratificación no acredita implementación de la CLI ni aprobación docente del perfil académico; las garantías no desplazadas de v1.2 continúan vigentes.
