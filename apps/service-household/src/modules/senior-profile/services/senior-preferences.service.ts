import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import {
  SENIOR_PREFERENCES_MAX_PER_SENIOR,
  type BulkUpsertSeniorPreferencesRequest,
  type SeniorPreferenceEntry,
  type SeniorPreferencesResponse,
} from '@taste-and-see/contracts';

import { PrismaService } from '../../../prisma/prisma.service';

/**
 * Domain service for the senior memory profile (TS-033).
 *
 * Two surfaces:
 *
 *   - `list({ seniorId, requesterUserId })`
 *       Every preference entry for the senior, sorted ascending by
 *       key. Wrapped in `{ seniorId, preferences: [...] }`.
 *
 *   - `bulkUpsert({ seniorId, requesterUserId, input })`
 *       Merge-semantics bulk upsert. Each entry in `input.entries` is
 *       processed in a single transaction:
 *         - `value: string` → upsert `(seniorId, key)` to the value.
 *         - `value: null`   → delete `(seniorId, key)` if it exists.
 *       Keys NOT present in the entries array are untouched.
 *
 *       Rejects:
 *         - empty entries array (400 — the contract permits it for
 *           syntactic ergonomics; the service requires real intent).
 *         - duplicate keys within a single request (400 — ambiguous
 *           "which value wins?").
 *         - net-of-deletes count exceeding `SENIOR_PREFERENCES_MAX_PER_SENIOR`
 *           (422 — defends against an attacker batching 64 inserts
 *           on a senior already at capacity).
 *
 * Authorisation. Every method runs `loadAuthorisedSenior` first.
 * Mirrors the senior-intake / memory-recipes pattern.
 *
 * No PII in logs. We log `seniorId`, `requesterUserId`, the action
 * kind, and the count of upserts vs deletes — never the keys or
 * values themselves (the values can carry warmth-laden personal
 * context). The audit-svc (TS-100) is the right home for the full
 * before/after diff.
 */
@Injectable()
export class SeniorPreferencesService {
  private readonly logger = new Logger(SeniorPreferencesService.name);

  constructor(private readonly prisma: PrismaService) {}

  async list(args: {
    readonly seniorId: string;
    readonly requesterUserId: string;
  }): Promise<SeniorPreferencesResponse> {
    await this.loadAuthorisedSenior(args.seniorId, args.requesterUserId);
    const rows = await this.prisma.seniorPreference.findMany({
      where: { seniorId: args.seniorId },
      orderBy: [{ key: 'asc' }],
      select: PREFERENCE_SELECT,
    });
    return {
      seniorId: args.seniorId,
      preferences: rows.map(toEntry),
    };
  }

  async bulkUpsert(args: {
    readonly seniorId: string;
    readonly requesterUserId: string;
    readonly input: BulkUpsertSeniorPreferencesRequest;
  }): Promise<SeniorPreferencesResponse> {
    const { seniorId, requesterUserId, input } = args;
    await this.loadAuthorisedSenior(seniorId, requesterUserId);

    if (input.entries.length === 0) {
      throw new BadRequestException({
        type: 'about:blank',
        title: 'Bad Request',
        status: 400,
        detail: 'Bulk upsert request must include at least one entry.',
      });
    }

    // Reject duplicate keys within the same request — ambiguous which
    // value should win, and silently keeping "last" would invite
    // bugs that only surface under load.
    const seen = new Set<string>();
    for (const entry of input.entries) {
      if (seen.has(entry.key)) {
        throw new BadRequestException({
          type: 'about:blank',
          title: 'Bad Request',
          status: 400,
          detail: `Duplicate key '${entry.key}' in entries; each key may appear at most once per request.`,
        });
      }
      seen.add(entry.key);
    }

    // Cap-check the post-write count. Compute against the current set
    // and the entry-shape: an upsert of an existing key doesn't grow
    // the count; a new key grows by 1; a delete shrinks by 1 if the
    // key currently exists. The check is best-effort — a small race
    // window between count and write can land us at +1 over cap; the
    // Prisma create inside upsert would still succeed (no DB-level
    // cap). Captured as a TS-033 follow-up if drift is observed.
    const currentKeys: Array<{ readonly key: string }> =
      await this.prisma.seniorPreference.findMany({
        where: { seniorId },
        select: { key: true },
      });
    const currentKeySet = new Set(currentKeys.map((r) => r.key));
    let projectedCount = currentKeySet.size;
    for (const entry of input.entries) {
      const exists = currentKeySet.has(entry.key);
      if (entry.value === null) {
        if (exists) projectedCount -= 1;
      } else if (!exists) {
        projectedCount += 1;
      }
    }
    if (projectedCount > SENIOR_PREFERENCES_MAX_PER_SENIOR) {
      throw new UnprocessableEntityException({
        type: 'about:blank',
        title: 'Unprocessable Entity',
        status: 422,
        detail: `This request would exceed the per-senior preferences cap of ${SENIOR_PREFERENCES_MAX_PER_SENIOR}.`,
      });
    }

    // Apply the batch in a single transaction so a partial failure
    // doesn't leave the profile in a half-written state. Each entry
    // is one upsert or one delete.
    let upsertCount = 0;
    let deleteCount = 0;
    await this.prisma.$transaction(
      input.entries.map((entry) => {
        if (entry.value === null) {
          deleteCount += 1;
          return this.prisma.seniorPreference.deleteMany({
            where: { seniorId, key: entry.key },
          });
        }
        upsertCount += 1;
        return this.prisma.seniorPreference.upsert({
          where: { seniorId_key: { seniorId, key: entry.key } },
          create: { seniorId, key: entry.key, value: entry.value },
          update: { value: entry.value },
          select: { seniorId: true },
        });
      }),
    );

    this.logger.log(
      {
        seniorId,
        requesterUserId,
        action: 'bulk_upsert',
        upsertCount,
        deleteCount,
      },
      'senior preferences bulk-upserted',
    );

    return this.list({ seniorId, requesterUserId });
  }

  /**
   * Active-membership precondition. Mirror of `IntakeService.loadAuthorisedSenior` /
   * `MemoryRecipesService.loadAuthorisedSenior` — see those methods for
   * the rationale on (a) two queries instead of a JOIN, and (b) 403
   * (not 404) when the requester is not a member.
   */
  private async loadAuthorisedSenior(
    seniorId: string,
    requesterUserId: string,
  ): Promise<{ readonly id: string; readonly householdId: string }> {
    const senior = await this.prisma.senior.findFirst({
      where: { id: seniorId, deletedAt: null },
      select: { id: true, householdId: true },
    });
    if (senior === null) {
      throw new NotFoundException({
        type: 'about:blank',
        title: 'Not Found',
        status: 404,
        detail: 'Senior not found.',
      });
    }
    const membership = await this.prisma.householdMember.findFirst({
      where: {
        householdId: senior.householdId,
        userId: requesterUserId,
        removedAt: null,
      },
      select: { id: true },
    });
    if (membership === null) {
      throw new ForbiddenException({
        type: 'about:blank',
        title: 'Forbidden',
        status: 403,
        detail: 'You do not have access to this senior.',
      });
    }
    return senior;
  }
}

const PREFERENCE_SELECT = {
  key: true,
  value: true,
  createdAt: true,
  updatedAt: true,
} as const;

interface PreferenceRow {
  readonly key: string;
  readonly value: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

function toEntry(row: PreferenceRow): SeniorPreferenceEntry {
  return {
    key: row.key,
    value: row.value,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
