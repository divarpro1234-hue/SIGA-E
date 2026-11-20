import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { Prisma, PrismaClient } from "../../src/generated/prisma/client.js";
import { validateM2IntegrationDatabase } from "../../src/config/m2-integration-database.js";
import { createPrismaClient } from "../../src/infrastructure/database/prisma-client.js";
import { PrismaDraftAlertService } from "../../src/modules/alerts/alert-draft-service.js";
import type { InternalUser } from "../../src/modules/identity/session-reader.js";

const denied = () => new Error("M2_HARNESS_DESTINATION_REJECTED");
export const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

// This barrier is reached after the read-only target check and before the service
// locks the author. It proves concurrent transaction entry, not concurrent alert CAS.
export function transactionEntryBarrier(parties = 2) {
  let arrivals = 0;
  let release!: () => void;
  let reject!: (reason: Error) => void;
  const rendezvous = new Promise<void>((resolve, fail) => { release = resolve; reject = fail; });
  return {
    get arrivals() { return arrivals; },
    async wait() {
      arrivals += 1;
      if (arrivals === parties) release();
      const timeout = setTimeout(() => reject(new Error("M2_TRANSACTION_ENTRY_TIMEOUT")), 5_000);
      try { await rendezvous; } finally { clearTimeout(timeout); }
    },
  };
}
export type TransactionEntryBarrier = ReturnType<typeof transactionEntryBarrier>;

// Esta función es la única puerta de entrada; no se crea cliente al importar el módulo.
export function openM2Lab() {
  if (process.env["SIGAE_RUN_M2_POSTGRES_SUBMIT"] !== "I_ACKNOWLEDGE_M2_WRITES") throw denied();
  const databaseUrl = process.env["DATABASE_URL"];
  const directUrl = process.env["DIRECT_URL"];
  const source = directUrl === undefined
    ? { DATABASE_URL: databaseUrl }
    : { DATABASE_URL: databaseUrl, DIRECT_URL: directUrl };
  validateM2IntegrationDatabase(source);
  if (typeof databaseUrl !== "string") throw denied();
  // No hay dotenv ni fallback; ambos clientes usan exactamente la URL validada.
  const writer = createPrismaClient(databaseUrl);
  const observer = createPrismaClient(databaseUrl);
  return { writer, observer };
}

export function openM2DecisionLab() {
  if (process.env["SIGAE_RUN_M2_POSTGRES_DECISIONS"] !== "I_ACKNOWLEDGE_M2_DECISION_WRITES") throw denied();
  const databaseUrl = process.env["DATABASE_URL"];
  const directUrl = process.env["DIRECT_URL"];
  const source = directUrl === undefined
    ? { DATABASE_URL: databaseUrl }
    : { DATABASE_URL: databaseUrl, DIRECT_URL: directUrl };
  validateM2IntegrationDatabase(source);
  if (typeof databaseUrl !== "string") throw denied();
  const writer = createPrismaClient(databaseUrl);
  const observer = createPrismaClient(databaseUrl);
  return { writer, observer };
}

export async function assertM2Target(tx: Prisma.TransactionClient): Promise<void> {
  const rows = await tx.$queryRaw<Array<{
    db: string; username: string; address: string | null; port: number | null; zone: string;
  }>>`SELECT current_database() AS db, current_user AS username,
    host(inet_server_addr()) AS address, inet_server_port() AS port,
    current_setting('TimeZone') AS zone`;
  const rowCountOk = rows.length === 1;
  if (!rowCountOk) {
    throw new Error(`M2_HARNESS_DESTINATION_REJECTED ${JSON.stringify({ rowCountOk })}`);
  }
  const row = rows[0]!;
  // inet_server_* reports the PostgreSQL endpoint, not the client's URL target.
  // A port forward to another server port fails closed until separately reviewed.
  const databaseOk = row.db === "sigae_m2_submit_itest";
  const userOk = row.username === "sigae_m2_itest";
  const addressOk = row.address === "127.0.0.1";
  const portOk = row.port === 55432;
  const timezoneOk = row.zone === "UTC";
  if (!databaseOk || !userOk || !addressOk || !portOk || !timezoneOk) {
    throw new Error(`M2_HARNESS_DESTINATION_REJECTED ${JSON.stringify({
      rowCountOk, databaseOk, userOk, addressOk, portOk, timezoneOk,
      portType: typeof row.port, addressIsNull: row.address === null,
    })}`);
  }
}

export type FailurePoint = "none" | "after_audit_head";
export interface TransactionEvidence { p2034: boolean }
export interface FailureEvidence { afterAuditHeadUpdated: boolean }

