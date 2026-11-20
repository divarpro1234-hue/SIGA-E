import type { Prisma } from "../../generated/prisma/client.js";
import type { PayloadSnapshot } from "./alert-payload.js";
import { nextAlertState, type AlertState } from "./alert-policy.js";
import { AlertPersistenceError, frozenData, inspectPayload, persistenceCall, prepareApprovalData,
  requireUuid, requireVersion, type DecisionInput } from "./alert-persistence.js";

/** Constructed by trusted services from authenticated identity, never from request filters. */
export type ContentScope = { readonly kind: "AUTHOR"; readonly actorId: string } |
  { readonly kind: "REVIEWER"; readonly actorId: string };
export type ListScope = ContentScope | { readonly kind: "ADMIN_SUMMARY" };
export interface AlertListFilter {
  readonly state?: AlertState;
  readonly skip?: number;
  readonly take?: number;
}

const summarySelect = { id: true, identifier: true, lifecycleState: true, anchorStatus: true } satisfies Prisma.AlertSelect;
const contentSelect = {
  ...summarySelect, sender: true, sentText: true, authorId: true, kind: true, severity: true,
  version: true, frozenPayload: true, payloadSha256: true, approvedPayloadSha256: true,
} satisfies Prisma.AlertSelect;
const issueSelect = {
  ...contentSelect, jwsCompact: true, kid: true, messageKey: true, jwsHash: true, publishedAt: true,
} satisfies Prisma.AlertSelect;
export type StoredAlert = Prisma.AlertGetPayload<{ select: typeof contentSelect }>;
export type StoredIssueAlert = Prisma.AlertGetPayload<{ select: typeof issueSelect }>;

function scopedWhere(scope: ListScope): Prisma.AlertWhereInput {
  if (scope.kind === "ADMIN_SUMMARY") return { kind: "Alert" };
  requireUuid(scope.actorId);
  if (scope.kind === "AUTHOR") return { kind: "Alert", authorId: scope.actorId };
  if (scope.kind === "REVIEWER") return {
    kind: "Alert", authorId: { not: scope.actorId }, lifecycleState: "PENDING_APPROVAL",
    severity: { in: ["Severe", "Extreme"] },
  };
  throw new AlertPersistenceError("INVALID_PERSISTENCE_INPUT");
}

function checkedAlert(row: StoredAlert): StoredAlert {
  requireVersion(row.version);
  const frozenPayload = Uint8Array.from(row.frozenPayload);
  const payloadSha256 = Uint8Array.from(row.payloadSha256);
  const metadata = inspectPayload(frozenPayload, payloadSha256);
  if (metadata.sender !== row.sender || metadata.identifier !== row.identifier ||
    metadata.sentText !== row.sentText || metadata.kind !== row.kind || metadata.severity !== row.severity ||
    (row.approvedPayloadSha256 !== null && !Buffer.from(row.approvedPayloadSha256).equals(Buffer.from(payloadSha256)))) {
    throw new AlertPersistenceError("PAYLOAD_INTEGRITY_ERROR");
  }
  return { ...row, frozenPayload, payloadSha256,
    approvedPayloadSha256: row.approvedPayloadSha256 === null ? null : Uint8Array.from(row.approvedPayloadSha256) };
}

function draftData(payload: PayloadSnapshot<"DRAFT">) {
  if (payload.phase !== "DRAFT") throw new AlertPersistenceError("INVALID_STATE_TRANSITION");
  const frozenPayload = Uint8Array.from(payload.payloadBytes);
  const payloadSha256 = Uint8Array.from(payload.payloadDigest);
  const metadata = inspectPayload(frozenPayload, payloadSha256);
  if (Buffer.from(payloadSha256).toString("hex") !== payload.payloadDigestHex) {
    throw new AlertPersistenceError("PAYLOAD_INTEGRITY_ERROR");
  }
  return { ...metadata, frozenPayload, payloadSha256 };
}

/** Internal persistence adapter, not an authorization boundary or a business service.
 * Caller supplies an interactive transaction and must propagate failures to roll it back.
 * MFA/role/session recheck, operation authorization and appendAuditEvent belong to that same transaction.
 * No generic update, approval insertion, state promotion or transaction/commit method is exposed.
 */
export class PrismaAlertRepository {
  constructor(private readonly tx: Prisma.TransactionClient) {}

  async createDraft(authorId: string, payload: PayloadSnapshot<"DRAFT">): Promise<StoredAlert> {
    requireUuid(authorId);
    const prepared = draftData(payload);
    return persistenceCall(async () => checkedAlert(await this.tx.alert.create({
      data: { ...prepared, authorId, version: 1, lifecycleState: "DRAFT", anchorStatus: "NOT_REQUESTED" },
      select: contentSelect,
    })), true);
  }

