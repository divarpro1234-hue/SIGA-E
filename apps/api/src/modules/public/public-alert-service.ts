import { calculateJwkThumbprint, importJWK, type JWK_EC_Public } from "jose";
import { Prisma, type PrismaClient } from "../../generated/prisma/client.js";
import type { AnchorStatus } from "../../generated/prisma/enums.js";
import { ApplicationError } from "../../domain/errors/application-error.js";
import { inspectPayload, requireUuid } from "../alerts/alert-persistence.js";
import { bytesToLowerHex, calculateJwsHash, calculateMessageKey } from "../signing/alert-hashes.js";
import { InMemoryTrustedPublicKeyCatalog } from "../signing/trusted-public-keys.js";
import { verifyAlertJws } from "../signing/verify-alert-jws.js";

const alertSummarySelect = {
  id: true, identifier: true, lifecycleState: true, anchorStatus: true,
} satisfies Prisma.AlertSelect;

const publicAlertSelect = {
  ...alertSummarySelect,
  sender: true, sentText: true, kind: true, frozenPayload: true, payloadSha256: true,
  jwsCompact: true, kid: true, messageKey: true, jwsHash: true, publishedAt: true, createdAt: true,
} satisfies Prisma.AlertSelect;

const safeUnavailable = () => new ApplicationError(
  503, "PUBLIC_DATA_UNAVAILABLE", "Servicio público no disponible",
  "Los datos públicos no pudieron verificarse.",
);
const publicNotFound = () => new ApplicationError(
  404, "PUBLIC_ALERT_NOT_FOUND", "Alerta no disponible", "La alerta no está disponible.",
);

export interface PublicAlertSummary {
  readonly id: string;
  readonly identifier: string;
  readonly lifecycleState: "PUBLISHED";
  readonly anchorStatus: AnchorStatus;
  readonly notice: "SIMULACRO";
}

export interface PublicAnchorEvidence {
  readonly network: "testnet";
  readonly contractId: string;
  readonly anchorStatus: AnchorStatus;
  readonly messageKeyHex: string;
  readonly jwsHashHex: string;
  readonly txHash: string | null;
  readonly checkedAt: string | null;
  readonly verificationSource: "backend_metadata";
  readonly note: string;
}

export interface PublicAlertApplicationService {
  list(page: number, limit: number): Promise<{ items: PublicAlertSummary[]; page: number; total: number }>;
  get(id: string): Promise<{
    alert: PublicAlertSummary & {
      sender: string;
      sent: string;
      status: "Exercise";
      scope: "Public";
    };
    jwsCompact: string;
    signatureMeta: { alg: "ES256"; kid: string };
    anchorEvidenceMeta: PublicAnchorEvidence;
  }>;
  anchor(id: string): Promise<PublicAnchorEvidence>;
  jwks(): Promise<{ keys: JWK_EC_Public[] }>;
  trust(): Promise<{
    trustedKeyThumbprints: string[];
    network: "testnet";
    contractId?: string;
    generation?: number;
  }>;
}

type PublicAlertDetail = Awaited<ReturnType<PublicAlertApplicationService["get"]>>;

type PublicAlertRow = Prisma.AlertGetPayload<{ select: typeof publicAlertSelect }>;
type AnchorEvidenceJob = {
  readonly messageKey: Uint8Array;
  readonly jwsHash: Uint8Array;
  readonly state: string;
  readonly txHash: string | null;
  readonly confirmedLedger: bigint | null;
  readonly deployment: { readonly network: string; readonly contractId: string };
};
type PublicAlertListingRow = Pick<
  PublicAlertRow,
  "id" | "identifier" | "lifecycleState" | "anchorStatus" | "messageKey" | "jwsHash"
> & {
  readonly jobMessageKey: Uint8Array;
  readonly jobJwsHash: Uint8Array;
  readonly jobState: string;
  readonly jobTxHash: string | null;
  readonly jobConfirmedLedger: bigint | null;
  readonly jobNetwork: string;
  readonly jobContractId: string;
};
type PublicKeyRow = {
  readonly kid: string;
  readonly publicJwk: Prisma.JsonValue;
  readonly thumbprint: string;
  readonly status: "ACTIVE" | "RETIRED" | "REVOKED";
  readonly revokedAt: Date | null;
};