// El servicio solo consume $transaction. La comprobación se ejecuta en la MISMA
// conexión y transacción que el servicio usará para sus escrituras.
export function guardedService(prisma: PrismaClient, evidence: TransactionEvidence,
  failure: FailurePoint = "none", clock: () => Date = () => new Date(),
  failureEvidence?: FailureEvidence, entryBarrier?: TransactionEntryBarrier) {
  const facade = {
    async $transaction<T>(work: (tx: Prisma.TransactionClient) => Promise<T>, options?: { isolationLevel?: Prisma.TransactionIsolationLevel }) {
      try {
        return await prisma.$transaction(async (tx) => {
          await assertM2Target(tx);
          if (entryBarrier) await entryBarrier.wait();
          if (failure !== "after_audit_head") return work(tx);
          const auditedTx = new Proxy(tx, {
            get(target, key) {
              if (key !== "auditChainState") {
                const value: unknown = Reflect.get(target, key, target);
                return typeof value === "function" ? value.bind(target) : value;
              }
              return new Proxy(target.auditChainState, {
                get(delegate, operation, object) {
                  if (operation !== "update") return Reflect.get(delegate, operation, object);
                  const original = delegate.update.bind(delegate) as (args: unknown) => Promise<unknown>;
                  return async (args: unknown) => {
                    await original(args);
                    if (failureEvidence) failureEvidence.afterAuditHeadUpdated = true;
                    throw new Error("M2_INJECTED_ROLLBACK");
                  };
                },
              });
            },
          });
          return work(auditedTx);
        }, options);
      } catch (error) {
        if (error && typeof error === "object" && "code" in error && error.code === "P2034") evidence.p2034 = true;
        throw error;
      }
    },
  } as unknown as PrismaClient;
  return new PrismaDraftAlertService(facade, "urn:siga-e:simulacro", clock);
}

export async function guardedRead<T>(prisma: PrismaClient, read: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
  return prisma.$transaction(async (tx) => { await assertM2Target(tx); return read(tx); },
    { isolationLevel: "RepeatableRead" });
}

export interface SyntheticActor { actor: InternalUser; cookie: string; runId: string }

// Preparación directa y sintética del servicio, sin pretender haber realizado MFA.
export async function seedActor(prisma: PrismaClient): Promise<SyntheticActor> {
  const runId = randomUUID();
  const actor: InternalUser = {
    id: randomUUID(), name: "SIMULACRO Autor M2", email: `m2-${runId}@example.invalid`,
    role: "AUTHOR", status: "ACTIVE",
  };
  const token = randomBytes(32).toString("base64url");
  const now = new Date();
  await prisma.$transaction(async (tx) => {
    await assertM2Target(tx);
    await tx.user.create({ data: {
      id: actor.id, name: actor.name, email: actor.email, role: "AUTHOR", status: "ACTIVE",
      // Valores sintéticos no utilizables como credenciales MFA reales.
      passwordHash: `SIMULACRO-NO-LOGIN-${runId}`,
      totpSecretCiphertext: randomBytes(32),
    } });
    await tx.session.create({ data: {
      userId: actor.id, tokenHash: createHash("sha256").update(token, "ascii").digest(),
      lastSeenAt: now, expiresAt: new Date(now.getTime() + 60 * 60_000),
    } });
  }, { isolationLevel: "Serializable" });
  return { actor, cookie: `sigae_session=${token}`, runId };
}

export async function seedApprover(prisma: PrismaClient): Promise<SyntheticActor> {
  const runId = randomUUID();
  const actor: InternalUser = {
    id: randomUUID(), name: "SIMULACRO Aprobador M2", email: `m2-approver-${runId}@example.invalid`,
    role: "APPROVER", status: "ACTIVE",
  };
  const token = randomBytes(32).toString("base64url");
  const now = new Date();
  await prisma.$transaction(async (tx) => {
    await assertM2Target(tx);
    await tx.user.create({ data: {
      id: actor.id, name: actor.name, email: actor.email, role: "APPROVER", status: "ACTIVE",
      passwordHash: `SIMULACRO-NO-LOGIN-${runId}`,
      totpSecretCiphertext: randomBytes(32),
    } });
    await tx.session.create({ data: {
      userId: actor.id, tokenHash: createHash("sha256").update(token, "ascii").digest(),
      lastSeenAt: now, expiresAt: new Date(now.getTime() + 60 * 60_000),
    } });
  }, { isolationLevel: "Serializable" });
  return { actor, cookie: `sigae_session=${token}`, runId };
}

export function syntheticInput(runId: string, severity: "Severe" | "Minor" = "Severe", expires?: Date) {
  return { kind: "Alert" as const, info: {
    scenario: "SISMO" as const, event: "Sismo ficticio SIMULACRO", severity,
    urgency: "Immediate" as const, certainty: "Likely" as const,
    headline: `SIMULACRO M2 ${runId}`,
    description: `Ejercicio académico ficticio SIMULACRO ${runId}`,
    expires: (expires ?? new Date(Date.now() + 60 * 60_000)).toISOString(),
    areaDesc: "Zona ficticia M2",
  } };
}

export function reportEvidence(runId: string, alertId: string, outcome: string): void {
  // Solo identificadores sintéticos y clasificación; jamás URL, cookie ni errores del driver.
  process.stdout.write(`M2 SIMULACRO run=${runId} alert=${alertId} outcome=${outcome}\n`);
}
