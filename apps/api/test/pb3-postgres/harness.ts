import { randomBytes, randomUUID } from "node:crypto";
import { Client } from "pg";
import type { Prisma, PrismaClient } from "../../src/generated/prisma/client.js";
import { createPrismaClient } from "../../src/infrastructure/database/prisma-client.js";
import { calculateAuditHash } from "../../src/modules/audit/append-audit-event.js";
import type { AnchorDeploymentTrustPolicy } from "../../src/modules/anchor/anchor-worker.js";
import type { AnchorDeploymentConfig } from "../../src/modules/anchor/soroban-anchor-gateway.js";

const M5_OPT_IN = "I_ACKNOWLEDGE_PB3_ANCHOR_WRITES";
const M5_DATABASE_URL = /^postgres(?:ql)?:\/\/pb3_admin:(?:[A-Za-z0-9._~-]|%[0-9A-Fa-f]{2})+@127\.0\.0\.1:55433\/sigae_pb3_lab$/u;
const DENIED = "PB3_ANCHOR_HARNESS_DESTINATION_REJECTED";
const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const ACTIVE_JOB_STATES = ["PENDING", "LEASED", "SUBMITTED", "RETRYABLE"] as const;

export interface M5PostgresLab {
  readonly writer: PrismaClient;
  readonly observer: PrismaClient;
  readonly contender: PrismaClient;
  readonly lockClient: Client;
  readonly deploymentId: string;
}

export interface M5SyntheticAlert {
  readonly runId: string;
  readonly alertId: string;
  readonly jobId: string;
  readonly kid: string;
  readonly jwsCompact: string;
  readonly messageKey: Uint8Array;
  readonly jwsHash: Uint8Array;
  readonly authorId: string;
  readonly frozenPayload: Uint8Array;
}

export interface M5SyntheticDeployment {
  readonly id: string;
  readonly trustPolicy: AnchorDeploymentTrustPolicy;
}

export type M5FailurePoint = "none" | "after_anchor_job_confirmation";
export interface M5FailureEvidence { readonly afterAnchorJobConfirmation: { value: boolean } }

function m5LabEnvironmentIsEnabled(): boolean {
  const databaseUrl = process.env["SIGAE_PB3_POSTGRES_URL"];
  const directUrl = process.env["SIGAE_PB3_POSTGRES_DIRECT_URL"];
  return process.env["SIGAE_RUN_PB3_POSTGRES_ANCHOR"] === M5_OPT_IN &&
    typeof databaseUrl === "string" && M5_DATABASE_URL.test(databaseUrl) &&
    (directUrl === undefined || directUrl === databaseUrl);
}

export async function openM5AnchorLab(): Promise<Omit<M5PostgresLab, "deploymentId">> {
  if (!m5LabEnvironmentIsEnabled()) throw new Error(DENIED);
  const databaseUrl = process.env["SIGAE_PB3_POSTGRES_URL"]!;
  const writer = createPrismaClient(databaseUrl);
  const observer = createPrismaClient(databaseUrl);
  const contender = createPrismaClient(databaseUrl);
  const lockClient = new Client({ connectionString: databaseUrl });
  await lockClient.connect();
  let lockResult;
  try {
    lockResult = await lockClient.query<{ locked: boolean }>(
      "SELECT pg_try_advisory_lock($1::integer, $2::integer) AS locked",
      [1_397_311_297, 1_295_310_849],
    );
  } catch {
    await lockClient.end();
    throw new Error("M5_ANCHOR_HARNESS_LOCK_ACQUISITION_FAILED");
  }
  if (lockResult.rows.length !== 1 || lockResult.rows[0]?.locked !== true) {
    await lockClient.end();
    throw new Error("M5_ANCHOR_HARNESS_ALREADY_RUNNING");
  }
  return { writer, observer, contender, lockClient };
}

export async function assertM5AnchorTarget(tx: Prisma.TransactionClient): Promise<void> {
  const rows = await tx.$queryRaw<Array<{
    database_name: string;
    username: string;
    address: string | null;
    port: number | null;
    timezone: string;
    data_directory: string;
  }>>`SELECT current_database() AS database_name, current_user AS username,
    host(inet_server_addr()) AS address, inet_server_port() AS port,
    current_setting('TimeZone') AS timezone,
    current_setting('data_directory') AS data_directory`;
  if (rows.length !== 1) throw new Error(DENIED);
  const row = rows[0]!;
  const matches =
    row.database_name === "sigae_pb3_lab" &&
    row.username === "pb3_admin" &&
    row.address === "127.0.0.1" &&
    typeof row.port === "number" && row.port === 55433 &&
    row.timezone === "UTC" &&
    row.data_directory.replace(/\\/g, "/").toLowerCase() ===
      "d:/desarrollo/sigae-pb3-postgres-lab/data";
  if (!matches) throw new Error(DENIED);
}