function summary(row: Pick<PublicAlertRow, "id" | "identifier" | "lifecycleState" | "anchorStatus">): PublicAlertSummary {
  if (row.lifecycleState !== "PUBLISHED" || row.anchorStatus !== "CONFIRMED") {
    throw safeUnavailable();
  }
  return {
    id: row.id,
    identifier: row.identifier,
    lifecycleState: "PUBLISHED",
    anchorStatus: row.anchorStatus,
    notice: "SIMULACRO",
  };
}

function publicJwk(value: Prisma.JsonValue, kid: string): JWK_EC_Public & { kty: "EC"; crv: "P-256" } {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      value["kty"] !== "EC" || value["crv"] !== "P-256" ||
      typeof value["x"] !== "string" || typeof value["y"] !== "string" ||
      ("d" in value) || (value["kid"] !== undefined && value["kid"] !== kid)) {
    throw safeUnavailable();
  }
  return { kty: "EC", crv: "P-256", x: value["x"], y: value["y"], kid };
}

function equalBytes(left: Uint8Array | null, right: Uint8Array): boolean {
  return left !== null && Buffer.from(left).equals(Buffer.from(right));
}

function eligiblePublicAlertsFrom(): Prisma.Sql {
  return Prisma.sql`
    FROM alerts AS alert
    INNER JOIN anchor_jobs AS job ON job.alert_id = alert.id
    INNER JOIN anchor_deployments AS deployment ON deployment.id = job.deployment_id
    WHERE alert.lifecycle_state = 'PUBLISHED'
      AND alert.anchor_status = 'CONFIRMED'
      AND alert.kind = 'Alert'
      AND alert.published_at IS NOT NULL
      AND alert.message_key IS NOT NULL
      AND alert.jws_hash IS NOT NULL
      AND job.state = 'CONFIRMED'
      AND job.message_key = alert.message_key
      AND job.jws_hash = alert.jws_hash
      AND job.tx_hash IS NOT NULL
      AND job.tx_hash ~ '[^[:space:]]'
      AND job.confirmed_ledger > 0
      AND deployment.network = 'testnet'
      AND (
        SELECT COUNT(*)
        FROM anchor_jobs AS related_job
        WHERE related_job.alert_id = alert.id
      ) = 1
  `;
}

function requireConsistentAnchorEvidence(
  row: Pick<PublicAlertRow, "anchorStatus" | "messageKey" | "jwsHash">,
  jobs: readonly AnchorEvidenceJob[],
): AnchorEvidenceJob {
  const job = jobs[0];
  if (row.anchorStatus !== "CONFIRMED" || !row.messageKey || !row.jwsHash ||
      jobs.length !== 1 || !job || job.deployment.network !== "TESTNET" ||
      job.state !== "CONFIRMED" || typeof job.txHash !== "string" ||
      job.txHash.trim().length === 0 || job.confirmedLedger === null ||
      job.confirmedLedger <= 0n ||
      !Buffer.from(job.messageKey).equals(Buffer.from(row.messageKey)) ||
      !Buffer.from(job.jwsHash).equals(Buffer.from(row.jwsHash))) {
    throw safeUnavailable();
  }
  return job;
}

export class PrismaPublicAlertService implements PublicAlertApplicationService {
  constructor(private readonly prisma: PrismaClient) {}