  async findById(id: string, scope: ContentScope): Promise<StoredAlert | null> {
    requireUuid(id);
    // Runtime check also prevents a cast from exposing content to administrative summaries.
    if (scope.kind !== "AUTHOR" && scope.kind !== "REVIEWER") throw new AlertPersistenceError("INVALID_PERSISTENCE_INPUT");
    const where = { AND: [{ id }, scopedWhere(scope)] };
    return persistenceCall(async () => {
      const row = await this.tx.alert.findFirst({ where, select: contentSelect });
      return row === null ? null : checkedAlert(row);
    });
  }

  async findForIssue(id: string, authorId: string): Promise<StoredIssueAlert | null> {
    requireUuid(id);
    requireUuid(authorId);
    return persistenceCall(async () => {
      const row = await this.tx.alert.findFirst({
        where: { id, authorId, kind: "Alert" },
        select: issueSelect,
      });
      if (row === null) return null;
      return { ...checkedAlert(row), jwsCompact: row.jwsCompact, kid: row.kid,
        messageKey: row.messageKey, jwsHash: row.jwsHash, publishedAt: row.publishedAt };
    });
  }

  async findForDecision(id: string): Promise<StoredAlert | null> {
    requireUuid(id);
    return persistenceCall(async () => {
      const row = await this.tx.alert.findUnique({ where: { id }, select: contentSelect });
      return row === null ? null : checkedAlert(row);
    });
  }

  async hasDecision(alertId: string, alertVersion: number): Promise<boolean> {
    requireUuid(alertId);
    requireVersion(alertVersion);
    return persistenceCall(async () => (await this.tx.approval.findUnique({
      where: { alertId_alertVersion: { alertId, alertVersion } }, select: { id: true },
    })) !== null);
  }

  async decide(input: DecisionInput & { readonly authorId: string }): Promise<{
    readonly lifecycleState: "READY_TO_SIGN" | "REJECTED";
    readonly version: number;
  }> {
    requireUuid(input.authorId);
    requireVersion(input.alertVersion, true);
    const approval = prepareApprovalData(input);
    const lifecycleState = approval.decision === "APPROVED" ? "READY_TO_SIGN" : "REJECTED";
    return persistenceCall(async () => {
      const updated = await this.tx.alert.updateMany({
        where: {
          id: approval.alertId, authorId: input.authorId, kind: "Alert",
          severity: { in: ["Severe", "Extreme"] }, lifecycleState: "PENDING_APPROVAL",
          version: approval.alertVersion, frozenPayload: approval.reviewedPayload,
          payloadSha256: approval.digest, approvedPayloadSha256: null,
          anchorStatus: "NOT_REQUESTED", jwsCompact: null, kid: null, messageKey: null,
          jwsHash: null, publishedAt: null,
        },
        data: {
          lifecycleState, version: { increment: 1 },
          approvedPayloadSha256: approval.decision === "APPROVED" ? approval.digest : null,
        },
      });
      if (updated.count !== 1) throw new AlertPersistenceError("STALE_ALERT_VERSION");
      await this.tx.approval.create({ data: approval });
      return { lifecycleState, version: approval.alertVersion + 1 };
    });
  }

  async list(scope: ListScope, filter: AlertListFilter = {}) {
    const { skip = 0, take = 20, state } = filter;
    if (!Number.isSafeInteger(skip) || skip < 0 || !Number.isInteger(take) || take < 1 || take > 100 ||
      (state !== undefined && !["DRAFT", "PENDING_APPROVAL", "REJECTED", "READY_TO_SIGN", "SIGNING", "SIGNED_PENDING_ANCHOR", "PUBLISHED"].includes(state))) {
      throw new AlertPersistenceError("INVALID_PERSISTENCE_INPUT");
    }
    const where: Prisma.AlertWhereInput = { AND: [scopedWhere(scope), state === undefined ? {} : { lifecycleState: state }] };
    return persistenceCall(() => this.tx.alert.findMany({ where, select: summarySelect,
      orderBy: [{ createdAt: "desc" }, { id: "asc" }], skip, take }));
  }

  async count(scope: ListScope): Promise<number> {
    return persistenceCall(() => this.tx.alert.count({ where: scopedWhere(scope) }));
  }

  async findSummary(id: string, scope: ListScope) {
    requireUuid(id);
    return persistenceCall(() => this.tx.alert.findFirst({
      where: { AND: [{ id }, scopedWhere(scope)] }, select: { ...summarySelect, version: true },
    }));
  }