function workerQueueWhere(now: Date): Prisma.AnchorJobWhereInput {
  return {
    OR: [
      ...(["PENDING", "RETRYABLE", "SUBMITTED"] as const).map((state) => ({
        state,
        AND: [
          { OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }] },
          { OR: [{ leaseUntil: null }, { leaseUntil: { lte: now } }] },
        ],
      })),
      { state: "LEASED", OR: [{ leaseUntil: null }, { leaseUntil: { lte: now } }] },
    ],
  };
}

export async function assertM5LabIsEmptyForWorker(prisma: PrismaClient): Promise<void> {
  await guardedRead(prisma, async (tx) => {
    const activeJobs = await tx.anchorJob.count({
      where: { state: { in: [...ACTIVE_JOB_STATES] } },
    });
    const activeDeployments = await tx.anchorDeployment.count({
      where: { state: "ACTIVE", network: "TESTNET" },
    });
    if (activeJobs !== 0 || activeDeployments !== 0) {
      throw new Error("M5_ANCHOR_HARNESS_REQUIRES_RESERVED_EMPTY_LAB");
    }
  });
}

export async function createSyntheticDeployment(
  prisma: PrismaClient,
): Promise<M5SyntheticDeployment> {
  return prisma.$transaction(async (tx) => {
    await assertM5AnchorTarget(tx);
    const current = await tx.anchorDeployment.findMany({
      where: { state: "ACTIVE", network: "TESTNET" },
      take: 2,
      select: { id: true },
    });
    if (current.length !== 0) throw new Error("M5_ANCHOR_HARNESS_DEPLOYMENT_AMBIGUOUS");
    const aggregate = await tx.anchorDeployment.aggregate({
      where: { network: "TESTNET" },
      _max: { generation: true },
    });
    const generation = (aggregate._max.generation ?? 0) + 1;
    if (!Number.isSafeInteger(generation) || generation < 1 || generation > 2_147_483_647) {
      throw new Error("M5_ANCHOR_HARNESS_DEPLOYMENT_GENERATION_INVALID");
    }
    const marker = randomUUID();
    const deploymentConfig: Omit<AnchorDeploymentConfig, "id"> = {
      network: "TESTNET",
      networkPassphrase: "Test SDF Network ; September 2015",
      contractId: `C${syntheticStrKeyBody()}`,
      wasmHash: Buffer.from(randomBytes(32)).toString("hex"),
      adminPublicAddress: `G${syntheticStrKeyBody()}`,
      generation,
      trustedConfigVersion: `SIMULACRO-M5-POSTGRES-v1-${marker}`,
    };
    const deployment = await tx.anchorDeployment.create({
      data: {
        ...deploymentConfig,
        state: "ACTIVE",
        deployedAt: new Date(),
      },
      select: { id: true },
    });
    const trustedDeployment = { ...deploymentConfig, id: deployment.id };
    const trustPolicy: AnchorDeploymentTrustPolicy = (candidate) =>
      m5LabEnvironmentIsEnabled() &&
      trustedDeployment.trustedConfigVersion.startsWith("SIMULACRO-M5-POSTGRES-v1-") &&
      candidate.id === trustedDeployment.id &&
      candidate.network === trustedDeployment.network &&
      candidate.networkPassphrase === trustedDeployment.networkPassphrase &&
      candidate.contractId === trustedDeployment.contractId &&
      candidate.wasmHash === trustedDeployment.wasmHash &&
      candidate.adminPublicAddress === trustedDeployment.adminPublicAddress &&
      candidate.generation === trustedDeployment.generation &&
      candidate.trustedConfigVersion === trustedDeployment.trustedConfigVersion;
    return { id: deployment.id, trustPolicy };
  }, { isolationLevel: "Serializable" });
}

function syntheticStrKeyBody(): string {
  return Array.from(randomBytes(55), (value) => BASE32[value % BASE32.length]).join("");
}

