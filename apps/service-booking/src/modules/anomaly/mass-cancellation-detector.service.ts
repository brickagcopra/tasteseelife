import { Injectable, Logger } from '@nestjs/common';
import { BOOKING_ANOMALY_MASS_CANCELLATION } from '@taste-and-see/contracts';
import { OutboxService } from '@taste-and-see/nest-outbox';

import { PrismaService, type PrismaTransactionClient } from '../../prisma/prisma.service';

import {
  findMassCancellations,
  massCancellationEventId,
  utcDateBucket,
  type CanceledBookingRow,
  type MassCancellationFinding,
  type MassCancellationThresholds,
} from './mass-cancellation-policy';

export interface MassCancellationSweepResult {
  /** Cancelled bookings examined in the window. */
  readonly scanned: number;
  /** Subjects (provider + household) the rows grouped into. */
  readonly subjects: number;
  /** Subjects over their threshold. */
  readonly findings: number;
  /**
   * Events actually appended. Lower than `findings` on every tick after
   * the first that re-observes the same breach — see the dedup note.
   */
  readonly emitted: number;
}

/**
 * Mass-cancellation detection sweep (TS-308c; PRD §10.13, PDD §17.3;
 * CLAUDE.md §12).
 *
 * Scans bookings cancelled inside a rolling window, groups them by the
 * two subjects the row names, and appends a
 * `booking.anomaly.mass_cancellation` event for every subject over its
 * threshold. service-trust-safety consumes it into an incident.
 *
 * **The second detector on service-booking's one sweep**, sharing
 * TS-308a's `AnomalySweepRunner`, queue and kill switch rather than
 * standing up a second timer. The two are independent: one throwing
 * must not stop the other from running (see `AnomalySweepRunner`).
 *
 * **The threshold is the whole judgement, and it is unconfirmed.** See
 * the constants in `mass-cancellation-policy.ts` for the reasoning.
 * Shipping a documented, configurable, honestly-labelled number beats
 * blocking the detector on a product decision nobody can make without
 * data the platform does not have yet — the posture TS-300 took with its
 * SLA budgets.
 *
 * **Dedup is a deterministic event id keyed to a UTC day, not a table.**
 * A sliding window has no natural identity: the same breach is visible
 * on every tick for the next twenty-four hours, so a naive detector
 * would open ninety-six incidents. `mass-cancellation:{kind}:{id}:{day}`
 * against the outbox's `ON CONFLICT (event_id) DO NOTHING` collapses
 * those into one, and behaviour that continues past midnight opens a
 * fresh incident — correctly, because it has not stopped.
 *
 * **No free text and no cancellation reasons cross the wire.** The
 * categorical reason would be useful triage colour and is deliberately
 * left off: a per-row reason breakdown says something about a named
 * senior's circumstances, and the reviewer already has permission-gated
 * access to the bookings themselves.
 *
 * **The producer states a fact; the consumer grades it.** This emits
 * "six distinct cancellations against provider P in 24h, threshold 5".
 * Whether that is `low` or `medium` is trust & safety's call — the same
 * split as TS-308a and TS-307a.
 */
@Injectable()
export class MassCancellationDetectorService {
  private readonly logger = new Logger(MassCancellationDetectorService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly outbox: OutboxService,
  ) {}

  /**
   * Run one evaluation over the window.
   *
   * Each finding is appended in **its own transaction**. A single
   * malformed finding must not roll back the rest — this is a detector,
   * and losing every other real finding because one failed validation
   * would be its worst failure mode.
   */
  async sweep(args: {
    readonly now: Date;
    readonly windowHours: number;
    readonly thresholds: MassCancellationThresholds;
  }): Promise<MassCancellationSweepResult> {
    const windowStart = new Date(args.now.getTime() - args.windowHours * 60 * 60 * 1000);
    const rows = await this.scanCanceledBookings(windowStart);

    const findings = findMassCancellations(rows, args.thresholds);
    const windowBucket = utcDateBucket(args.now);

    let emitted = 0;
    for (const finding of findings) {
      if (await this.emit(finding, windowStart, args.now, windowBucket)) emitted += 1;
    }

    const subjects =
      new Set(rows.map((row) => row.providerId)).size +
      new Set(rows.map((row) => row.householdId)).size;

    this.logger.log(
      {
        scanned: rows.length,
        subjects,
        findings: findings.length,
        emitted,
        windowHours: args.windowHours,
        providerThreshold: args.thresholds.provider,
        householdThreshold: args.thresholds.household,
      },
      'mass-cancellation sweep complete',
    );

    return { scanned: rows.length, subjects, findings: findings.length, emitted };
  }

