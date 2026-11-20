import { createHash, randomUUID } from "node:crypto";
import { Prisma, type PrismaClient } from "../../generated/prisma/client.js";
import { ApplicationError } from "../../domain/errors/application-error.js";
import { importJWK, type CryptoKey, type JWK_EC_Public } from "jose";
import { appendAuditEvent } from "../audit/append-audit-event.js";
import { readSessionCookie } from "../identity/session-authentication.js";
import type { InternalRole, InternalUser } from "../identity/session-reader.js";
import { AlertDomainError, validateAlertInput, validateApproveInput, validateMessageIdentity,
  validateIssueInput, validateRejectInput } from "./alert-input.js";
import { freezeAlertPayload, buildDraftPayload, payloadDigestMatches } from "./alert-payload.js";
import { requiresApproval, validateSubmitVersion } from "./alert-policy.js";
import { AlertPersistenceError, MAX_ALERT_VERSION, requireUuid, requireVersion } from "./alert-persistence.js";
import { PrismaAlertRepository } from "./prisma-alert-repository.js";
import type { ListScope, StoredAlert } from "./prisma-alert-repository.js";
import type { AlertSigningKeyProvider } from "../signing/alert-signing-key-provider.js";
import { ALERT_SIGNING_TIMEOUT_MS, type AlertSigner } from "../signing/alert-signer.js";
import { calculateJwsHash, calculateMessageKey } from "../signing/alert-hashes.js";
import { InMemoryTrustedPublicKeyCatalog } from "../signing/trusted-public-keys.js";
import { verifyAlertJws } from "../signing/verify-alert-jws.js";
import type {
  AlertDiagnosticCode,
  AlertDiagnosticReporter,
  AlertDiagnosticStage,
} from "../../presentation/http/diagnostic-reporting.js";

export interface AlertSummary {
  readonly id: string;
  readonly identifier: string;
  readonly lifecycleState: string;
  readonly anchorStatus: string;
  readonly notice: "SIMULACRO";
}
const summary = (row: Pick<StoredAlert, "id" | "identifier" | "lifecycleState" | "anchorStatus">): AlertSummary => ({
  id: row.id, identifier: row.identifier, lifecycleState: row.lifecycleState,
  anchorStatus: row.anchorStatus, notice: "SIMULACRO",
});
const problem = (status: number, code: string, detail: string) =>
  new ApplicationError(status, code, status >= 500 ? "Error interno" : "Operación no completada", detail);
const notFound = () => problem(404, "ALERT_NOT_FOUND", "La alerta no está disponible.");
const invalidInput = () => problem(422, "INVALID_ALERT_PAYLOAD", "El contenido de la alerta no es válido.");

function translate(error: unknown, editConflict = false): never {
  if (error instanceof ApplicationError) throw error;
  if (error instanceof AlertDomainError) throw invalidInput();
  if (error && typeof error === "object" && "code" in error && error.code === "P2034") {
    if (editConflict) throw problem(409, "STALE_ALERT_VERSION", "La versión de la alerta cambió.");
    throw problem(500, "INTERNAL_ERROR", "La solicitud no pudo completarse.");
  }
  if (error instanceof AlertPersistenceError) {
    if (error.code === "ALERT_ID_DUPLICATE") throw problem(409, error.code, "La identidad de la alerta ya existe.");
    if (error.code === "STALE_ALERT_VERSION" || error.code === "VERSION_LIMIT_REACHED" ||
        (error.code === "PERSISTENCE_CONFLICT" && editConflict))
      throw problem(409, "STALE_ALERT_VERSION", "La versión de la alerta cambió.");
    if (error.code === "INVALID_STATE_TRANSITION")
      throw problem(409, error.code, "La alerta no admite esta operación.");
    if (error.code === "INVALID_PERSISTENCE_INPUT") throw invalidInput();
  }
  throw problem(500, "INTERNAL_ERROR", "La solicitud no pudo completarse.");
}

function requiredAuthor(actor: InternalUser) {
  if (actor.status !== "ACTIVE") throw problem(401, "AUTH_REQUIRED", "La sesión no está disponible.");
  if (actor.role !== "AUTHOR") throw problem(403, "ROLE_FORBIDDEN", "El rol no permite esta operación.");
}
function requiredApprover(actor: InternalUser) {
  if (actor.status !== "ACTIVE") throw problem(401, "AUTH_REQUIRED", "La sesión no está disponible.");
  if (actor.role !== "APPROVER") throw problem(403, "ROLE_FORBIDDEN", "El rol no permite esta operación.");
}
function scopeFor(actor: InternalUser): ListScope {
  if (actor.status !== "ACTIVE") throw problem(401, "AUTH_REQUIRED", "La sesión no está disponible.");
  switch (actor.role) {
    case "AUTHOR": return { kind: "AUTHOR", actorId: actor.id };
    case "APPROVER": return { kind: "REVIEWER", actorId: actor.id };
    case "ADMIN": return { kind: "ADMIN_SUMMARY" };
    default: throw problem(403, "ROLE_FORBIDDEN", "El rol no permite esta operación.");
  }
}