export async function seedM5AnchorJob(
  prisma: PrismaClient,
  deploymentId: string,
  fixture: {
    readonly jwsCompact: string;
    readonly kid: string;
    readonly publicJwk: Prisma.InputJsonValue;
    readonly thumbprint: string;
    readonly frozenPayload: Uint8Array;
    readonly payloadDigest: Uint8Array;
    readonly messageKey: Uint8Array;
    readonly jwsHash: Uint8Array;
    readonly sent: string;
    readonly identifier: string;
    readonly sender: string;
  },
): Promise<M5SyntheticAlert> {
  const runId = randomUUID();
  const alertId = randomUUID();
  const jobId = randomUUID();
  const authorId = randomUUID();
  const kid = fixture.kid;
  const storedJws = fixture.jwsCompact;
  const storedJwsHash = fixture.jwsHash;
  const bytes = (value: Uint8Array) => Buffer.from(value);

  await prisma.$transaction(async (tx) => {
    await assertM5AnchorTarget(tx);
    await tx.user.create({
      data: {
        id: authorId,
        name: "SIMULACRO AnchorWorker M5",
        email: `m5-${runId}@example.invalid`,
        role: "AUTHOR",
        status: "DISABLED",
      },
    });
    await tx.publicKey.create({
      data: {
        kid,
        publicJwk: fixture.publicJwk,
        thumbprint: fixture.thumbprint,
        status: "ACTIVE",
        validFrom: new Date(Date.now() - 60_000),
      },
    });
    await tx.alert.create({
      data: {
        id: alertId,
        sender: fixture.sender,
        identifier: fixture.identifier,
        sentText: fixture.sent,
        kind: "Alert",
        severity: "Severe",
        lifecycleState: "SIGNED_PENDING_ANCHOR",
        anchorStatus: "PENDING",
        version: 3,
        frozenPayload: bytes(fixture.frozenPayload),
        payloadSha256: bytes(fixture.payloadDigest),
        approvedPayloadSha256: bytes(fixture.payloadDigest),
        jwsCompact: storedJws,
        kid,
        messageKey: bytes(fixture.messageKey),
        jwsHash: bytes(storedJwsHash),
        authorId,
      },
    });
    await tx.anchorJob.create({
      data: {
        id: jobId,
        alertId,
        deploymentId,
        messageKey: bytes(fixture.messageKey),
        jwsHash: bytes(storedJwsHash),
        state: "PENDING",
      },
    });
  }, { isolationLevel: "Serializable" });

  return {
    runId,
    alertId,
    jobId,
    kid,
    jwsCompact: storedJws,
    messageKey: Uint8Array.from(fixture.messageKey),
    jwsHash: Uint8Array.from(storedJwsHash),
    authorId,
    frozenPayload: Uint8Array.from(fixture.frozenPayload),
  };
}

export async function guardedRead<T>(
  prisma: PrismaClient,
  read: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  return prisma.$transaction(async (tx) => {
    await assertM5AnchorTarget(tx);
    return read(tx);
  }, { isolationLevel: "RepeatableRead" });
}

export async function assertNextM5JobIs(
  prisma: PrismaClient,
  expectedJobId: string,
): Promise<void> {
  await guardedRead(prisma, async (tx) => {
    const selected = await tx.anchorJob.findMany({
      where: workerQueueWhere(new Date()),
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      take: 2,
      select: { id: true },
    });
    if (selected.length !== 1 || selected[0]?.id !== expectedJobId) {
      throw new Error("M5_ANCHOR_HARNESS_QUEUE_NOT_ISOLATED");
    }
  });
}

export async function assertM5QueueIsIdle(prisma: PrismaClient): Promise<void> {
  await guardedRead(prisma, async (tx) => {
    const selected = await tx.anchorJob.findMany({
      where: workerQueueWhere(new Date()),
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      take: 1,
      select: { id: true },
    });
    if (selected.length !== 0) throw new Error("M5_ANCHOR_HARNESS_QUEUE_NOT_IDLE");
  });
}

export interface TransactionEntryBarrier {
  waitAfterSelection(): Promise<void>;
}

export function transactionEntryBarrier(parties: number): {
  readonly barrier: TransactionEntryBarrier;
  readonly arrivals: () => number;
} {
  let count = 0;
  let release!: () => void;
  let fail!: (error: Error) => void;
  const ready = new Promise<void>((resolve, reject) => {
    release = resolve;
    fail = reject;
  });
  const barrier = {
    async waitAfterSelection() {
      count += 1;
      if (count === parties) release();
      const timeout = setTimeout(() => fail(new Error("M5_ANCHOR_CAS_BARRIER_TIMEOUT")), 10_000);
      try {
        await ready;
      } finally {
        clearTimeout(timeout);
      }
    },
  };
  return { barrier, arrivals: () => count };
}

