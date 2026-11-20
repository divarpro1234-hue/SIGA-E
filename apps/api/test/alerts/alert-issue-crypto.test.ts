import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { calculateJwkThumbprint, exportJWK, generateKeyPair } from "jose";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";

import { createApp } from "../../src/app.js";
import type { PrismaClient } from "../../src/generated/prisma/client.js";
import { PrismaDraftAlertService } from "../../src/modules/alerts/alert-draft-service.js";
import {
  PrismaAnchorWorker,
  type AnchorDeploymentTrustPolicy,
  type AnchorWorkerPolicy,
} from "../../src/modules/anchor/anchor-worker.js";
import { PrismaPublicAlertService } from "../../src/modules/public/public-alert-service.js";
import type {
  AnchorConfirmation,
  AnchorDeploymentConfig,
  SorobanAnchorGateway,
} from "../../src/modules/anchor/soroban-anchor-gateway.js";
import { buildDraftPayload } from "../../src/modules/alerts/alert-payload.js";
import { validateAlertInput } from "../../src/modules/alerts/alert-input.js";
import { csrfTokenForSession } from "../../src/modules/identity/session-authentication.js";
import type { InternalUser, SessionReader } from "../../src/modules/identity/session-reader.js";
import {
  calculateJwsHash,
  calculateMessageKey,
} from "../../src/modules/signing/alert-hashes.js";
import { JoseAlertSigner } from "../../src/modules/signing/jose-alert-signer.js";
import { TrustedAlertSigningKeyProvider } from "../../src/modules/signing/trusted-alert-signing-key-provider.js";
import type { LocalAlertSignerSource } from "../../src/modules/signing/local-alert-signer-source.js";
import { InMemoryTrustedPublicKeyCatalog } from "../../src/modules/signing/trusted-public-keys.js";
import { verifyAlertJws } from "../../src/modules/signing/verify-alert-jws.js";
import { identity, input } from "./alert-fixtures.js";

const author: InternalUser = {
  id: "00000000-0000-4000-8000-000000000002",
  name: "Autor ficticio",
  email: "author@example.invalid",
  role: "AUTHOR",
  status: "ACTIVE",
};
const approverId = "00000000-0000-4000-8000-000000000003";
const alertId = "00000000-0000-4000-8000-000000000001";
const deploymentId = "00000000-0000-4000-8000-000000000004";
const sessionToken = "A".repeat(43);
const cookie = `sigae_session=${sessionToken}`;
const appOrigin = "https://sigae.example.invalid";
const csrfSecret = new Uint8Array(32).fill(7);
const operationTime = new Date(identity.sent);
const anchorJobId = "00000000-0000-4000-8000-000000000005";
const offlineDeployment: AnchorDeploymentConfig = {
  id: deploymentId,
  network: "TESTNET",
  networkPassphrase: "Test SDF Network ; September 2015",
  contractId: `C${"A".repeat(55)}`,
  wasmHash: "ab".repeat(32),
  adminPublicAddress: `G${"B".repeat(55)}`,
  generation: 1,
  trustedConfigVersion: "SIMULACRO-M5-OFFLINE-HTTP-v1",
};
const anchorWorkerPolicy: AnchorWorkerPolicy = {
  leaseDurationMs: 30_000,
  retryBaseDelayMs: 1_000,
  retryMaxDelayMs: 8_000,
  pollDelayMs: 2_000,
  maxAutomaticFailures: 3,
};

function matchesMemoryWhere(
  actual: Record<string, unknown>,
  where: Record<string, unknown>,
): boolean {
  return Object.entries(where).every(([key, expected]) => {
    if (key === "AND") {
      return (expected as Record<string, unknown>[]).every((part) =>
        matchesMemoryWhere(actual, part));
    }
    if (key === "OR") {
      return (expected as Record<string, unknown>[]).some((part) =>
        matchesMemoryWhere(actual, part));
    }
    const value = actual[key];
    if (value instanceof Uint8Array && expected instanceof Uint8Array) {
      return Buffer.from(value).equals(Buffer.from(expected));
    }
    if (value instanceof Date && expected instanceof Date) {
      return value.getTime() === expected.getTime();
    }
    if (expected && typeof expected === "object" &&
        !Array.isArray(expected) && !(expected instanceof Date) &&
        !(expected instanceof Uint8Array)) {
      const condition = expected as Record<string, unknown>;
      if ("in" in condition) {
        return (condition["in"] as unknown[]).includes(value);
      }
      if ("lte" in condition) {
        return value instanceof Date && condition["lte"] instanceof Date &&
          value.getTime() <= condition["lte"].getTime();
      }
      return false;
    }
    return value === expected;
  });
}

