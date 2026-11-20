-- SIGA-E / M5 / PB3
-- Limite de fallos automaticos del worker.
-- Migracion aditiva: conserva los registros existentes.
-- NO EJECUTAR sin validar primero una BD de laboratorio aislada.

ALTER TYPE "AnchorJobState" ADD VALUE 'FAILED';

ALTER TYPE "AnchorJobState" ADD VALUE 'REVIEW_REQUIRED';

ALTER TYPE "AnchorStatus" ADD VALUE 'FAILED';

ALTER TYPE "AnchorStatus" ADD VALUE 'REVIEW_REQUIRED';

ALTER TABLE "anchor_jobs"
    ADD COLUMN "automatic_failure_count" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "anchor_jobs"
    ADD CONSTRAINT "anchor_jobs_automatic_failure_count_nonnegative"
    CHECK ("automatic_failure_count" >= 0);
