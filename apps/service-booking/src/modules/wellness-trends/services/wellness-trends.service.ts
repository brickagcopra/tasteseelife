import { Injectable, Logger } from '@nestjs/common';
import {
  WELLNESS_TREND_MAX_VISITS,
  WELLNESS_TREND_METRICS,
  wellnessScoreForLevel,
  type WellnessTrendMetric,
  type WellnessTrendPoint,
  type WellnessTrendSeries,
  type WellnessTrendWindowDays,
} from '@taste-and-see/contracts';

import { PrismaService } from '../../../prisma/prisma.service';

const MILLIS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Minimal completed-booking row for the trend window. We `select` only
 * the id (to join visit notes) + the `scheduledStart` (the x-axis).
 */
interface TrendBookingRow {
  readonly id: string;
  readonly scheduledStart: Date;
}

/**
 * Minimal visit-note row — the four coarse-grained ordinal scales + the
 * write timestamp. The provider `recordedByUserId`, the freeform prose,
 * and the raw `photoKeys` are deliberately NOT projected (CLAUDE.md §12
 * family-observability boundary; the trend view plots only the scales).
 */
interface TrendVisitNoteRow {
  readonly bookingId: string;
  readonly mood: string | null;
  readonly appetite: string | null;
  readonly hydration: string | null;
  readonly socialEngagement: string | null;
  readonly recordedAt: Date;
}

/** Maps a trend metric to its `booking_visit_notes` column. */
const COLUMN_BY_METRIC: Record<WellnessTrendMetric, keyof TrendVisitNoteRow> = {
  mood: 'mood',
  appetite: 'appetite',
  hydration: 'hydration',
  social_engagement: 'socialEngagement',
};

export interface LoadWellnessTrendsArgs {
  /** Resolved from the token `tenantScope` — never client-supplied. */
  readonly householdId: string;
  /** The senior whose trends are requested (path param). */
  readonly seniorId: string;
  readonly windowDays: WellnessTrendWindowDays;
}

export interface WellnessTrendsResult {
  readonly seniorId: string;
  readonly windowDays: WellnessTrendWindowDays;
  readonly totalCompletedVisits: number;
  readonly series: readonly WellnessTrendSeries[];
  readonly generatedAt: Date;
}

/**
 * `WellnessTrendsService` (TS-231; PRD §6.4, §6.9; PDD §23.1).
 *
 * Read-side aggregate for one senior's recent wellness observations.
 * For each completed visit in the look-back window (30 / 90 days),
 * projects the four coarse-grained ordinal scales (mood / appetite /
 * hydration / social_engagement) into one trend series per scale —
 * per-visit points in chronological order, each carrying the ordinal
 * `level` + its 1..5 `score` (via the shared `wellnessScoreForLevel`).
 *
 * **Per-visit, not bucketed.** Each visit that recorded a scale yields
 * one point; we never average. A scale a provider left blank on a given
 * visit is simply absent from that scale's series (the other scales on
 * the same visit are unaffected).
 *
 * **Scope.** The `where` always pins `householdId` (token-derived) AND
 * `seniorId` (the path param), so a senior outside the actor's
 * household yields empty series rather than a cross-household leak. The
 * consent gate (`notes` surface) lives at the gateway BFF (TS-238 /
 * TS-232 pattern); this read trusts the gateway applied it but is safe
 * even reached directly — it can only ever return the actor's own
 * household's data.
 *
 * **Bounded scan.** `count` reports the true completed-visit total in
 * the window (the denominator); the points are drawn from the most
 * recent `WELLNESS_TREND_MAX_VISITS` so a pathological cadence can't
 * blow the payload.
 *
 * **Tenant scoping.** The controller runs behind `AccessTokenGuard`, so
 * the TS-141 `TenantContextInterceptor` seeds a scoped frame before any
 * Prisma op (`enforce` mode is satisfied).
 */
