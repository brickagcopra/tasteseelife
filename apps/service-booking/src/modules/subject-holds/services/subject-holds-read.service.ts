import { Injectable } from '@nestjs/common';
import type { ListBookingHoldsQuery } from '@taste-and-see/contracts';

import { PrismaService } from '../../../prisma/prisma.service';
import type { BookingSubjectHoldKind } from '../subject-hold-kinds';

/** A hold row as the ops read projects it, before the count is joined on. */
export interface BookingHoldRecord {
  readonly id: string;
  readonly incidentId: string;
  readonly subjectKind: BookingSubjectHoldKind;
  readonly subjectId: string;
  readonly severity: string;
  readonly category: string;
  readonly heldAt: Date;
  readonly releasedAt: Date | null;
}

/** One page of holds, the unpaged total, and the per-incident booking counts. */
export interface BookingHoldPage {
  readonly rows: readonly BookingHoldRecord[];
  readonly total: number;
  /**
   * `incidentId` → number of bookings CURRENTLY stamped as suspended by
   * that incident. Only carries the incidents present on this page; a
   * missing key means zero, and the controller maps it that way.
   */
  readonly suspendedBookingCounts: ReadonlyMap<string, number>;
}

/** Prisma `where` fragment shared by the page query and the count. */
interface HoldWhere {
  releasedAt?: null | { not: null };
  incidentId?: string;
  subjectKind?: BookingSubjectHoldKind;
  subjectId?: string;
}

/**
 * Ops read over `booking_subject_holds` (TS-304-followup-3; PRD §10.14,
 * PDD §16.1).
 *
 * **Read-only, and separate from `SubjectHoldsService` on purpose.**
 * That service owns the two transactional write paths (apply / release)
 * and the pre-flight screen that `createBooking` calls before any side
 * effect. This one exists so an ops question — "what is suspended, and
 * how much care is that interrupting" — cannot accidentally be answered
 * by a method that also mutates, and so the hot screening path keeps a
 * class whose every member is on the booking-create critical path.
 *
 * There is still **no write surface** on this side. A hold is placed by
 * a trust & safety incident and lifted by the committee closing it; an
 * endpoint here would be a way to un-suspend a provider without
 * touching the incident that suspended them.
 *
 * **The booking count is per-INCIDENT and is fetched in ONE grouped
 * query for the whole page**, not one query per row. A suspended
 * booking carries `held_by_incident_id` and nothing recording which of
 * the incident's subjects caused the hold — one booking can involve two
 * held subjects at once — so a per-subject number does not exist to be
 * reported. Fabricating one for a surface a committee deliberates from
 * would be worse than an honest shared figure; the contract names the
 * field `incidentSuspendedBookingCount` so a consumer that sums it is
 * visibly doing something the shape argued against.
 */
@Injectable()
export class SubjectHoldsReadService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * One page of holds, newest concern first.
   *
   * Ordered `heldAt DESC, incidentId ASC, subjectKind ASC`. The second
   * and third keys keep an incident's several subject rows adjacent and
   * in the canonical provider → senior → household order (the Postgres
   * enum's declaration order, which is what `subjectKind ASC` sorts
   * by), so a reader can see that three rows are one incident rather
   * than three separate suspensions.
   */
  async listHolds(query: ListBookingHoldsQuery): Promise<BookingHoldPage> {
    const where = buildWhere(query);

    const [rows, total] = await Promise.all([
      this.prisma.bookingSubjectHold.findMany({
        where,
        orderBy: [{ heldAt: 'desc' }, { incidentId: 'asc' }, { subjectKind: 'asc' }],
        skip: query.offset,
        take: query.limit,
        select: {
          id: true,
          incidentId: true,
          subjectKind: true,
          subjectId: true,
          severity: true,
          category: true,
          heldAt: true,
          releasedAt: true,
        },
      }) as Promise<BookingHoldRecord[]>,
      this.prisma.bookingSubjectHold.count({ where }) as Promise<number>,
    ]);

    return {
      rows,
      total,
      suspendedBookingCounts: await this.countSuspendedBookings([
        ...new Set(rows.map((row) => row.incidentId)),
      ]),
    };
  }

  /**
   * Suspended-booking counts for the incidents on this page, in one
   * grouped query.
   *
   * Counts CURRENTLY-suspended bookings only. A released hold therefore
   * normally reports zero: release clears `held_by_incident_id`, so the
   * historical figure is not recoverable from the booking row and the
   * read does not pretend otherwise.
   */
  private async countSuspendedBookings(
    incidentIds: readonly string[],
  ): Promise<ReadonlyMap<string, number>> {
    if (incidentIds.length === 0) return new Map();

    // No `as` cast on the result — `groupBy`'s return type is conditional
    // on its own generic, so an assertion flows backwards into inference
    // and TypeScript then demands the ARGUMENT be that array type too
    // (TS-501). The generated payload already types `heldByIncidentId`
    // (nullable) and `_count._all`.
    const grouped = await this.prisma.booking.groupBy({
      by: ['heldByIncidentId'],
      where: { heldByIncidentId: { in: [...incidentIds] } },
      _count: { _all: true },
    });

    const counts = new Map<string, number>();
    for (const group of grouped) {
      // `heldByIncidentId` is nullable on the model, but the `in` filter
      // means a null can never come back. Narrowed rather than asserted.
      if (group.heldByIncidentId === null) continue;
      counts.set(group.heldByIncidentId, group._count._all);
    }
    return counts;
  }
}

/**
 * Build the shared `where`.
 *
 * `active` and `released` are expressed as predicates on `releasedAt`
 * rather than as a status column, because there is no status column:
 * a hold row is never deleted and `releasedAt` is never cleared back to
 * null (a re-opened concern is a new incident with a new hold), so the
 * timestamp partitions the two sets permanently.
 */
function buildWhere(query: ListBookingHoldsQuery): HoldWhere {
  const where: HoldWhere = {};
  if (query.status === 'active') where.releasedAt = null;
  if (query.status === 'released') where.releasedAt = { not: null };
  if (query.incidentId !== undefined) where.incidentId = query.incidentId;
  if (query.subjectKind !== undefined) where.subjectKind = query.subjectKind;
  if (query.subjectId !== undefined) where.subjectId = query.subjectId;
  return where;
}
