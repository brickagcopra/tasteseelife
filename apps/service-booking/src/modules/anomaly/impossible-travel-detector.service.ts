import { Injectable, Logger } from '@nestjs/common';
import { BOOKING_ANOMALY_IMPOSSIBLE_TRAVEL } from '@taste-and-see/contracts';
import { OutboxService } from '@taste-and-see/nest-outbox';

import { PrismaService, type PrismaTransactionClient } from '../../prisma/prisma.service';

import {
  findImpossibleTravel,
  type CheckInPoint,
  type ImpossibleTravelFinding,
} from './impossible-travel-policy';

/**
 * One row of the sweep's join. `latitude` / `longitude` arrive as
 * Prisma `Decimal`, so the query casts them to double precision in SQL
 * — the policy does trigonometry and a `Decimal` would silently
 * stringify into `NaN` the moment it hit `Math.sin`.
 */
interface CheckInScanRow {
  readonly id: string;
  readonly bookingId: string;
  readonly providerId: string;
  readonly latitude: number;
  readonly longitude: number;
  readonly occurredAt: Date;
}

export interface ImpossibleTravelSweepResult {
  /** Check-in rows examined. */
  readonly scanned: number;
  /** Distinct providers those rows belonged to. */
  readonly providers: number;
  /** Pairs the predicate judged impossible. */
  readonly findings: number;
  /**
   * Events actually appended. Lower than `findings` on any tick that
   * re-examines a pair already reported — see the dedup note.
   */
  readonly emitted: number;
}

/**
 * Impossible-travel detection sweep (TS-308a; PRD §10.13, PDD §17.3).
 *
 * Scans recent provider check-ins, walks each provider's in time order,
 * and appends a `booking.anomaly.impossible_travel` event for every
 * consecutive pair the predicate rejects. service-trust-safety consumes
 * it into a `safety` incident.
 *
 * **Dedup is the deterministic event id, not a new table.** The outbox
 * insert is `ON CONFLICT (event_id) DO NOTHING`, so deriving the id
 * from the check-in pair — `impossible-travel:{previousId}:{currentId}`
 * — makes a re-detection a no-op insert. Check-ins are immutable and a
 * pair is unique, so the id is stable forever. This is what lets the
 * lookback window be generous without a table of "things already
 * reported": a pair examined on twenty consecutive ticks produces
 * exactly one event, one incident, and one SLA clock. It is also
 * greppable, which a hash would not be.
 *
 * **The lookback window is deliberately wide (default 24h) and
 * overlapping.** A pair straddles the window boundary — check-in A at
 * 09:00 and B at 10:05 are only a pair if both are in scope — so a
 * narrow window keyed to the tick interval would miss exactly the
 * journeys that cross it. Overlapping re-examination is the simple,
 * correct answer once re-emission is free.
 *
 * **Coordinates never leave this service.** They are read here, turned
 * into a distance and a speed, and dropped. A check-in location is a
 * senior's home address in decimal form, and CLAUDE.md §12 holds
 * location back even from the family portal; what rides the event is
 * the derived scalar plus two check-in ids.
 *
 * **The producer states a fact; the consumer grades it.** This emits
 * "these two check-ins imply 940 km/h". Whether that is `high` or
 * `medium` is trust & safety's call — the same split as TS-304 (the
 * other way round) and TS-307a.
 */
@Injectable()
export class ImpossibleTravelDetectorService {
  private readonly logger = new Logger(ImpossibleTravelDetectorService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly outbox: OutboxService,
  ) {}

  /**
   * Run one sweep over the lookback window.
   *
   * Each finding is appended in **its own transaction**. A single
   * malformed pair must not roll back the rest of the sweep — this is a
   * detector, and losing nineteen real findings because the twentieth
   * failed validation would be the worst possible failure mode for it.
   */
  async sweep(args: {
    readonly now: Date;
    readonly lookbackHours: number;
    readonly maxSpeedKph: number;
  }): Promise<ImpossibleTravelSweepResult> {
    const since = new Date(args.now.getTime() - args.lookbackHours * 60 * 60 * 1000);
    const rows = await this.scanCheckIns(since);

    const byProvider = new Map<string, CheckInPoint[]>();
    for (const row of rows) {
      const bucket = byProvider.get(row.providerId);
      const point: CheckInPoint = {
        id: row.id,
        bookingId: row.bookingId,
        latitude: row.latitude,
        longitude: row.longitude,
        occurredAt: row.occurredAt,
      };
      if (bucket === undefined) byProvider.set(row.providerId, [point]);
      else bucket.push(point);
    }

    let findings = 0;
    let emitted = 0;
    for (const [providerId, points] of byProvider) {
      for (const finding of findImpossibleTravel(points, args.maxSpeedKph)) {
        findings += 1;
        if (await this.emit(providerId, finding, args.maxSpeedKph)) emitted += 1;
      }
    }

    this.logger.log(
      {
        scanned: rows.length,
        providers: byProvider.size,
        findings,
        emitted,
        lookbackHours: args.lookbackHours,
        maxSpeedKph: args.maxSpeedKph,
      },
      'impossible-travel sweep complete',
    );

    return { scanned: rows.length, providers: byProvider.size, findings, emitted };
  }