@Injectable()
export class WellnessTrendsService {
  private readonly logger = new Logger(WellnessTrendsService.name);

  constructor(private readonly prisma: PrismaService) {}

  async loadTrends(args: LoadWellnessTrendsArgs): Promise<WellnessTrendsResult> {
    const now = new Date();
    const windowStart = new Date(now.getTime() - args.windowDays * MILLIS_PER_DAY);

    // Shared filter — completed visits for this household + senior whose
    // scheduled start falls inside the look-back window. `count` and
    // `findMany` share it so the denominator can't drift from the scan.
    const where = {
      householdId: args.householdId,
      seniorId: args.seniorId,
      status: 'completed' as const,
      scheduledStart: { gte: windowStart },
    };

    const totalCompletedVisits = await this.prisma.booking.count({ where });

    // Most-recent-first, capped, then reversed to chronological order so
    // the series points read oldest → newest for the sparkline.
    const recentFirst = (await this.prisma.booking.findMany({
      where,
      select: { id: true, scheduledStart: true },
      orderBy: [{ scheduledStart: 'desc' }, { id: 'desc' }],
      take: WELLNESS_TREND_MAX_VISITS,
    })) as TrendBookingRow[];
    const bookings = [...recentFirst].reverse();

    const notesByBookingId = await this.loadVisitNotes(bookings.map((row) => row.id));
    const series = WELLNESS_TREND_METRICS.map((metric) =>
      this.buildSeries(metric, bookings, notesByBookingId),
    );

    this.logger.log(
      `wellness-trends.load householdId=${args.householdId} seniorId=${args.seniorId} windowDays=${args.windowDays} totalCompletedVisits=${totalCompletedVisits} scanned=${bookings.length}`,
    );

    return {
      seniorId: args.seniorId,
      windowDays: args.windowDays,
      totalCompletedVisits,
      series,
      generatedAt: now,
    };
  }

  /**
   * Build one scale's series — walk the chronologically-ordered
   * bookings, emit a point for each visit that recorded a non-null
   * level for this metric, and surface the most-recent score as the
   * headline reading.
   */
  private buildSeries(
    metric: WellnessTrendMetric,
    bookings: readonly TrendBookingRow[],
    notesByBookingId: ReadonlyMap<string, TrendVisitNoteRow>,
  ): WellnessTrendSeries {
    const column = COLUMN_BY_METRIC[metric];
    const points: WellnessTrendPoint[] = [];

    for (const booking of bookings) {
      const note = notesByBookingId.get(booking.id);
      if (note === undefined) continue;
      const level = note[column];
      if (typeof level !== 'string') continue;
      const score = wellnessScoreForLevel(metric, level);
      if (score === null) continue; // defensive — an unknown enum value never plots
      points.push({
        bookingId: booking.id,
        visitDate: booking.scheduledStart.toISOString(),
        recordedAt: note.recordedAt.toISOString(),
        level,
        score,
      });
    }

    const latest = points.at(-1);
    return {
      metric,
      points,
      latestScore: latest === undefined ? null : latest.score,
      visitsRecorded: points.length,
    };
  }

  /**
   * Batched visit-note read — one `findMany` keyed by the window's
   * booking ids, returned as a `bookingId → row` map so series-building
   * is a pure lookup (no per-visit query, no N+1).
   */
  private async loadVisitNotes(
    bookingIds: readonly string[],
  ): Promise<Map<string, TrendVisitNoteRow>> {
    if (bookingIds.length === 0) return new Map();
    const rows = (await this.prisma.bookingVisitNote.findMany({
      where: { bookingId: { in: [...bookingIds] } },
      select: {
        bookingId: true,
        mood: true,
        appetite: true,
        hydration: true,
        socialEngagement: true,
        recordedAt: true,
      },
    })) as TrendVisitNoteRow[];

    const map = new Map<string, TrendVisitNoteRow>();
    for (const row of rows) {
      map.set(row.bookingId, row);
    }
    return map;
  }
}
