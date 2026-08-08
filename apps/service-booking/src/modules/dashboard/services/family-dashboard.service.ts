import { Injectable, Logger } from '@nestjs/common';
import {
  DASHBOARD_UPCOMING_MAX,
  type DashboardPastVisit,
  type DashboardWindowDays,
} from '@taste-and-see/contracts';

import { PrismaService } from '../../../prisma/prisma.service';
import { toBookingResponse } from '../../bookings/mappers/booking.mapper';
import type { BookingRecord } from '../../bookings/services/bookings.service';
import {
  toDashboardVisitNoteSummary,
  type DashboardVisitNoteRow,
} from '../mappers/dashboard-visit-note.mapper';

const MILLIS_PER_DAY = 24 * 60 * 60 * 1000;

/** Statuses that count as "upcoming" — not yet ended, not terminal. */
const UPCOMING_STATUSES = ['pending', 'confirmed', 'in_progress'] as const;

export interface LoadFamilyDashboardArgs {
  /** Resolved from the token `tenantScope` — never client-supplied. */
  readonly householdId: string;
  /** Optional per-senior tab filter; undefined = combined "All" view. */
  readonly seniorId: string | undefined;
  readonly windowDays: DashboardWindowDays;
  readonly historyCursor: string | undefined;
  readonly historyLimit: number;
}

export interface FamilyDashboardResult {
  readonly householdId: string;
  readonly seniorId: string | null;
  readonly windowDays: DashboardWindowDays;
  readonly upcoming: readonly BookingRecord[];
  readonly history: readonly DashboardPastVisit[];
  readonly historyNextCursor: string | null;
}

/**
 * `FamilyDashboardService` (TS-230; PRD §6.4, §6.9; PDD §10).
 *
 * Read-side aggregate for the family peace-of-mind dashboard. Produces
 * two lists for one household (optionally narrowed to one senior):
 *
 *   - **upcoming** — bookings that have not yet ended (status `pending`
 *     | `confirmed` | `in_progress`, `scheduledEnd >= now`) and start
 *     within the requested window (`scheduledStart <= now + windowDays`),
 *     soonest-first, hard-capped at `DASHBOARD_UPCOMING_MAX`. Using
 *     `scheduledEnd >= now` (rather than `scheduledStart >= now`) keeps
 *     an in-progress visit on the upcoming list while it's happening.
 *
 *   - **history** — completed visits, newest-first, cursor-paginated.
 *     Each carries its visit-note summary, fetched in a SINGLE batched
 *     `findMany` keyed by the page's booking ids (no N+1). Completed-
 *     only by design (TS-230): a cancelled / declined booking is not a
 *     visit, and missed-visit awareness is owned by TS-234.
 *
 * **Cursor shape.** `base64url(scheduledStartIso|id)`, stable under
 * writes via the strict `(scheduledStart < cursor.scheduledStart) OR
 * (scheduledStart = cursor.scheduledStart AND id < cursor.id)` tie-break.
 * Mirrors the `BookingsListService` cursor (which keys on `createdAt`)
 * — the history list keys on `scheduledStart` because the family reads
 * "most-recent visit first" by the time the visit happened, not the
 * time the booking was created.
 *
 * **Tenant scoping.** The controller runs behind `AccessTokenGuard`, so
 * the TS-141 `TenantContextInterceptor` seeds a scoped frame before any
 * Prisma op (`enforce` mode is satisfied). The `householdId` here is
 * resolved from the verified token `tenantScope`, so the explicit
 * `where.householdId` is a token-derived row-level filter, never a
 * client-supplied one (contrast the Phase-1 `GET /api/v1/bookings`
 * which still trusts a query-param householdId).
 */
@Injectable()
export class FamilyDashboardService {
  private readonly logger = new Logger(FamilyDashboardService.name);

  constructor(private readonly prisma: PrismaService) {}

