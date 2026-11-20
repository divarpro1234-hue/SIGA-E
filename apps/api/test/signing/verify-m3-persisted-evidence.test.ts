import { createHash } from "node:crypto";
import {
  calculateJwkThumbprint,
  CompactSign,
  exportJWK,
  generateKeyPair,
} from "jose";
import { describe, expect, it, vi } from "vitest";
import {
  analyzeM3PersistedEvidence,
  auditEventsQuery,
  hasExpectedDestination,
  validateReadOnlyEvidenceEnvironment,
  writeVerificationReport,
  type StoredAlert,
  type StoredApproval,
  type StoredAnchorJob,
  type StoredAuditEvent,
  type StoredPublicKey,
  type StoredUser,
} from "../../scripts/verify-m3-persisted-evidence.js";
import { calculateAuditHash, type AuditEventInput } from "../../src/modules/audit/append-audit-event.js";
import { calculateJwsHash, calculateMessageKey } from "../../src/modules/signing/alert-hashes.js";

const alertId = "00000000-0000-4000-8000-000000000101";
const authorId = "00000000-0000-4000-8000-000000000102";
const approverId = "00000000-0000-4000-8000-000000000103";
const kid = "sigae-evidence-offline-key";
const identity = {
  sender: "sigae.example.invalid",
  identifier: "SIMULACRO-EVIDENCE-001",
  sent: "2026-11-02T18:00:00.000Z",
};
const frozenPayload = Buffer.from(JSON.stringify({
  ...identity,
  status: "Exercise",
  scope: "Public",
  msgType: "Alert",
  info: {
    scenario: "SISMO",
    event: "Simulacro",
    severity: "Severe",
    urgency: "Immediate",
    certainty: "Likely",
    headline: "SIMULACRO de validación",
    description: "Contenido ficticio para prueba offline.",
    expires: "2026-11-02T19:00:00.000Z",
    areaDesc: "Zona ficticia",
  },
}), "utf8");
const payloadDigest = createHash("sha256").update(frozenPayload).digest();

async function fixture(approverOverride = approverId) {
  const pair = await generateKeyPair("ES256");
  const jws = await new CompactSign(frozenPayload)
    .setProtectedHeader({ alg: "ES256", kid })
    .sign(pair.privateKey);
  const publicJwk = await exportJWK(pair.publicKey);
  const thumbprint = await calculateJwkThumbprint(publicJwk, "sha256");
  const alerts: StoredAlert[] = [{
    id: alertId,
    sender: identity.sender,
    identifier: identity.identifier,
    sentText: identity.sent,
    kind: "Alert",
    severity: "Severe",
    lifecycleState: "SIGNED_PENDING_ANCHOR",
    version: 3,
    frozenPayload,
    payloadSha256: payloadDigest,
    approvedPayloadSha256: payloadDigest,
    jwsCompact: jws,
    kid,
    messageKey: Buffer.from(calculateMessageKey(identity)),
    jwsHash: Buffer.from(calculateJwsHash(jws)),
    authorId,
  }];
  const approvals: StoredApproval[] = [{
    alertId,
    approverId: approverOverride,
    alertVersion: 2,
    reviewedPayload: frozenPayload,
    digest: payloadDigest,
    decision: "APPROVED",
  }];
  const anchorJobs: StoredAnchorJob[] = [{
    alertId,
    messageKey: Buffer.from(calculateMessageKey(identity)),
    jwsHash: Buffer.from(calculateJwsHash(jws)),
    state: "PENDING",
  }];
  const keys: StoredPublicKey[] = [{
    kid,
    publicJwk,
    thumbprint,
    status: "ACTIVE",
    validFrom: new Date("2026-11-01T00:00:00.000Z"),
    retiredAt: null,
    revokedAt: null,
  }];
  const users: StoredUser[] = [
    { id: authorId, role: "AUTHOR" },
    { id: approverId, role: "APPROVER" },
  ];
  const auditEvents: StoredAuditEvent[] = [];
  let previousHash = Buffer.alloc(32);
  const auditInputs: ReadonlyArray<{
    readonly actorId: string;
    readonly action: string;
    readonly redactedDetails: AuditEventInput["redactedDetails"];
    readonly occurredAt: Date;
  }> = [
    {
      actorId: approverId,
      action: "ALERT_APPROVED",
      redactedDetails: { kind: "Alert", status: "PENDING_APPROVAL_TO_READY_TO_SIGN", result: "v3" },
      occurredAt: new Date("2026-11-02T18:01:00.000Z"),
    },
    {
      actorId: authorId,
      action: "ALERT_ISSUED",
      redactedDetails: {
        kind: "Alert",
        status: "READY_TO_SIGN_TO_SIGNED_PENDING_ANCHOR",
        result: "ANCHOR_JOB_ENQUEUED",
      },
      occurredAt: new Date("2026-11-02T18:02:00.000Z"),
    },
  ];
  for (const [index, item] of auditInputs.entries()) {
    const seq = BigInt(index + 1);
    const input: AuditEventInput = {
      actorId: item.actorId,
      action: item.action,
      objectType: "alert",
      objectId: alertId,
      redactedDetails: item.redactedDetails,
    };
    const eventHash = Buffer.from(calculateAuditHash(previousHash, seq, input, item.occurredAt));
    auditEvents.push({
      seq: seq.toString(),
      occurredAt: item.occurredAt,
      actorId: item.actorId,
      action: item.action,
      objectType: "alert",
      objectId: alertId,
      redactedDetails: item.redactedDetails,
      previousHash,
      eventHash,
    });
    previousHash = eventHash;
  }
  return {
    pair,
    thumbprint,
    input: {
      alerts,
      anchorJobs,
      approvals,
      keys,
      users,
      auditEvents,
      auditHead: { id: 1, lastSeq: "2", lastHash: previousHash },
      trustPins: new Map([[kid, thumbprint]]),
    },
  };
}

