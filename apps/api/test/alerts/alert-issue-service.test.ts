import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { CryptoKey } from "jose";
import type { PrismaClient } from "../../src/generated/prisma/client.js";
import { PrismaDraftAlertService } from "../../src/modules/alerts/alert-draft-service.js";
import { buildDraftPayload } from "../../src/modules/alerts/alert-payload.js";
import { validateAlertInput } from "../../src/modules/alerts/alert-input.js";
import { identity, input } from "./alert-fixtures.js";
import { calculateJwsHash, calculateMessageKey } from "../../src/modules/signing/alert-hashes.js";
import { verifyAlertJws } from "../../src/modules/signing/verify-alert-jws.js";
import type { TrustedPublicKeyCatalog } from "../../src/modules/signing/trusted-public-keys.js";
import { ALERT_SIGNING_TIMEOUT_MS, type AlertSigner } from "../../src/modules/signing/alert-signer.js";
import type { InternalUser } from "../../src/modules/identity/session-reader.js";
import { TrustedAlertSigningKeyProvider } from "../../src/modules/signing/trusted-alert-signing-key-provider.js";
import type { LocalAlertSignerSource } from "../../src/modules/signing/local-alert-signer-source.js";

vi.mock("jose", async (importOriginal) => {
  const actual = await importOriginal<typeof import("jose")>();
  return {
    ...actual,
    importJWK: vi.fn(async () => ({
      type: "public",
      extractable: false,
      algorithm: { name: "ECDSA", namedCurve: "P-256" },
      usages: ["verify"],
      testSignatureByte: 0,
    } as CryptoKey)),
  };
});

vi.mock("../../src/modules/signing/verify-alert-jws.js", () => ({
  verifyAlertJws: vi.fn(async (compact: string, trustedKeys: TrustedPublicKeyCatalog) => {
    const segments = compact.split(".");
    const [protectedSegment, payloadSegment, signatureSegment] = segments;
    if (segments.length !== 3 || !protectedSegment || !payloadSegment || !signatureSegment ||
        Buffer.from(signatureSegment, "base64url").length !== 64) {
      throw new Error("synthetic JWS is malformed");
    }
    const header = JSON.parse(Buffer.from(protectedSegment, "base64url").toString("utf8")) as {
      alg?: unknown; kid?: unknown;
    };
    const verificationKey = typeof header.kid === "string" ? trustedKeys.resolve(header.kid) : undefined;
    const signature = Buffer.from(signatureSegment, "base64url");
    const expectedSignatureByte = verificationKey && "testSignatureByte" in verificationKey
      ? verificationKey.testSignatureByte : undefined;
    if (header.alg !== "ES256" || typeof header.kid !== "string" || !verificationKey ||
        typeof expectedSignatureByte !== "number" ||
        !signature.equals(Buffer.alloc(64, expectedSignatureByte))) {
      throw new Error("synthetic JWS is not trusted");
    }
    return {
      payloadBytes: Uint8Array.from(Buffer.from(payloadSegment, "base64url")),
      alg: "ES256" as const,
      kid: header.kid,
    };
  }),
}));

const author = { id: "00000000-0000-4000-8000-000000000002", name: "Autor ficticio",
  email: "author@example.invalid", role: "AUTHOR" as const, status: "ACTIVE" as const };
const approverId = "00000000-0000-4000-8000-000000000003";
const alertId = "00000000-0000-4000-8000-000000000001";
const deploymentId = "00000000-0000-4000-8000-000000000004";
const cookie = `sigae_session=${"A".repeat(43)}`;
const operationTime = new Date(identity.sent);
const payload = buildDraftPayload(validateAlertInput(input, identity.sent), identity);
const digestHex = payload.payloadDigestHex;