/** Lock user before session, then alert CAS, then audit head. No external work under DB locks. */
interface LockedSessionValidity {
  readonly expiresAt: Date;
  readonly lastSeenAt: Date;
}

function requireLiveSessionAt(session: LockedSessionValidity, now: Date): void {
  if (!Number.isFinite(now.getTime())) throw problem(500, "INTERNAL_ERROR", "La solicitud no pudo completarse.");
  if (!Number.isFinite(session.expiresAt.getTime()) || !Number.isFinite(session.lastSeenAt.getTime()) ||
      session.expiresAt <= now || session.lastSeenAt > now ||
      now.getTime() - session.lastSeenAt.getTime() >= 30 * 60_000) {
    throw problem(401, "AUTH_REQUIRED", "La sesión no está disponible.");
  }
}

async function recheckActiveActor(tx: Prisma.TransactionClient, actor: InternalUser,
  cookie: string | undefined, clock: () => Date, expectedRole: InternalRole = "AUTHOR"): Promise<LockedSessionValidity> {
  const token = readSessionCookie(cookie);
  if (!token) throw problem(401, "AUTH_REQUIRED", "La sesión no está disponible.");
  const tokenHash = createHash("sha256").update(token, "ascii").digest();
  const users = await tx.$queryRaw<Array<{ id: string; role: string; status: string }>>`
    SELECT id, role, status FROM users WHERE id = ${actor.id}::uuid FOR UPDATE
  `;
  if (users.length !== 1 || users[0]?.role !== expectedRole || users[0].status !== "ACTIVE")
    throw problem(401, "AUTH_REQUIRED", "La sesión no está disponible.");
  const sessions = await tx.$queryRaw<Array<{ user_id: string; revoked_at: Date | null; expires_at: Date; last_seen_at: Date }>>`
    SELECT user_id, revoked_at, expires_at, last_seen_at FROM sessions
    WHERE token_hash = ${tokenHash} FOR UPDATE
  `;
  const session = sessions[0];
  if (sessions.length !== 1 || !session || session.user_id !== actor.id || session.revoked_at !== null) {
    throw problem(401, "AUTH_REQUIRED", "La sesión no está disponible.");
  }
  const validity = { expiresAt: session.expires_at, lastSeenAt: session.last_seen_at };
  // El reloj se lee después de esperar ambos bloqueos, nunca antes.
  requireLiveSessionAt(validity, clock());
  return validity;
}

interface IssueCandidate {
  readonly session: LockedSessionValidity;
  readonly alert: NonNullable<Awaited<ReturnType<PrismaAlertRepository["findForIssue"]>>>;
  readonly approval: {
    readonly approverId: string;
    readonly alertVersion: number;
    readonly reviewedPayload: Uint8Array;
    readonly digest: Uint8Array;
    readonly decision: string;
    readonly reviewedAt: Date;
  } | null;
  readonly publicJwk: JWK_EC_Public & { kty: "EC"; crv: "P-256" };
  readonly trustedPublicKey: CryptoKey;
  readonly deploymentId: string;
}

