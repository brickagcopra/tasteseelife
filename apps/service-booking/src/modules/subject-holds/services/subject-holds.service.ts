import { Injectable, Logger } from '@nestjs/common';

import { PrismaService, type PrismaTransactionClient } from '../../../prisma/prisma.service';
import { TERMINAL_BOOKING_STATUSES } from '../../lifecycle/booking-status';
import type { BookingStatus } from '../../lifecycle/booking-status';
import {
  toSubjectPairs,
  type BookingHoldSubjectTriple,
  type BookingSubjectHoldKind,
} from '../subject-hold-kinds';

/** The statuses a hold can suspend — every non-terminal state. */
const HOLDABLE_BOOKING_STATUSES: readonly BookingStatus[] = (
  ['pending', 'confirmed', 'in_progress', 'completed', 'canceled', 'declined'] as const
).filter((status) => !TERMINAL_BOOKING_STATUSES.has(status));

/** One active hold blocking a screened subject. */
export interface ActiveSubjectHold {
  readonly incidentId: string;
  readonly subjectKind: BookingSubjectHoldKind;
  readonly subjectId: string;
  readonly severity: string;
  readonly category: string;
  readonly heldAt: Date;
}

/** Input for a `trust_safety.booking_hold.requested`. */
export interface ApplySubjectHoldInput extends BookingHoldSubjectTriple {
  readonly incidentId: string;
  readonly severity: string;
  readonly category: string;
  /** The incident's `openedAt`, from the event — not our processing time. */
  readonly heldAt: Date;
  /** The event's `eventId` — the domain-level idempotency key. */
  readonly sourceEventId: string;
}

/** Input for a `trust_safety.booking_hold.released`. */
export interface ReleaseSubjectHoldInput extends BookingHoldSubjectTriple {
  readonly incidentId: string;
  /** The incident's resolution moment, from the event. */
  readonly releasedAt: Date;
  readonly releaseEventId: string;
}

export interface ApplySubjectHoldResult {
  /** Hold rows created (0 when every one already existed — a redelivery). */
  readonly holdsCreated: number;
  /** Existing bookings newly stamped as suspended. */
  readonly bookingsHeld: number;
}

export interface ReleaseSubjectHoldResult {
  /** Hold rows moved from active to released (0 on a redelivery). */
  readonly holdsReleased: number;
  /** Bookings whose hold was cleared entirely. */
  readonly bookingsCleared: number;
  /**
   * Bookings that stayed suspended because ANOTHER open incident still
   * covers them — re-stamped with the surviving incident's id. Non-zero
   * here is the case a naive "clear everything this incident held" release
   * would get wrong.
   */
  readonly bookingsRestamped: number;
}

/**
 * Trust & safety subject holds (TS-304; PRD §10.14; PDD §16.1;
 * CLAUDE.md §12).
 *
 * Owns everything the word "held" means inside service-booking:
 *
 *   - `applySubjectHold` — records the hold per named subject and suspends
 *     the subject's existing non-terminal bookings. Driven by the
 *     `trust_safety.booking_hold.requested` consumer.
 *   - `releaseSubjectHold` — lifts it, re-evaluating each suspended booking
 *     against any OTHER still-open hold before clearing.
 *   - `screenSubjects` — the pre-flight read `createBooking` and the
 *     recurring-series create consult before writing anything.
 *
 * **This service never decides WHETHER a subject should be held.** That
 * predicate is trust & safety's (`booking-hold-policy.ts` over there), and
 * it arrives as an explicit order on the wire. Nothing here inspects a
 * severity to re-derive eligibility — a second copy of "which concerns stop
 * a family's care" living in the booking service is how the two drift, and
 * the drifting copy would be the one with no trust & safety context.
 *
 * **Idempotency (CLAUDE.md §5.3).** Both mutations are safe to replay:
 * `applySubjectHold` skips hold rows that already exist and only stamps
 * bookings that are not already held; `releaseSubjectHold` filters on
 * `releasedAt IS NULL` and is a no-op once the release has landed. The
 * consumer SDK's dedup table is the second line; these are the first.
 *
 * **Availability posture.** A hold is applied by a background consumer, so
 * there is a window between an incident opening and the bookings freezing.
 * That is the deliberate trade from CLAUDE.md §5.3 / §12: an incident must
 * never fail to open because service-booking is unreachable. The window is
 * bounded by the relay + consumer poll cadence (seconds), and the screening
 * read closes it for NEW bookings the moment the hold row lands.
 */
