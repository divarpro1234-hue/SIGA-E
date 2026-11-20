# Prompt 05 - Migracion inicial en Neon temporal

## A. Identidad y alcance

Proyecto siga-e; rama test-initial-migration (br-late-bread-b6rl2mw3); endpoint esperado ep-green-frost-b6itfmc0; base siga_e; esquema public. La asociacion rama-endpoint fue verificada visualmente por el usuario. La API administrativa de Neon no fue consultada.

## B. Integridad del SQL

SHA-256 autorizado: 3A5D28D77DD23F9216A3C720C6EEC065507A9A421C7473D5382345D02146765F. SHA-256 local calculado: 3A5D28D77DD23F9216A3C720C6EEC065507A9A421C7473D5382345D02146765F.

## C. Preflight repetido

OK: TLS, endpoint, siga_e, public, PostgreSQL 18; 0 tablas, 0 enums, sin historial; ROLLBACK.

## D. Ejecucion de Prisma

Inicio UTC: 2026-10-12T02:38:16.2890714Z. Fin UTC: 2026-10-12T02:38:27.4923041Z. Migracion: 20261011_initial. Resultado: OK: Prisma migrate deploy finalizo con codigo 0. Codigo de salida: 0.

## E. Catalogos PostgreSQL posteriores

OK: 10 tablas + _prisma_migrations, 11 enums, 9 FK, 21 CHECK, 29 indices, genesis y checksum; ROLLBACK.

Tablas: alert_references, alerts, anchor_deployments, anchor_jobs, approvals, audit_chain_state, audit_events, public_keys, sessions, users

Enums: AlertKind, AlertLifecycleState, AnchorDeploymentState, AnchorJobState, AnchorStatus, ApprovalDecision, PublicKeyStatus, Severity, StellarNetwork, UserRole, UserStatus

Claves foraneas: alert_references_alert_id_fkey, alerts_author_id_fkey, alerts_kid_fkey, anchor_jobs_alert_id_fkey, anchor_jobs_deployment_id_fkey, approvals_alert_id_fkey, approvals_approver_id_fkey, audit_events_actor_id_fkey, sessions_user_id_fkey

CHECK: alerts_approved_payload_sha256_32_bytes, alerts_jws_hash_32_bytes, alerts_message_key_32_bytes, alerts_payload_sha256_32_bytes, alerts_version_positive, anchor_deployments_generation_positive, anchor_jobs_attempt_count_nonnegative, anchor_jobs_confirmed_ledger_positive, anchor_jobs_jws_hash_32_bytes, anchor_jobs_message_key_32_bytes, approvals_digest_32_bytes, audit_chain_state_last_hash_32_bytes, audit_chain_state_last_seq_nonnegative, audit_chain_state_singleton_id, audit_events_event_hash_32_bytes, audit_events_previous_hash_32_bytes, audit_events_seq_positive, sessions_token_hash_32_bytes, users_credentials_consistent, users_failed_attempts_nonnegative, users_name_length_and_trim

Indices explicitos: alert_references_alert_id_ref_sender_ref_identifier_ref_sen_key, alert_references_ref_sender_ref_identifier_ref_sent_text_idx, alerts_author_id_lifecycle_state_idx, alerts_jws_hash_key, alerts_kind_severity_idx, alerts_lifecycle_state_anchor_status_idx, alerts_message_key_key, alerts_sender_identifier_sent_text_key, anchor_deployments_network_contract_id_key, anchor_deployments_network_generation_key, anchor_deployments_one_active_per_network, anchor_deployments_state_generation_idx, anchor_jobs_alert_id_deployment_id_key, anchor_jobs_deployment_id_message_key_key, anchor_jobs_lease_until_idx, anchor_jobs_state_next_attempt_at_idx, anchor_jobs_tx_hash_idx, approvals_alert_id_reviewed_at_idx, approvals_approver_id_reviewed_at_idx, audit_events_actor_id_occurred_at_idx, audit_events_object_type_object_id_occurred_at_idx, public_keys_status_valid_from_idx, public_keys_thumbprint_key, sessions_expires_at_revoked_at_idx, sessions_token_hash_key, sessions_user_id_expires_at_idx, users_email_case_insensitive_key, users_email_key, users_status_idx

## F. Historial de migraciones

Estado previo: OK: una migracion local pendiente; exit code 1 esperado sin historial. Estado posterior: OK: sin migraciones pendientes; exit code 0.

## G. Validaciones locales

OK: Prisma validate, Prisma generate, TypeScript y pruebas existentes.

## H. Inconsistencias y riesgos

Fase alcanzada: validaciones locales. No se verifico la asociacion rama-endpoint mediante API administrativa. Si el despliegue tiene resultado incierto, comprobar _prisma_migrations en PostgreSQL antes de cualquier nuevo intento. No se realizaron reintentos, migrate resolve, db push, migrate reset ni SQL correctivo.

## I. Estado final

**MIGRACION_COMPLETAMENTE_VALIDADA**