async function fixture(options: {
  state?: string;
  expectedDigestHex?: string;
  missingProvider?: boolean;
  missingApproval?: boolean;
  unknownKid?: boolean;
  badApproval?: boolean;
  badApprovalDigest?: boolean;
  badApprovalVersion?: boolean;
  casConflict?: boolean;
  signerFailure?: boolean;
  auditFailure?: boolean;
  anchorJobFailure?: boolean;
  finalTransactionFailure?: boolean;
  signDelayMs?: number;
  actor?: InternalUser;
  incompleteSignedState?: boolean;
  untrustedCatalogKey?: boolean;
} = {}) {
  const kid = "sigae-synthetic-test-key";
  const publicJwk = {
    kty: "EC", crv: "P-256",
    x: Buffer.alloc(32, 1).toString("base64url"),
    y: Buffer.alloc(32, 2).toString("base64url"),
  };
  let activeTransactions = 0;
  let signingDuringTransaction = false;
  const sign = vi.fn(async (bytes: Uint8Array, _signal?: AbortSignal) => {
    if (activeTransactions > 0) signingDuringTransaction = true;
    if (options.signDelayMs) await new Promise((resolve) => setTimeout(resolve, options.signDelayMs));
    if (options.signerFailure) throw new Error("private provider diagnostic must not leak");
    const protectedSegment = Buffer.from(JSON.stringify({ alg: "ES256", kid })).toString("base64url");
    const payloadSegment = Buffer.from(bytes).toString("base64url");
    const syntheticSignature = Buffer.alloc(64).toString("base64url");
    return `${protectedSegment}.${payloadSegment}.${syntheticSignature}`;
  });
  const signer: AlertSigner = {
    kid,
    sign,
  };
  const trustedPublicKey = {
    type: "public",
    extractable: false,
    algorithm: { name: "ECDSA", namedCurve: "P-256" },
    usages: ["verify"],
    testSignatureByte: options.untrustedCatalogKey ? 1 : 0,
  } as CryptoKey;
  const actor = options.actor ?? author;
  const rowState = options.state ?? "READY_TO_SIGN";
  const state = {
    alert: {
      id: alertId, authorId: author.id, sender: identity.sender, identifier: identity.identifier,
      sentText: identity.sent, kind: "Alert", severity: "Severe", lifecycleState: rowState,
      anchorStatus: options.incompleteSignedState ? "PENDING" : "NOT_REQUESTED",
      version: 3, frozenPayload: new Uint8Array(payload.payloadBytes),
      payloadSha256: new Uint8Array(payload.payloadDigest), approvedPayloadSha256: new Uint8Array(payload.payloadDigest),
      jwsCompact: options.incompleteSignedState ? "incomplete.persisted.jws" : null as string | null,
      kid: null as string | null, messageKey: null as Uint8Array | null,
      jwsHash: null as Uint8Array | null, publishedAt: null as Date | null,
    },
    jobs: [] as Array<Record<string, unknown>>,
    audits: [] as Array<Record<string, unknown>>,
  };
  let rawQueryCount = 0;
  const tx = {
    $queryRaw: vi.fn().mockImplementation(async () => {
      rawQueryCount += 1;
      if (rawQueryCount === 1) return [{ id: actor.id, role: actor.role, status: actor.status }];
      if (rawQueryCount === 2) return [{ user_id: actor.id, revoked_at: null,
        expires_at: new Date(operationTime.getTime() + 60_000), last_seen_at: new Date(operationTime.getTime() - 1000) }];
      return [{ last_seq: BigInt(state.audits.length), last_hash: new Uint8Array(32) }];
    }),
    alert: {
      findFirst: vi.fn().mockImplementation(async ({ where }: {
        where: { authorId: string };
      }) => {
        if (where.authorId !== state.alert.authorId) return null;
        return {
          ...state.alert, frozenPayload: new Uint8Array(state.alert.frozenPayload),
          payloadSha256: new Uint8Array(state.alert.payloadSha256),
          approvedPayloadSha256: new Uint8Array(state.alert.approvedPayloadSha256!),
        };
      }),
      updateMany: vi.fn().mockImplementation(async ({ where, data }: {
        where: { lifecycleState: string; version: number };
        data: Record<string, unknown>;
      }) => {
        if (options.casConflict || state.alert.lifecycleState !== where.lifecycleState ||
            state.alert.version !== where.version) return { count: 0 };
        Object.assign(state.alert, data);
        return { count: 1 };
      }),
    },
    approval: {
      findUnique: vi.fn().mockResolvedValue(options.missingApproval ? null : {
        approverId, alertVersion: options.badApprovalVersion ? 1 : 2, reviewedPayload: options.badApproval
          ? new Uint8Array([...payload.payloadBytes, 0]) : new Uint8Array(payload.payloadBytes),
        digest: options.badApprovalDigest
          ? new Uint8Array(32).fill(1) : new Uint8Array(payload.payloadDigest),
        decision: "APPROVED",
        reviewedAt: operationTime,
      }),
    },
    publicKey: {
      findUnique: vi.fn().mockResolvedValue(options.unknownKid ? null : {
        kid, publicJwk, status: "ACTIVE", validFrom: new Date(operationTime.getTime() - 1000),
        retiredAt: null, revokedAt: null,
      }),
      findMany: vi.fn().mockImplementation(async () => options.unknownKid ? [] : [{
        kid, publicJwk, status: "ACTIVE", validFrom: new Date(operationTime.getTime() - 1000),
        retiredAt: null, revokedAt: null,
      }]),
    },
    anchorDeployment: { findMany: vi.fn().mockResolvedValue([{ id: deploymentId }]) },
    anchorJob: { create: vi.fn().mockImplementation(async ({ data }: { data: Record<string, unknown> }) => {
      if (options.anchorJobFailure) throw new Error("job insertion failed");
      state.jobs.push(data);
      return data;
    }) },
    auditEvent: { create: vi.fn().mockImplementation(async ({ data }: { data: Record<string, unknown> }) => {
      if (options.auditFailure) throw new Error("audit diagnostic must not leak");
      state.audits.push(data);
      return data;
    }) },
    auditChainState: { update: vi.fn().mockResolvedValue({}) },
  };
  let transactionCount = 0;
  const prisma = {
    $transaction: vi.fn(async (work: (client: typeof tx) => Promise<unknown>) => {
      transactionCount += 1;
      if (options.finalTransactionFailure && transactionCount === 2)
        throw new Error("simulated commit unavailable");
      rawQueryCount = 0;
      const alertBefore = structuredClone(state.alert);
      const jobsBefore = [...state.jobs];
      const auditsBefore = [...state.audits];
      activeTransactions += 1;
      try {
        return await work(tx);
      } catch (error) {
        Object.assign(state.alert, alertBefore);
        state.jobs.splice(0, state.jobs.length, ...jobsBefore);
        state.audits.splice(0, state.audits.length, ...auditsBefore);
        throw error;
      } finally {
        activeTransactions -= 1;
      }
    }),
  };
  const service = new PrismaDraftAlertService(prisma as unknown as PrismaClient,
    identity.sender, () => new Date(operationTime), undefined, undefined,
    options.missingProvider ? undefined : {
      getActiveSigner: () => signer,
      getTrustedPublicKey: () => trustedPublicKey,
    });
  const issue = (expected = options.expectedDigestHex ?? digestHex) =>
    service.issue(actor, cookie, alertId, { expectedDigestHex: expected });
  return {
    service, issue, tx, prisma, state, signer, sign, kid,
    wasSigningDuringTransaction: () => signingDuringTransaction,
  };
}