async function fixture(options: {
  readonly lifecycleState?: string;
  readonly decision?: string;
  readonly missingApproval?: boolean;
} = {}) {
  const keyPair = await generateKeyPair("ES256");
  const kid = "sigae-offline-real-crypto";
  const publicJwk = await exportJWK(keyPair.publicKey);
  const publicKeyRecord = {
    kid,
    publicJwk,
    thumbprint: await calculateJwkThumbprint(publicJwk, "sha256"),
    status: "ACTIVE",
    validFrom: new Date(operationTime.getTime() - 1_000),
    retiredAt: null,
    revokedAt: null,
  };
  const payload = buildDraftPayload(validateAlertInput(input, identity.sent), identity);
  const approval = {
    approverId,
    alertVersion: 2,
    reviewedPayload: Uint8Array.from(payload.payloadBytes),
    digest: Uint8Array.from(payload.payloadDigest),
    decision: options.decision ?? "APPROVED",
    reviewedAt: operationTime,
  };
  const signer = new JoseAlertSigner(keyPair.privateKey, kid);
  const sign = vi.fn(signer.sign.bind(signer));
  const signingKeyProvider = new TrustedAlertSigningKeyProvider(
    { getActiveSigner: () => ({ kid, sign }) } satisfies LocalAlertSignerSource,
    new InMemoryTrustedPublicKeyCatalog([[kid, keyPair.publicKey]]),
  );
  const state = {
    alert: {
      id: alertId,
      identifier: identity.identifier,
      lifecycleState: options.lifecycleState ?? "READY_TO_SIGN",
      anchorStatus: "NOT_REQUESTED",
      sender: identity.sender,
      sentText: identity.sent,
      authorId: author.id,
      kind: "Alert",
      severity: "Severe",
      version: 3,
      frozenPayload: Uint8Array.from(payload.payloadBytes),
      payloadSha256: Uint8Array.from(payload.payloadDigest),
      approvedPayloadSha256: Uint8Array.from(payload.payloadDigest),
      jwsCompact: null as string | null,
      kid: null as string | null,
      messageKey: null as Uint8Array | null,
      jwsHash: null as Uint8Array | null,
      publishedAt: null as Date | null,
      createdAt: operationTime,
    },
    approvals: [approval],
    jobs: [] as Array<Record<string, unknown>>,
    audits: [] as Array<Record<string, unknown>>,
    deployment: {
      ...offlineDeployment,
      state: "ACTIVE",
    },
    auditSeq: 0n,
    auditHash: new Uint8Array(32),
  };
  let workerTime = new Date(operationTime.getTime() + 60_000);
  let queryCount = 0;
  const tx = {
    $queryRaw: vi.fn(async (query: TemplateStringsArray) => {
      if (query.join("").includes("audit_chain_state")) {
        return [{ last_seq: state.auditSeq, last_hash: state.auditHash }];
      }
      queryCount += 1;
      if (queryCount === 1) return [{ id: author.id, role: author.role, status: author.status }];
      if (queryCount === 2) return [{
        user_id: author.id,
        revoked_at: null,
        expires_at: new Date(operationTime.getTime() + 60_000),
        last_seen_at: new Date(operationTime.getTime() - 1_000),
      }];
      return [{ last_seq: 0n, last_hash: new Uint8Array(32) }];
    }),
    alert: {
      findFirst: vi.fn(async ({ where }: { where: Record<string, unknown> }) =>
        matchesMemoryWhere(state.alert, where) ? structuredClone(state.alert) : null),
      updateMany: vi.fn(async ({
        where, data,
      }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        if (!matchesMemoryWhere(state.alert, where)) return { count: 0 };
        Object.assign(state.alert, data);
        return { count: 1 };
      }),
    },
    approval: {
      findUnique: vi.fn(async () => options.missingApproval ? null : structuredClone(approval)),
    },
    publicKey: {
      findMany: vi.fn(async () => [{ ...publicKeyRecord }]),
    },
    anchorDeployment: {
      findMany: vi.fn(async () => [{ ...state.deployment }]),
    },
    anchorJob: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const job = {
          id: anchorJobId,
          ...data,
          state: "PENDING",
          txHash: null,
          confirmedLedger: null,
          attemptCount: 0,
          automaticFailureCount: 0,
          nextAttemptAt: null,
          leaseUntil: null,
          lastErrorCode: null,
          sanitizedError: null,
          createdAt: operationTime,
          updatedAt: operationTime,
        };
        state.jobs.push(job);
        return job;
      }),
      findFirst: vi.fn(async () => {
        const job = state.jobs.find((candidate) => {
          const currentState = candidate["state"];
          const leaseUntil = candidate["leaseUntil"];
          const nextAttemptAt = candidate["nextAttemptAt"];
          const leaseExpired = leaseUntil === null ||
            (leaseUntil instanceof Date && leaseUntil.getTime() <= workerTime.getTime());
          if (currentState === "LEASED") return leaseExpired;
          const due = nextAttemptAt === null ||
            (nextAttemptAt instanceof Date && nextAttemptAt.getTime() <= workerTime.getTime());
          return (currentState === "PENDING" || currentState === "RETRYABLE" ||
            currentState === "SUBMITTED") && leaseExpired && due;
        });
        return job ? { ...job } : null;
      }),
      findMany: vi.fn(async ({ where }: { where: Record<string, unknown> }) =>
        state.jobs
          .filter((job) => matchesMemoryWhere(job, where))
          .map((job) => ({ ...job, deployment: { ...state.deployment } }))),
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => {
        const job = state.jobs.find((candidate) => candidate["id"] === where.id);
        return job ? { ...job, alert: state.alert, deployment: state.deployment } : null;
      }),
      updateMany: vi.fn(async ({
        where, data,
      }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        const job = state.jobs.find((candidate) =>
          matchesMemoryWhere(candidate, where));
        if (!job) return { count: 0 };
        for (const [key, value] of Object.entries(data)) {
          if ((key === "attemptCount" || key === "automaticFailureCount") &&
              value && typeof value === "object" && "increment" in value) {
            job[key] = Number(job[key]) +
              (value as { readonly increment: number }).increment;
          } else {
            job[key] = value;
          }
        }
        return { count: 1 };
      }),
    },
    auditEvent: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        state.audits.push(data);
        return data;
      }),
    },
    auditChainState: {
      update: vi.fn(async ({ data }: {
        data: { lastSeq: bigint; lastHash: Uint8Array };
      }) => {
        state.auditSeq = data.lastSeq;
        state.auditHash = Uint8Array.from(data.lastHash);
        return data;
      }),
    },
  };
  const prisma = {
    $transaction: vi.fn(async <T>(work: (client: typeof tx) => Promise<T>) => {
      queryCount = 0;
      return work(tx);
    }),
    anchorJob: {
      findUnique: tx.anchorJob.findUnique,
      findMany: tx.anchorJob.findMany,
    },
    alert: tx.alert,
    anchorDeployment: tx.anchorDeployment,
    publicKey: {
      findUnique: vi.fn(async () => ({ ...publicKeyRecord })),
    },
  } as unknown as PrismaClient;
  const service = new PrismaDraftAlertService(
    prisma,
    identity.sender,
    () => new Date(operationTime),
    undefined,
    undefined,
    signingKeyProvider,
  );

  return {
    service,
    state,
    tx,
    prisma,
    sign,
    keyPair,
    kid,
    payload,
    setWorkerTime: (value: Date) => { workerTime = new Date(value); },
  };
}

type IssueFixture = Awaited<ReturnType<typeof fixture>>;