async function loadIssueCandidate(
  tx: Prisma.TransactionClient,
  actor: InternalUser,
  cookie: string | undefined,
  id: string,
  expectedDigestHex: string,
  signerKid: string,
  trustedPublicKey: CryptoKey,
  clock: () => Date,
  confirmation = false,
): Promise<IssueCandidate> {
  const session = await recheckActiveActor(tx, actor, cookie, clock);
  const previous = await new PrismaAlertRepository(tx).findForIssue(id, actor.id);
  if (!previous) throw notFound();
  if (!payloadDigestMatches(previous.frozenPayload, expectedDigestHex))
    throw problem(409, "STALE_ALERT_VERSION", "El contenido congelado cambió.");
  if (previous.lifecycleState !== "READY_TO_SIGN" || previous.kind !== "Alert" ||
      previous.anchorStatus !== "NOT_REQUESTED" || previous.jwsCompact !== null ||
      previous.kid !== null || previous.messageKey !== null || previous.jwsHash !== null ||
      previous.publishedAt !== null) {
    throw problem(409, "INVALID_STATE_TRANSITION", "La alerta no admite esta operación.");
  }
  requireVersion(previous.version);
  let approvalSnapshot: IssueCandidate["approval"] = null;
  if (requiresApproval(previous.severity)) {
    if (!previous.approvedPayloadSha256 || previous.version < 2)
      throw problem(409, "INVALID_STATE_TRANSITION", "La aprobación requerida no está disponible.");
    const approval = await tx.approval.findUnique({
      where: { alertId_alertVersion: { alertId: id, alertVersion: previous.version - 1 } },
      select: {
        approverId: true, alertVersion: true, reviewedPayload: true,
        digest: true, decision: true, reviewedAt: true,
      },
    });
    if (!approval || approval.decision !== "APPROVED" || approval.approverId === actor.id ||
        approval.alertVersion !== previous.version - 1 ||
        !Buffer.from(approval.reviewedPayload).equals(Buffer.from(previous.frozenPayload)) ||
        !Buffer.from(approval.digest).equals(Buffer.from(previous.payloadSha256)) ||
        !Buffer.from(previous.approvedPayloadSha256).equals(Buffer.from(previous.payloadSha256))) {
      throw problem(409, "INVALID_STATE_TRANSITION", "La aprobación requerida no coincide con el contenido.");
    }
    approvalSnapshot = {
      approverId: approval.approverId,
      alertVersion: approval.alertVersion,
      reviewedPayload: Uint8Array.from(approval.reviewedPayload),
      digest: Uint8Array.from(approval.digest),
      decision: approval.decision,
      reviewedAt: approval.reviewedAt,
    };
  } else if (previous.approvedPayloadSha256 !== null) {
    throw problem(500, "INTERNAL_ERROR", "La integridad de la alerta no pudo verificarse.");
  }

  const decisionTime = clock();
  requireLiveSessionAt(session, decisionTime);
  const [activeKeys, deployments] = await Promise.all([
    tx.publicKey.findMany({
      where: { status: "ACTIVE", validFrom: { lte: decisionTime }, retiredAt: null, revokedAt: null },
      orderBy: { kid: "asc" },
      take: 2,
      select: { kid: true, publicJwk: true, status: true, validFrom: true, retiredAt: true, revokedAt: true },
    }),
    tx.anchorDeployment.findMany({
      where: { state: "ACTIVE", network: "TESTNET" },
      orderBy: { generation: "desc" },
      take: 2,
      select: { id: true },
    }),
  ]);
  const keyRecord = activeKeys[0];
  const deployment = deployments[0];
  if (activeKeys.length !== 1 || !keyRecord || keyRecord.kid !== signerKid ||
      keyRecord.status !== "ACTIVE" || keyRecord.validFrom > decisionTime ||
      keyRecord.retiredAt !== null || keyRecord.revokedAt !== null ||
      deployments.length !== 1 || !deployment) {
    throw confirmation
      ? problem(409, "STALE_ALERT_VERSION", "La configuración de emisión cambió.")
      : problem(500, "INTERNAL_ERROR", "La operación no puede completarse.");
  }
  return {
    session,
    alert: previous,
    approval: approvalSnapshot,
    publicJwk: publicJwkForVerification(keyRecord.publicJwk, keyRecord.kid),
    trustedPublicKey,
    deploymentId: deployment.id,
  };
}

function sameIssueCandidate(initial: IssueCandidate, current: IssueCandidate): boolean {
  const before = initial.alert;
  const after = current.alert;
  return before.version === after.version &&
    Buffer.from(before.frozenPayload).equals(Buffer.from(after.frozenPayload)) &&
    Buffer.from(before.payloadSha256).equals(Buffer.from(after.payloadSha256)) &&
    ((before.approvedPayloadSha256 === null && after.approvedPayloadSha256 === null) ||
      (before.approvedPayloadSha256 !== null && after.approvedPayloadSha256 !== null &&
        Buffer.from(before.approvedPayloadSha256).equals(Buffer.from(after.approvedPayloadSha256)))) &&
    ((initial.approval === null && current.approval === null) ||
      (initial.approval !== null && current.approval !== null &&
        initial.approval.approverId === current.approval.approverId &&
        initial.approval.alertVersion === current.approval.alertVersion &&
        initial.approval.decision === current.approval.decision &&
        initial.approval.reviewedAt.getTime() === current.approval.reviewedAt.getTime() &&
        Buffer.from(initial.approval.reviewedPayload).equals(Buffer.from(current.approval.reviewedPayload)) &&
        Buffer.from(initial.approval.digest).equals(Buffer.from(current.approval.digest)))) &&
    before.sender === after.sender && before.identifier === after.identifier && before.sentText === after.sentText &&
    initial.publicJwk.x === current.publicJwk.x && initial.publicJwk.y === current.publicJwk.y &&
    initial.deploymentId === current.deploymentId;
}

