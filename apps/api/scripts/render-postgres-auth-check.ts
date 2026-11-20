import { randomBytes, randomUUID } from "node:crypto";
import request from "supertest";
import { createApp } from "../src/app.js";
import { PrismaSessionReader } from "../src/modules/identity/prisma-session-reader.js";
import { PrismaLoginService } from "../src/modules/identity/login-service.js";
import { encryptTotpSecret, newTotpSecret, totpCodeForTest } from "../src/modules/identity/totp.js";
import { hashPassword } from "../src/modules/identity/password.js";
import { createPrismaClient } from "../src/infrastructure/database/prisma-client.js";

const expected = {
  db: "sigae_render_test",
  address: "127.0.0.1",
  port: 55434,
  marker: "SIGAE_RENDER_AUTH_TEST_V1",
};

function assertEnvironment(): { runtimeUrl: string; adminUrl: string } {
  if (process.env["SIGAE_RUN_RENDER_PG_AUTH_TEST"] !== "I_ACKNOWLEDGE_DISPOSABLE_DB_WRITES") {
    throw new Error("RENDER_AUTH_TEST_NOT_ACKNOWLEDGED");
  }
  const runtimeUrl = process.env["SIGAE_RENDER_TEST_RUNTIME_URL"];
  const adminUrl = process.env["SIGAE_RENDER_TEST_ADMIN_URL"];
  if (!runtimeUrl || !adminUrl) throw new Error("RENDER_AUTH_TEST_URLS_REQUIRED");
  for (const [value, username] of [[runtimeUrl, "sigae_render_runtime"], [adminUrl, "postgres"]] as const) {
    const url = new URL(value);
    if ((url.protocol !== "postgresql:" && url.protocol !== "postgres:") ||
        url.hostname !== expected.address || url.port !== String(expected.port) ||
        url.pathname !== `/${expected.db}` || decodeURIComponent(url.username) !== username) {
      throw new Error("RENDER_AUTH_TEST_DESTINATION_REJECTED");
    }
  }
  return { runtimeUrl, adminUrl };
}

async function assertTarget(client: ReturnType<typeof createPrismaClient>, username: string): Promise<void> {
  const rows = await client.$queryRaw<Array<{
    db: string; username: string; address: string | null; port: number | null;
    marker: string | null; timezone: string; superuser: boolean;
  }>>`
    SELECT current_database() AS db, current_user AS username,
      host(inet_server_addr()) AS address, inet_server_port() AS port,
      (SELECT shobj_description(oid, 'pg_database') FROM pg_database WHERE datname = current_database()) AS marker,
      current_setting('TimeZone') AS timezone,
      (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) AS superuser`;
  const row = rows[0];
  if (rows.length !== 1 || !row || row.db !== expected.db || row.username !== username ||
      row.address !== expected.address || row.port !== expected.port ||
      row.marker !== expected.marker || row.timezone !== "UTC" ||
      row.superuser !== (username === "postgres")) {
    throw new Error("RENDER_AUTH_TEST_DATABASE_GUARD_FAILED");
  }
}

