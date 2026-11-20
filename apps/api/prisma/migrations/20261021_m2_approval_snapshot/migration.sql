-- M2 / ADR-007. Preparacion aditiva; requiere autorizacion separada para aplicar.
-- Conservar approvals_digest_32_bytes, las claves foraneas y los indices existentes.
-- No inferir versiones, snapshots ni motivos para decisiones historicas.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

LOCK TABLE "public"."approvals" IN ACCESS EXCLUSIVE MODE;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "public"."approvals") THEN
    RAISE EXCEPTION 'M2_HISTORICAL_APPROVALS_REQUIRE_REVIEW';
  END IF;
END;
$$;

ALTER TABLE "public"."approvals"
  ADD COLUMN "alert_version" INTEGER NOT NULL,
  ADD COLUMN "reviewed_payload" BYTEA NOT NULL,
  ADD COLUMN "reason" TEXT,
  ADD CONSTRAINT "approvals_alert_version_positive"
    CHECK ("alert_version" >= 1),
  ADD CONSTRAINT "approvals_reason_by_decision"
    CHECK (
      ("decision" = 'APPROVED' AND "reason" IS NULL)
      OR
      (
        "decision" = 'REJECTED'
        AND "reason" IS NOT NULL
        AND char_length("reason") BETWEEN 3 AND 500
      )
    );

CREATE UNIQUE INDEX "approvals_alert_id_alert_version_key"
  ON "public"."approvals" ("alert_id", "alert_version");

COMMIT;
