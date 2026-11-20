-- M1 aditivo. No altera 20261011_initial ni datos existentes.
CREATE TYPE "IdentityChallengeKind" AS ENUM ('ENROLLMENT', 'LOGIN', 'TOTP_RECONFIGURE');

ALTER TABLE "users" ADD COLUMN "last_totp_step" BIGINT;
ALTER TABLE "users" ADD CONSTRAINT "users_last_totp_step_nonnegative" CHECK ("last_totp_step" IS NULL OR "last_totp_step" >= 0);

CREATE TABLE "identity_invitations" (
  "id" UUID NOT NULL,
  "user_id" UUID NOT NULL,
  "token_hash" BYTEA NOT NULL,
  "expires_at" TIMESTAMPTZ(3) NOT NULL,
  "claimed_at" TIMESTAMPTZ(3),
  "consumed_at" TIMESTAMPTZ(3),
  "revoked_at" TIMESTAMPTZ(3),
  "delivery_reported_at" TIMESTAMPTZ(3),
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "created_by" UUID,
  CONSTRAINT "identity_invitations_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "identity_invitations_token_hash_32_bytes" CHECK (octet_length("token_hash") = 32),
  CONSTRAINT "identity_invitations_expires_after_create" CHECK ("expires_at" > "created_at"),
  CONSTRAINT "identity_invitations_claimed_before_consumed" CHECK ("consumed_at" IS NULL OR "claimed_at" IS NOT NULL),
  CONSTRAINT "identity_invitations_terminal_exclusive" CHECK ("consumed_at" IS NULL OR "revoked_at" IS NULL)
);
CREATE UNIQUE INDEX "identity_invitations_token_hash_key" ON "identity_invitations"("token_hash");
CREATE UNIQUE INDEX "identity_invitations_one_open_per_user" ON "identity_invitations"("user_id") WHERE "consumed_at" IS NULL AND "revoked_at" IS NULL;
CREATE INDEX "identity_invitations_user_id_expires_at_idx" ON "identity_invitations"("user_id", "expires_at");
CREATE INDEX "identity_invitations_created_at_idx" ON "identity_invitations"("created_at");
ALTER TABLE "identity_invitations" ADD CONSTRAINT "identity_invitations_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "identity_invitations" ADD CONSTRAINT "identity_invitations_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "identity_challenges" (
  "id" UUID NOT NULL,
  "user_id" UUID NOT NULL,
  "kind" "IdentityChallengeKind" NOT NULL,
  "token_hash" BYTEA NOT NULL,
  "invitation_id" UUID,
  "pending_totp_ciphertext" BYTEA,
  "expires_at" TIMESTAMPTZ(3) NOT NULL,
  "failed_attempts" INTEGER NOT NULL DEFAULT 0,
  "consumed_at" TIMESTAMPTZ(3),
  "revoked_at" TIMESTAMPTZ(3),
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "identity_challenges_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "identity_challenges_token_hash_32_bytes" CHECK (octet_length("token_hash") = 32),
  CONSTRAINT "identity_challenges_failed_attempts_nonnegative" CHECK ("failed_attempts" >= 0),
  CONSTRAINT "identity_challenges_expires_after_create" CHECK ("expires_at" > "created_at"),
  CONSTRAINT "identity_challenges_terminal_exclusive" CHECK ("consumed_at" IS NULL OR "revoked_at" IS NULL),
  CONSTRAINT "identity_challenges_invitation_kind" CHECK (("kind" = 'ENROLLMENT' AND "invitation_id" IS NOT NULL) OR ("kind" <> 'ENROLLMENT' AND "invitation_id" IS NULL)),
  CONSTRAINT "identity_challenges_pending_secret_kind" CHECK ("pending_totp_ciphertext" IS NULL OR ("kind" = 'TOTP_RECONFIGURE' AND octet_length("pending_totp_ciphertext") > 0))
);
CREATE UNIQUE INDEX "identity_challenges_token_hash_key" ON "identity_challenges"("token_hash");
CREATE UNIQUE INDEX "identity_challenges_one_open_per_user_kind" ON "identity_challenges"("user_id", "kind") WHERE "consumed_at" IS NULL AND "revoked_at" IS NULL;
CREATE INDEX "identity_challenges_user_id_kind_expires_at_idx" ON "identity_challenges"("user_id", "kind", "expires_at");
CREATE INDEX "identity_challenges_expires_at_idx" ON "identity_challenges"("expires_at");
ALTER TABLE "identity_challenges" ADD CONSTRAINT "identity_challenges_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "identity_challenges" ADD CONSTRAINT "identity_challenges_invitation_id_fkey" FOREIGN KEY ("invitation_id") REFERENCES "identity_invitations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "identity_bootstrap" (
  "id" SMALLINT NOT NULL DEFAULT 1,
  "consumed_at" TIMESTAMPTZ(3) NOT NULL,
  "initial_admin_id" UUID NOT NULL,
  CONSTRAINT "identity_bootstrap_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "identity_bootstrap_singleton_id" CHECK ("id" = 1)
);
CREATE UNIQUE INDEX "identity_bootstrap_initial_admin_id_key" ON "identity_bootstrap"("initial_admin_id");
ALTER TABLE "identity_bootstrap" ADD CONSTRAINT "identity_bootstrap_initial_admin_id_fkey" FOREIGN KEY ("initial_admin_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "identity_rate_limits" (
  "key_hash" BYTEA NOT NULL,
  "window_start" TIMESTAMPTZ(3) NOT NULL,
  "attempt_count" INTEGER NOT NULL DEFAULT 0,
  "blocked_until" TIMESTAMPTZ(3),
  CONSTRAINT "identity_rate_limits_pkey" PRIMARY KEY ("key_hash", "window_start"),
  CONSTRAINT "identity_rate_limits_key_hash_32_bytes" CHECK (octet_length("key_hash") = 32),
  CONSTRAINT "identity_rate_limits_attempt_count_nonnegative" CHECK ("attempt_count" >= 0)
);
CREATE INDEX "identity_rate_limits_blocked_until_idx" ON "identity_rate_limits"("blocked_until");
CREATE INDEX "identity_rate_limits_window_start_idx" ON "identity_rate_limits"("window_start");
