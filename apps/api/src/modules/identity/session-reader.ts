export type InternalRole = "AUTHOR" | "APPROVER" | "ADMIN";
export type InternalStatus = "PENDING_ENROLLMENT" | "ACTIVE" | "DISABLED";

export interface InternalUser {
  readonly id: string;
  readonly name: string;
  readonly email: string;
  readonly role: InternalRole;
  readonly status: InternalStatus;
}

export interface StoredSession {
  readonly user: InternalUser;
  readonly expiresAt: Date;
  readonly revokedAt: Date | null;
  readonly lastSeenAt: Date;
}

export interface SessionReader {
  findByTokenHash(tokenHash: Uint8Array): Promise<StoredSession | null>;
  touchIfActive(tokenHash: Uint8Array, now: Date, idleCutoff: Date): Promise<boolean>;
}