export function guardedWorkerClient(
  prisma: PrismaClient,
  options: {
    readonly failurePoint?: M5FailurePoint;
    readonly failureEvidence?: M5FailureEvidence;
    readonly selectionBarrier?: TransactionEntryBarrier;
  } = {},
): PrismaClient {
  let barrierUsed = false;
  return new Proxy(prisma, {
    get(target, property) {
      if (property !== "$transaction") {
        const value: unknown = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      }
      return async <T>(
        work: (tx: Prisma.TransactionClient) => Promise<T>,
        txOptions?: { isolationLevel?: Prisma.TransactionIsolationLevel },
      ) => target.$transaction(async (tx) => {
        await assertM5AnchorTarget(tx);
        const guardedTx = new Proxy(tx, {
          get(transaction, delegateName) {
            const delegate = Reflect.get(transaction, delegateName, transaction);
            if (!delegate || typeof delegate !== "object") {
              return typeof delegate === "function" ? delegate.bind(transaction) : delegate;
            }
            if (delegateName !== "anchorJob") {
              return new Proxy(delegate, {
                get(model, operation, receiver) {
                  const value: unknown = Reflect.get(model, operation, receiver);
                  return typeof value === "function" ? value.bind(model) : value;
                },
              });
            }
            return new Proxy(delegate, {
              get(model, operation, receiver) {
                const value: unknown = Reflect.get(model, operation, receiver);
                if (operation === "findFirst" && typeof value === "function" &&
                    options.selectionBarrier && !barrierUsed) {
                  barrierUsed = true;
                  return async (...args: unknown[]) => {
                    const selected = await value.apply(model, args);
                    await options.selectionBarrier!.waitAfterSelection();
                    return selected;
                  };
                }
                if (operation === "updateMany" && typeof value === "function" &&
                    options.failurePoint === "after_anchor_job_confirmation") {
                  return async (...args: unknown[]) => {
                    const result = await value.apply(model, args);
                    const input = args[0] as { readonly data?: { readonly state?: unknown } } | undefined;
                    if (input?.data?.state === "CONFIRMED") {
                      if (options.failureEvidence) {
                        (options.failureEvidence.afterAnchorJobConfirmation as { value: boolean }).value = true;
                      }
                      throw new Error("M5_ANCHOR_INJECTED_ROLLBACK");
                    }
                    return result;
                  };
                }
                return typeof value === "function" ? value.bind(model) : value;
              },
            });
          },
        });
        return work(guardedTx);
      }, txOptions);
    },
  });
}

export async function assertAuditSegment(
  prisma: PrismaClient,
  before: { readonly seq: bigint; readonly hash: Uint8Array },
  actions: readonly string[],
): Promise<void> {
  await guardedRead(prisma, async (tx) => {
    const events = await tx.auditEvent.findMany({
      where: { seq: { gt: before.seq } },
      orderBy: { seq: "asc" },
    });
    expectAuditActions(events.map((event) => event.action), actions);
    let seq = before.seq;
    let hash = Uint8Array.from(before.hash);
    for (const event of events) {
      seq += 1n;
      if (event.seq !== seq || !Buffer.from(event.previousHash).equals(Buffer.from(hash))) {
        throw new Error("M5_ANCHOR_AUDIT_CHAIN_MISMATCH");
      }
      hash = calculateAuditHash(hash, event.seq, {
        actorId: event.actorId,
        action: event.action,
        objectType: event.objectType,
        objectId: event.objectId,
        redactedDetails: event.redactedDetails as Record<string, string | number | boolean | null>,
      }, event.occurredAt);
      if (!Buffer.from(event.eventHash).equals(Buffer.from(hash))) {
        throw new Error("M5_ANCHOR_AUDIT_HASH_MISMATCH");
      }
    }
    const head = await tx.auditChainState.findUniqueOrThrow({ where: { id: 1 } });
    if (head.lastSeq !== seq || !Buffer.from(head.lastHash).equals(Buffer.from(hash))) {
      throw new Error("M5_ANCHOR_AUDIT_HEAD_MISMATCH");
    }
  });
}

function expectAuditActions(actual: readonly string[], expected: readonly string[]): void {
  if (actual.length !== expected.length || actual.some((action, index) => action !== expected[index])) {
    throw new Error("M5_ANCHOR_AUDIT_ACTIONS_MISMATCH");
  }
}