@Injectable()
export class SubjectHoldsService {
  private readonly logger = new Logger(SubjectHoldsService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Apply a hold. Idempotent on `(sourceEventId, subjectKind)` and on
   * `(incidentId, subjectKind, subjectId)`.
   *
   * Returns a zero result — rather than throwing — when the order names no
   * subject. The producer's contract already refuses that payload and the
   * consumer rejects it before calling, so reaching here means a third
   * layer was needed; treating it as "hold nothing" is the only safe
   * reading, because the alternative interpretation of a subjectless hold
   * is a platform-wide freeze.
   */
  async applySubjectHold(input: ApplySubjectHoldInput): Promise<ApplySubjectHoldResult> {
    const pairs = toSubjectPairs(input);
    if (pairs.length === 0) {
      this.logger.error(
        `booking.subject_hold.no_subject incidentId=${input.incidentId} sourceEventId=${input.sourceEventId} — refusing a subjectless hold`,
      );
      return { holdsCreated: 0, bookingsHeld: 0 };
    }

    return this.prisma.$transaction(async (tx: PrismaTransactionClient) => {
      // `skipDuplicates` makes the replay a no-op at the database rather
      // than requiring a read-then-write race window. Both UNIQUEs are
      // honoured by it.
      const created = await tx.bookingSubjectHold.createMany({
        data: pairs.map((pair) => ({
          incidentId: input.incidentId,
          subjectKind: pair.kind,
          subjectId: pair.id,
          severity: input.severity,
          category: input.category,
          heldAt: input.heldAt,
          sourceEventId: input.sourceEventId,
        })),
        skipDuplicates: true,
      });

      // Suspend the subject's live bookings. `heldByIncidentId: null` keeps
      // an earlier incident's hold as the recorded reason — first hold
      // wins, and the release path re-evaluates rather than assuming a
      // single holder. Terminal bookings are excluded: a completed visit
      // cannot be suspended, and re-freezing history would corrupt the
      // family's record of what happened.
      const held = await tx.booking.updateMany({
        where: {
          heldByIncidentId: null,
          status: { in: [...HOLDABLE_BOOKING_STATUSES] },
          OR: subjectMatchClauses(pairs),
        },
        data: { heldByIncidentId: input.incidentId, heldAt: input.heldAt },
      });

      this.logger.warn(
        `booking.subject_hold.applied ${JSON.stringify({
          incidentId: input.incidentId,
          severity: input.severity,
          subjects: pairs.map((p) => p.kind),
          holdsCreated: created.count,
          bookingsHeld: held.count,
          sourceEventId: input.sourceEventId,
        })}`,
      );

      return { holdsCreated: created.count, bookingsHeld: held.count };
    });
  }

  /**
   * Release a hold and re-evaluate everything it was suspending.
   *
   * The re-evaluation is the part that is easy to get wrong. Clearing every
   * booking whose `heldByIncidentId` matches would resume visits that a
   * SECOND, still-open incident also covers — for example a provider under
   * two concurrent concerns, the first of which is dismissed. So after
   * marking this incident's holds released, each affected booking is
   * checked against the remaining active holds and either re-stamped with
   * the surviving incident or cleared.
   */
  async releaseSubjectHold(input: ReleaseSubjectHoldInput): Promise<ReleaseSubjectHoldResult> {
    return this.prisma.$transaction(async (tx: PrismaTransactionClient) => {
      const holdsReleased = await tx.bookingSubjectHold.updateMany({
        where: { incidentId: input.incidentId, releasedAt: null },
        data: { releasedAt: input.releasedAt, releaseEventId: input.releaseEventId },
      });

      // Everything this incident was recorded as holding. Projected — no
      // `SELECT *` on a production path (CLAUDE.md §4.1).
      const suspended: ReadonlyArray<{
        id: string;
        providerId: string;
        seniorId: string;
        householdId: string;
      }> = await tx.booking.findMany({
        where: { heldByIncidentId: input.incidentId },
        select: { id: true, providerId: true, seniorId: true, householdId: true },
      });

      if (suspended.length === 0) {
        this.logger.log(
          `booking.subject_hold.released ${JSON.stringify({
            incidentId: input.incidentId,
            holdsReleased: holdsReleased.count,
            bookingsCleared: 0,
            bookingsRestamped: 0,
            releaseEventId: input.releaseEventId,
          })}`,
        );
        return {
          holdsReleased: holdsReleased.count,
          bookingsCleared: 0,
          bookingsRestamped: 0,
        };
      }

      // One query for every still-active hold touching any subject of any
      // affected booking — not one query per booking (an N+1 is a defect,
      // CLAUDE.md §7.2).
      const survivors: ReadonlyArray<{
        incidentId: string;
        subjectKind: BookingSubjectHoldKind;
        subjectId: string;
        heldAt: Date;
      }> = await tx.bookingSubjectHold.findMany({
        where: {
          releasedAt: null,
          OR: [
            {
              subjectKind: 'provider',
              subjectId: { in: unique(suspended.map((b) => b.providerId)) },
            },
            { subjectKind: 'senior', subjectId: { in: unique(suspended.map((b) => b.seniorId)) } },
            {
              subjectKind: 'household',
              subjectId: { in: unique(suspended.map((b) => b.householdId)) },
            },
          ],
        },
        select: { incidentId: true, subjectKind: true, subjectId: true, heldAt: true },
        // Oldest first, so a re-stamped booking reports the longest-standing
        // remaining concern rather than an arbitrary one.
        orderBy: [{ heldAt: 'asc' }, { incidentId: 'asc' }],
      });

      const byKey = new Map<string, { incidentId: string; heldAt: Date }>();
      for (const hold of survivors) {
        const key = `${hold.subjectKind}:${hold.subjectId}`;
        if (!byKey.has(key)) byKey.set(key, { incidentId: hold.incidentId, heldAt: hold.heldAt });
      }

      const toClear: string[] = [];
      // Grouped by surviving incident so the re-stamp is one UPDATE per
      // survivor, not one per booking.
      const toRestamp = new Map<string, { heldAt: Date; bookingIds: string[] }>();

      for (const booking of suspended) {
        const survivor =
          byKey.get(`provider:${booking.providerId}`) ??
          byKey.get(`senior:${booking.seniorId}`) ??
          byKey.get(`household:${booking.householdId}`);
        if (survivor === undefined) {
          toClear.push(booking.id);
          continue;
        }
        const group = toRestamp.get(survivor.incidentId);
        if (group === undefined) {
          toRestamp.set(survivor.incidentId, {
            heldAt: survivor.heldAt,
            bookingIds: [booking.id],
          });
        } else {
          group.bookingIds.push(booking.id);
        }
      }

      let cleared = 0;
      if (toClear.length > 0) {
        const result = await tx.booking.updateMany({
          where: { id: { in: toClear } },
          data: { heldByIncidentId: null, heldAt: null },
        });
        cleared = result.count;
      }

      let restamped = 0;
      for (const [survivorIncidentId, group] of toRestamp) {
        const result = await tx.booking.updateMany({
          where: { id: { in: group.bookingIds } },
          data: { heldByIncidentId: survivorIncidentId, heldAt: group.heldAt },
        });
        restamped += result.count;
      }

      this.logger.log(
        `booking.subject_hold.released ${JSON.stringify({
          incidentId: input.incidentId,
          holdsReleased: holdsReleased.count,
          bookingsCleared: cleared,
          bookingsRestamped: restamped,
          releaseEventId: input.releaseEventId,
        })}`,
      );

      return {
        holdsReleased: holdsReleased.count,
        bookingsCleared: cleared,
        bookingsRestamped: restamped,
      };
    });
  }

  /**
   * The pre-flight screen. Returns every active hold covering any of the
   * three subjects — empty means "clear to book".
   *
   * Read-only and cheap (one indexed query, at most three probes), so it is
   * safe to call before the money math on the booking-create path. An empty
   * subject triple returns no holds: the caller has supplied nothing to
   * screen, which is a caller bug rather than a licence to block, and
   * `createBooking`'s own contract guarantees all three are present.
   */
  async screenSubjects(subjects: BookingHoldSubjectTriple): Promise<ActiveSubjectHold[]> {
    const pairs = toSubjectPairs(subjects);
    if (pairs.length === 0) return [];

    const rows: ReadonlyArray<{
      incidentId: string;
      subjectKind: BookingSubjectHoldKind;
      subjectId: string;
      severity: string;
      category: string;
      heldAt: Date;
    }> = await this.prisma.bookingSubjectHold.findMany({
      where: {
        releasedAt: null,
        OR: pairs.map((pair) => ({ subjectKind: pair.kind, subjectId: pair.id })),
      },
      select: {
        incidentId: true,
        subjectKind: true,
        subjectId: true,
        severity: true,
        category: true,
        heldAt: true,
      },
      orderBy: [{ heldAt: 'asc' }, { incidentId: 'asc' }],
    });

    return rows.map((row) => ({
      incidentId: row.incidentId,
      subjectKind: row.subjectKind,
      subjectId: row.subjectId,
      severity: row.severity,
      category: row.category,
      heldAt: row.heldAt,
    }));
  }
}

/**
 * Prisma `OR` clauses matching a booking against the held subjects. Kept as
 * a function so the apply path and any future sweep share one definition of
 * "this booking involves a held subject".
 */
function subjectMatchClauses(
  pairs: ReadonlyArray<{ readonly kind: BookingSubjectHoldKind; readonly id: string }>,
): Array<{ providerId: string } | { seniorId: string } | { householdId: string }> {
  return pairs.map((pair) => {
    switch (pair.kind) {
      case 'provider':
        return { providerId: pair.id };
      case 'senior':
        return { seniorId: pair.id };
      case 'household':
        return { householdId: pair.id };
    }
  });
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}
