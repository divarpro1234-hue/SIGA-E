import { createHash, randomBytes, randomUUID } from "node:crypto";
import request from "supertest";
import type { Express } from "express";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  assertM2HttpFreshLab,
  assertM2HttpTarget,
  createM2HttpIntegrationDatabaseClient,
} from "../../src/config/m2-http-integration-database.js";
import { createApp } from "../../src/app.js";
import { calculateAuditHash } from "../../src/modules/audit/append-audit-event.js";
import { PrismaDraftAlertService } from "../../src/modules/alerts/alert-draft-service.js";
import { PrismaSessionReader } from "../../src/modules/identity/prisma-session-reader.js";
import { csrfTokenForSession } from "../../src/modules/identity/session-authentication.js";
import type { InternalRole, InternalUser } from "../../src/modules/identity/session-reader.js";
import type { PrismaClient } from "../../src/generated/prisma/client.js";
import { bytesEqual } from "./bytes-equal.js";
import { csrfPost } from "./csrf-request.js";

const appOrigin = "https://siga-e-m2-http.example.invalid";
const csrfSecret = randomBytes(32);

interface TestActor {
  readonly user: InternalUser;
  readonly cookie: string;
  readonly csrf: string;
}

interface Baseline {
  readonly users: number;
  readonly sessions: number;
  readonly alerts: number;
  readonly approvals: number;
  readonly auditEvents: number;
  readonly auditSeq: bigint;
  readonly auditHash: Uint8Array;
}

let prisma: PrismaClient | undefined;
let app: Express;
let baseline: Baseline;
let author: TestActor;
let approver: TestActor;
let otherAuthor: TestActor;

async function seedActor(role: InternalRole): Promise<TestActor> {
  if (!prisma) throw new Error("M2_HTTP_DATABASE_NOT_OPEN");
  const id = randomUUID();
  const token = randomBytes(32).toString("base64url");
  const now = new Date();
  const user: InternalUser = {
    id,
    name: `SIMULACRO ${role}`,
    email: `m2-http-${id}@example.invalid`,
    role,
    status: "ACTIVE",
  };
  await prisma.$transaction(async (tx) => {
    await assertM2HttpTarget(tx);
    await tx.user.create({ data: {
      id,
      name: user.name,
      email: user.email,
      role,
      status: "ACTIVE",
      passwordHash: `SIMULACRO-NO-LOGIN-${id}`,
      totpSecretCiphertext: randomBytes(32),
    } });
    await tx.session.create({ data: {
      userId: id,
      tokenHash: createHash("sha256").update(token, "ascii").digest(),
      lastSeenAt: now,
      expiresAt: new Date(now.getTime() + 2 * 60 * 60_000),
    } });
  });
  return {
    user,
    cookie: `sigae_session=${token}`,
    csrf: csrfTokenForSession(token, csrfSecret),
  };
}

async function readBaseline(): Promise<Baseline> {
  if (!prisma) throw new Error("M2_HTTP_DATABASE_NOT_OPEN");
  const [users, sessions, alerts, approvals, auditEvents, chain] = await Promise.all([
    prisma.user.count(),
    prisma.session.count(),
    prisma.alert.count(),
    prisma.approval.count(),
    prisma.auditEvent.count(),
    prisma.auditChainState.findUnique({ where: { id: 1 } }),
  ]);
  if (!chain || chain.lastHash.length !== 32) throw new Error("M2_HTTP_AUDIT_GENESIS_INVALID");
  return {
    users, sessions, alerts, approvals, auditEvents,
    auditSeq: chain.lastSeq,
    auditHash: Uint8Array.from(chain.lastHash),
  };
}

function digestHex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

