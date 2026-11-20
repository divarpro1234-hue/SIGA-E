import { describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "../../src/generated/prisma/client.js";
import { PrismaDraftAlertService } from "../../src/modules/alerts/alert-draft-service.js";
import type { InternalUser } from "../../src/modules/identity/session-reader.js";
import { buildDraftPayload } from "../../src/modules/alerts/alert-payload.js";
import { validateAlertInput } from "../../src/modules/alerts/alert-input.js";
import { identity, input } from "./alert-fixtures.js";

const author: InternalUser = { id: "00000000-0000-4000-8000-000000000002", name: "Autor ficticio",
  email: "author@example.invalid", role: "AUTHOR", status: "ACTIVE" };
const other: InternalUser = { ...author, id: "00000000-0000-4000-8000-000000000003", role: "APPROVER" };
const approver: InternalUser = { ...other, name: "Aprobador ficticio", email: "approver@example.invalid" };
const alertId = "00000000-0000-4000-8000-000000000001";
const cookie = `sigae_session=${"A".repeat(43)}`;
const now = new Date(identity.sent);
const snapshot = buildDraftPayload(validateAlertInput(input, identity.sent), identity);
const row = (overrides: Record<string, unknown> = {}) => ({ id: alertId, authorId: author.id,
  sender: identity.sender, identifier: identity.identifier, sentText: identity.sent,
  kind: "Alert", severity: "Severe", lifecycleState: "DRAFT", anchorStatus: "NOT_REQUESTED", version: 1,
  frozenPayload: snapshot.payloadBytes, payloadSha256: snapshot.payloadDigest,
  approvedPayloadSha256: null as Uint8Array | null, ...overrides });

function fixture(options: { auditFailure?: boolean; existing?: ReturnType<typeof row> | null;
  clock?: () => Date;
  reportDiagnostic?: (event: { requestId: string; stage: string; code: string }) => void } = {}) {
  const operationNow = options.clock?.() ?? now;
  const records = [
    [{ id: author.id, role: "AUTHOR", status: "ACTIVE" }],
    [{ user_id: author.id, revoked_at: null, expires_at: new Date(operationNow.getTime() + 60_000),
      last_seen_at: new Date(operationNow.getTime() - 1000) }],
    [{ last_seq: 0n, last_hash: new Uint8Array(32) }],
  ];
  const tx = {
    $queryRaw: vi.fn().mockImplementation(async () => records.shift() ?? []),
    alert: { create: vi.fn().mockResolvedValue(row()), findFirst: vi.fn().mockResolvedValue(options.existing === undefined ? row() : options.existing),
      findMany: vi.fn().mockResolvedValue([]), count: vi.fn().mockResolvedValue(0),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
    approval: { findMany: vi.fn().mockResolvedValue([]) },
    auditEvent: { create: vi.fn().mockImplementation(async () => {
      if (options.auditFailure) throw new Error("audit unavailable");
    }) },
    auditChainState: { update: vi.fn().mockResolvedValue({}) },
  };
  const prisma = { $transaction: vi.fn(async (work: (client: typeof tx) => Promise<unknown>, _options?: object) => work(tx)) };
  const service = new PrismaDraftAlertService(prisma as unknown as PrismaClient,
    identity.sender, options.clock ?? (() => new Date(now)), () => identity.identifier, options.reportDiagnostic);
  return { service, tx, prisma };
}

function decisionFixture(options: {
  actor?: InternalUser;
  existing?: ReturnType<typeof row> | null;
  priorDecision?: boolean;
  auditFailure?: boolean;
  casConflict?: boolean;
} = {}) {
  const actor = options.actor ?? approver;
  let queryCount = 0;
  const state = {
    alert: options.existing === undefined ? row({ lifecycleState: "PENDING_APPROVAL", version: 2 }) : options.existing,
    decisions: [] as Array<Record<string, unknown>>,
    audits: [] as Array<Record<string, unknown>>,
  };
  const tx = {
    $queryRaw: vi.fn().mockImplementation(async () => {
      if (queryCount++ === 0) return [{ id: actor.id, role: actor.role, status: "ACTIVE" }];
      if (queryCount === 2) return [{ user_id: actor.id, revoked_at: null,
        expires_at: new Date(now.getTime() + 60_000), last_seen_at: new Date(now.getTime() - 1000) }];
      return [{ last_seq: BigInt(state.audits.length), last_hash: new Uint8Array(32) }];
    }),
    alert: {
      findUnique: vi.fn().mockImplementation(async () => state.alert && ({
        ...state.alert, frozenPayload: new Uint8Array(state.alert.frozenPayload),
        payloadSha256: new Uint8Array(state.alert.payloadSha256),
      })),
      updateMany: vi.fn().mockImplementation(async ({ where, data }: {
        where: { id: string; version: number; lifecycleState: string };
        data: { lifecycleState: string; version: { increment: number }; approvedPayloadSha256: Uint8Array | null };
      }) => {
        if (options.casConflict || !state.alert || state.alert.id !== where.id ||
            state.alert.version !== where.version || state.alert.lifecycleState !== where.lifecycleState) return { count: 0 };
        state.alert.lifecycleState = data.lifecycleState;
        state.alert.version += data.version.increment;
        state.alert.approvedPayloadSha256 = data.approvedPayloadSha256;
        return { count: 1 };
      }),
    },
    approval: {
      findUnique: vi.fn().mockImplementation(async () => options.priorDecision
        ? { id: "00000000-0000-4000-8000-000000000009" } : null),
      create: vi.fn().mockImplementation(async ({ data }: { data: Record<string, unknown> }) => {
        state.decisions.push(data);
        return data;
      }),
    },
    auditEvent: {
      create: vi.fn().mockImplementation(async ({ data }: { data: Record<string, unknown> }) => {
        if (options.auditFailure) throw new Error("audit unavailable");
        state.audits.push(data);
        return data;
      }),
    },
    auditChainState: { update: vi.fn().mockResolvedValue({}) },
  };
  const prisma = {
    $transaction: vi.fn(async (work: (client: typeof tx) => Promise<unknown>, _options?: object) => {
      queryCount = 0;
      const alertBefore = state.alert && { ...state.alert, frozenPayload: new Uint8Array(state.alert.frozenPayload),
        payloadSha256: new Uint8Array(state.alert.payloadSha256) };
      const decisionsBefore = [...state.decisions];
      const auditsBefore = [...state.audits];
      try {
        return await work(tx);
      } catch (error) {
        state.alert = alertBefore;
        state.decisions.splice(0, state.decisions.length, ...decisionsBefore);
        state.audits.splice(0, state.audits.length, ...auditsBefore);
        throw error;
      }
    }),
  };
  const service = new PrismaDraftAlertService(prisma as unknown as PrismaClient,
    identity.sender, () => new Date(now));
  return { service, tx, prisma, state, actor };
}

function barrier() {
  let entered!: () => void;
  let release!: () => void;
  const reached = new Promise<void>((resolve) => { entered = resolve; });
  const released = new Promise<void>((resolve) => { release = resolve; });
  return { reached, release, async wait() { entered(); await released; } };
}

function sharedRaceFixture(auditFailure = false, options: {
  clock?: () => Date;
  beforeCas?: () => Promise<void>;
  beforeAudit?: () => Promise<void>;
} = {}) {
  const operationNow = options.clock?.() ?? now;
  const state = { row: row({ version: 2 }), audit: [] as string[] };
  const createTransaction = () => {
    let queryCount = 0;
    let didMutate = false;
    const tx = {
      $queryRaw: vi.fn().mockImplementation(async () => {
        if (queryCount++ === 0) return [{ id: author.id, role: "AUTHOR", status: "ACTIVE" }];
        if (queryCount === 2) return [{ user_id: author.id, revoked_at: null, expires_at: new Date(operationNow.getTime() + 60_000),
          last_seen_at: new Date(operationNow.getTime() - 1000) }];
        return [{ last_seq: BigInt(state.audit.length), last_hash: new Uint8Array(32) }];
      }),
      alert: {
        findFirst: vi.fn().mockImplementation(async () => ({
          ...state.row,
          frozenPayload: new Uint8Array(state.row.frozenPayload),
          payloadSha256: new Uint8Array(state.row.payloadSha256),
        })),
        updateMany: vi.fn().mockImplementation(async (query: { where: { version: number; lifecycleState: string }; data: Record<string, unknown> }) => {
          await options.beforeCas?.();
          if (state.row.version !== query.where.version || state.row.lifecycleState !== query.where.lifecycleState) return { count: 0 };
          const nextVersion = state.row.version + 1;
          Object.assign(state.row, query.data, { version: nextVersion });
          didMutate = true;
          return { count: 1 };
        }),
      },
      auditEvent: { create: vi.fn().mockImplementation(async ({ data }: { data: { action: string } }) => {
        await options.beforeAudit?.();
        if (auditFailure) throw new Error("audit unavailable");
        state.audit.push(data.action);
      }) },
      auditChainState: { update: vi.fn().mockResolvedValue({}) },
      didMutate: () => didMutate,
    };
    return tx;
  };
  const prisma = {
    $transaction: vi.fn(async (work: (tx: ReturnType<typeof createTransaction>) => Promise<unknown>) => {
      const before = { ...state.row, frozenPayload: new Uint8Array(state.row.frozenPayload),
        payloadSha256: new Uint8Array(state.row.payloadSha256) };
      const auditBefore = [...state.audit];
      const tx = createTransaction();
      try {
        return await work(tx);
      } catch (error) {
        if (tx.didMutate() && state.row.version === before.version + 1) {
          Object.assign(state.row, before);
          state.audit.splice(0, state.audit.length, ...auditBefore);
        }
        throw error;
      }
    }),
  };
  const service = new PrismaDraftAlertService(prisma as unknown as PrismaClient,
    identity.sender, options.clock ?? (() => new Date(now)), () => identity.identifier);
  return { service, prisma, state };
}

describe("servicio de borradores con Prisma simulado", () => {
  it("crea con identidad del servidor y registra auditoría en la misma transacción", async () => {
    const { service, tx, prisma } = fixture();
    const result = await service.create(author, cookie, input);
    expect(result.alert).toEqual({ id: alertId, identifier: identity.identifier,
      lifecycleState: "DRAFT", anchorStatus: "NOT_REQUESTED", notice: "SIMULACRO" });
    expect(prisma.$transaction).toHaveBeenCalledOnce();
    expect(tx.$queryRaw).toHaveBeenCalledTimes(3);
    expect(tx.alert.create.mock.calls[0]![0].data.frozenPayload).toEqual(snapshot.payloadBytes);
    expect(tx.auditEvent.create.mock.calls[0]![0].data).toMatchObject({ action: "ALERT_CREATED", actorId: author.id,
      objectType: "alert", objectId: alertId });
  });

  it("reporta solo la etapa de validación de input para un 422", async () => {
    const reportDiagnostic = vi.fn();
    const { service } = fixture({ reportDiagnostic });

    await expect(service.create(author, cookie, { ...input, kind: "Update" }, "request-422"))
      .rejects.toMatchObject({ status: 422, code: "INVALID_ALERT_PAYLOAD" });

    expect(reportDiagnostic).toHaveBeenCalledOnce();
    expect(reportDiagnostic).toHaveBeenCalledWith({
      requestId: "request-422",
      stage: "INPUT_VALIDATION",
      code: "INVALID_ALERT_PAYLOAD",
    });
    expect(JSON.stringify(reportDiagnostic.mock.calls[0])).not.toContain("Update");
  });

  it("propaga fallo de auditoría y no devuelve creación exitosa", async () => {
    const { service, tx } = fixture({ auditFailure: true });
    await expect(service.create(author, cookie, input)).rejects.toMatchObject({ status: 500, code: "INTERNAL_ERROR" });
    expect(tx.alert.create).toHaveBeenCalledOnce();
    expect(tx.auditChainState.update).not.toHaveBeenCalled();
  });

  it("oculta recursos ajenos; AUTHOR obtiene info, ADMIN solo resumen", async () => {
    const { service, tx } = fixture({ existing: null });
    await expect(service.get(author, alertId)).rejects.toMatchObject({ status: 404, code: "ALERT_NOT_FOUND" });
    expect(tx.approval.findMany).not.toHaveBeenCalled();
    const admin = { ...author, role: "ADMIN" } as const;
    const second = fixture();
    const result = await second.service.get(admin, alertId);
    expect(result.alert).toEqual({ id: alertId, identifier: identity.identifier,
      lifecycleState: "DRAFT", anchorStatus: "NOT_REQUESTED", notice: "SIMULACRO" });
    expect(second.tx.alert.findFirst.mock.calls[0]![0].select).not.toHaveProperty("frozenPayload");
  });

  it("oculta UUID inválido y borrador ajeno sin filtrar su existencia", async () => {
    const { service, tx } = fixture({ existing: null });
    await expect(service.get(author, "id-inválido")).rejects.toMatchObject({ status: 404,
      code: "ALERT_NOT_FOUND" });
    await expect(service.edit(author, cookie, alertId, 1, input)).rejects.toMatchObject({ status: 404,
      code: "ALERT_NOT_FOUND" });
    expect(tx.alert.updateMany).not.toHaveBeenCalled();
  });

  it("APPROVER elegible recibe bytes persistidos y digest sin reserialización", async () => {
    const bytes = Buffer.concat([Buffer.from(" \n"), Buffer.from(snapshot.payloadBytes)]);
    const digest = await import("node:crypto").then(({ createHash }) => createHash("sha256").update(bytes).digest());
    const { service } = fixture({ existing: row({ lifecycleState: "PENDING_APPROVAL", frozenPayload: bytes,
      payloadSha256: digest, approvedPayloadSha256: digest }) });
    const result = await service.get(other, alertId);
    expect(result.alert).toMatchObject({ reviewSnapshot: {
      payloadBase64Url: bytes.toString("base64url"), payloadDigestHex: digest.toString("hex"),
    } });
  });

  it("falla cerrado ante digest corrupto", async () => {
    const { service } = fixture({ existing: row({ payloadSha256: new Uint8Array(32) }) });
    await expect(service.get(author, alertId)).rejects.toMatchObject({ status: 500, code: "INTERNAL_ERROR" });
  });

  it("lista con alcance derivado del rol y cuenta bajo el mismo snapshot", async () => {
    const { service, tx, prisma } = fixture();
    await service.list(other, 2, 10);
    expect(tx.alert.count.mock.calls[0]![0].where).toMatchObject({ authorId: { not: other.id },
      lifecycleState: "PENDING_APPROVAL" });
    expect(tx.alert.findMany.mock.calls[0]![0]).toMatchObject({ skip: 10, take: 10 });
    expect(prisma.$transaction.mock.calls[0]![1]).toMatchObject({ isolationLevel: "RepeatableRead" });
    const authorList = fixture();
    await authorList.service.list(author, 1, 20);
    expect(authorList.tx.alert.count.mock.calls[0]![0].where).toMatchObject({ kind: "Alert", authorId: author.id });
    expect(authorList.tx.alert.findMany.mock.calls[0]![0].where.AND[0]).toMatchObject({ authorId: author.id });
  });

  it("rechaza versión obsoleta y estado congelado antes de actualizar", async () => {
    const stale = fixture({ existing: row({ version: 2 }) });
    await expect(stale.service.edit(author, cookie, alertId, 1, input)).rejects.toMatchObject({ status: 409,
      code: "STALE_ALERT_VERSION" });
    expect(stale.tx.alert.updateMany).not.toHaveBeenCalled();
    const frozen = fixture({ existing: row({ lifecycleState: "PENDING_APPROVAL" }) });
    await expect(frozen.service.edit(author, cookie, alertId, 1, input)).rejects.toMatchObject({ status: 409,
      code: "INVALID_STATE_TRANSITION" });
    expect(frozen.tx.alert.updateMany).not.toHaveBeenCalled();
  });

  it("corrige REJECTED como nueva versión y conserva identidad y decisión histórica", async () => {
    const previous = row({ lifecycleState: "REJECTED" });
    const updated = row({ lifecycleState: "DRAFT", version: 2 });
    const { service, tx } = fixture({ existing: previous });
    tx.alert.findFirst.mockResolvedValueOnce(previous).mockResolvedValueOnce(previous).mockResolvedValueOnce(updated);
    const result = await service.edit(author, cookie, alertId, 1, input);
    expect(result.version).toBe(2);
    const mutation = tx.alert.updateMany.mock.calls[0]![0];
    expect(mutation.where).toMatchObject({ authorId: author.id, version: 1, lifecycleState: "REJECTED",
      sender: identity.sender, identifier: identity.identifier, sentText: identity.sent });
    expect(mutation.data).toMatchObject({ version: { increment: 1 }, lifecycleState: "DRAFT" });
    expect(tx.approval.findMany).not.toHaveBeenCalled();
    expect(tx.auditEvent.create.mock.calls[0]![0].data.action).toBe("ALERT_REVISED");
  });

  it("detiene edición al límite INTEGER antes del incremento", async () => {
    const max = fixture({ existing: row({ version: 2_147_483_647 }) });
    await expect(max.service.edit(author, cookie, alertId, 2_147_483_647, input)).rejects.toMatchObject({
      status: 409, code: "STALE_ALERT_VERSION",
    });
    expect(max.tx.alert.updateMany).not.toHaveBeenCalled();
  });

  it("rechaza campos fijados por el servidor antes de escribir", async () => {
    const { service, tx } = fixture();
    await expect(service.create(author, cookie, { ...input, authorId: other.id })).rejects.toMatchObject({
      status: 422, code: "INVALID_ALERT_PAYLOAD",
    });
    await expect(service.create(author, cookie, { ...input, sender: "otro" })).rejects.toMatchObject({
      status: 422, code: "INVALID_ALERT_PAYLOAD",
    });
    expect(tx.alert.create).not.toHaveBeenCalled();
  });

  it("rechaza sesión revocada dentro de la transacción antes de crear", async () => {
    const { service, tx } = fixture();
    tx.$queryRaw.mockReset().mockResolvedValueOnce([{ id: author.id, role: "AUTHOR", status: "ACTIVE" }])
      .mockResolvedValueOnce([{ user_id: author.id, revoked_at: now, expires_at: new Date(now.getTime() + 60_000),
        last_seen_at: new Date(now.getTime() - 1000) }]);
    await expect(service.create(author, cookie, input)).rejects.toMatchObject({ status: 401 });
    expect(tx.alert.create).not.toHaveBeenCalled();
  });

  it("normaliza conflicto de serialización sin revelar el error del controlador", async () => {
    const { service, prisma } = fixture();
    prisma.$transaction.mockRejectedValueOnce({ code: "P2034", message: "driver details" });
    await expect(service.create(author, cookie, input)).rejects.toMatchObject({
      status: 500, code: "INTERNAL_ERROR",
    });
  });

  it.each(["Severe", "Extreme", "Moderate", "Minor", "Unknown"] as const)(
    "envía %s con snapshot congelado, CAS y auditoría atómica", async (severity) => {
      const sourcePayload = buildDraftPayload(validateAlertInput({
        ...input, info: { ...input.info, severity },
      }, identity.sent), identity);
      const source = row({ severity, frozenPayload: sourcePayload.payloadBytes, payloadSha256: sourcePayload.payloadDigest });
      const { service, tx, prisma } = fixture({ existing: source });
      const result = await service.submit(author, cookie, alertId, 1);
      const expectedState = severity === "Severe" || severity === "Extreme" ? "PENDING_APPROVAL" : "READY_TO_SIGN";
      expect(result).toMatchObject({ lifecycleState: expectedState, version: 2, payloadDigestHex: sourcePayload.payloadDigestHex });
      expect(prisma.$transaction).toHaveBeenCalledWith(expect.any(Function), {
        isolationLevel: "Serializable",
      });
      expect(tx.alert.updateMany).toHaveBeenCalledOnce();
      expect(tx.auditEvent.create).toHaveBeenCalledOnce();
      expect(tx.auditEvent.create.mock.calls[0]![0].data).toMatchObject({
        action: "ALERT_SUBMITTED", actorId: author.id, objectId: alertId,
        redactedDetails: { kind: "Alert", status: `DRAFT_TO_${expectedState}`, result: "v2" },
      });
    },
  );

  it("revalida la sesión y exige AUTHOR antes de modificar", async () => {
    const approver = { ...author, role: "APPROVER" } as const;
    const { service, tx } = fixture();
    await expect(service.submit(approver, cookie, alertId, 1)).rejects.toMatchObject({
      status: 403, code: "ROLE_FORBIDDEN",
    });
    expect(tx.alert.updateMany).not.toHaveBeenCalled();

    const revoked = fixture();
    revoked.tx.$queryRaw.mockReset()
      .mockResolvedValueOnce([{ id: author.id, role: "AUTHOR", status: "ACTIVE" }])
      .mockResolvedValueOnce([{ user_id: author.id, revoked_at: now, expires_at: new Date(now.getTime() + 60_000),
        last_seen_at: new Date(now.getTime() - 1000) }]);
    await expect(revoked.service.submit(author, cookie, alertId, 1)).rejects.toMatchObject({
      status: 401, code: "AUTH_REQUIRED",
    });
    expect(revoked.tx.alert.updateMany).not.toHaveBeenCalled();
  });

  it("oculta una alerta ajena y rechaza la versión obsoleta", async () => {
    const foreign = fixture({ existing: null });
    await expect(foreign.service.submit(author, cookie, alertId, 1)).rejects.toMatchObject({
      status: 404, code: "ALERT_NOT_FOUND",
    });
    const stale = fixture({ existing: row({ version: 2 }) });
    await expect(stale.service.submit(author, cookie, alertId, 1)).rejects.toMatchObject({
      status: 409, code: "STALE_ALERT_VERSION",
    });
    expect(stale.tx.alert.updateMany).not.toHaveBeenCalled();
  });

  it("rechaza estado no DRAFT, expiración al submit e integridad alterada", async () => {
    const pending = fixture({ existing: row({ lifecycleState: "PENDING_APPROVAL" }) });
    await expect(pending.service.submit(author, cookie, alertId, 1)).rejects.toMatchObject({
      status: 409, code: "INVALID_STATE_TRANSITION",
    });
    const atExpiry = fixture({ clock: () => new Date("2026-10-21T14:00:00.000Z") });
    await expect(atExpiry.service.submit(author, cookie, alertId, 1)).rejects.toMatchObject({
      status: 422, code: "INVALID_ALERT_PAYLOAD",
    });
    const corrupt = fixture({ existing: row({ payloadSha256: new Uint8Array(32) }) });
    await expect(corrupt.service.submit(author, cookie, alertId, 1)).rejects.toMatchObject({
      status: 500, code: "INTERNAL_ERROR",
    });
  });

  it("revierte lógicamente si falla el CAS o la auditoría y consulta tiempo tras cada espera relevante", async () => {
    const cas = fixture();
    cas.tx.alert.updateMany.mockResolvedValueOnce({ count: 0 });
    await expect(cas.service.submit(author, cookie, alertId, 1)).rejects.toMatchObject({
      status: 409, code: "STALE_ALERT_VERSION",
    });
    expect(cas.tx.auditEvent.create).not.toHaveBeenCalled();

    const audit = fixture({ auditFailure: true });
    await expect(audit.service.submit(author, cookie, alertId, 1)).rejects.toMatchObject({
      status: 500, code: "INTERNAL_ERROR",
    });
    expect(audit.tx.alert.updateMany).toHaveBeenCalledOnce();

    const clock = vi.fn(() => new Date(now));
    const timed = fixture({ clock });
    clock.mockClear();
    await timed.service.submit(author, cookie, alertId, 1);
    expect(clock).toHaveBeenCalledTimes(4);
  });

  it("rechaza la sesión que expira mientras se espera su bloqueo, sin CAS ni auditoría", async () => {
    let current = now.getTime();
    const gate = barrier();
    const { service, tx } = fixture({ clock: () => new Date(current) });
    const query = tx.$queryRaw.getMockImplementation()!;
    let calls = 0;
    tx.$queryRaw.mockImplementation(async () => {
      if (++calls === 2) await gate.wait();
      return query();
    });
    const submit = service.submit(author, cookie, alertId, 1);
    await gate.reached;
    current = now.getTime() + 60_000;
    gate.release();
    await expect(submit).rejects.toMatchObject({ status: 401, code: "AUTH_REQUIRED" });
    expect(tx.alert.updateMany).not.toHaveBeenCalled();
    expect(tx.auditEvent.create).not.toHaveBeenCalled();
  });

  it("usa la hora posterior a una lectura bloqueada de alerta para rechazar expires", async () => {
    let current = Date.parse("2026-10-21T13:59:59.999Z");
    const gate = barrier();
    const { service, tx } = fixture({ clock: () => new Date(current) });
    const read = tx.alert.findFirst.getMockImplementation()!;
    tx.alert.findFirst.mockImplementation(async () => { await gate.wait(); return read(); });
    const submit = service.submit(author, cookie, alertId, 1);
    await gate.reached;
    current = Date.parse("2026-10-21T14:00:00.000Z");
    gate.release();
    await expect(submit).rejects.toMatchObject({ status: 422, code: "INVALID_ALERT_PAYLOAD" });
    expect(tx.alert.updateMany).not.toHaveBeenCalled();
    expect(tx.auditEvent.create).not.toHaveBeenCalled();
  });

  it("continúa cuando la espera no cruza expiración y fija submitAt tras ella", async () => {
    let current = Date.parse("2026-10-21T13:59:59.000Z");
    const gate = barrier();
    const clock = vi.fn(() => new Date(current));
    const { service, tx } = fixture({ clock });
    clock.mockClear();
    const query = tx.$queryRaw.getMockImplementation()!;
    let calls = 0;
    tx.$queryRaw.mockImplementation(async () => {
      if (++calls === 2) await gate.wait();
      return query();
    });
    const submit = service.submit(author, cookie, alertId, 1);
    await gate.reached;
    expect(clock).not.toHaveBeenCalled();
    current = Date.parse("2026-10-21T13:59:59.500Z");
    gate.release();
    await expect(submit).resolves.toMatchObject({ lifecycleState: "PENDING_APPROVAL", version: 2 });
    expect(clock).toHaveBeenCalledTimes(4);
    expect(tx.alert.updateMany).toHaveBeenCalledOnce();
    expect(tx.auditEvent.create).toHaveBeenCalledOnce();
  });

  it.each([
    ["sesión", Date.parse("2026-10-21T13:00:00.000Z"), Date.parse("2026-10-21T13:01:00.000Z"), 401, "AUTH_REQUIRED"],
    ["alerta", Date.parse("2026-10-21T13:59:59.000Z"), Date.parse("2026-10-21T14:00:00.000Z"), 422, "INVALID_ALERT_PAYLOAD"],
  ] as const)("revierte el CAS si su espera cruza expiración de %s", async (_label, start, expiry, status, code) => {
    let current = start;
    const gate = barrier();
    const race = sharedRaceFixture(false, { clock: () => new Date(current), beforeCas: () => gate.wait() });
    const submit = race.service.submit(author, cookie, alertId, 2);
    await gate.reached;
    current = expiry;
    gate.release();
    await expect(submit).rejects.toMatchObject({ status, code });
    expect(race.state.row.version).toBe(2);
    expect(race.state.row.lifecycleState).toBe("DRAFT");
    expect(race.state.audit).toEqual([]);
  });

  it("revierte CAS y auditoría si expires se cruza mientras espera la cabeza de auditoría", async () => {
    let current = Date.parse("2026-10-21T13:59:59.000Z");
    const gate = barrier();
    const race = sharedRaceFixture(false, { clock: () => new Date(current), beforeAudit: () => gate.wait() });
    const submit = race.service.submit(author, cookie, alertId, 2);
    await gate.reached;
    current = Date.parse("2026-10-21T14:00:00.000Z");
    gate.release();
    await expect(submit).rejects.toMatchObject({ status: 422, code: "INVALID_ALERT_PAYLOAD" });
    expect(race.state.row.version).toBe(2);
    expect(race.state.row.lifecycleState).toBe("DRAFT");
    expect(race.state.audit).toEqual([]);
    expect(race.prisma.$transaction).toHaveBeenCalledWith(expect.any(Function), { isolationLevel: "Serializable" });
  });

  it("dos submits concurrentes comparten fila y solo uno audita éxito", async () => {
    const first = sharedRaceFixture();
    const second = new PrismaDraftAlertService(
      (first.prisma as unknown as PrismaClient),
      identity.sender, () => new Date(now), () => identity.identifier,
    );
    const results = await Promise.allSettled([
      first.service.submit(author, cookie, alertId, 2),
      second.submit(author, cookie, alertId, 2),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect(first.state.row.version).toBe(3);
    expect(first.state.audit).toEqual(["ALERT_SUBMITTED"]);
  });

  it.each(["patch", "submit"] as const)("la operación %s gana la carrera frente a la otra mutación", async (winner) => {
    const race = sharedRaceFixture();
    const operations = winner === "patch"
      ? [() => race.service.edit(author, cookie, alertId, 2, input), () => race.service.submit(author, cookie, alertId, 2)]
      : [() => race.service.submit(author, cookie, alertId, 2), () => race.service.edit(author, cookie, alertId, 2, input)];
    const results = await Promise.allSettled([operations[0]!(), operations[1]!()]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect(race.state.row.version).toBe(3);
    expect(race.state.audit).toHaveLength(1);
  });

  it("el fake transaccional revierte CAS y auditoría ante fallo posterior", async () => {
    const race = sharedRaceFixture(true);
    await expect(race.service.submit(author, cookie, alertId, 2)).rejects.toMatchObject({
      status: 500, code: "INTERNAL_ERROR",
    });
    expect(race.state.row.version).toBe(2);
    expect(race.state.row.lifecycleState).toBe("DRAFT");
    expect(race.state.audit).toEqual([]);
  });

  it("convierte P2034 del submit en conflicto de versión saneado y no reintenta", async () => {
    const race = sharedRaceFixture();
    race.prisma.$transaction.mockRejectedValueOnce({ code: "P2034", message: "driver details" });
    await expect(race.service.submit(author, cookie, alertId, 2)).rejects.toMatchObject({
      status: 409, code: "STALE_ALERT_VERSION",
    });
    expect(race.prisma.$transaction).toHaveBeenCalledOnce();
    expect(race.state.row.version).toBe(2);
    expect(race.state.audit).toEqual([]);
  });

  it("aprueba el snapshot intacto, avanza a READY_TO_SIGN y audita en una transacción", async () => {
    const decision = decisionFixture();
    const result = await decision.service.approve(approver, cookie, alertId, {
      expectedDigestHex: snapshot.payloadDigestHex, expectedVersion: 2,
    });
    expect(result).toMatchObject({ alert: { lifecycleState: "READY_TO_SIGN" }, version: 3 });
    expect(decision.prisma.$transaction).toHaveBeenCalledWith(expect.any(Function), {
      isolationLevel: "Serializable",
    });
    expect(decision.tx.alert.updateMany).toHaveBeenCalledOnce();
    expect(decision.tx.alert.updateMany.mock.calls[0]![0].data).toMatchObject({
      lifecycleState: "READY_TO_SIGN", version: { increment: 1 },
      approvedPayloadSha256: snapshot.payloadDigest,
    });
    expect(decision.tx.approval.create).toHaveBeenCalledWith({ data: expect.objectContaining({
      alertId, approverId: approver.id, alertVersion: 2, decision: "APPROVED", reason: null,
      reviewedPayload: snapshot.payloadBytes, digest: snapshot.payloadDigest,
    }) });
    expect(decision.state.audits).toHaveLength(1);
    expect(decision.state.audits[0]).toMatchObject({ action: "ALERT_APPROVED", actorId: approver.id });
  });

  it("rechaza con motivo asociado al snapshot y no registra texto libre en auditoría", async () => {
    const decision = decisionFixture();
    const reason = "El contenido requiere corrección";
    const result = await decision.service.reject(approver, cookie, alertId, {
      reason, expectedDigestHex: snapshot.payloadDigestHex, expectedVersion: 2,
    });
    expect(result).toMatchObject({ alert: { lifecycleState: "REJECTED" }, version: 3 });
    expect(decision.tx.approval.create).toHaveBeenCalledWith({ data: expect.objectContaining({
      alertId, approverId: approver.id, alertVersion: 2, decision: "REJECTED", reason,
      reviewedPayload: snapshot.payloadBytes, digest: snapshot.payloadDigest,
    }) });
    expect(decision.state.audits[0]).toMatchObject({ action: "ALERT_REJECTED", actorId: approver.id });
    expect(JSON.stringify(decision.state.audits, (_key, value: unknown) =>
      typeof value === "bigint" ? value.toString() : value)).not.toContain(reason);
  });

  it("rechaza rol no autorizado y autor que intenta decidir su alerta", async () => {
    const unauthorized = decisionFixture({ actor: author });
    await expect(unauthorized.service.approve(author, cookie, alertId, {
      expectedDigestHex: snapshot.payloadDigestHex, expectedVersion: 2,
    })).rejects.toMatchObject({ status: 403, code: "ROLE_FORBIDDEN" });
    expect(unauthorized.prisma.$transaction).not.toHaveBeenCalled();

    const self = decisionFixture({ existing: row({
      authorId: approver.id, lifecycleState: "PENDING_APPROVAL", version: 2,
    }) });
    await expect(self.service.approve(approver, cookie, alertId, {
      expectedDigestHex: snapshot.payloadDigestHex, expectedVersion: 2,
    })).rejects.toMatchObject({ status: 403, code: "SELF_APPROVAL_FORBIDDEN" });
    expect(self.tx.alert.updateMany).not.toHaveBeenCalled();
  });

  it("rechaza estados incompatibles, versiones/digest obsoletos y decisiones duplicadas", async () => {
    const wrongState = decisionFixture({ existing: row({ lifecycleState: "READY_TO_SIGN", version: 2 }) });
    await expect(wrongState.service.approve(approver, cookie, alertId, {
      expectedDigestHex: snapshot.payloadDigestHex, expectedVersion: 2,
    })).rejects.toMatchObject({ status: 409, code: "INVALID_STATE_TRANSITION" });

    const stale = decisionFixture();
    await expect(stale.service.approve(approver, cookie, alertId, {
      expectedDigestHex: snapshot.payloadDigestHex, expectedVersion: 1,
    })).rejects.toMatchObject({ status: 409, code: "STALE_ALERT_VERSION" });
    await expect(stale.service.reject(approver, cookie, alertId, {
      reason: "Motivo válido", expectedDigestHex: "f".repeat(64), expectedVersion: 2,
    })).rejects.toMatchObject({ status: 409, code: "STALE_ALERT_VERSION" });
    expect(stale.tx.alert.updateMany).not.toHaveBeenCalled();

    const duplicate = decisionFixture({ priorDecision: true });
    await expect(duplicate.service.reject(approver, cookie, alertId, {
      reason: "Motivo válido", expectedDigestHex: snapshot.payloadDigestHex, expectedVersion: 2,
    })).rejects.toMatchObject({ status: 409, code: "INVALID_STATE_TRANSITION" });
    expect(duplicate.tx.alert.updateMany).not.toHaveBeenCalled();
  });

  it("maneja conflicto CAS y conserva snapshot íntegro ante auditoría fallida", async () => {
    const conflict = decisionFixture({ casConflict: true });
    await expect(conflict.service.approve(approver, cookie, alertId, {
      expectedDigestHex: snapshot.payloadDigestHex, expectedVersion: 2,
    })).rejects.toMatchObject({ status: 409, code: "STALE_ALERT_VERSION" });
    expect(conflict.tx.approval.create).not.toHaveBeenCalled();
    expect(conflict.tx.auditEvent.create).not.toHaveBeenCalled();

    const failedAudit = decisionFixture({ auditFailure: true });
    const originalPayload = new Uint8Array(failedAudit.state.alert!.frozenPayload);
    await expect(failedAudit.service.reject(approver, cookie, alertId, {
      reason: "Motivo válido", expectedDigestHex: snapshot.payloadDigestHex, expectedVersion: 2,
    })).rejects.toMatchObject({ status: 500, code: "INTERNAL_ERROR" });
    expect(failedAudit.state.alert).toMatchObject({ lifecycleState: "PENDING_APPROVAL", version: 2 });
    expect(failedAudit.state.alert!.frozenPayload).toEqual(originalPayload);
    expect(failedAudit.state.decisions).toEqual([]);
    expect(failedAudit.state.audits).toEqual([]);
  });

  it("traduce P2034 de una decisión a conflicto de versión sin exponer detalles del driver", async () => {
    const conflict = decisionFixture();
    conflict.prisma.$transaction.mockRejectedValueOnce({ code: "P2034", message: "private driver detail" });
    await expect(conflict.service.approve(approver, cookie, alertId, {
      expectedDigestHex: snapshot.payloadDigestHex, expectedVersion: 2,
    })).rejects.toMatchObject({ status: 409, code: "STALE_ALERT_VERSION" });
    expect(conflict.prisma.$transaction).toHaveBeenCalledOnce();
  });

  it("falla cerrada si los bytes congelados no coinciden con su digest", async () => {
    const corrupt = decisionFixture({ existing: row({ frozenPayload: Buffer.from("alterado") }) });
    await expect(corrupt.service.approve(approver, cookie, alertId, {
      expectedDigestHex: snapshot.payloadDigestHex, expectedVersion: 2,
    })).rejects.toMatchObject({ status: 500, code: "INTERNAL_ERROR" });
    expect(corrupt.tx.alert.updateMany).not.toHaveBeenCalled();
    expect(corrupt.tx.approval.create).not.toHaveBeenCalled();
  });
});