interface MemoryAlert {
  id: string;
  authorId: string;
  sender: string;
  identifier: string;
  sentText: string;
  kind: string;
  severity: string;
  lifecycleState: string;
  anchorStatus: string;
  version: number;
  frozenPayload: Uint8Array;
  payloadSha256: Uint8Array;
  approvedPayloadSha256: Uint8Array | null;
  jwsCompact: string | null;
  kid: string | null;
  messageKey: Uint8Array | null;
  jwsHash: Uint8Array | null;
  publishedAt: Date | null;
}

function memoryWorkflow() {
  const kid = "sigae-offline-workflow-key";
  const trustedKey = {
    type: "public", extractable: false,
    algorithm: { name: "ECDSA", namedCurve: "P-256" }, usages: ["verify"],
    testSignatureByte: 0,
  } as CryptoKey;
  const signer: AlertSigner = {
    kid,
    sign: vi.fn(async (bytes: Uint8Array) => {
      const protectedSegment = Buffer.from(JSON.stringify({ alg: "ES256", kid })).toString("base64url");
      const payloadSegment = Buffer.from(bytes).toString("base64url");
      return `${protectedSegment}.${payloadSegment}.${Buffer.alloc(64).toString("base64url")}`;
    }),
  };
  const source: LocalAlertSignerSource = { getActiveSigner: () => signer };
  const catalog: TrustedPublicKeyCatalog = { resolve: (candidate) => candidate === kid ? trustedKey : undefined };
  const provider = new TrustedAlertSigningKeyProvider(source, catalog);
  const state: {
    alert: MemoryAlert | null;
    approvals: Array<Record<string, unknown>>;
    jobs: Array<Record<string, unknown>>;
    audits: Array<Record<string, unknown>>;
    auditSeq: bigint;
    auditHash: Uint8Array;
  } = {
    alert: null, approvals: [], jobs: [], audits: [], auditSeq: 0n, auditHash: new Uint8Array(32),
  };
  let actor: InternalUser = author;
  let queryCount = 0;
  const copyAlert = (): MemoryAlert | null => state.alert === null ? null : structuredClone(state.alert);
  const matches = (actual: unknown, expected: unknown): boolean => {
    if (expected instanceof Uint8Array)
      return actual instanceof Uint8Array && Buffer.from(actual).equals(Buffer.from(expected));
    return actual === expected;
  };
  const matchesWhere = (row: MemoryAlert, where: Record<string, unknown>): boolean => {
    for (const [key, expected] of Object.entries(where)) {
      if (key === "AND" && Array.isArray(expected)) {
        if (!expected.every((part) => matchesWhere(row, part as Record<string, unknown>))) return false;
      } else if (expected && typeof expected === "object" && "in" in expected &&
          Array.isArray(expected.in)) {
        if (!expected.in.includes(Reflect.get(row, key))) return false;
      } else if (expected && typeof expected === "object" && "not" in expected) {
        if (Reflect.get(row, key) === expected.not) return false;
      } else if (!matches(Reflect.get(row, key), expected)) {
        return false;
      }
    }
    return true;
  };
  const tx = {
    $queryRaw: vi.fn(async () => {
      queryCount += 1;
      if (queryCount === 1) return [{ id: actor.id, role: actor.role, status: actor.status }];
      if (queryCount === 2) return [{ user_id: actor.id, revoked_at: null,
        expires_at: new Date(operationTime.getTime() + 60_000),
        last_seen_at: new Date(operationTime.getTime() - 1000) }];
      return [{ last_seq: state.auditSeq, last_hash: state.auditHash }];
    }),
    alert: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        state.alert = {
          id: alertId,
          authorId: data["authorId"] as string,
          sender: data["sender"] as string,
          identifier: data["identifier"] as string,
          sentText: data["sentText"] as string,
          kind: data["kind"] as string,
          severity: data["severity"] as string,
          lifecycleState: data["lifecycleState"] as string,
          anchorStatus: data["anchorStatus"] as string,
          version: data["version"] as number,
          frozenPayload: Uint8Array.from(data["frozenPayload"] as Uint8Array),
          payloadSha256: Uint8Array.from(data["payloadSha256"] as Uint8Array),
          approvedPayloadSha256: null, jwsCompact: null, kid: null,
          messageKey: null, jwsHash: null, publishedAt: null,
        };
        return copyAlert();
      }),
      findFirst: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
        return state.alert && matchesWhere(state.alert, where) ? copyAlert() : null;
      }),
      findUnique: vi.fn(async () => copyAlert()),
      updateMany: vi.fn(async ({ where, data }: {
        where: Record<string, unknown>;
        data: Record<string, unknown>;
      }) => {
        if (!state.alert || !matchesWhere(state.alert, where)) return { count: 0 };
        for (const [key, value] of Object.entries(data)) {
          if (key === "version" && value && typeof value === "object" &&
              "increment" in value && typeof value.increment === "number") {
            state.alert.version += value.increment;
          } else {
            Reflect.set(state.alert, key, value);
          }
        }
        return { count: 1 };
      }),
    },
    approval: {
      findUnique: vi.fn(async ({ where }: { where: { alertId_alertVersion: { alertId: string; alertVersion: number } } }) => {
        return state.approvals.find((approval) =>
          approval["alertId"] === where.alertId_alertVersion.alertId &&
          approval["alertVersion"] === where.alertId_alertVersion.alertVersion) ?? null;
      }),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        state.approvals.push(structuredClone(data));
        return data;
      }),
    },
    publicKey: {
      findUnique: vi.fn(async () => ({
        kid, publicJwk: {
          kty: "EC", crv: "P-256",
          x: Buffer.alloc(32, 1).toString("base64url"),
          y: Buffer.alloc(32, 2).toString("base64url"),
        },
        status: "ACTIVE", validFrom: new Date(operationTime.getTime() - 1000),
        retiredAt: null, revokedAt: null,
      })),
      findMany: vi.fn(async () => [{
        kid, publicJwk: {
          kty: "EC", crv: "P-256",
          x: Buffer.alloc(32, 1).toString("base64url"),
          y: Buffer.alloc(32, 2).toString("base64url"),
        },
        status: "ACTIVE", validFrom: new Date(operationTime.getTime() - 1000),
        retiredAt: null, revokedAt: null,
      }]),
    },
    anchorDeployment: { findMany: vi.fn(async () => [{ id: deploymentId }]) },
    anchorJob: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        state.jobs.push(structuredClone(data));
        return data;
      }),
    },
    auditEvent: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        state.audits.push(structuredClone(data));
        return data;
      }),
    },
    auditChainState: {
      update: vi.fn(async ({ data }: { data: { lastSeq: bigint; lastHash: Uint8Array } }) => {
        state.auditSeq = data.lastSeq;
        state.auditHash = Uint8Array.from(data.lastHash);
        return data;
      }),
    },
  };
  let transactionTail: Promise<void> = Promise.resolve();
  const prisma = {
    $transaction: vi.fn(async (work: (client: typeof tx) => Promise<unknown>) => {
      let release!: () => void;
      const previous = transactionTail;
      transactionTail = new Promise<void>((resolve) => { release = resolve; });
      await previous;
      const before = structuredClone(state);
      queryCount = 0;
      try {
        return await work(tx);
      } catch (error) {
        state.alert = before.alert;
        state.approvals.splice(0, state.approvals.length, ...before.approvals);
        state.jobs.splice(0, state.jobs.length, ...before.jobs);
        state.audits.splice(0, state.audits.length, ...before.audits);
        state.auditSeq = before.auditSeq;
        state.auditHash = before.auditHash;
        throw error;
      } finally {
        release();
      }
    }),
  };
  const service = new PrismaDraftAlertService(
    prisma as unknown as PrismaClient, identity.sender,
    () => new Date(operationTime), () => identity.identifier, undefined, provider,
  );
  return {
    service, state, signer,
    as(user: InternalUser) { actor = user; },
    async createSubmitApprove() {
      actor = author;
      const created = await service.create(author, cookie, input);
      const submitted = await service.submit(author, cookie, created.alert.id, created.version);
      actor = { ...author, id: approverId, role: "APPROVER" };
      const approved = await service.approve(actor, cookie, created.alert.id, {
        expectedDigestHex: submitted.payloadDigestHex, expectedVersion: submitted.version,
      });
      return { alertId: created.alert.id, digestHex: submitted.payloadDigestHex, approved };
    },
  };
}

