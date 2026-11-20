import { createHash, randomUUID } from "node:crypto";
import { calculateJwkThumbprint, exportJWK, generateKeyPair, type CryptoKey } from "jose";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PrismaClient } from "../../src/generated/prisma/client.js";
import { createApp } from "../../src/app.js";
import { csrfTokenForSession } from "../../src/modules/identity/session-authentication.js";
import type { InternalUser, SessionReader } from "../../src/modules/identity/session-reader.js";
import { calculateJwsHash, calculateMessageKey } from "../../src/modules/signing/alert-hashes.js";
import type { AlertSigner } from "../../src/modules/signing/alert-signer.js";
import type { AlertSigningKeyProvider } from "../../src/modules/signing/alert-signing-key-provider.js";
import { JoseAlertSigner } from "../../src/modules/signing/jose-alert-signer.js";
import { InMemoryTrustedPublicKeyCatalog } from "../../src/modules/signing/trusted-public-keys.js";
import { verifyAlertJws } from "../../src/modules/signing/verify-alert-jws.js";
import { guardedRead, guardedWrite, guardedIssueService, ensureSyntheticDeployment, evidence,
  openM3IssueLab, seedM3Actor, seedM3Approver, seedSyntheticPublicKey,
  type M3FailureEvidence } from "./harness.js";
import { syntheticInput } from "../m2-postgres/harness.js";