  /**
   * Cancelled bookings in the window.
   *
   * Raw SQL to project exactly the five columns the predicate needs and
   * nothing else — `bookings` carries `booking_notes` and
   * `cancellation_reason_text`, both free-text fields written by
   * families, and a `select`-less read would pull them into memory on a
   * timer for no reason (CLAUDE.md §4.1, §3.9).
   *
   * `canceled_at IS NOT NULL` is stated as well as the range predicate:
   * the range alone implies it, but stating it matches
   * `bookings_canceled_at_idx`'s partial predicate literally, which is
   * what keeps this off a sequential scan. See the migration's EXPLAIN.
   */
  private async scanCanceledBookings(windowStart: Date): Promise<readonly CanceledBookingRow[]> {
    return (await this.prisma.$queryRaw`
      SELECT
        b.id                  AS "bookingId",
        b.provider_id         AS "providerId",
        b.household_id        AS "householdId",
        b.series_id           AS "seriesId",
        b.canceled_by_user_id AS "canceledByUserId",
        b.canceled_by_actor_kind AS "canceledByActorKind"
      FROM "booking"."bookings" b
      WHERE b.canceled_at IS NOT NULL
        AND b.canceled_at >= ${windowStart}
      ORDER BY b.canceled_at ASC, b.id ASC
    `) as CanceledBookingRow[];
  }

  /**
   * Append one finding. Returns whether a NEW event was written.
   *
   * A validation failure is logged at error and swallowed: the sweep
   * continues, and a detector that dies on one bad finding stops
   * detecting everything else.
   */
  private async emit(
    finding: MassCancellationFinding,
    windowStart: Date,
    windowEnd: Date,
    windowBucket: string,
  ): Promise<boolean> {
    const eventId = massCancellationEventId(finding.subjectKind, finding.subjectId, windowBucket);

    try {
      return await this.prisma.$transaction(async (tx: PrismaTransactionClient) => {
        const result = await this.outbox.append(tx, {
          eventName: BOOKING_ANOMALY_MASS_CANCELLATION,
          eventId,
          payload: {
            eventId,
            // A window breach has no single moment, so the envelope's
            // producer clock IS the window end — the instant the
            // detector could first assert it. Equal to `windowEnd` by
            // construction, and carried separately because every
            // consumer reads `occurredAt` off the envelope without
            // knowing this event's shape.
            occurredAt: windowEnd.toISOString(),
            subjectKind: finding.subjectKind,
            subjectId: finding.subjectId,
            windowStart: windowStart.toISOString(),
            windowEnd: windowEnd.toISOString(),
            windowBucket,
            canceledBookingCount: finding.canceledBookingCount,
            distinctCancellationCount: finding.distinctCancellationCount,
            threshold: finding.threshold,
            distinctActorCount: finding.distinctActorCount,
            unattributedCount: finding.unattributedCount,
            staffExcludedCount: finding.staffExcludedCount,
          },
        });

        if (result.kind !== 'appended') {
          this.logger.error(
            { eventId, subjectKind: finding.subjectKind, kind: result.kind },
            'mass-cancellation event failed contract validation — finding dropped',
          );
          return false;
        }
        return true;
      });
    } catch (error) {
      this.logger.error(
        {
          eventId,
          subjectKind: finding.subjectKind,
          error: error instanceof Error ? error.message : 'unknown',
        },
        'mass-cancellation event append failed — sweep continues',
      );
      return false;
    }
  }
}