async function main(): Promise<void> {
  const { runtimeUrl, adminUrl } = assertEnvironment();
  const runtime = createPrismaClient(runtimeUrl);
  const admin = createPrismaClient(adminUrl);
  const totpKey = new Uint8Array(randomBytes(32));
  const csrfSecret = new Uint8Array(randomBytes(32));
  const rateSecret = new Uint8Array(randomBytes(32));
  try {
    await assertTarget(runtime, "sigae_render_runtime");
    await assertTarget(admin, "postgres");
    const syntheticPassword = randomBytes(32).toString("base64url") + "A1!";
    const totpSecret = newTotpSecret();
    const firstId = randomUUID();
    const firstEmail = `render-auth-${firstId}@example.invalid`;
    const firstPasswordHash = await hashPassword(syntheticPassword);
    await admin.user.create({ data: {
      id: firstId, name: "SIMULACRO PostgreSQL auth", email: firstEmail, role: "AUTHOR",
      status: "ACTIVE", passwordHash: firstPasswordHash,
      totpSecretCiphertext: encryptTotpSecret(totpSecret, totpKey),
    } });

    const loginService = new PrismaLoginService(runtime, totpKey, rateSecret);
    const clock = new Date();
    for (let attempt = 0; attempt < 5; attempt++) {
      const result = await loginService.login(firstEmail, "incorrecta", `ps5-${firstId}`, new Date(clock.getTime() + attempt * 1000));
      if (result.ok) throw new Error("RENDER_AUTH_UNEXPECTED_PASSWORD_ACCEPTED");
    }
    const locked = await admin.user.findUniqueOrThrow({ where: { id: firstId },
      select: { failedAttempts: true, lockedUntil: true } });
    if (locked.failedAttempts !== 5 || !locked.lockedUntil) throw new Error("RENDER_AUTH_LOCK_NOT_PERSISTED");

    const restartedService = new PrismaLoginService(runtime, totpKey, rateSecret);
    const duringLock = await restartedService.login(firstEmail, syntheticPassword, `ps5-${firstId}`,
      new Date(locked.lockedUntil.getTime() - 1000));
    if (duringLock.ok) throw new Error("RENDER_AUTH_LOCK_NOT_ENFORCED_AFTER_RESTART");

    const recoveredAt = new Date(locked.lockedUntil.getTime() + 1000);
    const challenge = await restartedService.login(firstEmail, syntheticPassword, `ps5-${firstId}`, recoveredAt);
    if (!challenge.ok) throw new Error("RENDER_AUTH_RECOVERY_FAILED");
    const verified = await restartedService.verify(challenge.challengeId,
      totpCodeForTest(totpSecret, recoveredAt), `ps5-${firstId}`, recoveredAt);
    if (!verified.ok) throw new Error("RENDER_AUTH_MFA_RECOVERY_FAILED");
    const recovered = await admin.user.findUniqueOrThrow({ where: { id: firstId },
      select: { failedAttempts: true, lockedUntil: true } });
    if (recovered.failedAttempts !== 0 || recovered.lockedUntil !== null) {
      throw new Error("RENDER_AUTH_LOCK_NOT_CLEARED_AFTER_MFA");
    }

    const httpId = randomUUID();
    const httpEmail = `render-http-${httpId}@example.invalid`;
    const httpPassword = randomBytes(32).toString("base64url") + "B2!";
    const httpTotp = newTotpSecret();
    await admin.user.create({ data: {
      id: httpId, name: "SIMULACRO PostgreSQL HTTP auth", email: httpEmail, role: "APPROVER",
      status: "ACTIVE", passwordHash: await hashPassword(httpPassword),
      totpSecretCiphertext: encryptTotpSecret(httpTotp, totpKey),
    } });
    const origin = "https://sigae.example.invalid";
    const app = createApp({
      sessionReader: new PrismaSessionReader(runtime),
      csrfSecret,
      appOrigin: origin,
      loginService: new PrismaLoginService(runtime, totpKey, new Uint8Array(randomBytes(32))),
    });
    const passwordResponse = await request(app).post("/api/v1/auth/login")
      .set("Origin", origin).send({ email: httpEmail, password: httpPassword });
    if (passwordResponse.status !== 200 || typeof passwordResponse.body.challengeId !== "string") {
      throw new Error("RENDER_AUTH_HTTP_PASSWORD_STAGE_FAILED");
    }
    const verifyResponse = await request(app).post("/api/v1/auth/totp/verify")
      .set("Origin", origin)
      .send({ challengeId: passwordResponse.body.challengeId, code: totpCodeForTest(httpTotp, new Date()) });
    const cookieHeader = verifyResponse.headers["set-cookie"]?.[0];
    if (verifyResponse.status !== 200 || !cookieHeader || !/HttpOnly/u.test(cookieHeader) ||
        !/Secure/u.test(cookieHeader) || !/SameSite=Strict/u.test(cookieHeader)) {
      throw new Error("RENDER_AUTH_HTTP_MFA_STAGE_FAILED");
    }
    const meResponse = await request(app).get("/api/v1/auth/me").set("Cookie", cookieHeader.split(";", 1)[0]!);
    if (meResponse.status !== 200 || meResponse.body.user?.role !== "APPROVER") {
      throw new Error("RENDER_AUTH_HTTP_SESSION_STAGE_FAILED");
    }
    const audit = await admin.auditEvent.findMany({
      where: { actorId: firstId },
      select: { action: true, objectId: true, redactedDetails: true },
      orderBy: { seq: "asc" },
    });
    if (audit.length < 8 || audit.some((event) => {
      const evidence = JSON.stringify(event);
      return evidence.includes(syntheticPassword) || evidence.includes(challenge.challengeId) ||
        evidence.includes(verified.token) || evidence.includes(Buffer.from(totpSecret).toString("base64"));
    })) {
      throw new Error("RENDER_AUTH_AUDIT_EVIDENCE_INVALID");
    }
    process.stdout.write("PASS: disposable PostgreSQL lock persistence, expiry recovery, MFA reset, HTTP MFA/session, secure cookie, and redacted audit.\n");
  } finally {
    await Promise.all([runtime.$disconnect(), admin.$disconnect()]);
  }
}

void main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : "RENDER_AUTH_TEST_FAILED"}\n`);
  process.exitCode = 1;
});
