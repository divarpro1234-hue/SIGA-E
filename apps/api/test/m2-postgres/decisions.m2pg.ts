import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PrismaClient } from "../../src/generated/prisma/client.js";
import type { InternalUser } from "../../src/modules/identity/session-reader.js";
import {
  assertM2Target, guardedRead, guardedService, openM2DecisionLab, reportEvidence,
  seedActor, seedApprover, syntheticInput, type FailureEvidence,
} from "./harness.js";

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

describe("M2 PostgreSQL real: approve/reject", () => {
  let writer: PrismaClient;
  let observer: PrismaClient;

  beforeAll(() => {
    ({ writer, observer } = openM2DecisionLab());
  });
  afterAll(async () => {
    await Promise.all([writer?.$disconnect(), observer?.$disconnect()]);
  });

  async function inspect(alertId: string, afterSeq?: bigint) {
    return guardedRead(observer, async (tx) => {
      const alert = await tx.alert.findUniqueOrThrow({ where: { id: alertId } });
      const approvals = await tx.approval.findMany({
        where: { alertId }, orderBy: [{ alertVersion: "asc" }, { id: "asc" }],
      });
      const events = await tx.auditEvent.findMany({
        where: { objectType: "alert", objectId: alertId }, orderBy: { seq: "asc" },
      });
      const head = await tx.auditChainState.findUniqueOrThrow({ where: { id: 1 } });
      const newEvents = afterSeq === undefined ? [] : await tx.auditEvent.findMany({
        where: { seq: { gt: afterSeq } }, orderBy: { seq: "asc" },
      });
      return { alert, approvals, events, head, newEvents };
    });
  }

  function assertAuditSegment(before: Awaited<ReturnType<typeof inspect>>,
    after: Awaited<ReturnType<typeof inspect>>, action: "ALERT_APPROVED" | "ALERT_REJECTED") {
    expect(after.newEvents.map((event) => event.action)).toEqual([action]);
    const event = after.newEvents[0]!;
    expect(event.objectType).toBe("alert");
    expect(event.objectId).toBe(before.alert.id);
    expect(event.actorId).not.toBe(before.alert.authorId);
    let hash = Buffer.from(before.head.lastHash);
    const seq = before.head.lastSeq + 1n;
    expect(event.seq).toBe(seq);
    expect(Buffer.from(event.previousHash)).toEqual(hash);
    const canonical = canonicalAuditJson({
      seq: event.seq.toString(10), occurredAt: event.occurredAt.toISOString(),
      actorId: event.actorId, action: event.action, objectType: event.objectType,
      objectId: event.objectId, redactedDetails: event.redactedDetails,
    });
    hash = createHash("sha256").update(hash).update(canonical, "utf8").digest();
    expect(Buffer.from(event.eventHash)).toEqual(hash);
    expect(after.head.lastSeq).toBe(seq);
    expect(Buffer.from(after.head.lastHash)).toEqual(hash);
  }

  async function createPending(author: { actor: InternalUser; cookie: string; runId: string }) {
    const service = guardedService(writer, { p2034: false });
    const created = await service.create(author.actor, author.cookie, syntheticInput(author.runId));
    const submitted = await service.submit(author.actor, author.cookie, created.alert.id, created.version);
    return { service, created, submitted };
  }

  it("A: aprueba Severe y conserva bytes, snapshot, digest y cadena de auditoría", async () => {
    const author = await seedActor(writer);
    const approver = await seedApprover(writer);
    const { service, created, submitted } = await createPending(author);
    const before = await inspect(created.alert.id);
    const frozen = Buffer.from(before.alert.frozenPayload);
    const payloadDigest = createHash("sha256").update(frozen).digest();

    const result = await service.approve(approver.actor, approver.cookie, created.alert.id, {
      expectedDigestHex: payloadDigest.toString("hex"), expectedVersion: submitted.version,
    });

    const after = await inspect(created.alert.id, before.head.lastSeq);
    expect(result).toMatchObject({ version: submitted.version + 1,
      alert: { lifecycleState: "READY_TO_SIGN" } });
    expect(after.alert.lifecycleState).toBe("READY_TO_SIGN");
    expect(after.alert.version).toBe(submitted.version + 1);
    expect(Buffer.from(after.alert.approvedPayloadSha256!)).toEqual(payloadDigest);
    expect(Buffer.from(after.alert.frozenPayload)).toEqual(frozen);
    expect(after.approvals).toHaveLength(1);
    expect(after.approvals[0]).toMatchObject({
      alertId: created.alert.id, approverId: approver.actor.id, alertVersion: submitted.version,
      decision: "APPROVED", reason: null,
    });
    expect(Buffer.from(after.approvals[0]!.digest)).toEqual(payloadDigest);
    expect(Buffer.from(after.approvals[0]!.reviewedPayload)).toEqual(frozen);
    assertAuditSegment(before, after, "ALERT_APPROVED");
    reportEvidence(author.runId, created.alert.id, "APPROVED_SEVERE");
  });

  it("B: rechaza, persiste motivo y snapshot, y mantiene el motivo fuera de auditoría", async () => {
    const author = await seedActor(writer);
    const approver = await seedApprover(writer);
    const { service, created, submitted } = await createPending(author);
    const before = await inspect(created.alert.id);
    const frozen = Buffer.from(before.alert.frozenPayload);
    const payloadDigest = createHash("sha256").update(frozen).digest();
    const reason = "SIMULACRO: requiere corrección editorial";

    const result = await service.reject(approver.actor, approver.cookie, created.alert.id, {
      reason, expectedDigestHex: payloadDigest.toString("hex"), expectedVersion: submitted.version,
    });

    const after = await inspect(created.alert.id, before.head.lastSeq);
    expect(result).toMatchObject({ version: submitted.version + 1, alert: { lifecycleState: "REJECTED" } });
    expect(after.alert.lifecycleState).toBe("REJECTED");
    expect(after.alert.version).toBe(submitted.version + 1);
    expect(after.alert.approvedPayloadSha256).toBeNull();
    expect(Buffer.from(after.alert.frozenPayload)).toEqual(frozen);
    expect(after.approvals).toHaveLength(1);
    expect(after.approvals[0]).toMatchObject({
      alertId: created.alert.id, approverId: approver.actor.id, alertVersion: submitted.version,
      decision: "REJECTED", reason,
    });
    expect(Buffer.from(after.approvals[0]!.digest)).toEqual(payloadDigest);
    expect(Buffer.from(after.approvals[0]!.reviewedPayload)).toEqual(frozen);
    expect(after.newEvents[0]!.redactedDetails).not.toHaveProperty("reason");
    expect(JSON.stringify(after.newEvents[0]!.redactedDetails)).not.toContain(reason);
    assertAuditSegment(before, after, "ALERT_REJECTED");
    reportEvidence(author.runId, created.alert.id, "REJECTED_SEVERE");
  });

  it("C: el mismo UUID autor/aprobador no puede aprobar ni crear evidencia de decisión", async () => {
    const author = await seedActor(writer);
    const { service, created, submitted } = await createPending(author);
    await writer.$transaction(async (tx) => {
      await assertM2Target(tx);
      await tx.user.update({ where: { id: author.actor.id }, data: { role: "APPROVER" } });
    }, { isolationLevel: "Serializable" });
    const sameIdentityApprover: InternalUser = { ...author.actor, role: "APPROVER" };
    const before = await inspect(created.alert.id);
    const payloadDigest = createHash("sha256").update(before.alert.frozenPayload).digest("hex");

    await expect(service.approve(sameIdentityApprover, author.cookie, created.alert.id, {
      expectedDigestHex: payloadDigest, expectedVersion: submitted.version,
    })).rejects.toMatchObject({ status: 403, code: "SELF_APPROVAL_FORBIDDEN" });

    const after = await inspect(created.alert.id, before.head.lastSeq);
    expect(after.alert.lifecycleState).toBe("PENDING_APPROVAL");
    expect(after.alert.version).toBe(submitted.version);
    expect(after.approvals).toHaveLength(0);
    expect(after.newEvents).toHaveLength(0);
    expect(after.head.lastSeq).toBe(before.head.lastSeq);
    expect(Buffer.from(after.head.lastHash)).toEqual(Buffer.from(before.head.lastHash));
    reportEvidence(author.runId, created.alert.id, "SELF_APPROVAL_REJECTED");
  });

  it("D: versión/digest obsoletos y decisión repetida producen conflicto sin escrituras extra", async () => {
    const author = await seedActor(writer);
    const approver = await seedApprover(writer);
    const { service, created, submitted } = await createPending(author);
    const before = await inspect(created.alert.id);
    const payloadDigest = createHash("sha256").update(before.alert.frozenPayload).digest("hex");
    const valid = { expectedDigestHex: payloadDigest, expectedVersion: submitted.version };

    await expect(service.approve(approver.actor, approver.cookie, created.alert.id, {
      ...valid, expectedVersion: submitted.version - 1,
    })).rejects.toMatchObject({ status: 409, code: "STALE_ALERT_VERSION" });
    await expect(service.reject(approver.actor, approver.cookie, created.alert.id, {
      ...valid, reason: "Motivo de prueba", expectedDigestHex: "f".repeat(64),
    })).rejects.toMatchObject({ status: 409, code: "STALE_ALERT_VERSION" });
    expect((await inspect(created.alert.id)).approvals).toHaveLength(0);

    await service.approve(approver.actor, approver.cookie, created.alert.id, valid);
    await expect(service.reject(approver.actor, approver.cookie, created.alert.id, {
      ...valid, reason: "Motivo duplicado",
    })).rejects.toMatchObject({ status: 409, code: "STALE_ALERT_VERSION" });
    const after = await inspect(created.alert.id, before.head.lastSeq);
    expect(after.alert.lifecycleState).toBe("READY_TO_SIGN");
    expect(after.approvals).toHaveLength(1);
    expect(after.newEvents.map((event) => event.action)).toEqual(["ALERT_APPROVED"]);
    reportEvidence(author.runId, created.alert.id, "STALE_AND_DUPLICATE_DECISIONS_REJECTED");
  });

  it("E: fallo tras actualizar la cabeza de auditoría revierte decisión, alerta y cadena", async () => {
    const author = await seedActor(writer);
    const approver = await seedApprover(writer);
    const { created, submitted } = await createPending(author);
    const before = await inspect(created.alert.id);
    const failureEvidence: FailureEvidence = { afterAuditHeadUpdated: false };
    const service = guardedService(writer, { p2034: false }, "after_audit_head",
      undefined, failureEvidence);
    const payloadDigest = createHash("sha256").update(before.alert.frozenPayload).digest("hex");

    await expect(service.reject(approver.actor, approver.cookie, created.alert.id, {
      reason: "Fallo de rollback sintético",
      expectedDigestHex: payloadDigest, expectedVersion: submitted.version,
    })).rejects.toMatchObject({ status: 500, code: "INTERNAL_ERROR" });

    expect(failureEvidence.afterAuditHeadUpdated).toBe(true);
    const after = await inspect(created.alert.id, before.head.lastSeq);
    expect(after.alert.lifecycleState).toBe("PENDING_APPROVAL");
    expect(after.alert.version).toBe(submitted.version);
    expect(after.alert.approvedPayloadSha256).toBeNull();
    expect(Buffer.from(after.alert.frozenPayload)).toEqual(Buffer.from(before.alert.frozenPayload));
    expect(after.approvals).toHaveLength(0);
    expect(after.newEvents).toHaveLength(0);
    expect(after.head.lastSeq).toBe(before.head.lastSeq);
    expect(Buffer.from(after.head.lastHash)).toEqual(Buffer.from(before.head.lastHash));
    reportEvidence(author.runId, created.alert.id, "DECISION_ROLLED_BACK_AFTER_AUDIT_HEAD");
  });
});
