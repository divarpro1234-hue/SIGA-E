import { describe, expect, it, vi } from "vitest";
import type { Prisma } from "../../src/generated/prisma/client.js";
import { validateAlertInput } from "../../src/modules/alerts/alert-input.js";
import { buildDraftPayload, calculatePayloadDigest, freezeAlertPayload } from "../../src/modules/alerts/alert-payload.js";
import type { PayloadSnapshot } from "../../src/modules/alerts/alert-payload.js";
import { MAX_ALERT_VERSION, prepareApprovalData } from "../../src/modules/alerts/alert-persistence.js";
import type { DecisionInput } from "../../src/modules/alerts/alert-persistence.js";
import { PrismaAlertRepository } from "../../src/modules/alerts/prisma-alert-repository.js";
import type { ContentScope, StoredAlert } from "../../src/modules/alerts/prisma-alert-repository.js";
import { identity, input } from "./alert-fixtures.js";

const id = "00000000-0000-4000-8000-000000000001";
const authorId = "00000000-0000-4000-8000-000000000002";
const approverId = "00000000-0000-4000-8000-000000000003";
const scope = { kind: "AUTHOR", actorId: authorId } as const;
const draft = () => buildDraftPayload(validateAlertInput(input, identity.sent), identity);
const frozen = (severity: "Extreme" | "Severe" | "Moderate" | "Minor" | "Unknown" = "Severe") =>
  freezeAlertPayload(validateAlertInput({ ...input, info: { ...input.info, severity } }, identity.sent),
    identity, new Date("2026-10-21T13:00:00.000Z"));
