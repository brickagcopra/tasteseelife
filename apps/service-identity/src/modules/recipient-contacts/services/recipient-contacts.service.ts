import { Injectable, Logger } from '@nestjs/common';
import type { RecipientContact } from '@taste-and-see/contracts';

import { PrismaService } from '../../../prisma/prisma.service';

/**
 * Local mirror of the identity `UserStatus` Postgres enum
 * (`apps/service-identity/prisma/schema.prisma`). Same root cause as
 * the KYC / MFA local-enum mirrors (TS-021-followup-2/-3): the
 * `@prisma/client` namespace does not surface the generated enum
 * cleanly under our `moduleResolution: "Node"` tsconfig, so we declare
 * the equivalent string-literal union locally. The values here are
 * byte-for-byte the same as the contract `UserStatusSchema` enum, so
 * the projection to the DTO is the identity mapping — but we keep the
 * type distinct so a future divergence between the identity enum and
 * the published contract surfaces at the mapper rather than silently.
 */
export type UserRecordStatus = 'pending_verification' | 'active' | 'suspended' | 'deactivated';

/**
 * Narrow projection of the Prisma `User` row this service reads. Only
 * the three columns the recipient-contacts batch needs — never select
 * the password hash or any other column into this path.
 */
interface UserContactRow {
  readonly id: string;
  readonly email: string;
  readonly status: UserRecordStatus;
}

const USER_CONTACT_SELECT = {
  id: true,
  email: true,
  status: true,
} as const;

/**
 * `RecipientContactsService` (TS-235) — resolves a batch of user ids to
 * their login email + account status so the wellness-summary worker can
 * address notifications.
 *
 * One read surface:
 *
 *   - `resolveBatch(userIds)`
 *       Single `prisma.user.findMany({ where: { id: { in: userIds } } })`
 *       projecting only `{ id, email, status }`. A userId with no
 *       matching row is simply ABSENT from the result — we never
 *       synthesise a placeholder contact (the worker treats a missing
 *       id as "no deliverable address"). The input batch is already
 *       capped (1..500) at the Zod boundary, so the `IN (...)` list is
 *       bounded.
 *
 * **No PII in logs (CLAUDE.md §3.6 / §3.9).** We log the COUNT of ids
 * requested and the COUNT resolved — never an email, never the id
 * list. The emails are the payload of this surface; emitting them to
 * the log layer would defeat the redaction posture the platform
 * mandates.
 */
@Injectable()
export class RecipientContactsService {
  private readonly logger = new Logger(RecipientContactsService.name);

  constructor(private readonly prisma: PrismaService) {}

  async resolveBatch(userIds: readonly string[]): Promise<RecipientContact[]> {
    if (userIds.length === 0) {
      return [];
    }

    const rows = (await this.prisma.user.findMany({
      where: { id: { in: [...userIds] } },
      select: USER_CONTACT_SELECT,
    })) as UserContactRow[];

    this.logger.debug(
      {
        requestedCount: userIds.length,
        resolvedCount: rows.length,
      },
      'recipient-contacts.resolveBatch ok',
    );

    return rows.map(toContactDto);
  }
}

/**
 * Project the Prisma row to the contract DTO. The status mapping is the
 * identity mapping today (the identity enum + contract enum share the
 * same string values) but the explicit pass-through keeps the mapper as
 * the single place a future divergence would be caught.
 */
function toContactDto(row: UserContactRow): RecipientContact {
  return {
    userId: row.id,
    email: row.email,
    status: mapStatus(row.status),
  };
}

/**
 * Map the identity `UserStatus` enum value to the contract
 * `UserStatusSchema` value. Explicit per-arm switch so a Prisma-schema
 * enum addition surfaces as a TS non-exhaustiveness error here rather
 * than as a silent fall-through at runtime.
 */
function mapStatus(status: UserRecordStatus): RecipientContact['status'] {
  switch (status) {
    case 'pending_verification':
      return 'pending_verification';
    case 'active':
      return 'active';
    case 'suspended':
      return 'suspended';
    case 'deactivated':
      return 'deactivated';
  }
}