  /**
   * Check-ins in the window, joined to their booking for the provider.
   *
   * Raw SQL because the walk needs `(provider_id, occurred_at)` ordering
   * ACROSS a join, and `BookingCheckIn` has no Prisma relation to
   * `Booking` (the schema models the link as a soft FK). The window
   * predicate rides `booking_check_ins_occurred_at_idx`, added for this
   * query — see its migration for the EXPLAIN.
   *
   * `latitude` / `longitude` are cast to `double precision` in SQL: the
   * columns are `Decimal(8,6)` / `Decimal(9,6)`, Prisma hands those back
   * as `Decimal` objects, and the policy's trigonometry would turn one
   * into `NaN` without a word.
   */
  private async scanCheckIns(since: Date): Promise<readonly CheckInScanRow[]> {
    return (await this.prisma.$queryRaw`
      SELECT
        ci.id                          AS "id",
        ci.booking_id                  AS "bookingId",
        b.provider_id                  AS "providerId",
        ci.latitude::double precision  AS "latitude",
        ci.longitude::double precision AS "longitude",
        ci.occurred_at                 AS "occurredAt"
      FROM "booking"."booking_check_ins" ci
      JOIN "booking"."bookings" b ON b.id = ci.booking_id
      WHERE ci.occurred_at >= ${since}
      ORDER BY b.provider_id ASC, ci.occurred_at ASC, ci.id ASC
    `) as CheckInScanRow[];
  }

  /**
   * Append one finding. Returns whether a NEW event was written.
   *
   * A validation failure is logged at error and swallowed: the sweep
   * continues, and a detector that dies on one bad row stops detecting
   * everything else.
   */
  private async emit(
    providerId: string,
    finding: ImpossibleTravelFinding,
    thresholdKph: number,
  ): Promise<boolean> {
    const eventId = impossibleTravelEventId(finding);

    try {
      return await this.prisma.$transaction(async (tx: PrismaTransactionClient) => {
        const result = await this.outbox.append(tx, {
          eventName: BOOKING_ANOMALY_IMPOSSIBLE_TRAVEL,
          eventId,
          payload: {
            eventId,
            providerId,
            previousCheckInId: finding.previous.id,
            checkInId: finding.current.id,
            previousBookingId: finding.previous.bookingId,
            bookingId: finding.current.bookingId,
            distanceMeters: finding.distanceMeters,
            elapsedSeconds: finding.elapsedSeconds,
            impliedSpeedKph: finding.impliedSpeedKph,
            thresholdKph,
            previousOccurredAt: finding.previous.occurredAt.toISOString(),
            occurredAt: finding.current.occurredAt.toISOString(),
          },
        });

        if (result.kind !== 'appended') {
          // No coordinates in this line either — `issues` carries field
          // paths and messages, not values.
          this.logger.error(
            { eventId, providerId, kind: result.kind },
            'impossible-travel event failed contract validation — finding dropped',
          );
          return false;
        }
        return true;
      });
    } catch (error) {
      this.logger.error(
        { eventId, providerId, error: error instanceof Error ? error.message : 'unknown' },
        'impossible-travel event append failed — sweep continues',
      );
      return false;
    }
  }
}

/**
 * Deterministic event id for a check-in pair.
 *
 * Stable forever (check-ins are immutable), unique per pair, and
 * greppable in the outbox, the relay log, and the incident row — which
 * a hash would not be. The outbox's `ON CONFLICT (event_id) DO NOTHING`
 * turns re-detection into a no-op, and trust-safety's
 * `incidents.source_event_id` UNIQUE is the second guard behind it.
 */
export function impossibleTravelEventId(finding: ImpossibleTravelFinding): string {
  return `impossible-travel:${finding.previous.id}:${finding.current.id}`;
}
