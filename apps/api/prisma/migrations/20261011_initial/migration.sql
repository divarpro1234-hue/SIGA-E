-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "UserRole" AS ENUM ('AUTHOR', 'APPROVER', 'ADMIN');

-- CreateEnum
CREATE TYPE "UserStatus" AS ENUM ('PENDING_ENROLLMENT', 'ACTIVE', 'DISABLED');

-- CreateEnum
CREATE TYPE "AlertKind" AS ENUM ('Alert', 'Update', 'Cancel');

-- CreateEnum
CREATE TYPE "Severity" AS ENUM ('Extreme', 'Severe', 'Moderate', 'Minor', 'Unknown');

-- CreateEnum
CREATE TYPE "AlertLifecycleState" AS ENUM ('DRAFT', 'PENDING_APPROVAL', 'REJECTED', 'READY_TO_SIGN', 'SIGNING', 'SIGNED_PENDING_ANCHOR', 'PUBLISHED');

-- CreateEnum
CREATE TYPE "AnchorStatus" AS ENUM ('NOT_REQUESTED', 'PENDING', 'SUBMITTED', 'CONFIRMED', 'RETRYABLE_ERROR', 'CONFLICT', 'UNVERIFIABLE');

-- CreateEnum
CREATE TYPE "ApprovalDecision" AS ENUM ('APPROVED', 'REJECTED');

-- CreateEnum
CREATE TYPE "PublicKeyStatus" AS ENUM ('ACTIVE', 'RETIRED', 'REVOKED');

-- CreateEnum
CREATE TYPE "StellarNetwork" AS ENUM ('testnet');

-- CreateEnum
CREATE TYPE "AnchorDeploymentState" AS ENUM ('ACTIVE', 'RETIRED', 'UNVERIFIABLE');

