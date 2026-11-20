import type { PrismaClient } from "../../generated/prisma/client.js";
import { withAuditedWrite } from "../audit/append-audit-event.js";
import type { InternalRole, InternalUser } from "./session-reader.js";

export interface PendingUserInput {
  readonly name: string;
  readonly email: string;
  readonly role: InternalRole;
}

export interface PendingUserService {
  create(actorId: string, input: PendingUserInput): Promise<InternalUser>;
}

export class PrismaPendingUserService implements PendingUserService {
  constructor(private readonly prisma: PrismaClient) {}

  async create(actorId: string, input: PendingUserInput): Promise<InternalUser> {
    return withAuditedWrite(this.prisma, async (tx) => {
      const user = await tx.user.create({ data: {
        name: input.name, email: input.email, role: input.role, status: "PENDING_ENROLLMENT",
      }, select: { id: true, name: true, email: true, role: true, status: true } });
      return {
        value: user,
        audit: {
          actorId, action: "USER_CREATED_PENDING", objectType: "user", objectId: user.id,
          redactedDetails: { role: input.role, status: "PENDING_ENROLLMENT" },
        },
      };
    });
  }
}
