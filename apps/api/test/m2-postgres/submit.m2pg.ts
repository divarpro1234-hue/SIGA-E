import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PrismaClient } from "../../src/generated/prisma/client.js";
import { validateAlertInput } from "../../src/modules/alerts/alert-input.js";
import { buildDraftPayload } from "../../src/modules/alerts/alert-payload.js";
import { guardedRead, guardedService, openM2Lab, reportEvidence, seedActor,
  syntheticInput, transactionEntryBarrier, type FailureEvidence, type TransactionEvidence } from "./harness.js";

// Reproduce the documented audit representation without calling calculateAuditHash.
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
  throw new Error("M2_AUDIT_REPRESENTATION_UNSUPPORTED");
}

// Archivo deliberadamente fuera de *.test.ts / *.spec.ts. El perfil dedicado
// lo descubre solo si se invoca con --config y el opt-in exacto está presente.
describe("M2 PostgreSQL real: DraftAlertService.submit", () => {
  let writer: PrismaClient;
  let observer: PrismaClient;

  beforeAll(() => {
    ({ writer, observer } = openM2Lab());
  });
  afterAll(async () => {
    await Promise.all([writer?.$disconnect(), observer?.$disconnect()]);
  });

  async function createDraft(severity: "Severe" | "Minor" = "Severe") {
    const identity = await seedActor(writer);
    const service = guardedService(writer, { p2034: false });
    const input = syntheticInput(identity.runId, severity);
    const created = await service.create(identity.actor, identity.cookie, input);
    return { ...identity, created, service, input };
  }

  async function inspect(alertId: string, afterSeq?: bigint) {
    return guardedRead(observer, async (tx) => {
      const alert = await tx.alert.findUniqueOrThrow({ where: { id: alertId } });
      const events = await tx.auditEvent.findMany({ where: {
        objectType: "alert", objectId: alertId,
      }, orderBy: { seq: "asc" } });
      const head = await tx.auditChainState.findUniqueOrThrow({ where: { id: 1 } });
      const newEvents = afterSeq === undefined ? [] : await tx.auditEvent.findMany({
        where: { seq: { gt: afterSeq } }, orderBy: { seq: "asc" },
      });
      return { alert, events, head, newEvents };
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

  function assertPayload(snapshot: Awaited<ReturnType<typeof inspect>>) {
    const bytes = Buffer.from(snapshot.alert.frozenPayload);
    const digest = createHash("sha256").update(bytes).digest();
    expect(Buffer.from(snapshot.alert.payloadSha256)).toEqual(digest);
    const decoded = JSON.parse(bytes.toString("utf8")) as Record<string, unknown>;
    expect(decoded).toMatchObject({ sender: snapshot.alert.sender,
      identifier: snapshot.alert.identifier, sent: snapshot.alert.sentText,
      status: "Exercise", scope: "Public", msgType: "Alert" });
    expect(JSON.stringify(decoded)).toContain("SIMULACRO");
  }

  it("A: congela un Severe y confirma versión, identidad y un evento", async () => {
    const { actor, cookie, runId, created, service, input } = await createDraft();
    const before = await inspect(created.alert.id);
    const expected = buildDraftPayload(validateAlertInput(input, before.alert.sentText), {
      sender: before.alert.sender, identifier: before.alert.identifier, sent: before.alert.sentText,
    });
    expect(Buffer.from(before.alert.frozenPayload)).toEqual(Buffer.from(expected.payloadBytes));
    const result = await service.submit(actor, cookie, created.alert.id, created.version);
    const after = await inspect(created.alert.id, before.head.lastSeq);
    expect(result).toMatchObject({ lifecycleState: "PENDING_APPROVAL", version: created.version + 1 });
    expect(after.alert).toMatchObject({ lifecycleState: "PENDING_APPROVAL", version: created.version + 1,
      anchorStatus: "NOT_REQUESTED", authorId: actor.id, sender: before.alert.sender,
      identifier: before.alert.identifier, sentText: before.alert.sentText });
    assertPayload(after);
    expect(Buffer.from(after.alert.frozenPayload)).toEqual(Buffer.from(expected.payloadBytes));
    const expectedDigest = createHash("sha256").update(expected.payloadBytes).digest();
    expect(Buffer.from(after.alert.payloadSha256)).toEqual(expectedDigest);
    expect(result.payloadDigestHex).toBe(expectedDigest.toString("hex"));
    expect(after.alert.severity).toBe(input.info.severity);
    const frozen = JSON.parse(Buffer.from(after.alert.frozenPayload).toString("utf8")) as { info: unknown };
    expect(frozen.info).toEqual(validateAlertInput(input, before.alert.sentText).info);
    expect(after.events.filter((event) => event.action === "ALERT_SUBMITTED")).toHaveLength(1);
    assertAuditSegment(before, after, ["ALERT_SUBMITTED"]);
    reportEvidence(runId, created.alert.id, "SUBMITTED_SEVERE");
  });

  it("B: dos transacciones iniciadas juntas se serializan sin doble submit", async () => {
    const { actor, cookie, runId, created } = await createDraft();
    const before = await inspect(created.alert.id);
    const a: TransactionEvidence = { p2034: false };
    const b: TransactionEvidence = { p2034: false };
    const barrier = transactionEntryBarrier();
    const first = guardedService(writer, a, "none", undefined, undefined, barrier);
    const second = guardedService(observer, b, "none", undefined, undefined, barrier);
    const results = await Promise.allSettled([
      first.submit(actor, cookie, created.alert.id, created.version),
      second.submit(actor, cookie, created.alert.id, created.version),
    ]);
    expect(barrier.arrivals).toBe(2);
    const succeeded = results.filter((result) => result.status === "fulfilled");
    const rejected = results.filter((result) => result.status === "rejected");
    expect(succeeded).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]).toMatchObject({ reason: { status: 409, code: "STALE_ALERT_VERSION" } });
    const after = await inspect(created.alert.id, before.head.lastSeq);
    expect(after.alert).toMatchObject({ lifecycleState: "PENDING_APPROVAL", version: created.version + 1 });
    assertPayload(after);
    expect(after.events.filter((event) => event.action === "ALERT_SUBMITTED")).toHaveLength(1);
    assertAuditSegment(before, after, ["ALERT_SUBMITTED"]);
    reportEvidence(runId, created.alert.id, a.p2034 || b.p2034 ? "CONFLICT_P2034_OBSERVED" : "CONFLICT_STALE_NO_P2034_OBSERVED");
  });

  it("C: PATCH y submit iniciados juntos se serializan coherentemente", async () => {
    const { actor, cookie, runId, created } = await createDraft();
    const before = await inspect(created.alert.id);
    const a: TransactionEvidence = { p2034: false };
    const b: TransactionEvidence = { p2034: false };
    const barrier = transactionEntryBarrier();
    const edit = guardedService(writer, a, "none", undefined, undefined, barrier).edit(actor, cookie, created.alert.id, created.version,
      syntheticInput(runId, "Minor"));
    const submit = guardedService(observer, b, "none", undefined, undefined, barrier)
      .submit(actor, cookie, created.alert.id, created.version);
    const results = await Promise.allSettled([edit, submit]);
    expect(barrier.arrivals).toBe(2);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect(results.find((result) => result.status === "rejected")).toMatchObject({
      reason: { status: 409, code: "STALE_ALERT_VERSION" },
    });
    const after = await inspect(created.alert.id, before.head.lastSeq);
    expect(after.alert.version).toBe(created.version + 1);
    assertPayload(after);
    const edited = results[0]?.status === "fulfilled";
    expect(after.alert.lifecycleState).toBe(edited ? "DRAFT" : "PENDING_APPROVAL");
    expect(after.alert.severity).toBe(edited ? "Minor" : "Severe");
    expect(after.events.filter((event) => event.action === "ALERT_DRAFT_UPDATED")).toHaveLength(edited ? 1 : 0);
    expect(after.events.filter((event) => event.action === "ALERT_SUBMITTED")).toHaveLength(edited ? 0 : 1);
    assertAuditSegment(before, after, [edited ? "ALERT_DRAFT_UPDATED" : "ALERT_SUBMITTED"]);
    reportEvidence(runId, created.alert.id, a.p2034 || b.p2034 ? "PATCH_SUBMIT_P2034_OBSERVED" : "PATCH_SUBMIT_STALE");
  });

  it("D: fallo después de actualizar la cabeza revierte físicamente la transacción", async () => {
    const { actor, cookie, runId, created } = await createDraft();
    const before = await inspect(created.alert.id);
    const injection: FailureEvidence = { afterAuditHeadUpdated: false };
    const service = guardedService(writer, { p2034: false }, "after_audit_head", undefined, injection);
    await expect(service.submit(actor, cookie, created.alert.id, created.version))
      .rejects.toMatchObject({ status: 500, code: "INTERNAL_ERROR" });
    expect(injection.afterAuditHeadUpdated).toBe(true);
    const after = await inspect(created.alert.id, before.head.lastSeq); // segunda conexión Prisma real
    expect(after.alert.lifecycleState).toBe(before.alert.lifecycleState);
    expect(after.alert.version).toBe(before.alert.version);
    expect(Buffer.from(after.alert.frozenPayload)).toEqual(Buffer.from(before.alert.frozenPayload));
    expect(Buffer.from(after.alert.payloadSha256)).toEqual(Buffer.from(before.alert.payloadSha256));
    expect(after.alert.severity).toBe(before.alert.severity);
    expect(after.alert.updatedAt).toEqual(before.alert.updatedAt);
    expect(after.events).toEqual(before.events);
    expect(after.events.filter((event) => event.action === "ALERT_SUBMITTED")).toHaveLength(0);
    assertAuditSegment(before, after, []);
    reportEvidence(runId, created.alert.id, "ROLLBACK_OBSERVED");
  });

  it("E: reloj inyectado rechaza expiración detectada durante submit", async () => {
    const { actor, cookie, runId } = await seedActor(writer);
    const creationTime = new Date();
    const expiredAt = new Date(creationTime.getTime() + 10 * 60_000);
    const validUntil = new Date(creationTime.getTime() + 20 * 60_000);
    const submitTime = new Date(expiredAt.getTime() + 1);
    const expiredInput = syntheticInput(runId, "Severe", expiredAt);
    const validInput = syntheticInput(runId, "Severe", validUntil);
    const creator = guardedService(writer, { p2034: false }, "none", () => creationTime);
    const expired = await creator.create(actor, cookie, expiredInput);
    const valid = await creator.create(actor, cookie, validInput);
    const before = await inspect(expired.alert.id);
    expect(() => validateAlertInput(expiredInput, before.alert.sentText,
      new Date(expiredAt.getTime() - 1))).not.toThrow();
    expect(() => validateAlertInput(expiredInput, before.alert.sentText, submitTime)).toThrow();
    expect(() => validateAlertInput(validInput, before.alert.sentText, submitTime)).not.toThrow();
    let clockReads = 0;
    const service = guardedService(writer, { p2034: false }, "none", () => {
      clockReads += 1;
      return submitTime;
    });
    await service.submit(actor, cookie, valid.alert.id, valid.version);
    const beforeRejection = await inspect(expired.alert.id);
    await expect(service.submit(actor, cookie, expired.alert.id, expired.version))
      .rejects.toMatchObject({ status: 422, code: "INVALID_ALERT_PAYLOAD" });
    expect(clockReads).toBeGreaterThanOrEqual(4);
    const after = await inspect(expired.alert.id, beforeRejection.head.lastSeq);
    expect(after.alert.version).toBe(before.alert.version);
    expect(after.alert.lifecycleState).toBe("DRAFT");
    expect(after.alert).toEqual(before.alert);
    expect(after.events.filter((event) => event.action === "ALERT_SUBMITTED")).toHaveLength(0);
    assertAuditSegment(beforeRejection, after, []);
    reportEvidence(runId, expired.alert.id, "EXPIRY_REJECTED");
  });
});
