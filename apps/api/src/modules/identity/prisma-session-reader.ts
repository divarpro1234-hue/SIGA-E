import type { PrismaClient } from "../../generated/prisma/client.js";
import type { SessionReader, StoredSession } from "./session-reader.js";

export class PrismaSessionReader implements SessionReader {
  constructor(private readonly prisma: PrismaClient) {}

  async findByTokenHash(tokenHash: Uint8Array): Promise<StoredSession | null> {
    const session = await this.prisma.session.findUnique({
      where: { tokenHash: new Uint8Array(tokenHash) },
      select: {
        expiresAt: true,
        revokedAt: true,
        lastSeenAt: true,
        user: { select: { id: true, name: true, email: true, role: true, status: true } },
      },
    });
    if (!session) return null;
    return {
      expiresAt: session.expiresAt,
      revokedAt: session.revokedAt,
      lastSeenAt: session.lastSeenAt,
      user: {
        id: session.user.id,
        name: session.user.name,
        email: session.user.email,
        role: session.user.role,
        status: session.user.status,
      },
    };
  }

  async touchIfActive(tokenHash: Uint8Array, now: Date, idleCutoff: Date): Promise<boolean> {
    const updated = await this.prisma.session.updateMany({
      where: {
        tokenHash: new Uint8Array(tokenHash),
        revokedAt: null,
        expiresAt: { gt: now },
        lastSeenAt: { gt: idleCutoff, lte: now },
        user: { status: "ACTIVE" },
      },
      data: { lastSeenAt: now },
    });
    return updated.count === 1;
  }
}
