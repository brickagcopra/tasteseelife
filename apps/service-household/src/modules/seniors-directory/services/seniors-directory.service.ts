import { Injectable, Logger } from '@nestjs/common';
import type { MySeniorSummary, MySeniorsResponse } from '@taste-and-see/contracts';

import { PrismaService } from '../../../prisma/prisma.service';

/**
 * "My seniors" directory service (TS-214).
 *
 * Resolves the seniors a signed-in family member can act on:
 *
 *   1. Active household memberships for the user
 *      (`household_members.user_id`, `removed_at IS NULL`).
 *   2. The active seniors in those households
 *      (`seniors.household_id IN (...)`, `deleted_at IS NULL`).
 *
 * This is the family-portal entry point into every per-senior surface
 * (preference editor, intake, memory recipes) — those endpoints take a
 * `seniorId` the caller is assumed to already hold, and there is no
 * other resolver from a user to their seniors.
 *
 * Authorisation. The membership query IS the row-level check: a user
 * only sees seniors in households they actively belong to. A user who
 * belongs to several households (e.g. a daughter paying for both parents
 * under separate household records) correctly sees all of them — the
 * tenant-scope gate (enforce mode) requires a scoped frame to be present
 * but does not auto-restrict to a single household id (see the
 * `proceed_scoped` contract in `@taste-and-see/nest-prisma-tenant-scope`).
 *
 * No PII in logs. We log the requester id + the household / senior
 * counts, never names or any per-senior field.
 */
@Injectable()
export class SeniorsDirectoryService {
  private readonly logger = new Logger(SeniorsDirectoryService.name);

  constructor(private readonly prisma: PrismaService) {}

  async listForUser(args: { readonly requesterUserId: string }): Promise<MySeniorsResponse> {
    const memberships: ReadonlyArray<{ readonly householdId: string }> =
      await this.prisma.householdMember.findMany({
        where: { userId: args.requesterUserId, removedAt: null },
        select: { householdId: true },
      });

    const householdIds = Array.from(new Set(memberships.map((m) => m.householdId)));
    if (householdIds.length === 0) {
      this.logger.log(
        { requesterUserId: args.requesterUserId, householdCount: 0, seniorCount: 0 },
        'listed seniors for user (no active memberships)',
      );
      return { seniors: [] };
    }

    const rows: ReadonlyArray<SeniorRow> = await this.prisma.senior.findMany({
      where: { householdId: { in: householdIds }, deletedAt: null },
      orderBy: [{ firstName: 'asc' }, { lastName: 'asc' }, { id: 'asc' }],
      select: SENIOR_SELECT,
    });

    this.logger.log(
      {
        requesterUserId: args.requesterUserId,
        householdCount: householdIds.length,
        seniorCount: rows.length,
      },
      'listed seniors for user',
    );

    return { seniors: rows.map(toSummary) };
  }
}

const SENIOR_SELECT = {
  id: true,
  householdId: true,
  firstName: true,
  lastName: true,
  displayName: true,
  status: true,
} as const;

interface SeniorRow {
  readonly id: string;
  readonly householdId: string;
  readonly firstName: string;
  readonly lastName: string;
  readonly displayName: string | null;
  readonly status: MySeniorSummary['status'];
}

function toSummary(row: SeniorRow): MySeniorSummary {
  return {
    seniorId: row.id,
    householdId: row.householdId,
    firstName: row.firstName,
    lastName: row.lastName,
    displayName: row.displayName,
    status: row.status,
  };
}