  async loadDashboard(args: LoadFamilyDashboardArgs): Promise<FamilyDashboardResult> {
    const now = new Date();
    const windowEnd = new Date(now.getTime() + args.windowDays * MILLIS_PER_DAY);
    const seniorFilter = args.seniorId === undefined ? {} : { seniorId: args.seniorId };

    const upcoming = (await this.prisma.booking.findMany({
      where: {
        householdId: args.householdId,
        ...seniorFilter,
        status: { in: [...UPCOMING_STATUSES] },
        scheduledEnd: { gte: now },
        scheduledStart: { lte: windowEnd },
      },
      orderBy: [{ scheduledStart: 'asc' }, { id: 'asc' }],
      take: DASHBOARD_UPCOMING_MAX,
    })) as BookingRecord[];

    const cursor = args.historyCursor === undefined ? null : decodeCursor(args.historyCursor);
    const historyRows = (await this.prisma.booking.findMany({
      where: {
        householdId: args.householdId,
        ...seniorFilter,
        status: 'completed',
        ...(cursor !== null && {
          OR: [
            { scheduledStart: { lt: cursor.scheduledStart } },
            {
              AND: [{ scheduledStart: cursor.scheduledStart }, { id: { lt: cursor.id } }],
            },
          ],
        }),
      },
      orderBy: [{ scheduledStart: 'desc' }, { id: 'desc' }],
      take: args.historyLimit + 1,
    })) as BookingRecord[];

    const sliced = historyRows.slice(0, args.historyLimit);
    const overflow = historyRows.length > args.historyLimit ? historyRows[args.historyLimit] : null;
    const historyNextCursor =
      overflow === null || overflow === undefined
        ? null
        : encodeCursor({ scheduledStart: overflow.scheduledStart, id: overflow.id });

    const notesByBookingId = await this.loadVisitNotes(sliced.map((row) => row.id));
    const history: DashboardPastVisit[] = sliced.map((row) => {
      const note = notesByBookingId.get(row.id);
      return {
        booking: toBookingResponse(row),
        visitNotes: note === undefined ? null : toDashboardVisitNoteSummary(note),
      };
    });

    this.logger.log(
      `family-dashboard.load householdId=${args.householdId} seniorId=${args.seniorId ?? 'all'} windowDays=${args.windowDays} upcoming=${upcoming.length} history=${history.length} hasMore=${historyNextCursor !== null}`,
    );

    return {
      householdId: args.householdId,
      seniorId: args.seniorId ?? null,
      windowDays: args.windowDays,
      upcoming,
      history,
      historyNextCursor,
    };
  }

  /**
   * Batched visit-note read — one `findMany` keyed by the page's
   * booking ids, returned as a `bookingId → row` map so the history
   * mapper is a pure lookup (no per-row query, no N+1).
   */
  private async loadVisitNotes(
    bookingIds: readonly string[],
  ): Promise<Map<string, DashboardVisitNoteRow>> {
    if (bookingIds.length === 0) return new Map();
    const rows = (await this.prisma.bookingVisitNote.findMany({
      where: { bookingId: { in: [...bookingIds] } },
      select: {
        bookingId: true,
        mood: true,
        appetite: true,
        hydration: true,
        socialEngagement: true,
        freeform: true,
        photoKeys: true,
        recordedAt: true,
      },
    })) as (DashboardVisitNoteRow & { bookingId: string })[];

    const map = new Map<string, DashboardVisitNoteRow>();
    for (const row of rows) {
      map.set(row.bookingId, row);
    }
    return map;
  }
}

interface DecodedCursor {
  readonly scheduledStart: Date;
  readonly id: string;
}

function encodeCursor(c: DecodedCursor): string {
  return Buffer.from(`${c.scheduledStart.toISOString()}|${c.id}`).toString('base64url');
}

function decodeCursor(raw: string): DecodedCursor | null {
  try {
    const decoded = Buffer.from(raw, 'base64url').toString('utf8');
    const [iso, id] = decoded.split('|', 2);
    if (iso === undefined || id === undefined) return null;
    const scheduledStart = new Date(iso);
    if (Number.isNaN(scheduledStart.getTime())) return null;
    return { scheduledStart, id };
  } catch {
    return null;
  }
}