  async list(page: number, limit: number) {
    if (!Number.isSafeInteger(page) || page < 1 || !Number.isSafeInteger(limit) ||
        limit < 1 || limit > 50 || (page - 1) * limit > Number.MAX_SAFE_INTEGER) {
      throw new ApplicationError(422, "INVALID_ALERT_PAYLOAD", "Entrada inválida", "La consulta no es válida.");
    }
    try {
      return await this.prisma.$transaction(async (tx) => {
        const from = eligiblePublicAlertsFrom();
        const [rows, counts] = await Promise.all([
          tx.$queryRaw<PublicAlertListingRow[]>(Prisma.sql`
            SELECT
              alert.id,
              alert.identifier,
              alert.lifecycle_state AS "lifecycleState",
              alert.anchor_status AS "anchorStatus",
              alert.message_key AS "messageKey",
              alert.jws_hash AS "jwsHash",
              job.message_key AS "jobMessageKey",
              job.jws_hash AS "jobJwsHash",
              job.state AS "jobState",
              job.tx_hash AS "jobTxHash",
              job.confirmed_ledger AS "jobConfirmedLedger",
              deployment.network AS "jobNetwork",
              deployment.contract_id AS "jobContractId"
            ${from}
            ORDER BY alert.published_at DESC, alert.id ASC
            LIMIT ${limit} OFFSET ${(page - 1) * limit}
          `),
          tx.$queryRaw<Array<{ readonly total: bigint }>>(Prisma.sql`
            SELECT COUNT(*) AS total
            ${from}
          `),
        ]);
        const total = counts[0]?.total;
        if (typeof total !== "bigint" || total < 0n || total > BigInt(Number.MAX_SAFE_INTEGER)) {
          throw safeUnavailable();
        }
        return {
          items: rows.map((row) => {
            requireConsistentAnchorEvidence(row, [{
              messageKey: row.jobMessageKey,
              jwsHash: row.jobJwsHash,
              state: row.jobState,
              txHash: row.jobTxHash,
              confirmedLedger: row.jobConfirmedLedger,
              deployment: {
                network: row.jobNetwork.toUpperCase(),
                contractId: row.jobContractId,
              },
            }]);
            return summary(row);
          }),
          page, total: Number(total),
        };
      }, { isolationLevel: "RepeatableRead" });
    } catch (error) {
      if (error instanceof ApplicationError) throw error;
      throw safeUnavailable();
    }
  }

  async get(id: string): Promise<PublicAlertDetail> {
    const row = await this.findPublished(id);
    const key = await this.findVerificationKey(row);
    const verified = await this.verifyStoredAlert(row, key);
    const anchorEvidenceMeta = await this.anchorEvidence(row);
    return {
      alert: {
        ...summary(row),
        sender: verified.metadata.sender,
        sent: verified.metadata.sentText,
        status: "Exercise" as const,
        scope: "Public" as const,
      },
      jwsCompact: row.jwsCompact!,
      signatureMeta: { alg: "ES256" as const, kid: verified.kid },
      anchorEvidenceMeta,
    };
  }

  async anchor(id: string): Promise<PublicAnchorEvidence> {
    const row = await this.findPublished(id);
    const key = await this.findVerificationKey(row);
    await this.verifyStoredAlert(row, key);
    return this.anchorEvidence(row);
  }

  async jwks(): Promise<{ keys: JWK_EC_Public[] }> {
    try {
      const records = await this.prisma.publicKey.findMany({
        where: { status: { in: ["ACTIVE", "RETIRED"] }, revokedAt: null },
        select: { kid: true, publicJwk: true, thumbprint: true },
        orderBy: { kid: "asc" },
      });
      const keys = await Promise.all(records.map(async (record) => {
        const jwk = publicJwk(record.publicJwk, record.kid);
        const thumbprint = await calculateJwkThumbprint(jwk, "sha256");
        if (thumbprint !== record.thumbprint) throw safeUnavailable();
        return { ...jwk, alg: "ES256", use: "sig", key_ops: ["verify"] };
      }));
      return { keys };
    } catch (error) {
      if (error instanceof ApplicationError) throw error;
      throw safeUnavailable();
    }
  }

  async trust() {
    try {
      const [keys, deployments] = await Promise.all([
        this.prisma.publicKey.findMany({
          where: { status: { in: ["ACTIVE", "RETIRED"] }, revokedAt: null },
          select: { kid: true, publicJwk: true, thumbprint: true },
          orderBy: { kid: "asc" },
        }),
        this.prisma.anchorDeployment.findMany({
          where: { state: "ACTIVE", network: "TESTNET" },
          orderBy: { generation: "desc" },
          take: 2,
          select: { contractId: true, generation: true },
        }),
      ]);
      if (deployments.length > 1) throw safeUnavailable();
      for (const record of keys) {
        const jwk = publicJwk(record.publicJwk, record.kid);
        if (await calculateJwkThumbprint(jwk, "sha256") !== record.thumbprint) throw safeUnavailable();
      }
      const deployment = deployments[0];
      return {
        trustedKeyThumbprints: keys.map((key) => key.thumbprint),
        network: "testnet" as const,
        ...(deployment ? { contractId: deployment.contractId, generation: deployment.generation } : {}),
      };
    } catch (error) {
      if (error instanceof ApplicationError) throw error;
      throw safeUnavailable();
    }
  }