function stored(overrides: Partial<StoredAlert> = {}): StoredAlert {
  const payload = draft();
  return { id, authorId, sender: identity.sender, identifier: identity.identifier, sentText: identity.sent,
    kind: "Alert", severity: "Severe", lifecycleState: "DRAFT", anchorStatus: "NOT_REQUESTED", version: 1,
    frozenPayload: new Uint8Array(payload.payloadBytes), payloadSha256: new Uint8Array(payload.payloadDigest), approvedPayloadSha256: null, ...overrides };
}
function fixture(row: StoredAlert | null = stored()) {
  const tx = {
    $transaction: vi.fn(),
    alert: { create: vi.fn().mockResolvedValue(row), findFirst: vi.fn().mockResolvedValue(row),
      findMany: vi.fn().mockResolvedValue([]), updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
    approval: { findMany: vi.fn().mockResolvedValue([]) },
  };
  return { tx, repo: new PrismaAlertRepository(tx as unknown as Prisma.TransactionClient) };
}
const edit = () => ({ id, authorId, expectedVersion: 1, expectedState: "DRAFT" as const, payload: draft() });

describe("persistencia M2 con dobles de Prisma (sin base real)", () => {
  it("acepta TransactionClient con $transaction propio y usa sus operaciones", async () => {
    const { tx, repo } = fixture();

    await repo.createDraft(authorId, draft());

    expect(tx.alert.create).toHaveBeenCalledOnce();
    expect(tx.$transaction).not.toHaveBeenCalled();
  });

  it("mapea creación, preserva bytes y fija valores internos", async () => {
    const { tx, repo } = fixture();
    const payload = draft();
    const row = await repo.createDraft(authorId, payload);
    const data = tx.alert.create.mock.calls[0]![0].data;
    expect(data).toEqual({ sender: identity.sender, identifier: identity.identifier, sentText: identity.sent,
      kind: "Alert", severity: "Severe", authorId, version: 1, lifecycleState: "DRAFT", anchorStatus: "NOT_REQUESTED",
      frozenPayload: payload.payloadBytes, payloadSha256: payload.payloadDigest });
    expect(row.frozenPayload).toEqual(payload.payloadBytes);
    expect(data.frozenPayload).not.toBe(payload.payloadBytes);
  });
  it("comprueba bytes y digest sin reconstruir JSON", async () => {
    const payload = draft();
    const bytes = Buffer.concat([Buffer.from(" \n"), Buffer.from(payload.payloadBytes)]);
    const digest = calculatePayloadDigest(bytes);
    const { tx, repo } = fixture(stored({ frozenPayload: bytes, payloadSha256: Uint8Array.from(digest) }));
    await repo.createDraft(authorId, { phase: "DRAFT", payloadBytes: bytes, payloadDigest: digest,
      payloadDigestHex: Buffer.from(digest).toString("hex") });
    expect(tx.alert.create.mock.calls[0]![0].data.frozenPayload).toEqual(Uint8Array.from(bytes));
  });
  it("rechaza digest alterado antes de escribir", async () => {
    const { tx, repo } = fixture();
    await expect(repo.createDraft(authorId, { ...draft(), payloadDigest: new Uint8Array(32) })).rejects.toMatchObject({ code: "PAYLOAD_INTEGRITY_ERROR" });
    await expect(repo.createDraft(authorId, { ...draft(), payloadDigestHex: "0".repeat(64) })).rejects.toMatchObject({ code: "PAYLOAD_INTEGRITY_ERROR" });
    expect(tx.alert.create).not.toHaveBeenCalled();
  });
  it("rechaza instantánea congelada como borrador", async () => {
    const { tx, repo } = fixture();
    const frozen = freezeAlertPayload(validateAlertInput(input, identity.sent), identity, new Date(identity.sent));
    await expect(repo.createDraft(authorId, frozen as unknown as PayloadSnapshot<"DRAFT">)).rejects.toMatchObject({ code: "INVALID_STATE_TRANSITION" });
    expect(tx.alert.create).not.toHaveBeenCalled();
  });
  it("recupera por UUID con alcance y devuelve copias", async () => {
    const source = stored();
    const { tx, repo } = fixture(source);
    const row = await repo.findById(id, scope);
    expect(tx.alert.findFirst.mock.calls[0]![0].where).toEqual({ AND: [{ id }, { kind: "Alert", authorId }] });
    row!.frozenPayload.fill(0);
    expect(source.frozenPayload).toEqual(draft().payloadBytes);
    tx.alert.findFirst.mockResolvedValue(null);
    expect(await repo.findById(id, scope)).toBeNull();
  });
  it.each([
    { payloadSha256: new Uint8Array(32) }, { sender: "otro" }, { identifier: "otro" },
    { sentText: "2026-10-21T12:00:01.000Z" }, { severity: "Minor" as const },
    { approvedPayloadSha256: new Uint8Array(32) },
  ])("falla cerrado con registro inconsistente %#", async (change) => {
    const { repo } = fixture(stored(change));
    await expect(repo.findById(id, scope)).rejects.toMatchObject({ code: "PAYLOAD_INTEGRITY_ERROR" });
  });
  it("combina filtros con alcance sin ampliarlo; ADMIN recibe solo resumen", async () => {
    const { tx, repo } = fixture();
    await repo.list({ kind: "REVIEWER", actorId: approverId }, { state: "DRAFT", skip: 20, take: 10 });
    expect(tx.alert.findMany.mock.calls[0]![0]).toMatchObject({ where: { AND: [
      { kind: "Alert", authorId: { not: approverId }, lifecycleState: "PENDING_APPROVAL", severity: { in: ["Severe", "Extreme"] } },
      { lifecycleState: "DRAFT" },
    ] }, skip: 20, take: 10 });
    await repo.list({ kind: "ADMIN_SUMMARY" });
    expect(tx.alert.findMany.mock.calls[1]![0].select).toEqual({ id: true, identifier: true, lifecycleState: true, anchorStatus: true });
    await expect(repo.findById(id, { kind: "ADMIN_SUMMARY" } as unknown as ContentScope)).rejects.toMatchObject({ code: "INVALID_PERSISTENCE_INPUT" });
  });
  it.each([{ take: 0 }, { take: 101 }, { skip: -1 }, { skip: 1.5 }])("limita paginación %#", async (filter) => {
    const { tx, repo } = fixture();
    await expect(repo.list(scope, filter)).rejects.toMatchObject({ code: "INVALID_PERSISTENCE_INPUT" });
    expect(tx.alert.findMany).not.toHaveBeenCalled();
  });
  it.each(["DRAFT", "REJECTED"] as const)("actualiza %s por compare-and-set conservando identidad e historia", async (state) => {
    const { tx, repo } = fixture(stored({ lifecycleState: state }));
    expect(await repo.updateDraft({ ...edit(), expectedState: state })).toBe(2);
    const query = tx.alert.updateMany.mock.calls[0]![0];
    expect(query.where).toMatchObject({ id, authorId, version: 1, lifecycleState: state,
      sender: identity.sender, identifier: identity.identifier, sentText: identity.sent,
      jwsCompact: null, approvedPayloadSha256: null, anchorStatus: "NOT_REQUESTED" });
    expect(Object.keys(query.data).sort()).toEqual(["frozenPayload", "payloadSha256", "severity", "lifecycleState", "version"].sort());
    expect(query.data.version).toEqual({ increment: 1 });
    expect(query.data.lifecycleState).toBe("DRAFT");
    expect(Object.keys(tx.approval)).toEqual(["findMany"]);
  });
  it.each([
    ["Severe", "PENDING_APPROVAL"],
    ["Extreme", "PENDING_APPROVAL"],
    ["Moderate", "READY_TO_SIGN"],
    ["Minor", "READY_TO_SIGN"],
    ["Unknown", "READY_TO_SIGN"],
  ] as const)("envía %s con CAS al estado %s", async (severity, lifecycleState) => {
    const payload = frozen(severity);
    const { tx, repo } = fixture(stored({
      severity,
      frozenPayload: new Uint8Array(payload.payloadBytes),
      payloadSha256: new Uint8Array(payload.payloadDigest),
    }));
    await expect(repo.submitDraft({ id, authorId, expectedVersion: 1, payload }))
      .resolves.toMatchObject({ lifecycleState, version: 2, payloadSha256: payload.payloadDigest });
    const query = tx.alert.updateMany.mock.calls[0]![0];
    expect(query.where).toMatchObject({
      id, authorId, kind: "Alert", lifecycleState: "DRAFT", version: 1,
      sender: identity.sender, identifier: identity.identifier, sentText: identity.sent,
    });
    expect(query.data).toMatchObject({
      frozenPayload: payload.payloadBytes, payloadSha256: payload.payloadDigest,
      severity, lifecycleState, version: { increment: 1 },
    });
  });
  it("rechaza payload congelado con digest inconsistente o identidad alterada antes del CAS", async () => {
    const payload = frozen();
    const { tx, repo } = fixture();
    await expect(repo.submitDraft({ id, authorId, expectedVersion: 1,
      payload: { ...payload, payloadDigest: new Uint8Array(32) } })).rejects.toMatchObject({ code: "PAYLOAD_INTEGRITY_ERROR" });
    const changed = freezeAlertPayload(validateAlertInput(input, identity.sent), { ...identity, identifier: "otro" },
      new Date("2026-10-21T13:00:00.000Z"));
    await expect(repo.submitDraft({ id, authorId, expectedVersion: 1, payload: changed }))
      .rejects.toMatchObject({ code: "PAYLOAD_INTEGRITY_ERROR" });
    expect(tx.alert.updateMany).not.toHaveBeenCalled();
  });
  it("rechaza versión obsoleta, alerta ajena y estados no DRAFT sin escribir", async () => {
    const payload = frozen();
    const stale = fixture(stored({ version: 2 }));
    await expect(stale.repo.submitDraft({ id, authorId, expectedVersion: 1, payload }))
      .rejects.toMatchObject({ code: "STALE_ALERT_VERSION" });
    const foreign = fixture(null);
    await expect(foreign.repo.submitDraft({ id, authorId, expectedVersion: 1, payload }))
      .rejects.toMatchObject({ code: "STALE_ALERT_VERSION" });
    const pending = fixture(stored({ lifecycleState: "PENDING_APPROVAL" }));
    await expect(pending.repo.submitDraft({ id, authorId, expectedVersion: 1, payload }))
      .rejects.toMatchObject({ code: "INVALID_STATE_TRANSITION" });
    expect(stale.tx.alert.updateMany).not.toHaveBeenCalled();
    expect(foreign.tx.alert.updateMany).not.toHaveBeenCalled();
    expect(pending.tx.alert.updateMany).not.toHaveBeenCalled();
  });
  it("rechaza versión máxima y protege campos de firma, anclaje y publicación", async () => {
    const payload = frozen();
    const { tx, repo } = fixture();
    await expect(repo.submitDraft({ id, authorId, expectedVersion: MAX_ALERT_VERSION, payload }))
      .rejects.toMatchObject({ code: "VERSION_LIMIT_REACHED" });
    const query = tx.alert.updateMany.mock.calls[0]?.[0];
    expect(query).toBeUndefined();
    const successful = fixture();
    await successful.repo.submitDraft({ id, authorId, expectedVersion: 1, payload });
    const where = successful.tx.alert.updateMany.mock.calls[0]![0].where;
    expect(where).toMatchObject({
      anchorStatus: "NOT_REQUESTED", jwsCompact: null, kid: null,
      messageKey: null, jwsHash: null, publishedAt: null, approvedPayloadSha256: null,
    });
  });
  it("no hace escritura adicional si el CAS afecta cero filas ni abre transacciones anidadas", async () => {
    const payload = frozen();
    const { tx, repo } = fixture();
    tx.alert.updateMany.mockResolvedValue({ count: 0 });
    await expect(repo.submitDraft({ id, authorId, expectedVersion: 1, payload }))
      .rejects.toMatchObject({ code: "STALE_ALERT_VERSION" });
    expect(tx.alert.updateMany).toHaveBeenCalledOnce();
    expect(tx.$transaction).not.toHaveBeenCalled();
  });
  it("dos repositorios comparten estado: solo un submit CAS modifica la alerta", async () => {
    const payload = frozen();
    const shared = stored({ version: 2 });
    const createShared = () => {
      const tx = {
        $transaction: vi.fn(),
        alert: {
          findFirst: vi.fn().mockImplementation(async () => shared),
          updateMany: vi.fn().mockImplementation(async (query: { where: { version: number }; data: Record<string, unknown> }) => {
            if (shared.version !== query.where.version || shared.lifecycleState !== "DRAFT") return { count: 0 };
            Object.assign(shared, query.data, { version: shared.version + 1 });
            return { count: 1 };
          }),
        },
      };
      return { tx, repo: new PrismaAlertRepository(tx as unknown as Prisma.TransactionClient) };
    };
    const first = createShared();
    const second = createShared();
    const results = await Promise.allSettled([
      first.repo.submitDraft({ id, authorId, expectedVersion: 2, payload }),
      second.repo.submitDraft({ id, authorId, expectedVersion: 2, payload }),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect(shared.version).toBe(3);
    expect(shared.lifecycleState).toBe("PENDING_APPROVAL");
    expect(first.tx.alert.updateMany.mock.calls.length + second.tx.alert.updateMany.mock.calls.length).toBe(2);
  });
  it.each(["sender", "identifier", "sent"] as const)("no cambia identidad %s ni siquiera dentro de bytes", async (field) => {
    const { tx, repo } = fixture();
    const changed = { ...identity, [field]: field === "sent" ? "2026-10-21T12:00:01.000Z" : "otro" };
    await expect(repo.updateDraft({ ...edit(), payload: buildDraftPayload(validateAlertInput(input, changed.sent), changed) })).rejects.toMatchObject({ code: "PAYLOAD_INTEGRITY_ERROR" });
    expect(tx.alert.updateMany).not.toHaveBeenCalled();
  });
  it.each(["PENDING_APPROVAL", "READY_TO_SIGN", "SIGNING", "SIGNED_PENDING_ANCHOR", "PUBLISHED"] as const)("no edita %s", async (lifecycleState) => {
    const { tx, repo } = fixture(stored({ lifecycleState }));
    await expect(repo.updateDraft(edit())).rejects.toMatchObject({ code: "INVALID_STATE_TRANSITION" });
    expect(tx.alert.updateMany).not.toHaveBeenCalled();
  });
  it("rechaza estado editable falsificado en runtime", async () => {
    const { tx, repo } = fixture();
    await expect(repo.updateDraft({ ...edit(), expectedState: "PUBLISHED" as "DRAFT" })).rejects.toMatchObject({ code: "INVALID_STATE_TRANSITION" });
    expect(tx.alert.findFirst).not.toHaveBeenCalled();
  });
  it("detecta versión obsoleta y carrera entre lectura y escritura", async () => {
    const { tx, repo } = fixture(stored({ version: 2 }));
    await expect(repo.updateDraft(edit())).rejects.toMatchObject({ code: "STALE_ALERT_VERSION" });
    expect(tx.alert.updateMany).not.toHaveBeenCalled();
    tx.alert.findFirst.mockResolvedValue(stored());
    tx.alert.updateMany.mockResolvedValue({ count: 0 });
    await expect(repo.updateDraft(edit())).rejects.toMatchObject({ code: "STALE_ALERT_VERSION" });
  });
  it.each([0, -1, 1.2, NaN, MAX_ALERT_VERSION + 1, MAX_ALERT_VERSION])("controla límite INTEGER %s antes de consultar", async (expectedVersion) => {
    const { tx, repo } = fixture();
    await expect(repo.updateDraft({ ...edit(), expectedVersion })).rejects.toMatchObject({ code:
      expectedVersion === MAX_ALERT_VERSION ? "VERSION_LIMIT_REACHED" : "INVALID_PERSISTENCE_INPUT" });
    expect(tx.alert.findFirst).not.toHaveBeenCalled();
  });
  it("permite último incremento representable", async () => {
    const { repo } = fixture(stored({ version: MAX_ALERT_VERSION - 1 }));
    expect(await repo.updateDraft({ ...edit(), expectedVersion: MAX_ALERT_VERSION - 1 })).toBe(MAX_ALERT_VERSION);
  });
  it.each([["P2002", "ALERT_ID_DUPLICATE"], ["P2003", "PERSISTENCE_FAILURE"], ["P2034", "PERSISTENCE_CONFLICT"], ["P2025", "PERSISTENCE_CONFLICT"], ["OTHER", "PERSISTENCE_FAILURE"]])("sanea error %s", async (code, expected) => {
    const { tx, repo } = fixture();
    tx.alert.create.mockRejectedValue({ code, message: "SQL_PRIVADO", meta: { value: "CONTENIDO_PRIVADO" } });
    const error = await repo.createDraft(authorId, draft()).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: expected, message: expected });
    expect(error).not.toHaveProperty("cause");
    expect(JSON.stringify(error)).not.toMatch(/SQL_PRIVADO|CONTENIDO_PRIVADO/);
  });
  it("sanea fallos de lectura y listado", async () => {
    const { tx, repo } = fixture();
    tx.alert.findFirst.mockRejectedValue(new Error("SQL_PRIVADO"));
    tx.alert.findMany.mockRejectedValue(new Error("SQL_PRIVADO"));
    tx.approval.findMany.mockRejectedValue(new Error("SQL_PRIVADO"));
    await expect(repo.findById(id, scope)).rejects.toMatchObject({ code: "PERSISTENCE_FAILURE" });
    await expect(repo.list(scope)).rejects.toMatchObject({ code: "PERSISTENCE_FAILURE" });
    await expect(repo.findDecisions(id, scope)).rejects.toMatchObject({ code: "PERSISTENCE_FAILURE" });
  });
  it("acepta el cliente transaccional tipado y no expone inserción de decisiones ni commits", () => {
    expect(() => new PrismaAlertRepository({ $transaction: vi.fn() } as unknown as Prisma.TransactionClient)).not.toThrow();
    const { repo } = fixture();
    expect(repo).not.toHaveProperty("insertApproval");
    expect(repo).not.toHaveProperty("commit");
  });
  it("lee decisiones históricas con alcance y su propio snapshot", async () => {
    const { tx, repo } = fixture();
    const decision = { id, ...prepareApprovalData(decisionInput()) };
    tx.approval.findMany.mockResolvedValue([decision]);
    const rows = await repo.findDecisions(id, scope);
    expect(tx.approval.findMany.mock.calls[0]![0].where).toEqual({ alertId: id, alert: { is: { kind: "Alert", authorId } } });
    expect(rows[0]!.alertVersion).toBe(3);
    rows[0]!.reviewedPayload.fill(0);
    expect(decision.reviewedPayload).toEqual(draft().payloadBytes);
    tx.approval.findMany.mockResolvedValue([{ ...decision, digest: new Uint8Array(32) }]);
    await expect(repo.findDecisions(id, scope)).rejects.toMatchObject({ code: "PAYLOAD_INTEGRITY_ERROR" });
  });
});

function decisionInput(): DecisionInput {
  const payload = draft();
  return { alertId: id, approverId, alertVersion: 3, reviewedPayload: payload.payloadBytes,
    digest: payload.payloadDigest, reviewedAt: new Date(identity.sent), decision: "REJECTED", reason: "Corregir simulacro" };
}
describe("preparación de Approval, sin inserción ni decisión de negocio", () => {
  it("incluye versión revisada sin incrementarla y copia bytes, digest y fecha", () => {
    const input = decisionInput();
    const result = prepareApprovalData(input);
    expect(result).toEqual(input);
    input.reviewedPayload.fill(0);
    input.digest.fill(0);
    input.reviewedAt.setTime(0);
    expect(result.reviewedPayload).toEqual(draft().payloadBytes);
    expect(result.digest).toEqual(draft().payloadDigest);
    expect(result.reviewedAt).toEqual(new Date(identity.sent));
  });
  it("aprobación exige motivo nulo", () => {
    expect(prepareApprovalData({ ...decisionInput(), decision: "APPROVED", reason: null }).reason).toBeNull();
    expect(() => prepareApprovalData({ ...decisionInput(), decision: "APPROVED", reason: "incorrecto" } as unknown as DecisionInput)).toThrow();
  });
  it.each([null, "", "ab", "x".repeat(501), "abc\u0000"])("rechaza motivo inválido %#", (reason) => {
    expect(() => prepareApprovalData({ ...decisionInput(), reason } as DecisionInput)).toThrow("INVALID_PERSISTENCE_INPUT");
  });
  it.each([3, 500])("acepta límite de motivo Unicode %s", (length) => {
    expect(prepareApprovalData({ ...decisionInput(), decision: "REJECTED", reason: "🌊".repeat(length) }).reason).toBe("🌊".repeat(length));
  });
  it("rechaza snapshot alterado, versión agotada, fecha y UUID inválidos", () => {
    expect(() => prepareApprovalData({ ...decisionInput(), digest: new Uint8Array(32) })).toThrow("PAYLOAD_INTEGRITY_ERROR");
    expect(() => prepareApprovalData({ ...decisionInput(), alertVersion: MAX_ALERT_VERSION })).toThrow("VERSION_LIMIT_REACHED");
    expect(() => prepareApprovalData({ ...decisionInput(), reviewedAt: new Date(NaN) })).toThrow("INVALID_PERSISTENCE_INPUT");
    expect(() => prepareApprovalData({ ...decisionInput(), alertId: "bad" })).toThrow("INVALID_PERSISTENCE_INPUT");
  });
});
