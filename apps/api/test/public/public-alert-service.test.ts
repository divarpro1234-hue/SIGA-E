import { createHash } from "node:crypto";
import { calculateJwkThumbprint, exportJWK, generateKeyPair } from "jose";
import { describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "../../src/generated/prisma/client.js";
import { PrismaPublicAlertService } from "../../src/modules/public/public-alert-service.js";
import { JoseAlertSigner } from "../../src/modules/signing/jose-alert-signer.js";
import { calculateJwsHash, calculateMessageKey } from "../../src/modules/signing/alert-hashes.js";

const alertId = "00000000-0000-4000-8000-000000000001";
const deploymentId = "00000000-0000-4000-8000-000000000002";
const keyId = "sigae-public-test-key";
const identity = {
  sender: "urn:siga-e:simulacro",
  identifier: "SIGAE-DEMO-0001",
  sent: "2026-10-20T14:32:00.000Z",
};
const payloadObject = {
  sender: identity.sender,
  identifier: identity.identifier,
  sent: identity.sent,
  status: "Exercise",
  scope: "Public",
  msgType: "Alert",
  info: {
    scenario: "SISMO",
    event: "Simulacro de sismo",
    severity: "Severe",
    urgency: "Immediate",
    certainty: "Likely",
    headline: "SIMULACRO: aviso ficticio de sismo",
    description: "Ejercicio académico. No constituye advertencia real.",
    expires: "2026-10-20T20:32:00.000Z",
    areaDesc: "Sector ficticio A",
  },
};

type ListingJob = {
  readonly alertId: string;
  readonly messageKey: Uint8Array;
  readonly jwsHash: Uint8Array;
  readonly state: string;
  readonly txHash: string | null;
  readonly confirmedLedger: bigint | null;
  readonly deployment: { readonly network: string; readonly contractId: string };
};
type ListingRow = {
  readonly id: string;
  readonly identifier: string;
  readonly lifecycleState: string;
  readonly anchorStatus: string;
  readonly kind: string;
  readonly publishedAt: Date | null;
  readonly messageKey: Uint8Array | null;
  readonly jwsHash: Uint8Array | null;
};
type ListingRecord = { readonly row: ListingRow; readonly jobs: readonly ListingJob[] };
type ListingQueryInput = { readonly sql: string; readonly values: readonly unknown[] };

function isListingRecordEligible({ row, jobs }: ListingRecord): boolean {
  const job = jobs[0];
  return row.lifecycleState === "PUBLISHED" && row.anchorStatus === "CONFIRMED" &&
    row.kind === "Alert" && row.publishedAt !== null && row.messageKey !== null &&
    row.jwsHash !== null && jobs.length === 1 && job !== undefined &&
    job.alertId === row.id && job.state === "CONFIRMED" &&
    typeof job.txHash === "string" && job.txHash.trim().length > 0 &&
    job.confirmedLedger !== null && job.confirmedLedger > 0n &&
    job.deployment.network === "TESTNET" &&
    Buffer.from(job.messageKey).equals(Buffer.from(row.messageKey)) &&
    Buffer.from(job.jwsHash).equals(Buffer.from(row.jwsHash));
}

function createListingQuery(records: readonly ListingRecord[]) {
  return vi.fn(async (query: ListingQueryInput) => {
    const eligible = records.filter(isListingRecordEligible).sort((left, right) => {
      const byPublishedAt = right.row.publishedAt!.getTime() - left.row.publishedAt!.getTime();
      return byPublishedAt || left.row.id.localeCompare(right.row.id);
    });
    if (/^\s*SELECT COUNT\(\*\) AS total/i.test(query.sql)) {
      return [{ total: BigInt(eligible.length) }];
    }

    const values = query.values;
    const limit = Number(values[values.length - 2]);
    const offset = Number(values[values.length - 1]);
    return eligible.slice(offset, offset + limit).map(({ row, jobs }) => {
      const job = jobs[0]!;
      return {
        id: row.id,
        identifier: row.identifier,
        lifecycleState: row.lifecycleState,
        anchorStatus: row.anchorStatus,
        messageKey: row.messageKey,
        jwsHash: row.jwsHash,
        jobMessageKey: job.messageKey,
        jobJwsHash: job.jwsHash,
        jobState: job.state,
        jobTxHash: job.txHash,
        jobConfirmedLedger: job.confirmedLedger,
        // Raw PostgreSQL queries return the mapped lowercase enum label.
        jobNetwork: job.deployment.network.toLowerCase(),
        jobContractId: job.deployment.contractId,
      };
    });
  });
}

function expectPublicListingPolicy(queries: readonly ListingQueryInput[]): void {
  for (const query of queries) {
    for (const predicate of [
      "alert.lifecycle_state = 'PUBLISHED'",
      "alert.anchor_status = 'CONFIRMED'",
      "job.message_key = alert.message_key",
      "job.jws_hash = alert.jws_hash",
      "job.tx_hash ~ '[^[:space:]]'",
      "job.confirmed_ledger > 0",
      "deployment.network = 'testnet'",
      "WHERE related_job.alert_id = alert.id",
    ]) {
      expect(query.sql).toContain(predicate);
    }
  }
}

async function fixture(options: {
  published?: boolean;
  anchorStatus?: string;
  jobState?: string;
  revoked?: boolean;
  missingKey?: boolean;
  badHash?: boolean;
  jobJwsHashMismatch?: boolean;
  jobMessageKeyMismatch?: boolean;
  jobTxHash?: string | null;
  jobConfirmedLedger?: bigint | null;
  alteredSignature?: boolean;
  repositoryFailure?: boolean;
  ambiguousJobs?: boolean;
  additionalJobStates?: string[];
  ambiguousDeployments?: boolean;
} = {}) {
  const keyPair = await generateKeyPair("ES256");
  const publicJwk = await exportJWK(keyPair.publicKey);
  const thumbprint = await calculateJwkThumbprint(publicJwk, "sha256");
  const frozenPayload = new TextEncoder().encode(JSON.stringify(payloadObject));
  const payloadSha256 = createHash("sha256").update(frozenPayload).digest();
  const jwsCompact = await new JoseAlertSigner(keyPair.privateKey, keyId).sign(frozenPayload);
  const storedJwsCompact = options.alteredSignature
    ? `${jwsCompact.slice(0, -1)}${jwsCompact.endsWith("A") ? "B" : "A"}`
    : jwsCompact;
  const jwsHash = calculateJwsHash(storedJwsCompact);
  if (options.badHash) jwsHash[0] = jwsHash[0]! ^ 0xff;
  const messageKey = calculateMessageKey(identity);
  const createdAt = new Date("2026-10-20T14:31:00.000Z");
  const row = {
    id: alertId,
    identifier: identity.identifier,
    lifecycleState: options.published === false ? "READY_TO_SIGN" : "PUBLISHED",
    anchorStatus: options.anchorStatus ?? "CONFIRMED",
    sender: identity.sender,
    sentText: identity.sent,
    kind: "Alert",
    frozenPayload,
    payloadSha256,
    jwsCompact: storedJwsCompact,
    kid: keyId,
    messageKey,
    jwsHash,
    publishedAt: new Date("2026-10-20T14:33:00.000Z"),
    createdAt,
    authorId: "private-author-id",
    severity: "Severe",
  };
  const keyRecord = {
    kid: keyId,
    publicJwk,
    thumbprint,
    status: options.revoked ? "REVOKED" : "ACTIVE",
    validFrom: new Date("2026-10-20T14:30:00.000Z"),
    retiredAt: null,
    revokedAt: options.revoked ? new Date("2026-10-20T14:34:00.000Z") : null,
  };
  const job = {
    alertId,
    messageKey: options.jobMessageKeyMismatch
      ? Uint8Array.from(messageKey, (byte, index) => index === 0 ? byte ^ 0xff : byte)
      : messageKey,
    jwsHash: options.jobJwsHashMismatch
      ? Uint8Array.from(jwsHash, (byte, index) => index === 0 ? byte ^ 0xff : byte)
      : options.badHash ? calculateJwsHash(storedJwsCompact) : jwsHash,
    state: options.jobState ?? "CONFIRMED",
    txHash: options.jobTxHash !== undefined
      ? options.jobTxHash
      : (options.jobState ?? "CONFIRMED") === "CONFIRMED" ? "ab".repeat(32) : null,
    confirmedLedger: options.jobConfirmedLedger !== undefined
      ? options.jobConfirmedLedger
      : (options.jobState ?? "CONFIRMED") === "CONFIRMED" ? 42n : null,
    deployment: { network: "TESTNET", contractId: "C".repeat(56) },
  };
  const jobs = [
    job,
    ...(options.additionalJobStates ?? []).map((state) => ({
      ...job,
      state,
      txHash: state === "CONFIRMED" ? "cd".repeat(32) : null,
      confirmedLedger: state === "CONFIRMED" ? 43n : null,
    })),
  ];
  const matchesJobWhere = (where: Record<string, unknown>) =>
    Object.entries(where).every(([field, expected]) => {
      if (field === "deployment") {
        if (!expected || typeof expected !== "object" || Array.isArray(expected)) return false;
        const is = (expected as Record<string, unknown>)["is"];
        return is !== undefined && is !== null && typeof is === "object" && !Array.isArray(is) &&
          Object.entries(is as Record<string, unknown>).every(([deploymentField, value]) =>
            deploymentField in job.deployment &&
            job.deployment[deploymentField as keyof typeof job.deployment] === value);
      }
      if (!(field in job)) return false;
      const value = job[field as keyof typeof job];
      if (expected && typeof expected === "object" && !Array.isArray(expected)) {
        const condition = expected as Record<string, unknown>;
        if ("not" in condition) return value !== condition["not"];
        const minimum = condition["gt"];
        if ("gt" in condition) {
          return typeof value === "bigint" && typeof minimum === "bigint" && value > minimum;
        }
        return false;
      }
      return value === expected;
    });
  const matchesAlertWhere = (where: Record<string, unknown>) =>
    Object.entries(where).every(([field, value]) => {
      if (field === "anchorJobs") {
        if (!value || typeof value !== "object" || Array.isArray(value)) return false;
        const some = (value as Record<string, unknown>)["some"];
        return some !== undefined && some !== null && typeof some === "object" &&
          !Array.isArray(some) && matchesJobWhere(some as Record<string, unknown>);
      }
      return field in row && row[field as keyof typeof row] === value;
    });
  const listingJobs = options.ambiguousJobs ? [job, job] : jobs;
  const listingQuery = createListingQuery([{ row, jobs: listingJobs }]);
  const tx = {
    $queryRaw: listingQuery,
    alert: {
      findMany: vi.fn(async ({ where }: { where: Record<string, unknown> }) =>
        matchesAlertWhere(where) ? [row] : []),
      count: vi.fn(async ({ where }: { where: Record<string, unknown> }) =>
        matchesAlertWhere(where) ? 1 : 0),
      findFirst: vi.fn(async ({ where }: { where: Record<string, unknown> }) =>
        matchesAlertWhere(where) ? row : null),
    },
    publicKey: {
      findUnique: vi.fn().mockResolvedValue(options.missingKey ? null : keyRecord),
      findMany: vi.fn().mockResolvedValue([keyRecord]),
    },
    anchorDeployment: {
      findMany: vi.fn().mockResolvedValue(options.ambiguousDeployments
        ? [{ contractId: "A".repeat(56), generation: 1 }, { contractId: "B".repeat(56), generation: 2 }]
        : [{ contractId: "C".repeat(56), generation: 1 }]),
    },
    anchorJob: {
      findMany: vi.fn().mockResolvedValue(options.ambiguousJobs ? [job, job] : jobs),
    },
  };
  const prisma = {
    ...tx,
    $transaction: vi.fn(async <T>(work: (client: typeof tx) => Promise<T>) => {
      if (options.repositoryFailure) throw new Error("private database diagnostic");
      return work(tx);
    }),
  } as unknown as PrismaClient;
  const service = new PrismaPublicAlertService(prisma);
  return {
    service, tx, row, jobs, listingQuery, keyPair, publicJwk, jwsCompact, frozenPayload,
    messageKey, jwsHash,
  };
}

function listingOnlyService(records: readonly ListingRecord[]) {
  const listingQuery = createListingQuery(records);
  const tx = { $queryRaw: listingQuery };
  const prisma = {
    $transaction: vi.fn(async <T>(work: (client: typeof tx) => Promise<T>) => work(tx)),
  } as unknown as PrismaClient;
  return { service: new PrismaPublicAlertService(prisma), listingQuery };
}

describe("API pública de alertas", () => {
  it("expone solo una alerta PUBLISHED y verifica JWS y bytes congelados", async () => {
    const { service, tx, frozenPayload } = await fixture();
    const result = await service.get(alertId);

    expect(result.alert).toMatchObject({
      id: alertId,
      lifecycleState: "PUBLISHED",
      sender: identity.sender,
      sent: identity.sent,
      status: "Exercise",
      scope: "Public",
      notice: "SIMULACRO",
    });
    expect(result.jwsCompact.split(".")).toHaveLength(3);
    expect(result.signatureMeta).toEqual({ alg: "ES256", kid: keyId });
    expect(result.alert).not.toHaveProperty("authorId");
    expect(result.alert).not.toHaveProperty("severity");
    expect(result.alert).not.toHaveProperty("email");
    expect(result.alert).not.toHaveProperty("info");
    expect(Buffer.from(result.jwsCompact.split(".")[1]!, "base64url"))
      .toEqual(Buffer.from(frozenPayload));
    expect(tx.publicKey.findUnique).toHaveBeenCalledTimes(1);
  });

  it("lista solo estados PUBLISHED con resumen y paginación", async () => {
    const { service, tx } = await fixture();
    await expect(service.list(1, 5)).resolves.toEqual({
      items: [{
        id: alertId, identifier: identity.identifier, lifecycleState: "PUBLISHED",
        anchorStatus: "CONFIRMED", notice: "SIMULACRO",
      }],
      page: 1,
      total: 1,
    });
    const queries = tx.$queryRaw.mock.calls.map(([query]) => query);
    expect(queries).toHaveLength(2);
    expectPublicListingPolicy(queries);
    const pageQuery = queries.find((query) => !/^\s*SELECT COUNT\(\*\) AS total/i.test(query.sql));
    expect(pageQuery?.sql).toContain("ORDER BY alert.published_at DESC, alert.id ASC");
    expect(pageQuery?.values).toEqual([5, 0]);
  });

  it("excluye del listado un AnchorJob cuyo jwsHash no coincide con la alerta", async () => {
    const { service } = await fixture({ jobJwsHashMismatch: true });

    await expect(service.list(1, 20)).resolves.toMatchObject({ items: [], total: 0 });
    await expect(service.get(alertId)).rejects.toMatchObject({
      status: 503, code: "PUBLIC_DATA_UNAVAILABLE",
    });
    await expect(service.anchor(alertId)).rejects.toMatchObject({
      status: 503, code: "PUBLIC_DATA_UNAVAILABLE",
    });
  });

  it("excluye del listado un AnchorJob cuyo messageKey no coincide con la alerta", async () => {
    const { service } = await fixture({ jobMessageKeyMismatch: true });

    await expect(service.list(1, 20)).resolves.toMatchObject({ items: [], total: 0 });
    await expect(service.get(alertId)).rejects.toMatchObject({
      status: 503, code: "PUBLIC_DATA_UNAVAILABLE",
    });
    await expect(service.anchor(alertId)).rejects.toMatchObject({
      status: 503, code: "PUBLIC_DATA_UNAVAILABLE",
    });
  });

  it.each(["", " \t\n"])("excluye del listado un txHash vacío o blanco (%j)", async (txHash) => {
    const { service } = await fixture({ jobTxHash: txHash });

    await expect(service.list(1, 20)).resolves.toMatchObject({ items: [], total: 0 });
    await expect(service.get(alertId)).rejects.toMatchObject({
      status: 503, code: "PUBLIC_DATA_UNAVAILABLE",
    });
    await expect(service.anchor(alertId)).rejects.toMatchObject({
      status: 503, code: "PUBLIC_DATA_UNAVAILABLE",
    });
  });

  it("excluye del listado un AnchorJob con ledger nulo o no positivo", async () => {
    for (const confirmedLedger of [null, 0n]) {
      const { service } = await fixture({ jobConfirmedLedger: confirmedLedger });

      await expect(service.list(1, 20)).resolves.toMatchObject({ items: [], total: 0 });
      await expect(service.get(alertId)).rejects.toMatchObject({
        status: 503, code: "PUBLIC_DATA_UNAVAILABLE",
      });
      await expect(service.anchor(alertId)).rejects.toMatchObject({
        status: 503, code: "PUBLIC_DATA_UNAVAILABLE",
      });
    }
  });

  it("excluye del listado una alerta con un AnchorJob confirmado y otro pendiente", async () => {
    const { service } = await fixture({ additionalJobStates: ["PENDING"] });

    await expect(service.list(1, 20)).resolves.toMatchObject({ items: [], total: 0 });
    await expect(service.get(alertId)).rejects.toMatchObject({
      status: 503, code: "PUBLIC_DATA_UNAVAILABLE",
    });
    await expect(service.anchor(alertId)).rejects.toMatchObject({
      status: 503, code: "PUBLIC_DATA_UNAVAILABLE",
    });
  });

  it("excluye del listado una alerta con dos AnchorJob confirmados", async () => {
    const { service } = await fixture({ ambiguousJobs: true });

    await expect(service.list(1, 20)).resolves.toMatchObject({ items: [], total: 0 });
    await expect(service.get(alertId)).rejects.toMatchObject({
      status: 503, code: "PUBLIC_DATA_UNAVAILABLE",
    });
    await expect(service.anchor(alertId)).rejects.toMatchObject({
      status: 503, code: "PUBLIC_DATA_UNAVAILABLE",
    });
  });

  it("pagina solo alertas elegibles, conserva el total y mantiene orden determinista", async () => {
    const recent = await fixture();
    const inconsistent = await fixture({ jobJwsHashMismatch: true });
    const oldest = await fixture();
    const record = (
      subject: Awaited<ReturnType<typeof fixture>>,
      id: string,
      identifierValue: string,
      publishedAt: Date,
    ): ListingRecord => ({
      row: { ...subject.row, id, identifier: identifierValue, publishedAt },
      jobs: subject.jobs.map((job) => ({ ...job, alertId: id })),
    });
    const recentId = "00000000-0000-4000-8000-000000000003";
    const invalidId = "00000000-0000-4000-8000-000000000004";
    const oldestId = "00000000-0000-4000-8000-000000000005";
    const { service, listingQuery } = listingOnlyService([
      record(recent, recentId, "SIGAE-DEMO-0003", new Date("2026-10-20T14:35:00.000Z")),
      record(inconsistent, invalidId, "SIGAE-DEMO-0004", new Date("2026-10-20T14:34:00.000Z")),
      record(oldest, oldestId, "SIGAE-DEMO-0005", new Date("2026-10-20T14:33:00.000Z")),
    ]);

    await expect(service.list(1, 1)).resolves.toEqual({
      items: [{
        id: recentId, identifier: "SIGAE-DEMO-0003", lifecycleState: "PUBLISHED",
        anchorStatus: "CONFIRMED", notice: "SIMULACRO",
      }],
      page: 1,
      total: 2,
    });
    await expect(service.list(2, 1)).resolves.toMatchObject({
      items: [{ id: oldestId, identifier: "SIGAE-DEMO-0005" }],
      page: 2,
      total: 2,
    });
    await expect(service.list(3, 1)).resolves.toEqual({ items: [], page: 3, total: 2 });

    const queries = listingQuery.mock.calls.map(([query]) => query);
    expect(queries).toHaveLength(6);
    expectPublicListingPolicy(queries);
    const pageQueries = queries.filter(
      (query) => !/^\s*SELECT COUNT\(\*\) AS total/i.test(query.sql),
    );
    expect(pageQueries.map((query) => query.values)).toEqual([[1, 0], [1, 1], [1, 2]]);
  });

  it("responde como no disponible ante alerta no publicada o UUID inválido", async () => {
    const unpublished = await fixture({ published: false });
    await expect(unpublished.service.get(alertId)).rejects.toMatchObject({
      status: 404, code: "PUBLIC_ALERT_NOT_FOUND",
    });
    expect(unpublished.tx.alert.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: alertId, lifecycleState: "PUBLISHED", kind: "Alert" },
    }));
    await expect(unpublished.service.get("no-es-uuid")).rejects.toMatchObject({
      status: 404, code: "PUBLIC_ALERT_NOT_FOUND",
    });
  });

  it("no expone públicamente una alerta PUBLISHED cuyo anclaje sigue PENDING", async () => {
    const { service, row, tx } = await fixture({
      published: true,
      anchorStatus: "PENDING",
      jobState: "PENDING",
    });

    expect(row).toMatchObject({
      lifecycleState: "PUBLISHED",
      anchorStatus: "PENDING",
      publishedAt: expect.any(Date),
    });
    const jobs = await tx.anchorJob.findMany({ where: { alertId } });
    expect(jobs).toMatchObject([
      expect.objectContaining({ state: "PENDING", txHash: null }),
    ]);

    const [listResult, detailResult] = await Promise.allSettled([
      service.list(1, 20),
      service.get(alertId),
    ]);

    if (listResult.status === "fulfilled") {
      expect.soft(listResult.value.items).toHaveLength(0);
      expect.soft(listResult.value.total).toBe(0);
      expectPublicListingPolicy(tx.$queryRaw.mock.calls.map(([query]) => query));
    }

    expect.soft(detailResult.status).toBe("rejected");
    if (detailResult.status === "rejected") {
      expect.soft(detailResult.reason).toMatchObject({
        status: 503,
        code: "PUBLIC_DATA_UNAVAILABLE",
      });
    }
    if (detailResult.status === "fulfilled") {
      expect.soft(detailResult.value.alert.lifecycleState).not.toBe("PUBLISHED");
      expect.soft(detailResult.value.jwsCompact).toBeUndefined();
      expect.soft(detailResult.value.signatureMeta).toBeUndefined();
      expect.soft(detailResult.value.anchorEvidenceMeta.anchorStatus).not.toBe("PENDING");
      expect.soft(detailResult.value.anchorEvidenceMeta.txHash).toBeTruthy();
    }

    const anchorResult = await Promise.allSettled([service.anchor(alertId)]);
    expect.soft(anchorResult[0]?.status).toBe("rejected");
    if (anchorResult[0]?.status === "rejected") {
      expect.soft(anchorResult[0].reason).toMatchObject({
        status: 503,
        code: "PUBLIC_DATA_UNAVAILABLE",
      });
    }
    if (anchorResult[0]?.status === "fulfilled") {
      expect.soft(anchorResult[0].value.anchorStatus).not.toBe("PENDING");
      expect.soft(anchorResult[0].value.txHash).toBeTruthy();
    }
  });

  it("rechaza hash incoherente, firma manipulada y clave revocada", async () => {
    const badHash = await fixture({ badHash: true });
    await expect(badHash.service.get(alertId)).rejects.toMatchObject({
      status: 503, code: "PUBLIC_DATA_UNAVAILABLE",
    });
    const badSignature = await fixture({ alteredSignature: true });
    await expect(badSignature.service.get(alertId)).rejects.toMatchObject({
      status: 503, code: "PUBLIC_DATA_UNAVAILABLE",
    });
    const revoked = await fixture({ revoked: true });
    await expect(revoked.service.get(alertId)).rejects.toMatchObject({
      status: 503, code: "PUBLIC_DATA_UNAVAILABLE",
    });
    const unknownKey = await fixture({ missingKey: true });
    await expect(unknownKey.service.get(alertId)).rejects.toMatchObject({
      status: 503, code: "PUBLIC_DATA_UNAVAILABLE",
    });
  });

  it("expone metadata de anclaje como backend_metadata, sin afirmar verificación blockchain", async () => {
    const { service, messageKey, jwsHash } = await fixture();
    const evidence = await service.anchor(alertId);

    expect(evidence).toMatchObject({
      network: "testnet",
      contractId: "C".repeat(56),
      anchorStatus: "CONFIRMED",
      messageKeyHex: Buffer.from(messageKey).toString("hex"),
      jwsHashHex: Buffer.from(jwsHash).toString("hex"),
      txHash: "ab".repeat(32),
      checkedAt: null,
      verificationSource: "backend_metadata",
    });
    expect(evidence.note).toContain("no es una lectura independiente");
  });

  it("rechaza evidencia ambigua y fallos de repositorio sin filtrar mensajes", async () => {
    const multipleJobs = await fixture({ ambiguousJobs: true });
    await expect(multipleJobs.service.get(alertId)).rejects.toMatchObject({
      status: 503, publicDetail: "Los datos públicos no pudieron verificarse.",
    });
    const failedRepository = await fixture({ repositoryFailure: true });
    await expect(failedRepository.service.list(1, 20)).rejects.toMatchObject({
      status: 503, publicDetail: "Los datos públicos no pudieron verificarse.",
    });
  });

  it("publica solo coordenadas públicas en JWKS y detecta deployments activos ambiguos", async () => {
    const { service, publicJwk } = await fixture();
    const result = await service.jwks();
    expect(result.keys).toHaveLength(1);
    expect(result.keys[0]).toMatchObject({
      kid: keyId, kty: "EC", crv: "P-256", alg: "ES256", use: "sig", key_ops: ["verify"],
      x: publicJwk.x, y: publicJwk.y,
    });
    expect(result.keys[0]).not.toHaveProperty("d");

    const ambiguousDeployment = await fixture({ ambiguousDeployments: true });
    await expect(ambiguousDeployment.service.trust()).rejects.toMatchObject({
      status: 503, code: "PUBLIC_DATA_UNAVAILABLE",
    });
  });
});
