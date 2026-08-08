import { Injectable, Logger } from '@nestjs/common';
import type {
  InternalWellnessSummaryHouseholdsResponse,
  MySeniorStatus,
  WellnessSummaryHousehold,
  WellnessSummaryRecipient,
  WellnessSummaryRecipientRole,
  WellnessSummarySenior,
} from '@taste-and-see/contracts';

import { PrismaService } from '../../../prisma/prisma.service';

/**
 * Households-batch service for the monthly wellness-summary worker
 * (TS-235; PRD §6.4, §6.9; PDD §12.2).
 *
 * One read surface:
 *
 *   - `listHouseholds({ cursor?, limit })`
 *       Keyset-paginate ACTIVE households by `id` ascending, hydrating
 *       each page with its active seniors (+ the senior's `notes` consent
 *       flag) and its active recipient members, then project into the
 *       `InternalWellnessSummaryHouseholdsResponse` shape the worker
 *       walks page-by-page across the whole population.
 *
 * **Keyset pagination.** We fetch `limit + 1` households with a strict
 * `id > cursor` predicate ordered ascending. The `+1` peek tells us
 * whether a further page exists; we drop it from the returned page. When
 * a further page exists, `nextCursor` anchors on the id of the LAST row
 * of the RETURNED page (NOT the peek row) — the next query's strict `>`
 * resumes exactly after it, so anchoring on the peek would skip that row.
 * When no further page exists, `nextCursor` is null.
 *
 * **No N+1.** For the page's household ids we issue exactly three batch
 * reads (`Senior.findMany`, `SeniorConsent.findMany`, `HouseholdMember
 * .findMany`) with `in` predicates, then group in memory — never a
 * per-household round-trip.
 *
 * **Consent default = opt-out (CLAUDE.md §12).** A senior with no
 * `SeniorConsent` row shares nothing — `notesConsent` defaults to false.
 * An absent row and an explicit `notes: false` row are observationally
 * identical here.
 *
 * **min-1 filter.** The contract requires each household to carry at
 * least one senior AND at least one recipient. A household that ends up
 * with zero active seniors OR zero active recipients is skipped — the
 * worker has nothing to summarise / nobody to notify, so it never
 * iterates an empty unit. The skip happens AFTER the keyset window is
 * chosen, so it can shrink a page below `limit`; pagination correctness
 * is unaffected because the cursor still anchors on the raw household id.
 *
 * **No PII in logs.** We log counts only (households returned, seniors,
 * recipients) — never names, emails, or any per-senior field.
 */
@Injectable()
export class WellnessSummaryService {
  private readonly logger = new Logger(WellnessSummaryService.name);

  constructor(private readonly prisma: PrismaService) {}