async function signWithDeadline(signer: AlertSigner, payload: Uint8Array): Promise<string> {
  const controller = new AbortController();
  let timeout: NodeJS.Timeout | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => {
      controller.abort();
      reject(new Error("SIGNING_TIMEOUT"));
    }, ALERT_SIGNING_TIMEOUT_MS);
  });
  try {
    return await Promise.race([
      Promise.resolve().then(() => signer.sign(payload, controller.signal)),
      timeoutPromise,
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
    controller.abort();
  }
}

export interface DraftAlertService {
  create(actor: InternalUser, cookie: string | undefined, input: unknown,
    requestId?: string): Promise<{ alert: AlertSummary; version: number }>;
  list(actor: InternalUser, page: number, limit: number): Promise<{ items: AlertSummary[]; page: number; total: number }>;
  get(actor: InternalUser, id: string): Promise<{ alert: object; version: number }>;
  anchor(actor: InternalUser, id: string): Promise<{
    anchorStatus: AlertSummary["anchorStatus"];
    network: "TESTNET" | null;
    contractId: string | null;
    txHash: string | null;
    confirmedLedger: string | null;
    digestVerification: "MATCHED" | "NOT_CHECKED";
    checkedAt: string | null;
    unavailableReason: "M5_DISABLED" | null;
  }>;
  audit(actor: InternalUser, id: string): Promise<{ items: Array<{ seq: string; occurredAt: string; actorId: string | null; action: string; redactedDetails: unknown }> }>;
  edit(actor: InternalUser, cookie: string | undefined, id: string, expectedVersion: number, input: unknown): Promise<{ alert: AlertSummary; version: number }>;
  submit(actor: InternalUser, cookie: string | undefined, id: string, expectedVersion: number):
    Promise<{ lifecycleState: "PENDING_APPROVAL" | "READY_TO_SIGN"; version: number; payloadDigestHex: string }>;
  approve(actor: InternalUser, cookie: string | undefined, id: string, raw: unknown):
    Promise<{ alert: AlertSummary; version: number }>;
  reject(actor: InternalUser, cookie: string | undefined, id: string, raw: unknown):
    Promise<{ alert: AlertSummary; version: number }>;
  issue(actor: InternalUser, cookie: string | undefined, id: string, raw: unknown):
    Promise<{ alertId: string; lifecycleState: "SIGNED_PENDING_ANCHOR"; anchorStatus: "PENDING" }>;
}

/** Server-owned fictitious sender; identifier and sent are generated once at creation. */
export class PrismaDraftAlertService implements DraftAlertService {
  constructor(private readonly prisma: PrismaClient,
    private readonly sender = "urn:siga-e:simulacro",
    private readonly clock: () => Date = () => new Date(),
    private readonly newIdentifier: () => string = () => `SIGAE-${randomUUID()}`,
    private readonly reportDiagnostic?: AlertDiagnosticReporter,
    private readonly signingKeyProvider?: AlertSigningKeyProvider) {
    validateMessageIdentity({ sender, identifier: "probe", sent: new Date(0).toISOString() });
  }

  async create(actor: InternalUser, cookie: string | undefined, raw: unknown, requestId?: string) {
    let stage: AlertDiagnosticStage = "IDENTITY_VALIDATION";
    try {
      requiredAuthor(actor);
      const now = this.clock();
      if (!Number.isFinite(now.getTime())) throw invalidInput();
      const identity = { sender: this.sender, identifier: this.newIdentifier(), sent: now.toISOString() };
      validateMessageIdentity(identity);
      stage = "INPUT_VALIDATION";
      const input = validateAlertInput(raw, identity.sent);
      stage = "PAYLOAD_BUILD";
      const payload = buildDraftPayload(input, identity);
      return await this.prisma.$transaction(async (tx) => {
        await recheckActiveActor(tx, actor, cookie, this.clock);
        let row: StoredAlert;
        try {
          stage = "PERSISTENCE_INPUT";
          row = await new PrismaAlertRepository(tx).createDraft(actor.id, payload);
        } catch (error) {
          if (error instanceof AlertPersistenceError && error.code === "INVALID_PERSISTENCE_INPUT")
            stage = "PERSISTENCE_INPUT";
          else stage = "DATABASE_CREATE";
          throw error;
        }
        stage = "AUDIT_APPEND";
        await appendAuditEvent(tx, { actorId: actor.id, action: "ALERT_CREATED", objectType: "alert",
          objectId: row.id, redactedDetails: { kind: "Alert", status: "DRAFT" } });
        return { alert: summary(row), version: row.version };
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    } catch (error) {
      const translated = (() => {
        try { return translate(error); } catch (translatedError) { return translatedError; }
      })();
      if (requestId && this.reportDiagnostic && translated instanceof ApplicationError &&
          translated.status === 422 &&
          (translated.code === "INVALID_ALERT_PAYLOAD" || translated.code === "INVALID_PERSISTENCE_INPUT")) {
        this.reportDiagnostic({ requestId, stage, code: translated.code as AlertDiagnosticCode });
      }
      throw translated;
    }
  }

  async list(actor: InternalUser, page: number, limit: number) {
    try {
      const scope = scopeFor(actor);
      if (!Number.isSafeInteger(page) || page < 1 || !Number.isSafeInteger(limit) || limit < 1 || limit > 50 ||
          (page - 1) * limit > Number.MAX_SAFE_INTEGER) throw invalidInput();
      return await this.prisma.$transaction(async (tx) => {
        const repository = new PrismaAlertRepository(tx);
        const total = await repository.count(scope);
        const rows = await repository.list(scope, { skip: (page - 1) * limit, take: limit });
        return { items: rows.map(summary), page, total };
      }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
    } catch (error) { return translate(error); }
  }

  async get(actor: InternalUser, id: string) {
    try {
      const scope = scopeFor(actor);
      try { requireUuid(id); } catch { throw notFound(); }
      return await this.prisma.$transaction(async (tx) => {
        const repository = new PrismaAlertRepository(tx);
        if (scope.kind === "ADMIN_SUMMARY") {
          const row = await repository.findSummary(id, scope);
          if (!row) throw notFound();
          return { alert: summary(row), version: row.version };
        }
        const row = await repository.findById(id, scope);
        if (!row) throw notFound();
        if (scope.kind === "REVIEWER") return { alert: {
          ...summary(row), authorId: row.authorId, kind: row.kind, severity: row.severity,
          version: row.version, reviewSnapshot: {
            payloadBase64Url: Buffer.from(row.frozenPayload).toString("base64url"),
            payloadDigestHex: Buffer.from(row.payloadSha256).toString("hex"),
          },
        }, version: row.version };
        const decoded = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(row.frozenPayload)) as { info: unknown };
        let lastRejectionReason: string | undefined;
        if (row.lifecycleState === "REJECTED") {
          const decisions = await repository.findDecisions(id, scope);
          lastRejectionReason = decisions.filter((decision) => decision.decision === "REJECTED").at(-1)?.reason ?? undefined;
          if (!lastRejectionReason) throw problem(500, "INTERNAL_ERROR", "La solicitud no pudo completarse.");
        }
        return { alert: { ...summary(row), version: row.version, kind: row.kind, info: decoded.info,
          ...(lastRejectionReason ? { lastRejectionReason } : {}) }, version: row.version };
      }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
    } catch (error) { return translate(error); }
  }

  async anchor(actor: InternalUser, id: string) {
    try {
      const scope = scopeFor(actor);
      if (scope.kind !== "ADMIN_SUMMARY") {
        throw problem(403, "ROLE_FORBIDDEN", "Solo ADMIN puede consultar esta evidencia.");
      }
      try { requireUuid(id); } catch { throw notFound(); }
      return await this.prisma.$transaction(async (tx) => {
        const repository = new PrismaAlertRepository(tx);
        const alert = await repository.findSummary(id, scope);
        if (!alert) throw notFound();
        const job = await tx.anchorJob.findFirst({
          where: { alertId: id },
          orderBy: [{ createdAt: "desc" }, { id: "asc" }],
          select: {
            state: true,
            txHash: true,
            confirmedLedger: true,
            updatedAt: true,
            deployment: {
              select: { network: true, contractId: true },
            },
          },
        });
        const confirmed = alert.anchorStatus === "CONFIRMED" &&
          job?.state === "CONFIRMED" &&
          job.confirmedLedger !== null &&
          job.confirmedLedger > 0n &&
          typeof job.txHash === "string" &&
          job.txHash.trim().length > 0;
        const txHash = confirmed && job !== null && typeof job.txHash === "string"
          ? job.txHash
          : null;
        const confirmedLedger = confirmed && job !== null && job.confirmedLedger !== null
          ? job.confirmedLedger.toString()
          : null;
        return {
          anchorStatus: alert.anchorStatus,
          network: job?.deployment.network === "TESTNET" ? "TESTNET" as const : null,
          contractId: job?.deployment.contractId ?? null,
          txHash,
          confirmedLedger,
          digestVerification: confirmed ? "MATCHED" as const : "NOT_CHECKED" as const,
          checkedAt: confirmed ? job.updatedAt.toISOString() : null,
          unavailableReason: "M5_DISABLED" as const,
        };
      }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
    } catch (error) { return translate(error); }
  }

  async audit(actor: InternalUser, id: string) {
    try {
      const scope = scopeFor(actor);
      try { requireUuid(id); } catch { throw notFound(); }
      return await this.prisma.$transaction(async (tx) => {
        const repository = new PrismaAlertRepository(tx);
        const alert = scope.kind === "ADMIN_SUMMARY"
          ? await repository.findSummary(id, scope)
          : await repository.findById(id, scope);
        if (!alert) throw notFound();
        const rows = await tx.auditEvent.findMany({
          where: { objectType: "alert", objectId: id },
          orderBy: { seq: "asc" },
          select: { seq: true, occurredAt: true, actorId: true, action: true, redactedDetails: true },
        });
        return { items: rows.map((row) => ({
          seq: row.seq.toString(),
          occurredAt: row.occurredAt.toISOString(),
          actorId: row.actorId,
          action: row.action,
          redactedDetails: row.redactedDetails,
        })) };
      }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
    } catch (error) { return translate(error); }
  }

  async edit(actor: InternalUser, cookie: string | undefined, id: string, expectedVersion: number, raw: unknown) {
    try {
      requiredAuthor(actor);
      try { requireUuid(id); } catch { throw notFound(); }
      if (!Number.isInteger(expectedVersion) || expectedVersion < 1) throw invalidInput();
      if (expectedVersion > MAX_ALERT_VERSION) throw problem(409, "STALE_ALERT_VERSION", "La versión de la alerta cambió.");
      return await this.prisma.$transaction(async (tx) => {
        await recheckActiveActor(tx, actor, cookie, this.clock);
        const repository = new PrismaAlertRepository(tx);
        const previous = await repository.findById(id, { kind: "AUTHOR", actorId: actor.id });
        if (!previous) throw notFound();
        if (previous.version !== expectedVersion) throw problem(409, "STALE_ALERT_VERSION", "La versión de la alerta cambió.");
        if (previous.lifecycleState !== "DRAFT" && previous.lifecycleState !== "REJECTED")
          throw problem(409, "INVALID_STATE_TRANSITION", "La alerta no admite esta operación.");
        const input = validateAlertInput(raw, previous.sentText);
        const payload = buildDraftPayload(input, {
          sender: previous.sender, identifier: previous.identifier, sent: previous.sentText,
        });
        const version = await repository.updateDraft({ id, authorId: actor.id, expectedVersion,
          expectedState: previous.lifecycleState, payload });
        const updated = await repository.findById(id, { kind: "AUTHOR", actorId: actor.id });
        if (!updated || updated.version !== version) throw problem(500, "INTERNAL_ERROR", "La solicitud no pudo completarse.");
        await appendAuditEvent(tx, { actorId: actor.id, action: previous.lifecycleState === "REJECTED" ? "ALERT_REVISED" : "ALERT_DRAFT_UPDATED",
          objectType: "alert", objectId: id, redactedDetails: { kind: "Alert", status: "DRAFT" } });
        return { alert: summary(updated), version };
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    } catch (error) { return translate(error, true); }
  }

  async submit(actor: InternalUser, cookie: string | undefined, id: string, expectedVersion: number) {
    try {
      requiredAuthor(actor);
      try { requireUuid(id); } catch { throw notFound(); }
      validateSubmitVersion(expectedVersion);
      return await this.prisma.$transaction(async (tx) => {
        const session = await recheckActiveActor(tx, actor, cookie, this.clock);
        const repository = new PrismaAlertRepository(tx);
        const previous = await repository.findById(id, { kind: "AUTHOR", actorId: actor.id });
        if (!previous) throw notFound();
        if (previous.kind !== "Alert") throw problem(409, "INVALID_STATE_TRANSITION", "La alerta no admite esta operación.");
        if (previous.version !== expectedVersion) throw problem(409, "STALE_ALERT_VERSION", "La versión de la alerta cambió.");
        if (previous.lifecycleState !== "DRAFT")
          throw problem(409, "INVALID_STATE_TRANSITION", "La alerta no admite esta operación.");
        // findById también puede esperar: este es el instante autorizado de envío.
        const submitAt = this.clock();
        requireLiveSessionAt(session, submitAt);
        const decoded = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(previous.frozenPayload)) as { info: unknown };
        const input = validateAlertInput({ kind: "Alert", info: decoded.info }, previous.sentText, submitAt);
        const payload = freezeAlertPayload(input, {
          sender: previous.sender, identifier: previous.identifier, sent: previous.sentText,
        }, submitAt);
        const result = await repository.submitDraft({ id, authorId: actor.id, expectedVersion, payload });
        // El CAS y la cabeza de auditoría pueden esperar; un fallo aún revierte toda la transacción.
        const afterCas = this.clock();
        requireLiveSessionAt(session, afterCas);
        validateAlertInput(input, previous.sentText, afterCas);
        await appendAuditEvent(tx, {
          actorId: actor.id, action: "ALERT_SUBMITTED", objectType: "alert", objectId: id,
          redactedDetails: { kind: "Alert", status: `DRAFT_TO_${result.lifecycleState}`, result: `v${result.version}` },
        });
        const beforeCommit = this.clock();
        requireLiveSessionAt(session, beforeCommit);
        validateAlertInput(input, previous.sentText, beforeCommit);
        return { ...result, payloadDigestHex: payload.payloadDigestHex };
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    } catch (error) { return translate(error, true); }
  }

  async approve(actor: InternalUser, cookie: string | undefined, id: string, raw: unknown) {
    try {
      requiredApprover(actor);
      try { requireUuid(id); } catch { throw notFound(); }
      let decision;
      try { decision = validateApproveInput(raw); }
      catch (error) {
        if (error instanceof AlertDomainError) throw invalidInput();
        throw error;
      }
      if (decision.expectedVersion >= MAX_ALERT_VERSION)
        throw problem(409, "STALE_ALERT_VERSION", "La versión de la alerta cambió.");
      return await this.prisma.$transaction(async (tx) => {
        const session = await recheckActiveActor(tx, actor, cookie, this.clock, "APPROVER");
        const repository = new PrismaAlertRepository(tx);
        const previous = await repository.findForDecision(id);
        if (!previous) throw notFound();
        if (previous.authorId === actor.id)
          throw problem(403, "SELF_APPROVAL_FORBIDDEN", "El autor no puede decidir su propia alerta.");
        if (previous.version !== decision.expectedVersion ||
            !payloadDigestMatches(previous.frozenPayload, decision.expectedDigestHex))
          throw problem(409, "STALE_ALERT_VERSION", "La versión o el contenido revisado cambió.");
        if (previous.lifecycleState !== "PENDING_APPROVAL" || previous.kind !== "Alert" ||
            (previous.severity !== "Severe" && previous.severity !== "Extreme"))
          throw problem(409, "INVALID_STATE_TRANSITION", "La alerta no admite esta operación.");
        if (await repository.hasDecision(id, previous.version))
          throw problem(409, "INVALID_STATE_TRANSITION", "La decisión de esta versión ya fue registrada.");
        const reviewedAt = this.clock();
        requireLiveSessionAt(session, reviewedAt);
        const result = await repository.decide({
          alertId: id, authorId: previous.authorId, approverId: actor.id,
          alertVersion: previous.version, reviewedPayload: previous.frozenPayload,
          digest: previous.payloadSha256, decision: "APPROVED", reason: null, reviewedAt,
        });
        requireLiveSessionAt(session, this.clock());
        await appendAuditEvent(tx, {
          actorId: actor.id, action: "ALERT_APPROVED", objectType: "alert", objectId: id,
          redactedDetails: { kind: "Alert", status: "PENDING_APPROVAL_TO_READY_TO_SIGN", result: `v${result.version}` },
        });
        requireLiveSessionAt(session, this.clock());
        return { alert: summary({ ...previous, lifecycleState: result.lifecycleState }), version: result.version };
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    } catch (error) { return translate(error, true); }
  }

  async reject(actor: InternalUser, cookie: string | undefined, id: string, raw: unknown) {
    try {
      requiredApprover(actor);
      try { requireUuid(id); } catch { throw notFound(); }
      let decision;
      try { decision = validateRejectInput(raw); }
      catch (error) {
        if (error instanceof AlertDomainError) throw invalidInput();
        throw error;
      }
      if (decision.expectedVersion >= MAX_ALERT_VERSION)
        throw problem(409, "STALE_ALERT_VERSION", "La versión de la alerta cambió.");
      return await this.prisma.$transaction(async (tx) => {
        const session = await recheckActiveActor(tx, actor, cookie, this.clock, "APPROVER");
        const repository = new PrismaAlertRepository(tx);
        const previous = await repository.findForDecision(id);
        if (!previous) throw notFound();
        if (previous.authorId === actor.id)
          throw problem(403, "SELF_APPROVAL_FORBIDDEN", "El autor no puede decidir su propia alerta.");
        if (previous.version !== decision.expectedVersion ||
            !payloadDigestMatches(previous.frozenPayload, decision.expectedDigestHex))
          throw problem(409, "STALE_ALERT_VERSION", "La versión o el contenido revisado cambió.");
        if (previous.lifecycleState !== "PENDING_APPROVAL" || previous.kind !== "Alert" ||
            (previous.severity !== "Severe" && previous.severity !== "Extreme"))
          throw problem(409, "INVALID_STATE_TRANSITION", "La alerta no admite esta operación.");
        if (await repository.hasDecision(id, previous.version))
          throw problem(409, "INVALID_STATE_TRANSITION", "La decisión de esta versión ya fue registrada.");
        const reviewedAt = this.clock();
        requireLiveSessionAt(session, reviewedAt);
        const result = await repository.decide({
          alertId: id, authorId: previous.authorId, approverId: actor.id,
          alertVersion: previous.version, reviewedPayload: previous.frozenPayload,
          digest: previous.payloadSha256, decision: "REJECTED", reason: decision.reason, reviewedAt,
        });
        requireLiveSessionAt(session, this.clock());
        await appendAuditEvent(tx, {
          actorId: actor.id, action: "ALERT_REJECTED", objectType: "alert", objectId: id,
          redactedDetails: { kind: "Alert", status: "PENDING_APPROVAL_TO_REJECTED", result: `v${result.version}` },
        });
        requireLiveSessionAt(session, this.clock());
        return { alert: summary({ ...previous, lifecycleState: result.lifecycleState }), version: result.version };
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    } catch (error) { return translate(error, true); }
  }

  async issue(actor: InternalUser, cookie: string | undefined, id: string, raw: unknown) {
    try {
      requiredAuthor(actor);
      try { requireUuid(id); } catch { throw notFound(); }
      let issueInput;
      try { issueInput = validateIssueInput(raw); }
      catch (error) {
        if (error instanceof AlertDomainError) throw invalidInput();
        throw error;
      }
      const signingKeyProvider = this.signingKeyProvider;
      if (!signingKeyProvider)
        throw problem(500, "INTERNAL_ERROR", "La operación no puede completarse.");
      let signer;
      try { signer = signingKeyProvider.getActiveSigner(); }
      catch { throw problem(500, "INTERNAL_ERROR", "La operación no puede completarse."); }
      if (!signer || typeof signer.kid !== "string" || signer.kid.length === 0 ||
          typeof signer.sign !== "function")
        throw problem(500, "INTERNAL_ERROR", "La operación no puede completarse.");

      const initial = await this.prisma.$transaction((tx) =>
        loadIssueCandidate(tx, actor, cookie, id, issueInput.expectedDigestHex,
          signer.kid, signingKeyProvider.getTrustedPublicKey(signer.kid), this.clock),
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });

      const frozenBytes = Uint8Array.from(initial.alert.frozenPayload);
      const jwsCompact = await signWithDeadline(signer, frozenBytes);
      const databasePublicKey = await importJWK(initial.publicJwk, "ES256");
      const databaseVerified = await verifyAlertJws(jwsCompact,
        new InMemoryTrustedPublicKeyCatalog([[signer.kid, databasePublicKey]]));
      const trustedVerified = await verifyAlertJws(jwsCompact,
        new InMemoryTrustedPublicKeyCatalog([[signer.kid, initial.trustedPublicKey]]));
      const currentSigner = signingKeyProvider.getActiveSigner();
      const currentTrustedPublicKey = signingKeyProvider.getTrustedPublicKey(signer.kid);
      const currentTrustedVerified = await verifyAlertJws(jwsCompact,
        new InMemoryTrustedPublicKeyCatalog([[signer.kid, currentTrustedPublicKey]]));
      if (currentSigner.kid !== signer.kid ||
          databaseVerified.kid !== signer.kid || trustedVerified.kid !== signer.kid ||
          currentTrustedVerified.kid !== signer.kid ||
          !Buffer.from(databaseVerified.payloadBytes).equals(Buffer.from(frozenBytes)) ||
          !Buffer.from(trustedVerified.payloadBytes).equals(Buffer.from(frozenBytes)) ||
          !Buffer.from(currentTrustedVerified.payloadBytes).equals(Buffer.from(frozenBytes))) {
        throw problem(500, "INTERNAL_ERROR", "La firma no coincide con el contenido congelado.");
      }

      const jwsHash = calculateJwsHash(jwsCompact);
      const messageKey = calculateMessageKey({
        sender: initial.alert.sender,
        identifier: initial.alert.identifier,
        sent: initial.alert.sentText,
      });
      return await this.prisma.$transaction(async (tx) => {
        const current = await loadIssueCandidate(tx, actor, cookie, id,
          issueInput.expectedDigestHex, signer.kid, currentTrustedPublicKey, this.clock, true);
        if (!sameIssueCandidate(initial, current))
          throw problem(409, "STALE_ALERT_VERSION", "La alerta o la configuración cambió durante la firma.");
        const beforeCommit = this.clock();
        requireLiveSessionAt(current.session, beforeCommit);
        const updated = await tx.alert.updateMany({
          where: {
            id, authorId: actor.id, kind: "Alert", lifecycleState: "READY_TO_SIGN",
            version: initial.alert.version, frozenPayload: initial.alert.frozenPayload,
            payloadSha256: initial.alert.payloadSha256,
            approvedPayloadSha256: initial.alert.approvedPayloadSha256,
            anchorStatus: "NOT_REQUESTED", jwsCompact: null, kid: null, messageKey: null,
            jwsHash: null, publishedAt: null,
          },
          data: {
            lifecycleState: "SIGNED_PENDING_ANCHOR", anchorStatus: "PENDING",
            jwsCompact, kid: signer.kid,
            messageKey: Buffer.from(messageKey), jwsHash: Buffer.from(jwsHash),
          },
        });
        if (updated.count !== 1)
          throw problem(409, "STALE_ALERT_VERSION", "La versión de la alerta cambió.");
        await tx.anchorJob.create({
          data: { alertId: id, deploymentId: initial.deploymentId,
            messageKey: Buffer.from(messageKey), jwsHash: Buffer.from(jwsHash) },
        });
        await appendAuditEvent(tx, {
          actorId: actor.id, action: "ALERT_ISSUED", objectType: "alert", objectId: id,
          redactedDetails: {
            kind: "Alert", status: "READY_TO_SIGN_TO_SIGNED_PENDING_ANCHOR",
            result: "ANCHOR_JOB_ENQUEUED",
          },
        });
        return { alertId: id, lifecycleState: "SIGNED_PENDING_ANCHOR" as const, anchorStatus: "PENDING" as const };
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    } catch (error) { return translate(error, true); }
  }
}

function publicJwkForVerification(value: Prisma.JsonValue, kid: string): JWK_EC_Public & { kty: "EC"; crv: "P-256" } {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      value["kty"] !== "EC" || value["crv"] !== "P-256" ||
      typeof value["x"] !== "string" || typeof value["y"] !== "string" ||
      ("d" in value) || (value["kid"] !== undefined && value["kid"] !== kid)) {
    throw problem(500, "INTERNAL_ERROR", "La clave de verificación no está disponible.");
  }
  return { kty: "EC", crv: "P-256", x: value["x"], y: value["y"], kid };
}