describe("Integración HTTP M2 con Express, Prisma y PostgreSQL reales", () => {
  beforeAll(async () => {
    prisma = createM2HttpIntegrationDatabaseClient();
    await prisma.$connect();
    await prisma.$transaction(async (tx) => {
      await assertM2HttpTarget(tx);
      await assertM2HttpFreshLab(tx);
    });
    baseline = await readBaseline();
    app = createApp({
      sessionReader: new PrismaSessionReader(prisma),
      csrfSecret,
      appOrigin,
      alertDraftService: new PrismaDraftAlertService(prisma),
    });
    author = await seedActor("AUTHOR");
    approver = await seedActor("APPROVER");
    otherAuthor = await seedActor("AUTHOR");
  }, 120_000);

  afterAll(async () => {
    await prisma?.$disconnect();
  });

  it("persiste creación, lectura, envío, decisión, rechazos y auditoría sin limpiar fixtures", async () => {
    if (!prisma) throw new Error("M2_HTTP_DATABASE_NOT_OPEN");

    const unauthenticated = await request(app).get("/api/v1/alerts");
    expect(unauthenticated.status).toBe(401);

    const wrongRole = await csrfPost(app, approver, appOrigin, "/api/v1/alerts").send({
      kind: "Alert", info: {},
    });
    expect(wrongRole.status).toBe(403);

    const wrongCsrf = await request(app).post("/api/v1/alerts")
      .set("Cookie", author.cookie).set("Origin", appOrigin)
      .set("X-CSRF-Token", "invalid").send({ kind: "Alert", info: {} });
    expect(wrongCsrf.status).toBe(403);
    expect(wrongCsrf.body.code).toBe("CSRF_INVALID");

    const wrongOrigin = await request(app).post("/api/v1/alerts")
      .set("Cookie", author.cookie).set("Origin", "https://wrong.example.invalid")
      .set("X-CSRF-Token", author.csrf).send({ kind: "Alert", info: {} });
    expect(wrongOrigin.status).toBe(403);
    expect(wrongOrigin.body.code).toBe("CSRF_INVALID");

    const runId = randomUUID();
    const input = {
      kind: "Alert",
      info: {
        scenario: "SISMO",
        event: "Sismo ficticio SIMULACRO",
        severity: "Severe",
        urgency: "Immediate",
        certainty: "Likely",
        headline: `SIMULACRO M2 ${runId}`,
        description: `Ejercicio académico ficticio SIMULACRO ${runId}`,
        expires: new Date(Date.now() + 60 * 60_000).toISOString(),
        areaDesc: "Zona ficticia M2",
      },
    };

    const created = await csrfPost(app, author, appOrigin, "/api/v1/alerts").send(input);
    expect(created.status).toBe(201);
    expect(created.headers.etag).toBe('"v1"');
    expect(created.body).toMatchObject({
      lifecycleState: "DRAFT",
      anchorStatus: "NOT_REQUESTED",
      notice: "SIMULACRO",
    });
    const alertId = created.body.id as string;
    expect(typeof alertId).toBe("string");

    const listed = await request(app).get("/api/v1/alerts?page=1&limit=1").set("Cookie", author.cookie);
    expect(listed.status).toBe(200);
    expect(listed.body).toMatchObject({ page: 1, total: 1 });
    expect(listed.body.items).toHaveLength(1);
    expect(listed.body.items[0].id).toBe(alertId);

    const ownDetail = await request(app).get(`/api/v1/alerts/${alertId}`).set("Cookie", author.cookie);
    expect(ownDetail.status).toBe(200);
    expect(ownDetail.headers.etag).toBe('"v1"');
    expect(ownDetail.body).toMatchObject({ id: alertId, version: 1, kind: "Alert", info: input.info });

    const hiddenDetail = await request(app).get(`/api/v1/alerts/${alertId}`).set("Cookie", otherAuthor.cookie);
    expect(hiddenDetail.status).toBe(404);
    expect(hiddenDetail.body.code).toBe("ALERT_NOT_FOUND");
    expect(hiddenDetail.body).not.toHaveProperty("info");

    const staleSubmit = await csrfPost(app, author, appOrigin, `/api/v1/alerts/${alertId}/submit`)
      .send({ expectedVersion: 9 });
    expect(staleSubmit.status).toBe(409);
    expect(staleSubmit.body.code).toBe("STALE_ALERT_VERSION");

    const submitted = await csrfPost(app, author, appOrigin, `/api/v1/alerts/${alertId}/submit`)
      .send({ expectedVersion: 1 });
    expect(submitted.status).toBe(200);
    expect(submitted.headers.etag).toBe('"v2"');
    expect(submitted.body).toMatchObject({
      lifecycleState: "PENDING_APPROVAL",
      payloadDigestHex: expect.stringMatching(/^[a-f0-9]{64}$/u),
    });

    const reviewerView = await request(app).get(`/api/v1/alerts/${alertId}`).set("Cookie", approver.cookie);
    expect(reviewerView.status).toBe(200);
    expect(reviewerView.headers.etag).toBe('"v2"');
    expect(reviewerView.body).toMatchObject({
      id: alertId,
      lifecycleState: "PENDING_APPROVAL",
      authorId: author.user.id,
      version: 2,
      reviewSnapshot: {
        payloadBase64Url: expect.any(String),
        payloadDigestHex: submitted.body.payloadDigestHex,
      },
    });
    expect(reviewerView.body.authorId).not.toBe(approver.user.id);
    expect(reviewerView.body).not.toHaveProperty("info");
    expect(reviewerView.body.reviewSnapshot.payloadBase64Url).not.toBeUndefined();
    const reviewBytes = Buffer.from(reviewerView.body.reviewSnapshot.payloadBase64Url, "base64url");
    expect(reviewBytes.toString("base64url")).toBe(reviewerView.body.reviewSnapshot.payloadBase64Url);
    expect(digestHex(reviewBytes)).toBe(reviewerView.body.reviewSnapshot.payloadDigestHex);
    const storedForReview = await prisma.alert.findUnique({
      where: { id: alertId },
      select: { frozenPayload: true, payloadSha256: true },
    });
    if (!storedForReview) throw new Error("M2_HTTP_REVIEW_ALERT_NOT_PERSISTED");
    expect(Buffer.from(storedForReview.frozenPayload)).toEqual(reviewBytes);
    expect(Buffer.from(storedForReview.payloadSha256).toString("hex"))
      .toBe(reviewerView.body.reviewSnapshot.payloadDigestHex);

    const authorDecision = await csrfPost(app, author, appOrigin, `/api/v1/alerts/${alertId}/approve`)
      .send({
        expectedVersion: 2,
        expectedDigestHex: reviewerView.body.reviewSnapshot.payloadDigestHex,
      });
    expect(authorDecision.status).toBe(403);

    const staleDigestDecision = await csrfPost(app, approver, appOrigin, `/api/v1/alerts/${alertId}/approve`)
      .send({ expectedVersion: 2, expectedDigestHex: "0".repeat(64) });
    expect(staleDigestDecision.status).toBe(409);
    expect(staleDigestDecision.body.code).toBe("STALE_ALERT_VERSION");

    const approved = await csrfPost(app, approver, appOrigin, `/api/v1/alerts/${alertId}/approve`)
      .send({
        expectedVersion: 2,
        expectedDigestHex: reviewerView.body.reviewSnapshot.payloadDigestHex,
      });
    expect(approved.status).toBe(200);
    expect(approved.headers.etag).toBe('"v3"');
    expect(approved.body.lifecycleState).toBe("READY_TO_SIGN");

    const rejectedCreated = await csrfPost(app, author, appOrigin, "/api/v1/alerts").send(input);
    expect(rejectedCreated.status).toBe(201);
    const rejectedAlertId = rejectedCreated.body.id as string;
    const rejectedSubmitted = await csrfPost(app, author, appOrigin, `/api/v1/alerts/${rejectedAlertId}/submit`)
      .send({ expectedVersion: 1 });
    expect(rejectedSubmitted.status).toBe(200);

    const rejectorView = await request(app).get(`/api/v1/alerts/${rejectedAlertId}`)
      .set("Cookie", approver.cookie);
    expect(rejectorView.status).toBe(200);
    const rejectionSnapshot = rejectorView.body.reviewSnapshot;
    expect(digestHex(Buffer.from(rejectionSnapshot.payloadBase64Url, "base64url")))
      .toBe(rejectionSnapshot.payloadDigestHex);

    const staleReject = await csrfPost(app, approver, appOrigin, `/api/v1/alerts/${rejectedAlertId}/reject`)
      .send({
        reason: "Rechazo SIMULACRO",
        expectedVersion: 1,
        expectedDigestHex: rejectionSnapshot.payloadDigestHex,
      });
    expect(staleReject.status).toBe(409);
    expect(staleReject.body.code).toBe("STALE_ALERT_VERSION");

    const rejected = await csrfPost(app, approver, appOrigin, `/api/v1/alerts/${rejectedAlertId}/reject`)
      .send({
        reason: "Rechazo SIMULACRO",
        expectedVersion: 2,
        expectedDigestHex: rejectionSnapshot.payloadDigestHex,
      });
    expect(rejected.status).toBe(200);
    expect(rejected.headers.etag).toBe('"v3"');
    expect(rejected.body.lifecycleState).toBe("REJECTED");

    const [users, sessions, alerts, approvals, auditEvents, chain, rows, approvedStored, rejectedStored] = await Promise.all([
      prisma.user.count(),
      prisma.session.count(),
      prisma.alert.count(),
      prisma.approval.count(),
      prisma.auditEvent.count(),
      prisma.auditChainState.findUnique({ where: { id: 1 } }),
      prisma.approval.findMany({
        where: { alertId: { in: [alertId, rejectedAlertId] } },
        orderBy: { alertVersion: "asc" },
      }),
      prisma.alert.findUnique({
        where: { id: alertId },
        select: { lifecycleState: true, version: true, approvedPayloadSha256: true },
      }),
      prisma.alert.findUnique({
        where: { id: rejectedAlertId },
        select: { lifecycleState: true, version: true, approvedPayloadSha256: true },
      }),
    ]);
    expect(users - baseline.users).toBe(3);
    expect(sessions - baseline.sessions).toBe(3);
    expect(alerts - baseline.alerts).toBe(2);
    expect(approvals - baseline.approvals).toBe(2);
    expect(auditEvents - baseline.auditEvents).toBe(6);
    expect(chain?.lastSeq).toBe(baseline.auditSeq + 6n);
    if (!approvedStored?.approvedPayloadSha256) throw new Error("M2_HTTP_APPROVED_ALERT_NOT_PERSISTED");
    expect(approvedStored).toMatchObject({ lifecycleState: "READY_TO_SIGN", version: 3 });
    expect(Buffer.from(approvedStored.approvedPayloadSha256).toString("hex"))
      .toBe(reviewerView.body.reviewSnapshot.payloadDigestHex);
    expect(rejectedStored).toMatchObject({
      lifecycleState: "REJECTED",
      version: 3,
      approvedPayloadSha256: null,
    });
    expect(rows).toHaveLength(2);
    expect(rows).toEqual(expect.arrayContaining([
      expect.objectContaining({
        alertId,
        alertVersion: 2,
        approverId: approver.user.id,
        decision: "APPROVED",
        reason: null,
      }),
      expect.objectContaining({
        alertId: rejectedAlertId,
        alertVersion: 2,
        approverId: approver.user.id,
        decision: "REJECTED",
        reason: "Rechazo SIMULACRO",
      }),
    ]));
    const approvedEvidence = rows.find((row) => row.alertId === alertId);
    const rejectedEvidence = rows.find((row) => row.alertId === rejectedAlertId);
    if (!approvedEvidence || !rejectedEvidence) throw new Error("M2_HTTP_APPROVAL_EVIDENCE_MISSING");
    expect(bytesEqual(approvedEvidence.reviewedPayload, reviewBytes)).toBe(true);
    expect(Buffer.from(approvedEvidence.digest).toString("hex"))
      .toBe(reviewerView.body.reviewSnapshot.payloadDigestHex);
    expect(bytesEqual(
      rejectedEvidence.reviewedPayload,
      Buffer.from(rejectionSnapshot.payloadBase64Url, "base64url"),
    )).toBe(true);

    const events = await prisma.auditEvent.findMany({
      where: { seq: { gt: baseline.auditSeq } },
      orderBy: { seq: "asc" },
    });
    const expectedActions = [
      "ALERT_CREATED",
      "ALERT_SUBMITTED",
      "ALERT_APPROVED",
      "ALERT_CREATED",
      "ALERT_SUBMITTED",
      "ALERT_REJECTED",
    ];
    expect(events.map((event) => event.action)).toEqual(expectedActions);
    let previousHash = Uint8Array.from(baseline.auditHash);
    let expectedSeq = baseline.auditSeq;
    for (const event of events) {
      expectedSeq += 1n;
      expect(event.seq).toBe(expectedSeq);
      expect(Buffer.from(event.previousHash)).toEqual(Buffer.from(previousHash));
      const details = event.redactedDetails;
      if (details === null || typeof details !== "object" || Array.isArray(details)) {
        throw new Error("M2_HTTP_AUDIT_DETAILS_INVALID");
      }
      const safeDetails: Record<string, string | number | boolean | null> = {};
      for (const [key, value] of Object.entries(details)) {
        if (value !== null && typeof value !== "string" &&
            typeof value !== "number" && typeof value !== "boolean") {
          throw new Error("M2_HTTP_AUDIT_DETAILS_INVALID");
        }
        safeDetails[key] = value;
      }
      previousHash = calculateAuditHash(previousHash, event.seq, {
        actorId: event.actorId,
        action: event.action,
        objectType: event.objectType,
        objectId: event.objectId,
        redactedDetails: safeDetails,
      }, event.occurredAt);
      expect(Buffer.from(event.eventHash)).toEqual(Buffer.from(previousHash));
    }
    expect(chain?.lastHash).toEqual(previousHash);
  }, 120_000);
});