  private async findPublished(id: string): Promise<PublicAlertRow> {
    try {
      requireUuid(id);
    } catch {
      throw publicNotFound();
    }
    try {
      const row = await this.prisma.alert.findFirst({
        where: { id, lifecycleState: "PUBLISHED", kind: "Alert" },
        select: publicAlertSelect,
      });
      if (!row) throw publicNotFound();
      if (row.anchorStatus !== "CONFIRMED") throw safeUnavailable();
      return row;
    } catch (error) {
      if (error instanceof ApplicationError) throw error;
      throw safeUnavailable();
    }
  }

  private async findVerificationKey(row: PublicAlertRow): Promise<PublicKeyRow> {
    if (!row.kid) throw safeUnavailable();
    try {
      const key = await this.prisma.publicKey.findUnique({
        where: { kid: row.kid },
        select: {
          kid: true, publicJwk: true, thumbprint: true, status: true, revokedAt: true,
        },
      });
      if (!key || key.kid !== row.kid || key.status === "REVOKED" || key.revokedAt !== null ||
          (key.status !== "ACTIVE" && key.status !== "RETIRED")) {
        throw safeUnavailable();
      }
      const jwk = publicJwk(key.publicJwk, key.kid);
      if (await calculateJwkThumbprint(jwk, "sha256") !== key.thumbprint) throw safeUnavailable();
      return key;
    } catch (error) {
      if (error instanceof ApplicationError) throw error;
      throw safeUnavailable();
    }
  }

  private async verifyStoredAlert(row: PublicAlertRow, key: PublicKeyRow) {
    if (!row.jwsCompact || row.jwsCompact.length > 32_768 || !row.kid ||
        !row.messageKey || !row.jwsHash || !row.publishedAt) {
      throw safeUnavailable();
    }
    try {
      const frozenPayload = Uint8Array.from(row.frozenPayload);
      const metadata = inspectPayload(frozenPayload, Uint8Array.from(row.payloadSha256));
      if (metadata.kind !== row.kind || metadata.identifier !== row.identifier ||
          metadata.sender !== row.sender || metadata.sentText !== row.sentText ||
          !equalBytes(row.jwsHash, calculateJwsHash(row.jwsCompact)) ||
          !equalBytes(row.messageKey, calculateMessageKey({
            sender: metadata.sender, identifier: metadata.identifier, sent: metadata.sentText,
          }))) {
        throw safeUnavailable();
      }
      const imported = await importJWK(publicJwk(key.publicJwk, key.kid), "ES256");
      const verified = await verifyAlertJws(row.jwsCompact,
        new InMemoryTrustedPublicKeyCatalog([[key.kid, imported]]));
      if (verified.kid !== row.kid || !Buffer.from(verified.payloadBytes).equals(Buffer.from(frozenPayload))) {
        throw safeUnavailable();
      }
      return { ...verified, metadata };
    } catch (error) {
      if (error instanceof ApplicationError) throw error;
      throw safeUnavailable();
    }
  }

  private async anchorEvidence(row: PublicAlertRow): Promise<PublicAnchorEvidence> {
    try {
      const jobs = await this.prisma.anchorJob.findMany({
        where: { alertId: row.id },
        orderBy: [{ createdAt: "desc" }, { id: "asc" }],
        take: 2,
        select: {
          messageKey: true, jwsHash: true, state: true, txHash: true, confirmedLedger: true,
          deployment: { select: { network: true, contractId: true } },
        },
      });
      if (row.messageKey === null || row.jwsHash === null) throw safeUnavailable();
      const job = requireConsistentAnchorEvidence(row, jobs);
      return {
        network: "testnet",
        contractId: job.deployment.contractId,
        anchorStatus: row.anchorStatus,
        messageKeyHex: bytesToLowerHex(row.messageKey),
        jwsHashHex: bytesToLowerHex(row.jwsHash),
        txHash: job.txHash,
        checkedAt: null,
        verificationSource: "backend_metadata",
        note: "Metadata del backend; no es una lectura independiente de Soroban.",
      };
    } catch (error) {
      if (error instanceof ApplicationError) throw error;
      throw safeUnavailable();
    }
  }
}