describe("emisión M3 de alerta", () => {
  it("recorre creación, congelación, aprobación independiente, firma y outbox", async () => {
    const workflow = memoryWorkflow();
    const prepared = await workflow.createSubmitApprove();

    expect(prepared.approved).toMatchObject({
      alert: { lifecycleState: "READY_TO_SIGN" }, version: 3,
    });
    workflow.as(author);
    const receipt = await workflow.service.issue(author, cookie, prepared.alertId, {
      expectedDigestHex: prepared.digestHex,
    });
    const alert = workflow.state.alert;

    expect(receipt).toEqual({
      alertId: prepared.alertId, lifecycleState: "SIGNED_PENDING_ANCHOR", anchorStatus: "PENDING",
    });
    expect(alert).toMatchObject({
      lifecycleState: "SIGNED_PENDING_ANCHOR", anchorStatus: "PENDING", kid: "sigae-offline-workflow-key",
    });
    expect(alert?.jwsCompact).toContain(".");
    expect(Buffer.from(alert!.jwsHash!).equals(
      Buffer.from(calculateJwsHash(alert!.jwsCompact!)),
    )).toBe(true);
    expect(workflow.state.approvals).toHaveLength(1);
    expect(workflow.state.jobs).toHaveLength(1);
    expect(workflow.state.audits.map((event) => event["action"])).toEqual([
      "ALERT_CREATED", "ALERT_SUBMITTED", "ALERT_APPROVED", "ALERT_ISSUED",
    ]);
    expect(workflow.signer.sign).toHaveBeenCalledOnce();
  });

  it("serializa dos solicitudes de emisión y crea un solo outbox", async () => {
    const workflow = memoryWorkflow();
    const prepared = await workflow.createSubmitApprove();
    workflow.as(author);

    const responses = await Promise.allSettled([
      workflow.service.issue(author, cookie, prepared.alertId, { expectedDigestHex: prepared.digestHex }),
      workflow.service.issue(author, cookie, prepared.alertId, { expectedDigestHex: prepared.digestHex }),
    ]);

    expect(responses.filter((response) => response.status === "fulfilled")).toHaveLength(1);
    expect(responses.filter((response) => response.status === "rejected")).toHaveLength(1);
    expect(workflow.state.jobs).toHaveLength(1);
    expect(workflow.state.audits.filter((event) => event["action"] === "ALERT_ISSUED")).toHaveLength(1);
    expect(workflow.signer.sign).toHaveBeenCalledTimes(2);
  });

  it("firma los bytes congelados, persiste JWS/hash/messageKey y encola atomicamente", async () => {
    const { issue, state, kid, tx, prisma, sign, wasSigningDuringTransaction } = await fixture();
    const receipt = await issue();
    const alert = state.alert;
    const [protectedSegment, payloadSegment, signatureSegment] = alert.jwsCompact!.split(".");

    expect(receipt).toEqual({ alertId, lifecycleState: "SIGNED_PENDING_ANCHOR", anchorStatus: "PENDING" });
    expect(alert.lifecycleState).toBe("SIGNED_PENDING_ANCHOR");
    expect(alert.anchorStatus).toBe("PENDING");
    expect(protectedSegment).toBeDefined();
    expect(JSON.parse(Buffer.from(protectedSegment!, "base64url").toString("utf8"))).toEqual({ alg: "ES256", kid });
    expect(Buffer.from(payloadSegment!, "base64url")).toEqual(Buffer.from(payload.payloadBytes));
    expect(Buffer.from(signatureSegment!, "base64url")).toHaveLength(64);
    expect(verifyAlertJws).toHaveBeenCalledTimes(3);
    expect(sign).toHaveBeenCalledOnce();
    expect(alert.frozenPayload).toEqual(payload.payloadBytes);
    expect(Buffer.from(alert.jwsHash!).equals(Buffer.from(calculateJwsHash(alert.jwsCompact!)))).toBe(true);
    expect(Buffer.from(alert.messageKey!).equals(Buffer.from(calculateMessageKey(identity)))).toBe(true);
    expect(alert.kid).toBe(kid);
    expect(state.jobs).toHaveLength(1);
    expect(state.jobs[0]).toMatchObject({ alertId, deploymentId });
    expect(Buffer.from(state.jobs[0]?.messageKey as Uint8Array)).toEqual(Buffer.from(alert.messageKey!));
    expect(Buffer.from(state.jobs[0]?.jwsHash as Uint8Array)).toEqual(Buffer.from(alert.jwsHash!));
    expect(state.audits).toHaveLength(1);
    expect(state.audits[0]).toMatchObject({
      actorId: author.id, action: "ALERT_ISSUED", objectId: alertId,
      redactedDetails: { status: "READY_TO_SIGN_TO_SIGNED_PENDING_ANCHOR", result: "ANCHOR_JOB_ENQUEUED" },
    });
    expect(prisma.$transaction).toHaveBeenCalledTimes(2);
    expect(tx.anchorJob.create).toHaveBeenCalledOnce();
    expect(tx.alert.updateMany).toHaveBeenCalledOnce();
    expect(wasSigningDuringTransaction()).toBe(false);
  });

  it("mantiene la firma lenta fuera de cualquier transacción", async () => {
    const { issue, prisma, sign, wasSigningDuringTransaction } = await fixture({ signDelayMs: 25 });

    await issue();

    expect(sign).toHaveBeenCalledOnce();
    expect(wasSigningDuringTransaction()).toBe(false);
    expect(prisma.$transaction).toHaveBeenCalledTimes(2);
  });

  it("cancela el firmante al vencer el límite sin persistir la emisión", async () => {
    const { issue, state, sign, tx } = await fixture();
    let started!: () => void;
    const signingStarted = new Promise<void>((resolve) => { started = resolve; });
    sign.mockImplementation(async (_bytes, signal) => {
      started();
      return await new Promise<string>((_resolve, reject) => {
        signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      });
    });

    vi.useFakeTimers();
    try {
      const issuing = issue();
      const rejection = expect(issuing).rejects.toMatchObject({ code: "INTERNAL_ERROR" });
      await signingStarted;
      await vi.advanceTimersByTimeAsync(ALERT_SIGNING_TIMEOUT_MS);
      await rejection;
      expect(sign.mock.calls[0]?.[1]?.aborted).toBe(true);
      expect(state.alert.lifecycleState).toBe("READY_TO_SIGN");
      expect(state.jobs).toHaveLength(0);
      expect(state.audits).toHaveLength(0);
      expect(tx.alert.updateMany).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("descarta la firma si falla el inicio de la transacción de confirmación", async () => {
    const { issue, state, prisma, sign } = await fixture({ finalTransactionFailure: true });

    await expect(issue()).rejects.toMatchObject({ code: "INTERNAL_ERROR" });

    expect(sign).toHaveBeenCalledOnce();
    expect(prisma.$transaction).toHaveBeenCalledTimes(2);
    expect(state.alert.lifecycleState).toBe("READY_TO_SIGN");
    expect(state.alert.jwsCompact).toBeNull();
    expect(state.jobs).toHaveLength(0);
    expect(state.audits).toHaveLength(0);
  });

  it("rechaza si la aprobación cambia mientras se firma", async () => {
    const { issue, state, tx, sign } = await fixture();
    const validApproval = {
      approverId,
      alertVersion: 2,
      reviewedPayload: new Uint8Array(payload.payloadBytes),
      digest: new Uint8Array(payload.payloadDigest),
      decision: "APPROVED",
      reviewedAt: operationTime,
    };
    tx.approval.findUnique.mockResolvedValueOnce(validApproval).mockResolvedValueOnce({
      ...validApproval,
      approverId: "00000000-0000-4000-8000-000000000088",
    });
    const originalSign = sign.getMockImplementation();
    if (!originalSign) throw new Error("Missing test signer implementation");
    sign.mockImplementation(async (bytes, signal) => originalSign(bytes, signal));

    await expect(issue()).rejects.toMatchObject({ status: 409, code: "STALE_ALERT_VERSION" });

    expect(state.alert.lifecycleState).toBe("READY_TO_SIGN");
    expect(state.alert.jwsCompact).toBeNull();
    expect(state.jobs).toHaveLength(0);
    expect(tx.anchorJob.create).not.toHaveBeenCalled();
  });

  it("rechaza cambios concurrentes de versión, kid o deployment", async () => {
    const versionChange = await fixture();
    const versionSigner = versionChange.sign.getMockImplementation();
    if (!versionSigner) throw new Error("Missing test signer implementation");
    versionChange.sign.mockImplementation(async (bytes, signal) => {
      versionChange.state.alert.version += 1;
      return versionSigner(bytes, signal);
    });
    await expect(versionChange.issue()).rejects.toMatchObject({ status: 409 });
    expect(versionChange.state.alert.jwsCompact).toBeNull();
    expect(versionChange.state.jobs).toHaveLength(0);

    const keyChange = await fixture();
    const keySigner = keyChange.sign.getMockImplementation();
    if (!keySigner) throw new Error("Missing test signer implementation");
    keyChange.sign.mockImplementation(async (bytes, signal) => {
      keyChange.tx.publicKey.findMany.mockResolvedValue([]);
      return keySigner(bytes, signal);
    });
    await expect(keyChange.issue()).rejects.toMatchObject({ status: 409, code: "STALE_ALERT_VERSION" });
    expect(keyChange.state.alert.jwsCompact).toBeNull();
    expect(keyChange.state.jobs).toHaveLength(0);

    const deploymentChange = await fixture();
    const deploymentSigner = deploymentChange.sign.getMockImplementation();
    if (!deploymentSigner) throw new Error("Missing test signer implementation");
    deploymentChange.sign.mockImplementation(async (bytes, signal) => {
      deploymentChange.tx.anchorDeployment.findMany.mockResolvedValue([{ id: "00000000-0000-4000-8000-000000000099" }]);
      return deploymentSigner(bytes, signal);
    });
    await expect(deploymentChange.issue()).rejects.toMatchObject({ status: 409, code: "STALE_ALERT_VERSION" });
    expect(deploymentChange.state.alert.jwsCompact).toBeNull();
    expect(deploymentChange.state.jobs).toHaveLength(0);
  });

  it("rechaza digest obsoleto y estado incompatible sin cambiar datos", async () => {
    const stale = await fixture();
    await expect(stale.issue("0".repeat(64))).rejects.toMatchObject({ code: "STALE_ALERT_VERSION" });
    expect(stale.state.alert.lifecycleState).toBe("READY_TO_SIGN");
    expect(stale.state.jobs).toHaveLength(0);

    const wrongState = await fixture({ state: "PENDING_APPROVAL" });
    await expect(wrongState.issue()).rejects.toMatchObject({ code: "INVALID_STATE_TRANSITION" });
    expect(wrongState.state.jobs).toHaveLength(0);
  });

  it("rechaza aprobación incompatible, clave no configurada y firma fallida sin mutación", async () => {
    const missingApproval = await fixture({ missingApproval: true });
    await expect(missingApproval.issue()).rejects.toMatchObject({ code: "INVALID_STATE_TRANSITION" });
    expect(missingApproval.state.alert.lifecycleState).toBe("READY_TO_SIGN");
    expect(missingApproval.state.jobs).toHaveLength(0);

    const badApproval = await fixture({ badApproval: true });
    await expect(badApproval.issue()).rejects.toMatchObject({ code: "INVALID_STATE_TRANSITION" });
    expect(badApproval.state.alert.lifecycleState).toBe("READY_TO_SIGN");

    const badApprovalDigest = await fixture({ badApprovalDigest: true });
    await expect(badApprovalDigest.issue()).rejects.toMatchObject({ code: "INVALID_STATE_TRANSITION" });
    expect(badApprovalDigest.state.alert.lifecycleState).toBe("READY_TO_SIGN");

    const obsoleteApproval = await fixture({ badApprovalVersion: true });
    await expect(obsoleteApproval.issue()).rejects.toMatchObject({ code: "INVALID_STATE_TRANSITION" });
    expect(obsoleteApproval.state.alert.lifecycleState).toBe("READY_TO_SIGN");
    expect(obsoleteApproval.state.jobs).toHaveLength(0);

    const missingProvider = await fixture({ missingProvider: true });
    await expect(missingProvider.issue()).rejects.toMatchObject({ code: "INTERNAL_ERROR" });
    expect(missingProvider.prisma.$transaction).not.toHaveBeenCalled();

    const brokenSigner = await fixture({ signerFailure: true });
    await expect(brokenSigner.issue()).rejects.toMatchObject({ code: "INTERNAL_ERROR" });
    expect(brokenSigner.state.alert.lifecycleState).toBe("READY_TO_SIGN");
    expect(brokenSigner.state.jobs).toHaveLength(0);
  });

  it("rechaza kid no confiable o firma que no corresponde a la clave pública aprobada", async () => {
    const unknownKid = await fixture({ unknownKid: true });
    await expect(unknownKid.issue()).rejects.toMatchObject({ code: "INTERNAL_ERROR" });
    expect(unknownKid.state.alert.lifecycleState).toBe("READY_TO_SIGN");
    expect(unknownKid.state.jobs).toHaveLength(0);
    expect(unknownKid.sign).not.toHaveBeenCalled();

    const mismatchedKey = await fixture();
    mismatchedKey.sign.mockImplementation(async (bytes) => {
      const protectedSegment = Buffer.from(JSON.stringify({
        alg: "ES256", kid: mismatchedKey.kid,
      })).toString("base64url");
      const payloadSegment = Buffer.from(bytes).toString("base64url");
      return `${protectedSegment}.${payloadSegment}.${Buffer.alloc(64, 1).toString("base64url")}`;
    });
    await expect(mismatchedKey.issue()).rejects.toMatchObject({ code: "INTERNAL_ERROR" });
    expect(mismatchedKey.state.alert.lifecycleState).toBe("READY_TO_SIGN");
    expect(mismatchedKey.state.jobs).toHaveLength(0);
  });

  it("rechaza una clave de PostgreSQL que no coincide con la clave del catálogo confiable", async () => {
    const mismatch = await fixture({ untrustedCatalogKey: true });

    await expect(mismatch.issue()).rejects.toMatchObject({ code: "INTERNAL_ERROR" });
    expect(mismatch.state.alert.lifecycleState).toBe("READY_TO_SIGN");
    expect(mismatch.state.alert.jwsCompact).toBeNull();
    expect(mismatch.state.jobs).toHaveLength(0);
    expect(mismatch.state.audits).toHaveLength(0);
  });

  it("rechaza en el servicio a actores que no sean AUTHOR", async () => {
    const unauthorized = await fixture({ actor: { ...author, role: "APPROVER" } });
    await expect(unauthorized.issue()).rejects.toMatchObject({ code: "ROLE_FORBIDDEN" });
    expect(unauthorized.prisma.$transaction).not.toHaveBeenCalled();
  });

  it("previene firmas duplicadas y conflictos CAS de versión", async () => {
    const duplicate = await fixture({ state: "SIGNED_PENDING_ANCHOR" });
    await expect(duplicate.issue()).rejects.toMatchObject({ code: "INVALID_STATE_TRANSITION" });
    expect(duplicate.tx.alert.updateMany).not.toHaveBeenCalled();

    const staleCas = await fixture({ casConflict: true });
    await expect(staleCas.issue()).rejects.toMatchObject({ code: "STALE_ALERT_VERSION" });
    expect(staleCas.state.alert.lifecycleState).toBe("READY_TO_SIGN");
    expect(staleCas.state.jobs).toHaveLength(0);
    expect(staleCas.sign).toHaveBeenCalledOnce();
  });

  it("una emisión repetida idéntica devuelve conflicto sin efectos duplicados", async () => {
    const repeated = await fixture();
    await repeated.issue();
    const alertAfterFirst = structuredClone(repeated.state.alert);
    const jobsAfterFirst = [...repeated.state.jobs];
    const auditsAfterFirst = [...repeated.state.audits];
    const updateCallsAfterFirst = repeated.tx.alert.updateMany.mock.calls.length;

    await expect(repeated.issue()).rejects.toMatchObject({ status: 409, code: "INVALID_STATE_TRANSITION" });

    expect(repeated.state.alert).toEqual(alertAfterFirst);
    expect(repeated.state.jobs).toEqual(jobsAfterFirst);
    expect(repeated.state.audits).toEqual(auditsAfterFirst);
    expect(repeated.tx.alert.updateMany).toHaveBeenCalledTimes(updateCallsAfterFirst);
    expect(repeated.tx.anchorJob.create).toHaveBeenCalledTimes(1);
    expect(repeated.tx.auditEvent.create).toHaveBeenCalledTimes(1);
    expect(repeated.sign).toHaveBeenCalledTimes(1);
  });

  it("una repetición con digest distinto se rechaza sin más mutaciones", async () => {
    const repeated = await fixture();
    await repeated.issue();
    const alertAfterFirst = structuredClone(repeated.state.alert);
    const jobsAfterFirst = [...repeated.state.jobs];
    const auditsAfterFirst = [...repeated.state.audits];

    await expect(repeated.issue("0".repeat(64))).rejects.toMatchObject({
      status: 409, code: "STALE_ALERT_VERSION",
    });

    expect(repeated.state.alert).toEqual(alertAfterFirst);
    expect(repeated.state.jobs).toEqual(jobsAfterFirst);
    expect(repeated.state.audits).toEqual(auditsAfterFirst);
    expect(repeated.tx.anchorJob.create).toHaveBeenCalledTimes(1);
    expect(repeated.tx.auditEvent.create).toHaveBeenCalledTimes(1);
    expect(repeated.sign).toHaveBeenCalledTimes(1);
  });

  it("un autor distinto no puede obtener el recibo de emisión ajeno", async () => {
    const owner = await fixture();
    await owner.issue();
    const otherAuthor = { ...author, id: "00000000-0000-4000-8000-000000000099" };
    const other = await fixture({ actor: otherAuthor });

    await expect(other.issue()).rejects.toMatchObject({ status: 404, code: "ALERT_NOT_FOUND" });
    expect(other.tx.alert.updateMany).not.toHaveBeenCalled();
    expect(other.tx.anchorJob.create).not.toHaveBeenCalled();
    expect(other.tx.auditEvent.create).not.toHaveBeenCalled();
    expect(other.sign).not.toHaveBeenCalled();
  });

  it("un estado firmado incompleto falla de forma segura", async () => {
    const incomplete = await fixture({ state: "SIGNED_PENDING_ANCHOR", incompleteSignedState: true });

    await expect(incomplete.issue()).rejects.toMatchObject({
      status: 409, code: "INVALID_STATE_TRANSITION",
    });
    expect(incomplete.state.alert.jwsCompact).toBe("incomplete.persisted.jws");
    expect(incomplete.state.jobs).toHaveLength(0);
    expect(incomplete.state.audits).toHaveLength(0);
    expect(incomplete.tx.alert.updateMany).not.toHaveBeenCalled();
    expect(incomplete.sign).not.toHaveBeenCalled();
  });

  it("revierte alerta y outbox si falla su persistencia o la auditoría", async () => {
    for (const options of [{ anchorJobFailure: true }, { auditFailure: true }]) {
      const failed = await fixture(options);
      await expect(failed.issue()).rejects.toMatchObject({ code: "INTERNAL_ERROR" });
      expect(failed.state.alert.lifecycleState).toBe("READY_TO_SIGN");
      expect(failed.state.alert.jwsCompact).toBeNull();
      expect(failed.state.jobs).toHaveLength(0);
      expect(failed.state.audits).toHaveLength(0);
    }
  });

  it("usa SHA-256 del JWS compacto ASCII", async () => {
    const { issue, state } = await fixture();
    await issue();
    const expected = createHash("sha256").update(state.alert.jwsCompact!, "ascii").digest();
    expect(Buffer.from(state.alert.jwsHash!).equals(expected)).toBe(true);
  });
});