const appOrigin = "https://sigae.example.invalid";
const csrfSecret = new Uint8Array(32).fill(9);
function canonicalAuditJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number" && Number.isSafeInteger(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalAuditJson).join(",")}]`;
  if (value && typeof value === "object" &&
      (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)) {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).sort().map((key) =>
      `${JSON.stringify(key)}:${canonicalAuditJson(object[key])}`).join(",")}}`;
  }
  throw new Error("M3_ISSUE_AUDIT_REPRESENTATION_UNSUPPORTED");
}

interface SigningFixture {
  readonly kid: string;
  readonly signer: AlertSigner;
  readonly provider: AlertSigningKeyProvider;
  readonly publicKey: CryptoKey;
  setBeforeSign(callback: ((signal?: AbortSignal) => Promise<void>) | undefined): void;
  setActiveSigner(signer: AlertSigner): void;
  setTrustedPublicKey(kid: string, key: CryptoKey): void;
}

async function createSigningFixture(writer: PrismaClient): Promise<SigningFixture> {
  const pair = await generateKeyPair("ES256");
  const kid = `m3-issue-synthetic-${randomUUID()}`;
  const joseSigner = new JoseAlertSigner(pair.privateKey, kid);
  let beforeSign: ((signal?: AbortSignal) => Promise<void>) | undefined;
  let activeSigner: AlertSigner = {
    kid,
    async sign(bytes, signal) {
      await beforeSign?.(signal);
      if (signal?.aborted) throw new Error("M3_TEST_SIGNING_CANCELLED");
      return joseSigner.sign(bytes, signal);
    },
  };
  const trustedKeys = new Map<string, CryptoKey>([[kid, pair.publicKey]]);
  const exported = await exportJWK(pair.publicKey);
  const publicJwk = { ...exported, kid };
  const thumbprint = await calculateJwkThumbprint(exported, "sha256");
  await seedSyntheticPublicKey(writer, kid, publicJwk, thumbprint);
  return {
    kid,
    signer: activeSigner,
    provider: {
      getActiveSigner: () => activeSigner,
      getTrustedPublicKey: (candidate) => {
        const key = trustedKeys.get(candidate);
        if (!key) throw new Error("M3_TEST_UNTRUSTED_KID");
        return key;
      },
    },
    publicKey: pair.publicKey,
    setBeforeSign(callback) { beforeSign = callback; },
    setActiveSigner(signer) { activeSigner = signer; },
    setTrustedPublicKey(candidate, key) { trustedKeys.set(candidate, key); },
  };
}

describe("M3 PostgreSQL aislado: emisión con firma efímera de laboratorio", () => {
  let writer: PrismaClient;
  let observer: PrismaClient;
  let lockClient: Awaited<ReturnType<typeof openM3IssueLab>>["lockClient"];
  let syntheticDeploymentId: string;

  beforeAll(async () => {
    ({ writer, observer, lockClient } = await openM3IssueLab());
    syntheticDeploymentId = await ensureSyntheticDeployment(writer);
  });

  afterAll(async () => {
    await Promise.all([
      writer?.$disconnect(),
      observer?.$disconnect(),
      lockClient?.end(),
    ]);
  });

  async function inspect(alertId: string, afterSeq?: bigint) {
    return guardedRead(observer, async (tx) => {
      const alert = await tx.alert.findUniqueOrThrow({ where: { id: alertId } });
      const approvals = await tx.approval.findMany({
        where: { alertId }, orderBy: [{ alertVersion: "asc" }, { id: "asc" }],
      });
      const jobs = await tx.anchorJob.findMany({ where: { alertId }, orderBy: { createdAt: "asc" } });
      const events = await tx.auditEvent.findMany({
        where: { objectType: "alert", objectId: alertId }, orderBy: { seq: "asc" },
      });
      const head = await tx.auditChainState.findUniqueOrThrow({ where: { id: 1 } });
      const newEvents = afterSeq === undefined ? [] : await tx.auditEvent.findMany({
        where: { seq: { gt: afterSeq } }, orderBy: { seq: "asc" },
      });
      return { alert, approvals, jobs, events, head, newEvents };
    });
  }

  function assertAuditSegment(before: Awaited<ReturnType<typeof inspect>>,
    after: Awaited<ReturnType<typeof inspect>>, actions: string[]) {
    expect(after.newEvents.map((event) => event.action)).toEqual(actions);
    let seq = before.head.lastSeq;
    let hash = Buffer.from(before.head.lastHash);
    for (const event of after.newEvents) {
      seq += 1n;
      expect(event.seq).toBe(seq);
      expect(Buffer.from(event.previousHash)).toEqual(hash);
      const canonical = canonicalAuditJson({
        seq: event.seq.toString(10), occurredAt: event.occurredAt.toISOString(),
        actorId: event.actorId, action: event.action, objectType: event.objectType,
        objectId: event.objectId, redactedDetails: event.redactedDetails,
      });
      hash = createHash("sha256").update(hash).update(canonical, "utf8").digest();
      expect(Buffer.from(event.eventHash)).toEqual(hash);
    }
    expect(after.head.lastSeq).toBe(seq);
    expect(Buffer.from(after.head.lastHash)).toEqual(hash);
  }

  async function prepareReadyAlert() {
    const author = await seedM3Actor(writer);
    const approver = await seedM3Approver(writer);
    const signing = await createSigningFixture(writer);
    const service = guardedIssueService(writer, signing.provider);
    const created = await service.create(author.actor, author.cookie, syntheticInput(author.runId, "Severe"));
    const submitted = await service.submit(author.actor, author.cookie, created.alert.id, created.version);
    const beforeApproval = await inspect(created.alert.id);
    const approved = await service.approve(approver.actor, approver.cookie, created.alert.id, {
      expectedDigestHex: createHash("sha256").update(beforeApproval.alert.frozenPayload).digest("hex"),
      expectedVersion: submitted.version,
    });
    expect(approved.alert.lifecycleState).toBe("READY_TO_SIGN");
    const beforeIssue = await inspect(created.alert.id);
    return { author, approver, signing, service, created, beforeIssue };
  }

  async function issueOverHttp(fixture: Pick<Awaited<ReturnType<typeof prepareReadyAlert>>,
    "author" | "created" | "service" | "beforeIssue">,
    service = fixture.service, digestHex = Buffer.from(fixture.beforeIssue.alert.payloadSha256).toString("hex")) {
    const user: InternalUser = fixture.author.actor;
    const sessionReader: SessionReader = {
      async findByTokenHash() {
        return { user, expiresAt: new Date(Date.now() + 60_000), revokedAt: null,
          lastSeenAt: new Date(Date.now() - 1_000) };
      },
      async touchIfActive() { return true; },
    };
    const app = createApp({ sessionReader, csrfSecret, appOrigin, alertDraftService: service });
    const token = fixture.author.cookie.slice("sigae_session=".length);
    return request(app).post(`/api/v1/alerts/${fixture.created.alert.id}/issue`)
      .set("Cookie", fixture.author.cookie)
      .set("Origin", appOrigin)
      .set("X-CSRF-Token", csrfTokenForSession(token, csrfSecret))
      .send({ expectedDigestHex: digestHex });
  }

  async function expectNoEmission(alertId: string, afterSeq: bigint) {
    const after = await inspect(alertId, afterSeq);
    expect(after.alert.lifecycleState).toBe("READY_TO_SIGN");
    expect(after.alert.anchorStatus).toBe("NOT_REQUESTED");
    expect(after.alert.jwsCompact).toBeNull();
    expect(after.alert.kid).toBeNull();
    expect(after.alert.messageKey).toBeNull();
    expect(after.alert.jwsHash).toBeNull();
    expect(after.jobs).toHaveLength(0);
    expect(after.newEvents).toHaveLength(0);
    expect(after.head.lastSeq).toBe(afterSeq);
    return after;
  }

  it("A: emite Severe, verifica JWS, bytes, hashes, AnchorJob y cadena por observador", async () => {
    const fixture = await prepareReadyAlert();
    const response = await issueOverHttp(fixture);
    const after = await inspect(fixture.created.alert.id, fixture.beforeIssue.head.lastSeq);
    const alert = after.alert;

    expect(response.status).toBe(202);
    expect(response.body).toEqual({
      alertId: fixture.created.alert.id,
      lifecycleState: "SIGNED_PENDING_ANCHOR",
      anchorStatus: "PENDING",
    });
    expect(alert.lifecycleState).toBe("SIGNED_PENDING_ANCHOR");
    expect(alert.anchorStatus).toBe("PENDING");
    expect(alert.jwsCompact).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u);
    expect(alert.kid).toBe(fixture.signing.kid);
    expect(Buffer.from(alert.frozenPayload)).toEqual(Buffer.from(fixture.beforeIssue.alert.frozenPayload));
    const verified = await verifyAlertJws(alert.jwsCompact!, new InMemoryTrustedPublicKeyCatalog([
      [fixture.signing.kid, fixture.signing.publicKey],
    ]));
    expect(verified.kid).toBe(fixture.signing.kid);
    expect(Buffer.from(verified.payloadBytes)).toEqual(Buffer.from(alert.frozenPayload));
    expect(Buffer.from(alert.jwsHash!)).toEqual(Buffer.from(calculateJwsHash(alert.jwsCompact!)));
    expect(Buffer.from(alert.messageKey!)).toEqual(Buffer.from(calculateMessageKey({
      sender: alert.sender, identifier: alert.identifier, sent: alert.sentText,
    })));
    expect(after.approvals).toHaveLength(1);
    expect(after.approvals[0]).toMatchObject({
      approverId: fixture.approver.actor.id, decision: "APPROVED",
    });
    expect(after.jobs).toHaveLength(1);
    expect(after.jobs[0]).toMatchObject({
      alertId: fixture.created.alert.id, deploymentId: syntheticDeploymentId, state: "PENDING",
    });
    expect(after.jobs[0]!.txHash).toBeNull();
    expect(after.events.filter((event) => event.action === "ALERT_ISSUED")).toHaveLength(1);
    expect(after.newEvents.map((event) => event.action)).toEqual(["ALERT_ISSUED"]);
    expect(after.newEvents[0]).toMatchObject({
      actorId: fixture.author.actor.id, objectId: fixture.created.alert.id,
      redactedDetails: {
        kind: "Alert", status: "READY_TO_SIGN_TO_SIGNED_PENDING_ANCHOR",
        result: "ANCHOR_JOB_ENQUEUED",
      },
    });
    assertAuditSegment(fixture.beforeIssue, after, ["ALERT_ISSUED"]);
    expect(syntheticDeploymentId).toBeTruthy();
    evidence(fixture.author.runId, fixture.created.alert.id,
      "EPHEMERAL_TEST_KEY_JOSE_VERIFIED_PENDING_ANCHOR_NO_PRODUCTION_SIGNER");
  });

  it("B: digest incompatible no conserva firma, AnchorJob ni evento de emisión", async () => {
    const fixture = await prepareReadyAlert();
    const response = await issueOverHttp(fixture, fixture.service, "0".repeat(64));
    const after = await inspect(fixture.created.alert.id, fixture.beforeIssue.head.lastSeq);

    expect(response.status).toBe(409);
    expect(response.body.code).toBe("STALE_ALERT_VERSION");
    expect(after.alert.lifecycleState).toBe("READY_TO_SIGN");
    expect(after.alert.jwsCompact).toBeNull();
    expect(after.alert.jwsHash).toBeNull();
    expect(after.jobs).toHaveLength(0);
    expect(after.newEvents).toHaveLength(0);
    assertAuditSegment(fixture.beforeIssue, after, []);
    evidence(fixture.author.runId, fixture.created.alert.id, "REJECTED_BAD_DIGEST_NO_WRITE");
  });

  it("B: estado incompatible no conserva firma, AnchorJob ni evento de emisión", async () => {
    const author = await seedM3Actor(writer);
    const signing = await createSigningFixture(writer);
    const service = guardedIssueService(writer, signing.provider);
    const created = await service.create(author.actor, author.cookie, syntheticInput(author.runId, "Severe"));
    const before = await inspect(created.alert.id);
    const response = await issueOverHttp({ author, created, service, beforeIssue: before });
    const after = await inspect(created.alert.id, before.head.lastSeq);

    expect(response.status).toBe(409);
    expect(response.body.code).toBe("INVALID_STATE_TRANSITION");
    expect(after.alert.lifecycleState).toBe("DRAFT");
    expect(after.alert.jwsCompact).toBeNull();
    expect(after.jobs).toHaveLength(0);
    expect(after.newEvents).toHaveLength(0);
    assertAuditSegment(before, after, []);
    evidence(author.runId, created.alert.id, "REJECTED_WRONG_STATE_NO_WRITE");
  });

  it("C: emisión repetida devuelve conflicto sin duplicar firma, AnchorJob ni auditoría", async () => {
    const fixture = await prepareReadyAlert();
    const first = await issueOverHttp(fixture);
    expect(first.status).toBe(202);
    const afterFirst = await inspect(fixture.created.alert.id);
    const second = await issueOverHttp(fixture);
    const afterSecond = await inspect(fixture.created.alert.id, afterFirst.head.lastSeq);

    expect(second.status).toBe(409);
    expect(second.body.code).toBe("INVALID_STATE_TRANSITION");
    expect(afterSecond.alert.jwsCompact).toBe(afterFirst.alert.jwsCompact);
    expect(Buffer.from(afterSecond.alert.jwsHash!)).toEqual(Buffer.from(afterFirst.alert.jwsHash!));
    expect(afterSecond.jobs).toHaveLength(1);
    expect(afterSecond.newEvents).toHaveLength(0);
    expect(afterSecond.head.lastSeq).toBe(afterFirst.head.lastSeq);
    expect(Buffer.from(afterSecond.head.lastHash)).toEqual(Buffer.from(afterFirst.head.lastHash));
    evidence(fixture.author.runId, fixture.created.alert.id, "REPEAT_CONFLICT_NO_DUPLICATE_EFFECT");
  });

  it("dos solicitudes HTTP concurrentes producen una única emisión y un AnchorJob", async () => {
    const fixture = await prepareReadyAlert();
    const [first, second] = await Promise.all([
      issueOverHttp(fixture),
      issueOverHttp(fixture),
    ]);
    const after = await inspect(fixture.created.alert.id, fixture.beforeIssue.head.lastSeq);

    expect([first.status, second.status].sort()).toEqual([202, 409]);
    expect(after.alert.lifecycleState).toBe("SIGNED_PENDING_ANCHOR");
    expect(after.jobs).toHaveLength(1);
    expect(after.newEvents.map((event) => event.action)).toEqual(["ALERT_ISSUED"]);
    assertAuditSegment(fixture.beforeIssue, after, ["ALERT_ISSUED"]);
    evidence(fixture.author.runId, fixture.created.alert.id, "CONCURRENT_ISSUE_SINGLE_OUTBOX");
  });

  it("un fallo del firmante no emite ni altera datos y permite reintento limpio", async () => {
    const fixture = await prepareReadyAlert();
    fixture.signing.setBeforeSign(async () => { throw new Error("M3_TEST_SYNTHETIC_SIGNER_FAILURE"); });
    const failed = await issueOverHttp(fixture);
    await expectNoEmission(fixture.created.alert.id, fixture.beforeIssue.head.lastSeq);
    expect(failed.status).toBe(500);
    expect(failed.body.code).toBe("INTERNAL_ERROR");

    fixture.signing.setBeforeSign(undefined);
    const retry = await issueOverHttp(fixture);
    const after = await inspect(fixture.created.alert.id, fixture.beforeIssue.head.lastSeq);
    expect(retry.status).toBe(202);
    expect(after.jobs).toHaveLength(1);
    expect(after.newEvents.map((event) => event.action)).toEqual(["ALERT_ISSUED"]);
    evidence(fixture.author.runId, fixture.created.alert.id, "SIGNER_FAILURE_CLEAN_RETRY");
  });

  it("un timeout de firma cancela el trabajo antes de persistir y permite reintento", async () => {
    const fixture = await prepareReadyAlert();
    let aborted = false;
    fixture.signing.setBeforeSign((signal) => new Promise<void>((_resolve, reject) => {
      signal?.addEventListener("abort", () => {
        aborted = true;
        reject(new Error("M3_TEST_SIGNING_ABORTED"));
      }, { once: true });
    }));
    const timedOut = await issueOverHttp(fixture);
    await expectNoEmission(fixture.created.alert.id, fixture.beforeIssue.head.lastSeq);
    expect(timedOut.status).toBe(500);
    expect(timedOut.body.code).toBe("INTERNAL_ERROR");
    expect(aborted).toBe(true);

    fixture.signing.setBeforeSign(undefined);
    expect((await issueOverHttp(fixture)).status).toBe(202);
    evidence(fixture.author.runId, fixture.created.alert.id, "SIGNING_TIMEOUT_CANCELLED_CLEAN_RETRY");
  }, 15_000);

  it("una versión cambiada durante la firma se rechaza y el recurso se recupera", async () => {
    const fixture = await prepareReadyAlert();
    const originalVersion = fixture.beforeIssue.alert.version;
    const originalUpdatedAt = fixture.beforeIssue.alert.updatedAt;
    fixture.signing.setBeforeSign(async () => {
      await guardedWrite(writer, async (tx) => {
        await tx.alert.update({
          where: { id: fixture.created.alert.id },
          data: { version: originalVersion + 1 },
        });
      });
    });
    const conflict = await issueOverHttp(fixture);
    expect(conflict.status).toBe(409);
    const changed = await inspect(fixture.created.alert.id);
    expect(changed.alert.lifecycleState).toBe("READY_TO_SIGN");
    expect(changed.alert.version).toBe(originalVersion + 1);
    expect(changed.alert.jwsCompact).toBeNull();
    expect(changed.jobs).toHaveLength(0);

    fixture.signing.setBeforeSign(undefined);
    await guardedWrite(writer, async (tx) => {
      await tx.alert.update({
        where: { id: fixture.created.alert.id },
        data: { version: originalVersion, updatedAt: originalUpdatedAt },
      });
    });
    expect((await issueOverHttp(fixture)).status).toBe(202);
    expect((await inspect(fixture.created.alert.id)).jobs).toHaveLength(1);
    evidence(fixture.author.runId, fixture.created.alert.id, "VERSION_CONFLICT_RESTORED_AND_REISSUED");
  });

  it("una aprobación modificada durante la firma invalida la confirmación y recupera tras restaurar", async () => {
    const fixture = await prepareReadyAlert();
    const originalDigest = Buffer.from(fixture.beforeIssue.approvals[0]!.digest);
    const approvalId = fixture.beforeIssue.approvals[0]!.id;
    fixture.signing.setBeforeSign(async () => {
      await guardedWrite(writer, async (tx) => {
        await tx.approval.update({
          where: { id: approvalId },
          data: { digest: Buffer.alloc(32, 7) },
        });
      });
    });
    const conflict = await issueOverHttp(fixture);
    expect(conflict.status).toBe(409);
    await expectNoEmission(fixture.created.alert.id, fixture.beforeIssue.head.lastSeq);

    fixture.signing.setBeforeSign(undefined);
    await guardedWrite(writer, async (tx) => {
      await tx.approval.update({
        where: { id: approvalId },
        data: { digest: originalDigest },
      });
    });
    expect((await issueOverHttp(fixture)).status).toBe(202);
    evidence(fixture.author.runId, fixture.created.alert.id, "STALE_APPROVAL_RESTORED_AND_REISSUED");
  });

  it("cambios concurrentes de kid, clave activa o deployment impiden confirmar", async () => {
    const kidFixture = await prepareReadyAlert();
    const replacementSigner: AlertSigner = {
      kid: `m3-issue-synthetic-replacement-${randomUUID()}`,
      sign: async () => { throw new Error("M3_TEST_REPLACEMENT_SIGNER_NOT_CALLED"); },
    };
    kidFixture.signing.setBeforeSign(async () => {
      kidFixture.signing.setActiveSigner(replacementSigner);
    });
    const kidResponse = await issueOverHttp(kidFixture);
    expect(kidResponse.status).toBe(500);
    await expectNoEmission(kidFixture.created.alert.id, kidFixture.beforeIssue.head.lastSeq);
    kidFixture.signing.setBeforeSign(undefined);
    kidFixture.signing.setActiveSigner(kidFixture.signing.signer);
    expect((await issueOverHttp(kidFixture)).status).toBe(202);

    const keyFixture = await prepareReadyAlert();
    keyFixture.signing.setBeforeSign(async () => {
      await guardedWrite(writer, async (tx) => {
        await tx.publicKey.update({
          where: { kid: keyFixture.signing.kid },
          data: { status: "RETIRED", retiredAt: new Date() },
        });
      });
    });
    const keyResponse = await issueOverHttp(keyFixture);
    expect(keyResponse.status).toBe(409);
    await expectNoEmission(keyFixture.created.alert.id, keyFixture.beforeIssue.head.lastSeq);
    keyFixture.signing.setBeforeSign(undefined);
    await guardedWrite(writer, async (tx) => {
      await tx.publicKey.update({
        where: { kid: keyFixture.signing.kid },
        data: { status: "ACTIVE", retiredAt: null },
      });
    });
    expect((await issueOverHttp(keyFixture)).status).toBe(202);

    const deploymentFixture = await prepareReadyAlert();
    let replacementDeploymentId: string | undefined;
    deploymentFixture.signing.setBeforeSign(async () => {
      replacementDeploymentId = await guardedWrite(writer, async (tx) => {
        await tx.anchorDeployment.update({
          where: { id: syntheticDeploymentId },
          data: { state: "RETIRED" },
        });
        const maximum = await tx.anchorDeployment.aggregate({
          where: { network: "TESTNET" },
          _max: { generation: true },
        });
        const marker = randomUUID();
        const replacement = await tx.anchorDeployment.create({
          data: {
            network: "TESTNET",
            networkPassphrase: "SIMULACRO-LOCAL-NO-NETWORK",
            contractId: `SIMULACRO-LOCAL-M3-ISSUE-${marker}`,
            wasmHash: createHash("sha256").update(marker, "utf8").digest("hex"),
            adminPublicAddress: `SIMULACRO-LOCAL-NO-ACCOUNT-${marker}`,
            generation: (maximum._max.generation ?? 0) + 1,
            state: "ACTIVE",
            deployedAt: new Date(),
            trustedConfigVersion: "SIMULACRO-LOCAL-M3-ISSUE-v1",
          },
          select: { id: true },
        });
        return replacement.id;
      });
    });
    try {
      const deploymentResponse = await issueOverHttp(deploymentFixture);
      expect(deploymentResponse.status).toBe(409);
      await expectNoEmission(deploymentFixture.created.alert.id, deploymentFixture.beforeIssue.head.lastSeq);
    } finally {
      deploymentFixture.signing.setBeforeSign(undefined);
      await guardedWrite(writer, async (tx) => {
        if (replacementDeploymentId) {
          await tx.anchorDeployment.delete({ where: { id: replacementDeploymentId } });
        }
        await tx.anchorDeployment.update({
          where: { id: syntheticDeploymentId },
          data: { state: "ACTIVE" },
        });
      });
    }
    expect((await issueOverHttp(deploymentFixture)).status).toBe(202);
    evidence(deploymentFixture.author.runId, deploymentFixture.created.alert.id,
      "KID_KEY_DEPLOYMENT_REVALIDATION_PASSED");
  });

  it("rechaza una clave confiable cambiada durante la firma", async () => {
    const fixture = await prepareReadyAlert();
    const replacement = await generateKeyPair("ES256");
    fixture.signing.setBeforeSign(async () => {
      fixture.signing.setTrustedPublicKey(fixture.signing.kid, replacement.publicKey);
    });

    const response = await issueOverHttp(fixture);
    expect(response.status).toBe(500);
    await expectNoEmission(fixture.created.alert.id, fixture.beforeIssue.head.lastSeq);
    fixture.signing.setBeforeSign(undefined);
    fixture.signing.setTrustedPublicKey(fixture.signing.kid, fixture.signing.publicKey);
    expect((await issueOverHttp(fixture)).status).toBe(202);
  });

  it.each([
    ["durante la creación", "during_anchor_job_create", false],
    ["después de crear el AnchorJob", "after_anchor_job_create", true],
    ["después de insertar la auditoría", "after_audit_create", true],
  ] as const)("revierte todo si falla %s", async (_label, failure, expectedInjection) => {
    const fixture = await prepareReadyAlert();
    const injection: M3FailureEvidence = {
      afterAlertUpdate: false,
      afterAnchorJobCreate: false,
      afterAuditCreate: false,
    };
    const failingService = guardedIssueService(writer, fixture.signing.provider, failure, injection);
    const response = await issueOverHttp(fixture, failingService);
    const after = await expectNoEmission(fixture.created.alert.id, fixture.beforeIssue.head.lastSeq);

    expect(response.status).toBe(500);
    expect(response.body.code).toBe("INTERNAL_ERROR");
    if (failure === "after_anchor_job_create") expect(injection.afterAnchorJobCreate).toBe(expectedInjection);
    if (failure === "after_audit_create") expect(injection.afterAuditCreate).toBe(expectedInjection);
    assertAuditSegment(fixture.beforeIssue, after, []);
  });

  it("D: una excepción después del CAS final revierte alerta, outbox y auditoría", async () => {
    const fixture = await prepareReadyAlert();
    const injection: M3FailureEvidence = {
      afterAlertUpdate: false,
      afterAnchorJobCreate: false,
      afterAuditCreate: false,
    };
    const failingService = guardedIssueService(writer, fixture.signing.provider,
      "after_alert_update", injection);
    const response = await issueOverHttp(fixture, failingService);
    const after = await inspect(fixture.created.alert.id, fixture.beforeIssue.head.lastSeq);

    expect(injection.afterAlertUpdate).toBe(true);
    expect(response.status).toBe(500);
    expect(response.body.code).toBe("INTERNAL_ERROR");
    expect(after.alert.lifecycleState).toBe("READY_TO_SIGN");
    expect(after.alert.anchorStatus).toBe("NOT_REQUESTED");
    expect(after.alert.jwsCompact).toBeNull();
    expect(after.alert.kid).toBeNull();
    expect(after.alert.messageKey).toBeNull();
    expect(after.alert.jwsHash).toBeNull();
    expect(after.jobs).toHaveLength(0);
    expect(after.newEvents).toHaveLength(0);
    expect(after.head.lastSeq).toBe(fixture.beforeIssue.head.lastSeq);
    expect(Buffer.from(after.head.lastHash)).toEqual(Buffer.from(fixture.beforeIssue.head.lastHash));
    evidence(fixture.author.runId, fixture.created.alert.id, "ROLLBACK_AFTER_FINAL_ALERT_CAS");
  });

  it("recupera una alerta íntegra tras rollback de outbox y no altera otros recursos", async () => {
    const fixture = await prepareReadyAlert();
    const unrelatedBefore = await guardedRead(observer, async (tx) => ({
      users: await tx.user.count(),
      alerts: await tx.alert.count(),
      jobs: await tx.anchorJob.count(),
    }));
    const failingService = guardedIssueService(writer, fixture.signing.provider,
      "after_anchor_job_create", {
        afterAlertUpdate: false,
        afterAnchorJobCreate: false,
        afterAuditCreate: false,
      });
    const failed = await issueOverHttp(fixture, failingService);
    await expectNoEmission(fixture.created.alert.id, fixture.beforeIssue.head.lastSeq);
    expect(failed.status).toBe(500);
    expect((await issueOverHttp(fixture)).status).toBe(202);
    const unrelatedAfter = await guardedRead(observer, async (tx) => ({
      users: await tx.user.count(),
      alerts: await tx.alert.count(),
      jobs: await tx.anchorJob.count(),
    }));
    expect(unrelatedAfter.users).toBe(unrelatedBefore.users);
    expect(unrelatedAfter.alerts).toBe(unrelatedBefore.alerts);
    expect(unrelatedAfter.jobs).toBe(unrelatedBefore.jobs + 1);
    evidence(fixture.author.runId, fixture.created.alert.id, "RECOVERED_ONLY_TEST_OWNED_ALERT");
  });

  it("E: sin proveedor de clave falla antes de la transacción y no altera PostgreSQL", async () => {
    const fixture = await prepareReadyAlert();
    const before = await inspect(fixture.created.alert.id);
    const unavailable = guardedIssueService(writer, undefined);
    const response = await issueOverHttp(fixture, unavailable);
    const after = await inspect(fixture.created.alert.id, before.head.lastSeq);

    expect(response.status).toBe(500);
    expect(response.body.code).toBe("INTERNAL_ERROR");
    expect(after.alert.lifecycleState).toBe("READY_TO_SIGN");
    expect(after.alert.jwsCompact).toBeNull();
    expect(after.alert.jwsHash).toBeNull();
    expect(after.jobs).toHaveLength(0);
    expect(after.newEvents).toHaveLength(0);
    expect(after.head.lastSeq).toBe(before.head.lastSeq);
    expect(Buffer.from(after.head.lastHash)).toEqual(Buffer.from(before.head.lastHash));
    evidence(fixture.author.runId, fixture.created.alert.id, "NO_SIGNING_PROVIDER_NO_WRITE");
  });
});