describe("verificación offline de evidencia M3 persistida", () => {
  it("requiere opt-in y destino literal antes de permitir conexión", () => {
    const url = "postgresql://sigae_m3_itest:fixture-password@127.0.0.1:55432/sigae_m3_issue_itest";
    const environment = {
      SIGAE_RUN_M3_EVIDENCE_READONLY: "I_ACKNOWLEDGE_M3_EVIDENCE_READ_ONLY",
      SIGAE_M3_POSTGRES_LAB_ID: "SIGAE_M3_POSTGRES_ISSUE_LAB_V1",
      SIGAE_M3_POSTGRES_URL: url,
    } as NodeJS.ProcessEnv;
    expect(validateReadOnlyEvidenceEnvironment(environment)).toBe(url);
    expect(() => validateReadOnlyEvidenceEnvironment({
      ...environment,
      SIGAE_RUN_M3_EVIDENCE_READONLY: undefined,
    } as NodeJS.ProcessEnv)).toThrow("M3_EVIDENCE_READ_ONLY_PREFLIGHT_REJECTED");
    expect(() => validateReadOnlyEvidenceEnvironment({
      ...environment,
      DATABASE_URL: url,
    } as NodeJS.ProcessEnv)).toThrow("M3_EVIDENCE_READ_ONLY_PREFLIGHT_REJECTED");

    const destination = {
      databaseName: "sigae_m3_issue_itest",
      username: "sigae_m3_itest",
      sessionUsername: "sigae_m3_itest",
      address: "127.0.0.1",
      port: 55432,
      labMarker: "SIGAE_M3_POSTGRES_ISSUE_LAB_V1",
      transactionReadOnly: "on",
    };
    expect(hasExpectedDestination(destination, true)).toBe(true);
    expect(hasExpectedDestination({ ...destination, databaseName: "sigae_m2_http_itest" }, true)).toBe(false);
    expect(hasExpectedDestination({ ...destination, transactionReadOnly: "off" }, true)).toBe(false);
  });

  it("verifica firma, bytes aprobados, hashes, confianza independiente y cadena completa", async () => {
    const subject = await fixture();
    const report = await analyzeM3PersistedEvidence(subject.input);

    expect(report).toMatchObject({
      examinedAlerts: 1,
      expectedCountMatches: false,
      signedPendingAnchor: 1,
      integrityChecksPass: false,
      signatureValid: 1,
      signatureInvalid: 0,
      databaseKeyRecordMatches: 1,
      independentlyTrusted: 1,
      frozenPayloadMatchesJws: 1,
      approvedContentMatches: 1,
      independentApprovals: 1,
      jwsHashesMatch: 1,
      messageKeysMatch: 1,
      anchorJobsMatch: 1,
      issueAuditLinks: 1,
      approvalAuditLinks: 1,
      audit: {
        eventCount: 2,
        headSequenceMatches: true,
        fullChainValid: true,
        headHashMatches: true,
      },
      negativeTests: {
        modifiedPayloadRejected: true,
        modifiedSignatureRejected: true,
        differentKeyRejected: true,
        forbiddenAlgorithmRejected: true,
      },
    });
  });

  it("ordena numéricamente la auditoría al incluir las secuencias 1, 2 y 10", async () => {
    expect(auditEventsQuery).toContain("FROM audit_events AS e ORDER BY e.seq ASC");

    const subject = await fixture();
    const events = [...subject.input.auditEvents];
    let previousHash = events.at(-1)!.eventHash;
    const occurredAt = new Date("2026-11-02T18:03:00.000Z");
    const auditInput: AuditEventInput = {
      actorId: null,
      action: "AUDIT_REGRESSION",
      objectType: "audit",
      objectId: "offline-sequence-regression",
      redactedDetails: { result: "OK" },
    };
    for (let seq = 3n; seq <= 10n; seq += 1n) {
      const eventHash = Buffer.from(calculateAuditHash(previousHash, seq, auditInput, occurredAt));
      events.push({
        seq: seq.toString(),
        occurredAt,
        ...auditInput,
        previousHash,
        eventHash,
      });
      previousHash = eventHash;
    }

    expect(events.map((event) => event.seq)).toEqual([
      "1", "2", "3", "4", "5", "6", "7", "8", "9", "10",
    ]);
    const report = await analyzeM3PersistedEvidence({
      ...subject.input,
      auditEvents: events,
      auditHead: { id: 1, lastSeq: "10", lastHash: previousHash },
    });
    expect(report.audit).toEqual({
      eventCount: 10,
      headSequenceMatches: true,
      fullChainValid: true,
      headHashMatches: true,
    });
  });

  it("establece código de salida distinto de cero si falla la integridad", async () => {
    const report = await analyzeM3PersistedEvidence((await fixture()).input);
    expect(report.integrityChecksPass).toBe(false);

    const originalExitCode = process.exitCode;
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    process.exitCode = 0;
    try {
      writeVerificationReport(report);
      expect(process.exitCode).toBe(1);
    } finally {
      write.mockRestore();
      process.exitCode = originalExitCode;
    }
  });

  it("no acredita aprobación independiente cuando el autor es el aprobador", async () => {
    const subject = await fixture(authorId);
    const report = await analyzeM3PersistedEvidence(subject.input);
    expect(report.approvedContentMatches).toBe(1);
    expect(report.independentApprovals).toBe(0);
    expect(report.approvalAuditLinks).toBe(0);
  });

  it("separa la validez criptográfica de la confianza y señala una clave DB alterada", async () => {
    const subject = await fixture();
    const alteredInput = {
      ...subject.input,
      keys: subject.input.keys.map((key) => ({ ...key, thumbprint: "A".repeat(43) })),
      trustPins: undefined,
    };
    const report = await analyzeM3PersistedEvidence(alteredInput);
    expect(report.signatureValid).toBe(1);
    expect(report.databaseKeyRecordMatches).toBe(0);
    expect(report.independentlyTrusted).toBeNull();
  });

  it("detecta una alteración de auditoría sin sustituir el cálculo por comparar la cabeza", async () => {
    const subject = await fixture();
    const brokenEvents = subject.input.auditEvents.map((event, index) =>
      index === subject.input.auditEvents.length - 1
        ? { ...event, eventHash: Buffer.alloc(32, 4) }
        : event);
    const report = await analyzeM3PersistedEvidence({
      ...subject.input,
      auditEvents: brokenEvents,
    });
    expect(report.audit.headSequenceMatches).toBe(true);
    expect(report.audit.headHashMatches).toBe(false);
    expect(report.audit.fullChainValid).toBe(false);
    expect(report.integrityChecksPass).toBe(false);
  });

  it.each([
    ["eliminado", (events: Awaited<ReturnType<typeof fixture>>["input"]["auditEvents"]) => events.slice(1)],
    ["reordenado", (events: Awaited<ReturnType<typeof fixture>>["input"]["auditEvents"]) => [...events].reverse()],
  ])("detecta un registro de auditoría %s", async (_change, alter) => {
    const subject = await fixture();
    const report = await analyzeM3PersistedEvidence({
      ...subject.input,
      auditEvents: alter(subject.input.auditEvents),
    });

    expect(report.audit.headSequenceMatches).toBe(false);
    expect(report.audit.fullChainValid).toBe(false);
  });
});