async function issueOverHttp(subject: IssueFixture, expectedDigestHex: string) {
  const sessionReader: SessionReader = {
    findByTokenHash: vi.fn(async () => {
      const now = new Date();
      return {
        user: author,
        expiresAt: new Date(now.getTime() + 60_000),
        revokedAt: null,
        lastSeenAt: new Date(now.getTime() - 1_000),
      };
    }),
    touchIfActive: vi.fn(async () => true),
  };
  const app = createApp({
    sessionReader,
    csrfSecret,
    appOrigin,
    alertDraftService: subject.service,
  });
  const server = createServer(app);

  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("HTTP_TEST_SERVER_ADDRESS_UNAVAILABLE");
    }
    expect(address.address).toBe("127.0.0.1");
    expect(address.port).toBeGreaterThan(0);

    const response = await request(server)
      .post(`/api/v1/alerts/${alertId}/issue`)
      .set("Cookie", cookie)
      .set("Origin", appOrigin)
      .set("X-CSRF-Token", csrfTokenForSession(sessionToken, csrfSecret))
      .send({ expectedDigestHex });

    return { response, server, sessionReader };
  } finally {
    if (server.listening) {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
      });
    }
  }
}

describe("emisión M2 → M3 con criptografía real y persistencia aislada", () => {
  it("emite por HTTP una alerta Severe aprobada y conserva JWS y AnchorJob pendientes", async () => {
    const subject = await fixture();
    const sessionReader: SessionReader = {
      async findByTokenHash() {
        const now = new Date();
        return {
          user: author,
          expiresAt: new Date(now.getTime() + 60_000),
          revokedAt: null,
          lastSeenAt: new Date(now.getTime() - 1_000),
        };
      },
      async touchIfActive() { return true; },
    };
    const app = createApp({
      sessionReader,
      csrfSecret,
      appOrigin,
      alertDraftService: subject.service,
    });
    const server = createServer(app);

    expect(subject.state.alert).toMatchObject({
      lifecycleState: "READY_TO_SIGN",
      severity: "Severe",
      version: 3,
    });
    expect(Buffer.from(subject.state.alert.frozenPayload)).toEqual(
      Buffer.from(subject.payload.payloadBytes),
    );
    expect(Buffer.from(subject.state.alert.approvedPayloadSha256!)).toEqual(
      Buffer.from(subject.payload.payloadDigest),
    );
    expect(subject.state.approvals).toHaveLength(1);
    expect(subject.state.approvals[0]?.approverId).not.toBe(author.id);
    expect(subject.state.approvals[0]?.decision).toBe("APPROVED");
    expect(Buffer.from(subject.state.approvals[0]!.reviewedPayload)).toEqual(
      Buffer.from(subject.payload.payloadBytes),
    );

    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
      });
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("HTTP_TEST_SERVER_ADDRESS_UNAVAILABLE");
      }
      expect(address.address).toBe("127.0.0.1");
      expect(address.port).toBeGreaterThan(0);

      const response = await request(server)
        .post(`/api/v1/alerts/${alertId}/issue`)
        .set("Cookie", cookie)
        .set("Origin", appOrigin)
        .set("X-CSRF-Token", csrfTokenForSession(sessionToken, csrfSecret))
        .send({ expectedDigestHex: Buffer.from(subject.payload.payloadDigest).toString("hex") });

      expect(response.status).toBe(202);
      expect(response.body).toEqual({
        alertId,
        lifecycleState: "SIGNED_PENDING_ANCHOR",
        anchorStatus: "PENDING",
      });
      expect(subject.sign).toHaveBeenCalledOnce();

      const alert = subject.state.alert;
      const verified = await verifyAlertJws(
        alert.jwsCompact!,
        new InMemoryTrustedPublicKeyCatalog([[subject.kid, subject.keyPair.publicKey]]),
      );
      expect(verified).toMatchObject({ alg: "ES256", kid: subject.kid });
      expect(Buffer.from(verified.payloadBytes)).toEqual(Buffer.from(alert.frozenPayload));
      expect(Buffer.from(alert.frozenPayload)).toEqual(Buffer.from(subject.payload.payloadBytes));
      expect(Buffer.from(alert.payloadSha256)).toEqual(Buffer.from(subject.payload.payloadDigest));
      expect(Buffer.from(alert.approvedPayloadSha256!)).toEqual(
        Buffer.from(subject.payload.payloadDigest),
      );
      expect(Buffer.from(alert.jwsHash!)).toEqual(
        Buffer.from(calculateJwsHash(alert.jwsCompact!)),
      );
      expect(Buffer.from(alert.messageKey!)).toEqual(Buffer.from(calculateMessageKey(identity)));
      expect(alert).toMatchObject({
        lifecycleState: "SIGNED_PENDING_ANCHOR",
        anchorStatus: "PENDING",
        kid: subject.kid,
        publishedAt: null,
      });
      expect(subject.state.jobs).toHaveLength(1);
      expect(subject.state.jobs[0]).toMatchObject({
        alertId,
        deploymentId,
        state: "PENDING",
        messageKey: alert.messageKey,
        jwsHash: alert.jwsHash,
      });
      expect(subject.state.audits.map((event) => event["action"])).toEqual(["ALERT_ISSUED"]);
    } finally {
      if (server.listening) {
        await new Promise<void>((resolve, reject) => {
          server.close((error) => error ? reject(error) : resolve());
        });
      }
    }

    expect(server.listening).toBe(false);
  });

  it("firma el payload aprobado exacto y verifica JWS, digest, versión y hashes", async () => {
    const subject = await fixture();

    await expect(subject.service.issue(author, cookie, alertId, {
      expectedDigestHex: Buffer.from(subject.payload.payloadDigest).toString("hex"),
    })).resolves.toEqual({
      alertId,
      lifecycleState: "SIGNED_PENDING_ANCHOR",
      anchorStatus: "PENDING",
    });

    const alert = subject.state.alert;
    const verified = await verifyAlertJws(
      alert.jwsCompact!,
      new InMemoryTrustedPublicKeyCatalog([[subject.kid, subject.keyPair.publicKey]]),
    );
    expect(verified).toMatchObject({ alg: "ES256", kid: subject.kid });
    expect(Buffer.from(verified.payloadBytes).equals(Buffer.from(subject.payload.payloadBytes))).toBe(true);
    expect(Buffer.from(alert.frozenPayload).equals(Buffer.from(subject.payload.payloadBytes))).toBe(true);
    expect(Buffer.from(alert.approvedPayloadSha256!).equals(Buffer.from(subject.payload.payloadDigest))).toBe(true);
    expect(alert.version).toBe(3);
    expect(subject.tx.approval.findUnique).toHaveBeenCalledWith(expect.objectContaining({
      where: { alertId_alertVersion: { alertId, alertVersion: 2 } },
    }));
    expect(Buffer.from(alert.jwsHash!).equals(Buffer.from(calculateJwsHash(alert.jwsCompact!)))).toBe(true);
    expect(Buffer.from(alert.messageKey!).equals(Buffer.from(calculateMessageKey(identity)))).toBe(true);
    expect(alert.lifecycleState).toBe("SIGNED_PENDING_ANCHOR");
    expect(subject.state.jobs).toHaveLength(1);
    expect(subject.state.audits.map((event) => event["action"])).toEqual(["ALERT_ISSUED"]);
    expect(subject.sign).toHaveBeenCalledOnce();

    const otherPair = await generateKeyPair("ES256");
    await expect(verifyAlertJws(
      alert.jwsCompact!,
      new InMemoryTrustedPublicKeyCatalog([[subject.kid, otherPair.publicKey]]),
    )).rejects.toMatchObject({ code: "SIGNATURE_VERIFICATION_FAILED" });

    const [header, payloadSegment, signatureSegment] = alert.jwsCompact!.split(".");
    const changedPayload = `${header}.${Buffer.from("altered content").toString("base64url")}.${signatureSegment}`;
    const signatureBytes = Buffer.from(signatureSegment!, "base64url");
    signatureBytes[0] = signatureBytes[0]! ^ 0xff;
    const changedSignature = `${header}.${payloadSegment}.${signatureBytes.toString("base64url")}`;
    await expect(verifyAlertJws(
      changedPayload,
      new InMemoryTrustedPublicKeyCatalog([[subject.kid, subject.keyPair.publicKey]]),
    )).rejects.toMatchObject({ code: "SIGNATURE_VERIFICATION_FAILED" });
    await expect(verifyAlertJws(
      changedSignature,
      new InMemoryTrustedPublicKeyCatalog([[subject.kid, subject.keyPair.publicKey]]),
    )).rejects.toMatchObject({ code: "SIGNATURE_VERIFICATION_FAILED" });

    const [protectedSegment] = alert.jwsCompact!.split(".");
    expect(JSON.parse(Buffer.from(protectedSegment!, "base64url").toString("utf8"))).toEqual({
      alg: "ES256",
      kid: subject.kid,
    });
    expect(Buffer.from(alert.jwsHash!).equals(
      createHash("sha256").update(alert.jwsCompact!, "ascii").digest(),
    )).toBe(true);
    expect(subject.tx.publicKey.findMany).toHaveBeenCalled();
  });

  it("no firma alertas rechazadas ni alertas sin aprobación independiente", async () => {
    const rejected = await fixture({ lifecycleState: "REJECTED", decision: "REJECTED" });
    await expect(rejected.service.issue(author, cookie, alertId, {
      expectedDigestHex: Buffer.from(rejected.payload.payloadDigest).toString("hex"),
    })).rejects.toMatchObject({ code: "INVALID_STATE_TRANSITION" });
    expect(rejected.sign).not.toHaveBeenCalled();
    expect(rejected.state.jobs).toHaveLength(0);

    const unapproved = await fixture({ missingApproval: true });
    await expect(unapproved.service.issue(author, cookie, alertId, {
      expectedDigestHex: Buffer.from(unapproved.payload.payloadDigest).toString("hex"),
    })).rejects.toMatchObject({ code: "INVALID_STATE_TRANSITION" });
    expect(unapproved.sign).not.toHaveBeenCalled();
    expect(unapproved.state.jobs).toHaveLength(0);
  });

  it("rechaza por HTTP una alerta Severe sin aprobación independiente válida", async () => {
    const subject = await fixture({ missingApproval: true });

    const { response, server, sessionReader } = await issueOverHttp(
      subject,
      Buffer.from(subject.payload.payloadDigest).toString("hex"),
    );

    expect(response.status).toBe(409);
    expect(response.body).toMatchObject({
      status: 409,
      code: "INVALID_STATE_TRANSITION",
    });
    expect(sessionReader.findByTokenHash).toHaveBeenCalledOnce();
    expect(sessionReader.touchIfActive).toHaveBeenCalledOnce();
    expect(subject.tx.approval.findUnique).toHaveBeenCalledOnce();
    expect(subject.sign).not.toHaveBeenCalled();
    expect(subject.tx.alert.updateMany).not.toHaveBeenCalled();
    expect(subject.tx.anchorJob.create).not.toHaveBeenCalled();
    expect(subject.tx.auditEvent.create).not.toHaveBeenCalled();
    expect(subject.state.alert).toMatchObject({
      lifecycleState: "READY_TO_SIGN",
      jwsCompact: null,
      kid: null,
      messageKey: null,
      jwsHash: null,
      publishedAt: null,
    });
    expect(subject.state.jobs).toHaveLength(0);
    expect(subject.state.audits).toHaveLength(0);
    expect(server.listening).toBe(false);
  });

  it("rechaza por HTTP un digest de emisión obsoleto frente a la aprobación vigente", async () => {
    const subject = await fixture();
    const approvedDigest = Buffer.from(subject.payload.payloadDigest);
    const staleDigest = Uint8Array.from(approvedDigest);
    staleDigest[0] = staleDigest[0]! ^ 0xff;

    expect(subject.state.approvals).toHaveLength(1);
    expect(subject.state.approvals[0]?.decision).toBe("APPROVED");
    expect(subject.state.approvals[0]?.approverId).not.toBe(author.id);
    expect(Buffer.from(subject.state.approvals[0]!.digest)).toEqual(approvedDigest);
    expect(Buffer.from(subject.state.alert.approvedPayloadSha256!)).toEqual(approvedDigest);
    expect(Buffer.from(staleDigest)).not.toEqual(approvedDigest);

    const { response, server, sessionReader } = await issueOverHttp(
      subject,
      Buffer.from(staleDigest).toString("hex"),
    );

    expect(response.status).toBe(409);
    expect(response.body).toMatchObject({
      status: 409,
      code: "STALE_ALERT_VERSION",
    });
    expect(sessionReader.findByTokenHash).toHaveBeenCalledOnce();
    expect(sessionReader.touchIfActive).toHaveBeenCalledOnce();
    expect(subject.sign).not.toHaveBeenCalled();
    expect(subject.tx.alert.updateMany).not.toHaveBeenCalled();
    expect(subject.tx.anchorJob.create).not.toHaveBeenCalled();
    expect(subject.tx.auditEvent.create).not.toHaveBeenCalled();
    expect(subject.state.alert).toMatchObject({
      lifecycleState: "READY_TO_SIGN",
      jwsCompact: null,
      kid: null,
      messageKey: null,
      jwsHash: null,
      publishedAt: null,
    });
    expect(Buffer.from(subject.state.alert.frozenPayload)).toEqual(
      Buffer.from(subject.payload.payloadBytes),
    );
    expect(subject.state.jobs).toHaveLength(0);
    expect(subject.state.audits).toHaveLength(0);
    expect(server.listening).toBe(false);
  });

  it("rechaza por HTTP un JWS alterado que no verifica con la clave ES256 confiable", async () => {
    const subject = await fixture();
    const actualSign = subject.sign.getMockImplementation();
    if (!actualSign) {
      throw new Error("TEST_SIGNER_IMPLEMENTATION_MISSING");
    }

    let authenticJws: string | undefined;
    let alteredJws: string | undefined;
    subject.sign.mockImplementationOnce(async (payloadBytes, signal) => {
      authenticJws = await actualSign(payloadBytes, signal);
      const [header, payload, signature] = authenticJws.split(".");
      if (!header || !payload || !signature) {
        throw new Error("TEST_SIGNER_RETURNED_INVALID_COMPACT_JWS");
      }
      const signatureBytes = Buffer.from(signature, "base64url");
      if (signatureBytes.length !== 64) {
        throw new Error("TEST_SIGNER_RETURNED_INVALID_ES256_SIGNATURE");
      }
      signatureBytes[0] = signatureBytes[0]! ^ 1;
      alteredJws = `${header}.${payload}.${signatureBytes.toString("base64url")}`;
      return alteredJws;
    });

    const { response, server, sessionReader } = await issueOverHttp(
      subject,
      Buffer.from(subject.payload.payloadDigest).toString("hex"),
    );

    expect(response.status).toBe(500);
    expect(response.body).toMatchObject({
      status: 500,
      code: "INTERNAL_ERROR",
      detail: "La solicitud no pudo completarse.",
    });
    expect(JSON.stringify(response.body)).not.toContain("SIGNATURE_VERIFICATION_FAILED");
    expect(sessionReader.findByTokenHash).toHaveBeenCalledOnce();
    expect(sessionReader.touchIfActive).toHaveBeenCalledOnce();
    expect(subject.tx.$queryRaw).toHaveBeenCalledTimes(2);
    expect(subject.tx.approval.findUnique).toHaveBeenCalledOnce();
    expect(subject.tx.approval.findUnique.mock.invocationCallOrder[0]!).toBeLessThan(
      subject.sign.mock.invocationCallOrder[0]!,
    );
    expect(subject.sign).toHaveBeenCalledOnce();
    expect(Buffer.from(subject.sign.mock.calls[0]![0])).toEqual(
      Buffer.from(subject.payload.payloadBytes),
    );
    expect(authenticJws).toBeDefined();
    expect(alteredJws).toBeDefined();
    expect(alteredJws).not.toBe(authenticJws);

    const trustedKeys = new InMemoryTrustedPublicKeyCatalog([
      [subject.kid, subject.keyPair.publicKey],
    ]);
    const verifiedAuthentic = await verifyAlertJws(authenticJws!, trustedKeys);
    expect(Buffer.from(verifiedAuthentic.payloadBytes)).toEqual(
      Buffer.from(subject.payload.payloadBytes),
    );
    await expect(verifyAlertJws(alteredJws!, trustedKeys)).rejects.toMatchObject({
      code: "SIGNATURE_VERIFICATION_FAILED",
    });

    expect(subject.tx.alert.updateMany).not.toHaveBeenCalled();
    expect(subject.tx.anchorJob.create).not.toHaveBeenCalled();
    expect(subject.tx.auditEvent.create).not.toHaveBeenCalled();
    expect(subject.state.alert).toMatchObject({
      lifecycleState: "READY_TO_SIGN",
      anchorStatus: "NOT_REQUESTED",
      jwsCompact: null,
      kid: null,
      messageKey: null,
      jwsHash: null,
      publishedAt: null,
    });
    expect(subject.state.jobs).toHaveLength(0);
    expect(subject.state.audits).toHaveLength(0);
    expect(server.listening).toBe(false);
  });

  it("rechaza por HTTP una emisión cuando el proveedor falla durante la firma", async () => {
    const subject = await fixture();
    const providerFailureMarker = "CONTROLLED_TEST_PROVIDER_FAILURE";
    subject.sign.mockRejectedValueOnce(new Error(providerFailureMarker));

    const { response, server, sessionReader } = await issueOverHttp(
      subject,
      Buffer.from(subject.payload.payloadDigest).toString("hex"),
    );

    expect(response.status).toBe(500);
    expect(response.body).toMatchObject({
      status: 500,
      code: "INTERNAL_ERROR",
      detail: "La solicitud no pudo completarse.",
    });
    expect(JSON.stringify(response.body)).not.toContain(providerFailureMarker);
    expect(JSON.stringify(response.body)).not.toContain("SIGNATURE_OPERATION_FAILED");
    expect(sessionReader.findByTokenHash).toHaveBeenCalledOnce();
    expect(sessionReader.touchIfActive).toHaveBeenCalledOnce();
    expect(subject.tx.$queryRaw).toHaveBeenCalledTimes(2);
    expect(subject.tx.approval.findUnique).toHaveBeenCalledOnce();
    expect(subject.tx.publicKey.findMany).toHaveBeenCalledOnce();
    expect(subject.tx.anchorDeployment.findMany).toHaveBeenCalledOnce();
    expect(subject.tx.approval.findUnique.mock.invocationCallOrder[0]!).toBeLessThan(
      subject.sign.mock.invocationCallOrder[0]!,
    );
    expect(subject.sign).toHaveBeenCalledOnce();
    expect(Buffer.from(subject.sign.mock.calls[0]![0])).toEqual(
      Buffer.from(subject.payload.payloadBytes),
    );
    expect(subject.tx.alert.updateMany).not.toHaveBeenCalled();
    expect(subject.tx.anchorJob.create).not.toHaveBeenCalled();
    expect(subject.tx.auditEvent.create).not.toHaveBeenCalled();
    expect(subject.state.alert).toMatchObject({
      lifecycleState: "READY_TO_SIGN",
      anchorStatus: "NOT_REQUESTED",
      jwsCompact: null,
      kid: null,
      messageKey: null,
      jwsHash: null,
      publishedAt: null,
    });
    expect(subject.state.jobs).toHaveLength(0);
    expect(subject.state.audits).toHaveLength(0);
    expect(server.listening).toBe(false);
  });

  it("entrega al worker M5 el AnchorJob generado por HTTP sin publicar una alerta pendiente", async () => {
    const originalNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "test";

    try {
      const subject = await fixture();
      const expectedDigestHex = Buffer.from(subject.payload.payloadDigest).toString("hex");
      const approval = subject.state.approvals[0];
      if (!approval) throw new Error("TEST_APPROVAL_FIXTURE_MISSING");
      expect(approval.approverId).not.toBe(author.id);
      expect(approval.decision).toBe("APPROVED");
      expect(Buffer.from(approval.reviewedPayload)).toEqual(
        Buffer.from(subject.payload.payloadBytes),
      );

      const { response, server } = await issueOverHttp(subject, expectedDigestHex);

      expect(response.status).toBe(202);
      expect(response.body).toEqual({
        alertId,
        lifecycleState: "SIGNED_PENDING_ANCHOR",
        anchorStatus: "PENDING",
      });
      expect(server.listening).toBe(false);
      expect(subject.sign).toHaveBeenCalledOnce();
      expect(Buffer.from(subject.sign.mock.calls[0]![0])).toEqual(
        Buffer.from(approval.reviewedPayload),
      );

      const alert = subject.state.alert;
      const jwsCompact = alert.jwsCompact;
      if (!jwsCompact) throw new Error("HTTP_ISSUE_DID_NOT_PERSIST_JWS");
      const verified = await verifyAlertJws(
        jwsCompact,
        new InMemoryTrustedPublicKeyCatalog([[subject.kid, subject.keyPair.publicKey]]),
      );
      expect(verified).toMatchObject({ alg: "ES256", kid: subject.kid });
      expect(Buffer.from(verified.payloadBytes)).toEqual(
        Buffer.from(approval.reviewedPayload),
      );

      expect(subject.state.jobs).toHaveLength(1);
      expect(subject.tx.anchorJob.create).toHaveBeenCalledOnce();
      const issuedJob = subject.state.jobs[0];
      if (!issuedJob) throw new Error("HTTP_ISSUE_DID_NOT_CREATE_ANCHOR_JOB");
      const issuedJobId = issuedJob["id"];
      const issuedMessageKey = issuedJob["messageKey"];
      const issuedJwsHash = issuedJob["jwsHash"];
      if (typeof issuedJobId !== "string" ||
          !(issuedMessageKey instanceof Uint8Array) ||
          !(issuedJwsHash instanceof Uint8Array)) {
        throw new Error("HTTP_ISSUE_ANCHOR_JOB_INVALID");
      }

      const expectedMessageKey = calculateMessageKey(identity);
      const expectedJwsHash = calculateJwsHash(jwsCompact);
      const alertMessageKey = alert.messageKey;
      const alertJwsHash = alert.jwsHash;
      if (!alertMessageKey || !alertJwsHash) {
        throw new Error("HTTP_ISSUE_DID_NOT_PERSIST_ANCHOR_HASHES");
      }
      expect(issuedJob).toMatchObject({
        alertId,
        deploymentId,
        state: "PENDING",
        txHash: null,
        confirmedLedger: null,
        attemptCount: 0,
      });
      expect(Buffer.from(issuedMessageKey)).toEqual(Buffer.from(expectedMessageKey));
      expect(Buffer.from(issuedJwsHash)).toEqual(Buffer.from(expectedJwsHash));
      expect(Buffer.from(alertMessageKey)).toEqual(Buffer.from(issuedMessageKey));
      expect(Buffer.from(alertJwsHash)).toEqual(Buffer.from(issuedJwsHash));
      expect(alert).toMatchObject({
        lifecycleState: "SIGNED_PENDING_ANCHOR",
        anchorStatus: "PENDING",
        publishedAt: null,
      });

      const gateway: SorobanAnchorGateway = {
        trustDomain: "OFFLINE_LAB",
        reconcile: vi.fn<SorobanAnchorGateway["reconcile"]>(async (anchorRequest) => ({
          kind: "absent",
          deploymentId: anchorRequest.deployment.id,
          contractId: anchorRequest.deployment.contractId,
          messageKey: Uint8Array.from(anchorRequest.messageKey),
          observedContractHash: null,
          priorTransactionStatus: "NOT_APPLICABLE",
        })),
        submit: vi.fn<SorobanAnchorGateway["submit"]>(async (anchorRequest) => ({
          kind: "submitted",
          receipt: {
            deploymentId: anchorRequest.deployment.id,
            contractId: anchorRequest.deployment.contractId,
            messageKey: Uint8Array.from(anchorRequest.messageKey),
            txHash: "ab".repeat(32),
            transactionStatus: "PENDING",
          },
        })),
      };
      const deploymentTrustPolicy: AnchorDeploymentTrustPolicy = (candidate) =>
        offlineDeployment.trustedConfigVersion.startsWith("SIMULACRO-M5-OFFLINE-") &&
        candidate.id === offlineDeployment.id &&
        candidate.network === offlineDeployment.network &&
        candidate.networkPassphrase === offlineDeployment.networkPassphrase &&
        candidate.contractId === offlineDeployment.contractId &&
        candidate.wasmHash === offlineDeployment.wasmHash &&
        candidate.adminPublicAddress === offlineDeployment.adminPublicAddress &&
        candidate.generation === offlineDeployment.generation &&
        candidate.trustedConfigVersion === offlineDeployment.trustedConfigVersion;
      const workerNow = new Date(operationTime.getTime() + 60_000);
      const worker = new PrismaAnchorWorker(subject.prisma, gateway, anchorWorkerPolicy, {
        clock: { now: () => new Date(workerNow) },
        allowOfflineGateway: true,
        deploymentTrustPolicy,
      });

      await expect(worker.processNext()).resolves.toEqual({
        kind: "submitted",
        jobId: issuedJobId,
        txHash: "ab".repeat(32),
      });

      expect(subject.tx.anchorJob.findFirst).toHaveBeenCalledOnce();
      expect(subject.tx.anchorJob.findUnique).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: issuedJobId } }),
      );
      expect(subject.state.jobs).toHaveLength(1);
      expect(subject.tx.anchorJob.create).toHaveBeenCalledOnce();
      expect(gateway.reconcile).toHaveBeenCalledOnce();
      expect(gateway.submit).toHaveBeenCalledOnce();
      const reconciledRequest = vi.mocked(gateway.reconcile).mock.calls[0]?.[0];
      const submittedRequest = vi.mocked(gateway.submit).mock.calls[0]?.[0];
      if (!reconciledRequest || !submittedRequest) {
        throw new Error("OFFLINE_GATEWAY_REQUEST_MISSING");
      }
      expect(vi.mocked(gateway.reconcile).mock.calls[0]?.[1]).toBeNull();
      expect(reconciledRequest.deployment).toEqual(offlineDeployment);
      expect(reconciledRequest.attemptCount).toBe(1);
      expect(Buffer.from(reconciledRequest.messageKey)).toEqual(Buffer.from(issuedMessageKey));
      expect(Buffer.from(reconciledRequest.jwsHash)).toEqual(Buffer.from(issuedJwsHash));
      expect(Buffer.from(submittedRequest.messageKey)).toEqual(Buffer.from(issuedMessageKey));
      expect(Buffer.from(submittedRequest.jwsHash)).toEqual(Buffer.from(issuedJwsHash));
      expect(subject.state.jobs[0]).toMatchObject({
        id: issuedJobId,
        alertId,
        deploymentId,
        state: "SUBMITTED",
        txHash: "ab".repeat(32),
        confirmedLedger: null,
        attemptCount: 1,
      });
      expect(subject.state.alert).toMatchObject({
        lifecycleState: "SIGNED_PENDING_ANCHOR",
        anchorStatus: "SUBMITTED",
        publishedAt: null,
      });
      expect(subject.state.audits.map((event) => event["action"])).toEqual([
        "ALERT_ISSUED",
        "ANCHOR_JOB_CLAIMED",
        "ANCHOR_JOB_SUBMITTED",
      ]);
      expect(subject.state.audits.some((event) =>
        event["action"] === "ANCHOR_JOB_CONFIRMED")).toBe(false);
      expect(process.env.NODE_ENV).toBe("test");
    } finally {
      if (originalNodeEnv === undefined) {
        delete process.env.NODE_ENV;
      } else {
        process.env.NODE_ENV = originalNodeEnv;
      }
    }
    expect(process.env.NODE_ENV).toBe(originalNodeEnv);
  });

  it("publica en M4 solo después de confirmación sintética coincidente procesada por M5", async () => {
    const originalNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "test";

    try {
      const subject = await fixture();
      const approval = subject.state.approvals[0];
      if (!approval) throw new Error("TEST_APPROVAL_FIXTURE_MISSING");
      expect(approval.approverId).not.toBe(author.id);
      expect(approval.decision).toBe("APPROVED");

      const { response, server } = await issueOverHttp(
        subject,
        Buffer.from(subject.payload.payloadDigest).toString("hex"),
      );
      expect(response.status).toBe(202);
      expect(response.body).toEqual({
        alertId,
        lifecycleState: "SIGNED_PENDING_ANCHOR",
        anchorStatus: "PENDING",
      });
      expect(server.listening).toBe(false);
      expect(subject.state.jobs).toHaveLength(1);
      expect(subject.tx.anchorJob.create).toHaveBeenCalledOnce();

      const alert = subject.state.alert;
      const jwsCompact = alert.jwsCompact;
      const messageKey = alert.messageKey;
      const jwsHash = alert.jwsHash;
      const job = subject.state.jobs[0];
      const issuedJobId = job?.["id"];
      if (!jwsCompact || !messageKey || !jwsHash || !job ||
          !(job["messageKey"] instanceof Uint8Array) ||
          !(job["jwsHash"] instanceof Uint8Array) ||
          typeof issuedJobId !== "string") {
        throw new Error("HTTP_ISSUE_DID_NOT_PERSIST_ANCHOR_EVIDENCE");
      }

      const verified = await verifyAlertJws(
        jwsCompact,
        new InMemoryTrustedPublicKeyCatalog([[subject.kid, subject.keyPair.publicKey]]),
      );
      expect(verified).toMatchObject({ alg: "ES256", kid: subject.kid });
      expect(Buffer.from(verified.payloadBytes)).toEqual(Buffer.from(approval.reviewedPayload));
      expect(Buffer.from(verified.payloadBytes)).toEqual(Buffer.from(subject.payload.payloadBytes));
      expect(Buffer.from(messageKey)).toEqual(Buffer.from(calculateMessageKey(identity)));
      expect(Buffer.from(jwsHash)).toEqual(Buffer.from(calculateJwsHash(jwsCompact)));
      expect(Buffer.from(job["messageKey"])).toEqual(Buffer.from(messageKey));
      expect(Buffer.from(job["jwsHash"])).toEqual(Buffer.from(jwsHash));
      expect(job).toMatchObject({
        alertId,
        deploymentId,
        state: "PENDING",
        txHash: null,
        confirmedLedger: null,
      });
      expect(alert).toMatchObject({
        lifecycleState: "SIGNED_PENDING_ANCHOR",
        anchorStatus: "PENDING",
        publishedAt: null,
      });

      const publicAlerts = new PrismaPublicAlertService(subject.prisma);
      let workerNow = new Date(operationTime.getTime() + 60_000);
      subject.setWorkerTime(workerNow);
      const txHash = "cd".repeat(32);
      let confirmation: AnchorConfirmation | undefined;
      const gateway: SorobanAnchorGateway = {
        trustDomain: "OFFLINE_LAB",
        reconcile: vi.fn<SorobanAnchorGateway["reconcile"]>(
          async (anchorRequest, priorTxHash) => {
            if (priorTxHash === null) {
              return {
                kind: "absent",
                deploymentId: anchorRequest.deployment.id,
                contractId: anchorRequest.deployment.contractId,
                messageKey: Uint8Array.from(anchorRequest.messageKey),
                observedContractHash: null,
                priorTransactionStatus: "NOT_APPLICABLE",
              };
            }
            if (!confirmation) throw new Error("TEST_CONFIRMATION_NOT_PREPARED");
            return { kind: "confirmed", evidence: confirmation };
          },
        ),
        submit: vi.fn<SorobanAnchorGateway["submit"]>(async (anchorRequest) => ({
          kind: "submitted",
          receipt: {
            deploymentId: anchorRequest.deployment.id,
            contractId: anchorRequest.deployment.contractId,
            messageKey: Uint8Array.from(anchorRequest.messageKey),
            txHash,
            transactionStatus: "PENDING",
          },
        })),
      };
      const deploymentTrustPolicy: AnchorDeploymentTrustPolicy = (candidate) =>
        offlineDeployment.trustedConfigVersion.startsWith("SIMULACRO-M5-OFFLINE-") &&
        candidate.id === offlineDeployment.id &&
        candidate.network === offlineDeployment.network &&
        candidate.networkPassphrase === offlineDeployment.networkPassphrase &&
        candidate.contractId === offlineDeployment.contractId &&
        candidate.wasmHash === offlineDeployment.wasmHash &&
        candidate.adminPublicAddress === offlineDeployment.adminPublicAddress &&
        candidate.generation === offlineDeployment.generation &&
        candidate.trustedConfigVersion === offlineDeployment.trustedConfigVersion;
      const worker = new PrismaAnchorWorker(subject.prisma, gateway, anchorWorkerPolicy, {
        clock: { now: () => new Date(workerNow) },
        allowOfflineGateway: true,
        deploymentTrustPolicy,
      });

      await expect(worker.processNext()).resolves.toEqual({
        kind: "submitted",
        jobId: issuedJobId,
        txHash,
      });
      expect(subject.state.jobs).toHaveLength(1);
      expect(subject.state.jobs[0]).toMatchObject({
        id: issuedJobId,
        alertId,
        deploymentId,
        state: "SUBMITTED",
        txHash,
        confirmedLedger: null,
      });
      expect(subject.state.alert).toMatchObject({
        lifecycleState: "SIGNED_PENDING_ANCHOR",
        anchorStatus: "SUBMITTED",
        publishedAt: null,
      });
      expect(subject.state.audits.map((event) => event["action"])).toEqual([
        "ALERT_ISSUED",
        "ANCHOR_JOB_CLAIMED",
        "ANCHOR_JOB_SUBMITTED",
      ]);
      await expect(publicAlerts.get(alertId)).rejects.toMatchObject({
        status: 404,
        code: "PUBLIC_ALERT_NOT_FOUND",
        publicDetail: "La alerta no está disponible.",
      });

      const nextAttemptAt = subject.state.jobs[0]?.["nextAttemptAt"];
      if (!(nextAttemptAt instanceof Date)) {
        throw new Error("SUBMITTED_JOB_NEXT_ATTEMPT_MISSING");
      }
      workerNow = new Date(nextAttemptAt.getTime() + 1);
      subject.setWorkerTime(workerNow);
      confirmation = {
        source: "transaction_and_readback",
        deploymentId: offlineDeployment.id,
        contractId: offlineDeployment.contractId,
        messageKey: Uint8Array.from(messageKey),
        jwsHash: Uint8Array.from(jwsHash),
        txHash,
        confirmedLedger: 42n,
        verifiedAt: new Date(workerNow),
        transactionStatus: "SUCCESS",
        contractReadMatched: true,
      };

      await expect(worker.processNext()).resolves.toEqual({
        kind: "confirmed",
        jobId: issuedJobId,
      });
      expect(subject.state.jobs).toHaveLength(1);
      expect(subject.state.jobs[0]).toMatchObject({
        id: issuedJobId,
        alertId,
        deploymentId,
        state: "CONFIRMED",
        txHash,
        confirmedLedger: 42n,
        nextAttemptAt: null,
        leaseUntil: null,
      });
      const confirmedJob = subject.state.jobs[0];
      if (!confirmedJob ||
          !(confirmedJob["messageKey"] instanceof Uint8Array) ||
          !(confirmedJob["jwsHash"] instanceof Uint8Array)) {
        throw new Error("CONFIRMED_JOB_HASHES_MISSING");
      }
      expect(Buffer.from(confirmedJob["messageKey"])).toEqual(Buffer.from(messageKey));
      expect(Buffer.from(confirmedJob["jwsHash"])).toEqual(Buffer.from(jwsHash));
      expect(subject.state.alert).toMatchObject({
        lifecycleState: "PUBLISHED",
        anchorStatus: "CONFIRMED",
      });
      expect(subject.state.alert.publishedAt).toEqual(workerNow);
      expect(subject.state.audits.map((event) => event["action"])).toEqual([
        "ALERT_ISSUED",
        "ANCHOR_JOB_CLAIMED",
        "ANCHOR_JOB_SUBMITTED",
        "ANCHOR_JOB_CLAIMED",
        "ANCHOR_JOB_CONFIRMED",
      ]);
      expect(gateway.reconcile).toHaveBeenCalledTimes(2);
      expect(gateway.submit).toHaveBeenCalledOnce();
      expect(subject.tx.anchorJob.create).toHaveBeenCalledOnce();

      const published = await publicAlerts.get(alertId);
      expect(published.alert).toMatchObject({
        id: alertId,
        lifecycleState: "PUBLISHED",
        anchorStatus: "CONFIRMED",
        sender: identity.sender,
        sent: identity.sent,
        status: "Exercise",
        scope: "Public",
        notice: "SIMULACRO",
      });
      expect(published.alert).not.toHaveProperty("authorId");
      expect(published.jwsCompact).toBe(jwsCompact);
      expect(published.signatureMeta).toEqual({ alg: "ES256", kid: subject.kid });
      const verifiedPublicJws = await verifyAlertJws(
        published.jwsCompact,
        new InMemoryTrustedPublicKeyCatalog([[subject.kid, subject.keyPair.publicKey]]),
      );
      expect(Buffer.from(verifiedPublicJws.payloadBytes)).toEqual(
        Buffer.from(approval.reviewedPayload),
      );
      expect(published.anchorEvidenceMeta).toEqual({
        network: "testnet",
        contractId: offlineDeployment.contractId,
        anchorStatus: "CONFIRMED",
        messageKeyHex: Buffer.from(messageKey).toString("hex"),
        jwsHashHex: Buffer.from(jwsHash).toString("hex"),
        txHash,
        checkedAt: null,
        verificationSource: "backend_metadata",
        note: "Metadata del backend; no es una lectura independiente de Soroban.",
      });
    } finally {
      if (originalNodeEnv === undefined) {
        delete process.env.NODE_ENV;
      } else {
        process.env.NODE_ENV = originalNodeEnv;
      }
    }
    expect(process.env.NODE_ENV).toBe(originalNodeEnv);
  });
});