  async updateDraft(input: {
    readonly id: string; readonly authorId: string; readonly expectedVersion: number;
    readonly expectedState: "DRAFT" | "REJECTED"; readonly payload: PayloadSnapshot<"DRAFT">;
  }): Promise<number> {
    requireUuid(input.id);
    requireUuid(input.authorId);
    requireVersion(input.expectedVersion, true);
    if (input.expectedState !== "DRAFT" && input.expectedState !== "REJECTED") {
      throw new AlertPersistenceError("INVALID_STATE_TRANSITION");
    }
    const data = draftData(input.payload);
    return persistenceCall(async () => {
      const existing = await this.findById(input.id, { kind: "AUTHOR", actorId: input.authorId });
      if (!existing || existing.version !== input.expectedVersion) throw new AlertPersistenceError("STALE_ALERT_VERSION");
      if (existing.lifecycleState !== input.expectedState) throw new AlertPersistenceError("INVALID_STATE_TRANSITION");
      if (existing.authorId !== input.authorId ||
        existing.sender !== data.sender || existing.identifier !== data.identifier || existing.sentText !== data.sentText) {
        throw new AlertPersistenceError("PAYLOAD_INTEGRITY_ERROR");
      }
      const updated = await this.tx.alert.updateMany({
        where: { id: input.id, authorId: input.authorId, kind: "Alert", version: input.expectedVersion,
          lifecycleState: input.expectedState, sender: data.sender, identifier: data.identifier, sentText: data.sentText,
          anchorStatus: "NOT_REQUESTED", jwsCompact: null, kid: null, messageKey: null, jwsHash: null,
          publishedAt: null, approvedPayloadSha256: null },
        data: { frozenPayload: data.frozenPayload, payloadSha256: data.payloadSha256,
          severity: data.severity, lifecycleState: "DRAFT", version: { increment: 1 } },
      });
      if (updated.count !== 1) throw new AlertPersistenceError("STALE_ALERT_VERSION");
      return input.expectedVersion + 1;
    });
  }

  async submitDraft(input: {
    readonly id: string;
    readonly authorId: string;
    readonly expectedVersion: number;
    readonly payload: PayloadSnapshot<"FROZEN">;
  }): Promise<{ readonly lifecycleState: "PENDING_APPROVAL" | "READY_TO_SIGN"; readonly version: number; readonly payloadSha256: Uint8Array }> {
    requireUuid(input.id);
    requireUuid(input.authorId);
    requireVersion(input.expectedVersion, true);
    const data = frozenData(input.payload);
    const lifecycleState = nextAlertState("DRAFT", "SUBMIT", data.severity);
    if (lifecycleState !== "PENDING_APPROVAL" && lifecycleState !== "READY_TO_SIGN") {
      throw new AlertPersistenceError("INVALID_STATE_TRANSITION");
    }
    return persistenceCall(async () => {
      const existing = await this.findById(input.id, { kind: "AUTHOR", actorId: input.authorId });
      if (!existing || existing.version !== input.expectedVersion) {
        throw new AlertPersistenceError("STALE_ALERT_VERSION");
      }
      if (existing.lifecycleState !== "DRAFT") {
        throw new AlertPersistenceError("INVALID_STATE_TRANSITION");
      }
      if (existing.authorId !== input.authorId ||
        existing.sender !== data.sender || existing.identifier !== data.identifier || existing.sentText !== data.sentText) {
        throw new AlertPersistenceError("PAYLOAD_INTEGRITY_ERROR");
      }
      const updated = await this.tx.alert.updateMany({
        where: {
          id: input.id, authorId: input.authorId, kind: "Alert", version: input.expectedVersion,
          lifecycleState: "DRAFT", sender: data.sender, identifier: data.identifier, sentText: data.sentText,
          anchorStatus: "NOT_REQUESTED", jwsCompact: null, kid: null, messageKey: null, jwsHash: null,
          publishedAt: null, approvedPayloadSha256: null,
        },
        data: {
          frozenPayload: data.frozenPayload, payloadSha256: data.payloadSha256,
          severity: data.severity, lifecycleState, version: { increment: 1 },
        },
      });
      if (updated.count !== 1) throw new AlertPersistenceError("STALE_ALERT_VERSION");
      return { lifecycleState, version: input.expectedVersion + 1, payloadSha256: Uint8Array.from(data.payloadSha256) };
    });
  }

  async findDecisions(alertId: string, scope: ContentScope) {
    requireUuid(alertId);
    if (scope.kind !== "AUTHOR" && scope.kind !== "REVIEWER") throw new AlertPersistenceError("INVALID_PERSISTENCE_INPUT");
    const where = { alertId, alert: { is: scopedWhere(scope) } };
    return persistenceCall(async () => {
      const rows = await this.tx.approval.findMany({ where, orderBy: [{ alertVersion: "asc" }, { id: "asc" }] });
      return rows.map((row) => {
        requireVersion(row.alertVersion);
        const reviewedPayload = Uint8Array.from(row.reviewedPayload);
        const digest = Uint8Array.from(row.digest);
        inspectPayload(reviewedPayload, digest);
        if (row.decision === "APPROVED" ? row.reason !== null :
          row.reason === null || Array.from(row.reason).length < 3 || Array.from(row.reason).length > 500) {
          throw new AlertPersistenceError("PAYLOAD_INTEGRITY_ERROR");
        }
        return { ...row, reviewedPayload, digest, reviewedAt: new Date(row.reviewedAt) };
      });
    });
  }
}