  async listHouseholds(args: {
    readonly cursor?: string | undefined;
    readonly limit: number;
  }): Promise<InternalWellnessSummaryHouseholdsResponse> {
    // Keyset window: active households, id ASC, strict `> cursor`, with a
    // +1 peek to detect a further page without a second count query.
    const pageWithPeek: ReadonlyArray<HouseholdRow> = await this.prisma.household.findMany({
      where: {
        status: 'active',
        ...(args.cursor === undefined ? {} : { id: { gt: args.cursor } }),
      },
      orderBy: { id: 'asc' },
      take: args.limit + 1,
      select: HOUSEHOLD_SELECT,
    });

    const hasMore = pageWithPeek.length > args.limit;
    const pageRows = hasMore ? pageWithPeek.slice(0, args.limit) : pageWithPeek;
    // Anchor on the LAST row of the RETURNED page (not the peek row) — the
    // next query resumes with strict `> nextCursor`, so anchoring on the
    // peek would skip it. Null when the page is empty or there is no more.
    const nextCursor =
      hasMore && pageRows.length > 0 ? (pageRows[pageRows.length - 1]?.id ?? null) : null;

    const householdIds = pageRows.map((h) => h.id);

    if (householdIds.length === 0) {
      this.logger.log(
        { householdCount: 0, seniorCount: 0, recipientCount: 0, hasMore },
        'wellness-summary households batch built (empty page)',
      );
      return { households: [], nextCursor };
    }

    // Three batch reads + in-memory grouping — never per-household.
    const [seniorRowsRaw, consentRowsRaw, memberRowsRaw] = await Promise.all([
      this.prisma.senior.findMany({
        where: { householdId: { in: householdIds }, deletedAt: null, status: 'active' },
        select: SENIOR_SELECT,
      }),
      this.prisma.seniorConsent.findMany({
        // Consent is keyed by seniorId; we fetch every senior's consent in
        // one go and resolve `notesConsent` from the senior → consent map.
        where: { senior: { householdId: { in: householdIds }, deletedAt: null, status: 'active' } },
        select: CONSENT_SELECT,
      }),
      this.prisma.householdMember.findMany({
        where: { householdId: { in: householdIds }, removedAt: null },
        select: MEMBER_SELECT,
      }),
    ]);
    const seniorRows = seniorRowsRaw as ReadonlyArray<SeniorRow>;
    const consentRows = consentRowsRaw as ReadonlyArray<ConsentRow>;
    const memberRows = memberRowsRaw as ReadonlyArray<MemberRow>;

    const notesConsentBySeniorId = new Map<string, boolean>();
    for (const consent of consentRows) {
      notesConsentBySeniorId.set(consent.seniorId, consent.notes);
    }

    const seniorsByHousehold = new Map<string, WellnessSummarySenior[]>();
    for (const senior of seniorRows) {
      const dto: WellnessSummarySenior = {
        seniorId: senior.id,
        firstName: senior.firstName,
        status: senior.status as MySeniorStatus,
        // Absent consent row => opt-out default (false).
        notesConsent: notesConsentBySeniorId.get(senior.id) ?? false,
      };
      const bucket = seniorsByHousehold.get(senior.householdId);
      if (bucket === undefined) {
        seniorsByHousehold.set(senior.householdId, [dto]);
      } else {
        bucket.push(dto);
      }
    }

    const recipientsByHousehold = new Map<string, WellnessSummaryRecipient[]>();
    for (const member of memberRows) {
      const dto: WellnessSummaryRecipient = {
        userId: member.userId,
        role: member.memberRole as WellnessSummaryRecipientRole,
      };
      const bucket = recipientsByHousehold.get(member.householdId);
      if (bucket === undefined) {
        recipientsByHousehold.set(member.householdId, [dto]);
      } else {
        bucket.push(dto);
      }
    }

    const households: WellnessSummaryHousehold[] = [];
    for (const householdId of householdIds) {
      const seniors = seniorsByHousehold.get(householdId) ?? [];
      const recipients = recipientsByHousehold.get(householdId) ?? [];
      // Contract floor: skip a household with nobody to notify or no
      // senior to summarise (min 1 each).
      if (seniors.length === 0 || recipients.length === 0) {
        continue;
      }
      households.push({ householdId, seniors, recipients });
    }

    const seniorCount = households.reduce((sum, h) => sum + h.seniors.length, 0);
    const recipientCount = households.reduce((sum, h) => sum + h.recipients.length, 0);
    this.logger.log(
      { householdCount: households.length, seniorCount, recipientCount, hasMore },
      'wellness-summary households batch built',
    );

    return { households, nextCursor };
  }
}

const HOUSEHOLD_SELECT = { id: true } as const;

interface HouseholdRow {
  readonly id: string;
}

const SENIOR_SELECT = {
  id: true,
  householdId: true,
  firstName: true,
  status: true,
} as const;

interface SeniorRow {
  readonly id: string;
  readonly householdId: string;
  readonly firstName: string;
  readonly status: string;
}

const CONSENT_SELECT = {
  seniorId: true,
  notes: true,
} as const;

interface ConsentRow {
  readonly seniorId: string;
  readonly notes: boolean;
}

const MEMBER_SELECT = {
  householdId: true,
  userId: true,
  memberRole: true,
} as const;

interface MemberRow {
  readonly householdId: string;
  readonly userId: string;
  readonly memberRole: string;
}