-- CreateEnum
CREATE TYPE "AnchorJobState" AS ENUM ('PENDING', 'LEASED', 'SUBMITTED', 'RETRYABLE', 'CONFIRMED', 'CONFLICT', 'UNVERIFIABLE');

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "role" "UserRole" NOT NULL,
    "password_hash" TEXT,
    "totp_secret_ciphertext" BYTEA,
    "status" "UserStatus" NOT NULL DEFAULT 'PENDING_ENROLLMENT',
    "failed_attempts" INTEGER NOT NULL DEFAULT 0,
    "locked_until" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sessions" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "token_hash" BYTEA NOT NULL,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "revoked_at" TIMESTAMPTZ(3),
    "last_seen_at" TIMESTAMPTZ(3) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "alerts" (
    "id" UUID NOT NULL,
    "sender" TEXT NOT NULL,
    "identifier" TEXT NOT NULL,
    "sent_text" TEXT NOT NULL,
    "kind" "AlertKind" NOT NULL,
    "severity" "Severity" NOT NULL,
    "lifecycle_state" "AlertLifecycleState" NOT NULL DEFAULT 'DRAFT',
    "anchor_status" "AnchorStatus" NOT NULL DEFAULT 'NOT_REQUESTED',
    "version" INTEGER NOT NULL DEFAULT 1,
    "frozen_payload" BYTEA NOT NULL,
    "payload_sha256" BYTEA NOT NULL,
    "approved_payload_sha256" BYTEA,
    "jws_compact" TEXT,
    "kid" TEXT,
    "message_key" BYTEA,
    "jws_hash" BYTEA,
    "author_id" UUID NOT NULL,
    "published_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "alerts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "alert_references" (
    "id" UUID NOT NULL,
    "alert_id" UUID NOT NULL,
    "ref_sender" TEXT NOT NULL,
    "ref_identifier" TEXT NOT NULL,
    "ref_sent_text" TEXT NOT NULL,

    CONSTRAINT "alert_references_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "approvals" (
    "id" UUID NOT NULL,
    "alert_id" UUID NOT NULL,
    "approver_id" UUID NOT NULL,
    "digest" BYTEA NOT NULL,
    "decision" "ApprovalDecision" NOT NULL,
    "reviewed_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "approvals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public_keys" (
    "kid" TEXT NOT NULL,
    "public_jwk" JSONB NOT NULL,
    "thumbprint" TEXT NOT NULL,
    "status" "PublicKeyStatus" NOT NULL DEFAULT 'ACTIVE',
    "valid_from" TIMESTAMPTZ(3) NOT NULL,
    "retired_at" TIMESTAMPTZ(3),
    "revoked_at" TIMESTAMPTZ(3),

    CONSTRAINT "public_keys_pkey" PRIMARY KEY ("kid")
);

-- CreateTable
CREATE TABLE "anchor_deployments" (
    "id" UUID NOT NULL,
    "network" "StellarNetwork" NOT NULL,
    "network_passphrase" TEXT NOT NULL,
    "contract_id" TEXT NOT NULL,
    "wasm_hash" TEXT NOT NULL,
    "admin_public_address" TEXT NOT NULL,
    "generation" INTEGER NOT NULL,
    "state" "AnchorDeploymentState" NOT NULL DEFAULT 'ACTIVE',
    "deployed_at" TIMESTAMPTZ(3) NOT NULL,
    "trusted_config_version" TEXT NOT NULL,

    CONSTRAINT "anchor_deployments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "anchor_jobs" (
    "id" UUID NOT NULL,
    "alert_id" UUID NOT NULL,
    "deployment_id" UUID NOT NULL,
    "message_key" BYTEA NOT NULL,
    "jws_hash" BYTEA NOT NULL,
    "state" "AnchorJobState" NOT NULL DEFAULT 'PENDING',
    "tx_hash" TEXT,
    "confirmed_ledger" BIGINT,
    "attempt_count" INTEGER NOT NULL DEFAULT 0,
    "next_attempt_at" TIMESTAMPTZ(3),
    "lease_until" TIMESTAMPTZ(3),
    "last_error_code" TEXT,
    "sanitized_error" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "anchor_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_events" (
    "seq" BIGINT NOT NULL,
    "occurred_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "actor_id" UUID,
    "action" TEXT NOT NULL,
    "object_type" TEXT NOT NULL,
    "object_id" TEXT NOT NULL,
    "redacted_details" JSONB NOT NULL,
    "previous_hash" BYTEA NOT NULL,
    "event_hash" BYTEA NOT NULL,

    CONSTRAINT "audit_events_pkey" PRIMARY KEY ("seq")
);

-- CreateTable
CREATE TABLE "audit_chain_state" (
    "id" SMALLINT NOT NULL DEFAULT 1,
    "last_seq" BIGINT NOT NULL,
    "last_hash" BYTEA NOT NULL,

    CONSTRAINT "audit_chain_state_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE INDEX "users_status_idx" ON "users"("status");

-- CreateIndex
CREATE UNIQUE INDEX "sessions_token_hash_key" ON "sessions"("token_hash");

-- CreateIndex
CREATE INDEX "sessions_user_id_expires_at_idx" ON "sessions"("user_id", "expires_at");

-- CreateIndex
CREATE INDEX "sessions_expires_at_revoked_at_idx" ON "sessions"("expires_at", "revoked_at");

-- CreateIndex
CREATE UNIQUE INDEX "alerts_message_key_key" ON "alerts"("message_key");

-- CreateIndex
CREATE UNIQUE INDEX "alerts_jws_hash_key" ON "alerts"("jws_hash");

-- CreateIndex
CREATE INDEX "alerts_author_id_lifecycle_state_idx" ON "alerts"("author_id", "lifecycle_state");

-- CreateIndex
CREATE INDEX "alerts_lifecycle_state_anchor_status_idx" ON "alerts"("lifecycle_state", "anchor_status");

-- CreateIndex
CREATE INDEX "alerts_kind_severity_idx" ON "alerts"("kind", "severity");

-- CreateIndex
CREATE UNIQUE INDEX "alerts_sender_identifier_sent_text_key" ON "alerts"("sender", "identifier", "sent_text");

-- CreateIndex
CREATE INDEX "alert_references_ref_sender_ref_identifier_ref_sent_text_idx" ON "alert_references"("ref_sender", "ref_identifier", "ref_sent_text");

-- CreateIndex
CREATE UNIQUE INDEX "alert_references_alert_id_ref_sender_ref_identifier_ref_sen_key" ON "alert_references"("alert_id", "ref_sender", "ref_identifier", "ref_sent_text");

-- CreateIndex
CREATE INDEX "approvals_alert_id_reviewed_at_idx" ON "approvals"("alert_id", "reviewed_at");

-- CreateIndex
CREATE INDEX "approvals_approver_id_reviewed_at_idx" ON "approvals"("approver_id", "reviewed_at");

-- CreateIndex
CREATE UNIQUE INDEX "public_keys_thumbprint_key" ON "public_keys"("thumbprint");

-- CreateIndex
CREATE INDEX "public_keys_status_valid_from_idx" ON "public_keys"("status", "valid_from");

-- CreateIndex
CREATE INDEX "anchor_deployments_state_generation_idx" ON "anchor_deployments"("state", "generation");

-- CreateIndex
CREATE UNIQUE INDEX "anchor_deployments_network_generation_key" ON "anchor_deployments"("network", "generation");

-- CreateIndex
CREATE UNIQUE INDEX "anchor_deployments_network_contract_id_key" ON "anchor_deployments"("network", "contract_id");

-- CreateIndex
CREATE INDEX "anchor_jobs_state_next_attempt_at_idx" ON "anchor_jobs"("state", "next_attempt_at");

-- CreateIndex
CREATE INDEX "anchor_jobs_lease_until_idx" ON "anchor_jobs"("lease_until");

-- CreateIndex
CREATE INDEX "anchor_jobs_tx_hash_idx" ON "anchor_jobs"("tx_hash");

-- CreateIndex
CREATE UNIQUE INDEX "anchor_jobs_alert_id_deployment_id_key" ON "anchor_jobs"("alert_id", "deployment_id");

-- CreateIndex
CREATE UNIQUE INDEX "anchor_jobs_deployment_id_message_key_key" ON "anchor_jobs"("deployment_id", "message_key");

-- CreateIndex
CREATE INDEX "audit_events_actor_id_occurred_at_idx" ON "audit_events"("actor_id", "occurred_at");

-- CreateIndex
CREATE INDEX "audit_events_object_type_object_id_occurred_at_idx" ON "audit_events"("object_type", "object_id", "occurred_at");

-- AddForeignKey
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "alerts" ADD CONSTRAINT "alerts_author_id_fkey" FOREIGN KEY ("author_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "alerts" ADD CONSTRAINT "alerts_kid_fkey" FOREIGN KEY ("kid") REFERENCES "public_keys"("kid") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "alert_references" ADD CONSTRAINT "alert_references_alert_id_fkey" FOREIGN KEY ("alert_id") REFERENCES "alerts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_alert_id_fkey" FOREIGN KEY ("alert_id") REFERENCES "alerts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_approver_id_fkey" FOREIGN KEY ("approver_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "anchor_jobs" ADD CONSTRAINT "anchor_jobs_alert_id_fkey" FOREIGN KEY ("alert_id") REFERENCES "alerts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "anchor_jobs" ADD CONSTRAINT "anchor_jobs_deployment_id_fkey" FOREIGN KEY ("deployment_id") REFERENCES "anchor_deployments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- Prisma Schema no expresa estos CHECK. Se mantienen en la migración inicial.
ALTER TABLE "users" ADD CONSTRAINT "users_name_length_and_trim" CHECK (char_length("name") BETWEEN 1 AND 120 AND "name" = btrim("name"));
ALTER TABLE "users" ADD CONSTRAINT "users_credentials_consistent" CHECK (("password_hash" IS NULL OR char_length("password_hash") > 0) AND ("totp_secret_ciphertext" IS NULL OR octet_length("totp_secret_ciphertext") > 0) AND ("status" <> 'ACTIVE' OR ("password_hash" IS NOT NULL AND "totp_secret_ciphertext" IS NOT NULL)));
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_token_hash_32_bytes" CHECK (octet_length("token_hash") = 32);
ALTER TABLE "alerts" ADD CONSTRAINT "alerts_payload_sha256_32_bytes" CHECK (octet_length("payload_sha256") = 32);
ALTER TABLE "alerts" ADD CONSTRAINT "alerts_approved_payload_sha256_32_bytes" CHECK ("approved_payload_sha256" IS NULL OR octet_length("approved_payload_sha256") = 32);
ALTER TABLE "alerts" ADD CONSTRAINT "alerts_message_key_32_bytes" CHECK ("message_key" IS NULL OR octet_length("message_key") = 32);
ALTER TABLE "alerts" ADD CONSTRAINT "alerts_jws_hash_32_bytes" CHECK ("jws_hash" IS NULL OR octet_length("jws_hash") = 32);
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_digest_32_bytes" CHECK (octet_length("digest") = 32);
ALTER TABLE "anchor_jobs" ADD CONSTRAINT "anchor_jobs_message_key_32_bytes" CHECK (octet_length("message_key") = 32);
ALTER TABLE "anchor_jobs" ADD CONSTRAINT "anchor_jobs_jws_hash_32_bytes" CHECK (octet_length("jws_hash") = 32);
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_previous_hash_32_bytes" CHECK (octet_length("previous_hash") = 32);
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_event_hash_32_bytes" CHECK (octet_length("event_hash") = 32);
ALTER TABLE "audit_chain_state" ADD CONSTRAINT "audit_chain_state_last_hash_32_bytes" CHECK (octet_length("last_hash") = 32);

ALTER TABLE "audit_chain_state" ADD CONSTRAINT "audit_chain_state_singleton_id" CHECK ("id" = 1);
ALTER TABLE "audit_chain_state" ADD CONSTRAINT "audit_chain_state_last_seq_nonnegative" CHECK ("last_seq" >= 0);
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_seq_positive" CHECK ("seq" > 0);
ALTER TABLE "users" ADD CONSTRAINT "users_failed_attempts_nonnegative" CHECK ("failed_attempts" >= 0);
ALTER TABLE "alerts" ADD CONSTRAINT "alerts_version_positive" CHECK ("version" >= 1);
ALTER TABLE "anchor_deployments" ADD CONSTRAINT "anchor_deployments_generation_positive" CHECK ("generation" >= 1);
ALTER TABLE "anchor_jobs" ADD CONSTRAINT "anchor_jobs_attempt_count_nonnegative" CHECK ("attempt_count" >= 0);
ALTER TABLE "anchor_jobs" ADD CONSTRAINT "anchor_jobs_confirmed_ledger_positive" CHECK ("confirmed_ledger" IS NULL OR "confirmed_ledger" > 0);

CREATE UNIQUE INDEX "users_email_case_insensitive_key" ON "users" (lower("email"));
CREATE UNIQUE INDEX "anchor_deployments_one_active_per_network" ON "anchor_deployments" ("network") WHERE "state" = 'ACTIVE';

-- Cabeza génesis: el servicio debe bloquear esta fila y asignar seq = last_seq + 1
-- en la misma transacción que inserta el evento y actualiza la cabeza.
INSERT INTO "audit_chain_state" ("id", "last_seq", "last_hash") VALUES (1, 0, decode(repeat('00', 32), 'hex'));
