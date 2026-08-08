import { Injectable, Logger } from '@nestjs/common';

import { PrismaService } from '../../../prisma/prisma.service';

/**
 * Local enum + status mirrors. Same TS-021-followup-2 / -3 root cause
 * documented across the codebase — Prisma 5.22's namespace value-side
 * resolves inconsistently under our tsconfig, so the services hold
 * locally-declared string-literal unions for the generated enums. The
 * cross-pin is the contract-side `BookingStatusSchema` /
 * `BookingServiceKindSchema` / `BookingDisputeReasonSchema`; drift
 * surfaces at the first call that passes a non-listed string to Prisma.
 * Replaced once Prisma 5.23 / 6.x resolves the namespace cleanly.
 */
type BookingStatusValue =
  | 'pending'
  | 'confirmed'
  | 'in_progress'
  | 'completed'
  | 'canceled'
  | 'declined';

type ServiceKindValue =
  | 'companion_dining'
  | 'personal_chef_visit'
  | 'grocery_coordination'
  | 'transportation'
  | 'social_outing'
  | 'event_dining'
  | 'emergency_concierge'
  | 'holiday_dinner'
  | 'birthday_experience'
  | 'tea_social'
  | 'museum_outing'
  | 'memory_meal'
  | 'custom_request';

type CheckInKindValue = 'check_in' | 'check_out';

type DisputeStatusValue = 'open' | 'under_review' | 'resolved' | 'dismissed';

type DisputeReasonValue =
  | 'no_show'
  | 'late_arrival'
  | 'early_departure'
  | 'service_quality'
  | 'billing_dispute'
  | 'property_damage'
  | 'safety_concern'
  | 'welfare_concern'
  | 'other';

type DisputeOpenedByRoleValue = 'family' | 'provider' | 'admin';

type VisitNoteMoodValue = 'low' | 'subdued' | 'neutral' | 'bright' | 'joyful';
type VisitNoteAppetiteValue = 'none' | 'minimal' | 'moderate' | 'hearty' | 'robust';
type VisitNoteHydrationValue = 'poor' | 'light' | 'adequate' | 'good' | 'excellent';
type VisitNoteSocialEngagementValue = 'withdrawn' | 'reserved' | 'present' | 'engaged' | 'vibrant';

/** Hard caps mirroring the contract-side constants. */
const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;
const DISPUTES_LIMIT = 50;
const CHECK_INS_LIMIT = 10;

/**
 * Decimal-shaped value Prisma returns for `Decimal(...)` columns. We
 * narrow to the surface that matters at the persistence boundary —
 * `.toString()` — so the mapper can do the integer-minor-unit
 * conversion exactly once on the way out. CLAUDE.md §17.6 forbids
 * `Number` math on money; we never do it here.
 */
interface DecimalLike {
  toString(): string;
}

export interface AdminBookingRow {
  readonly id: string;
  readonly householdId: string;
  readonly seniorId: string;
  readonly providerId: string;
  readonly serviceKind: ServiceKindValue;
  readonly status: BookingStatusValue;
  readonly scheduledStart: Date;
  readonly scheduledEnd: Date;
  readonly currency: string;
  readonly basePrice: DecimalLike;
  readonly commissionRate: DecimalLike;
  readonly commissionAmount: DecimalLike;
  readonly finalPrice: DecimalLike;
  readonly bookingNotes: string | null;
  readonly completedAt: Date | null;
  readonly canceledAt: Date | null;
  readonly cancellationReason: string | null;
  readonly cancellationReasonText: string | null;
  readonly seriesId: string | null;
  readonly seriesIndex: number | null;
  /** TS-304's hold marker — narrowed to a boolean by the mapper. */
  readonly heldByIncidentId: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface AdminBookingListPage {
  readonly bookings: readonly AdminBookingRow[];
  readonly nextCursor: string | null;
}

export interface AdminBookingVisitNoteRow {
  readonly id: string;
  readonly mood: VisitNoteMoodValue | null;
  readonly appetite: VisitNoteAppetiteValue | null;
  readonly hydration: VisitNoteHydrationValue | null;
  readonly socialEngagement: VisitNoteSocialEngagementValue | null;
  readonly freeform: string | null;
  readonly photoKeys: readonly string[];
  readonly recordedByUserId: string;
  readonly recordedAt: Date;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface AdminBookingCheckInRow {
  readonly id: string;
  readonly kind: CheckInKindValue;
  readonly latitude: DecimalLike;
  readonly longitude: DecimalLike;
  readonly locationAccuracyMeters: DecimalLike | null;
  readonly occurredAt: Date;
  readonly recordedByUserId: string;
  readonly createdAt: Date;
}

export interface AdminBookingDisputeRow {
  readonly id: string;
  readonly openedByUserId: string;
  readonly openedByRole: DisputeOpenedByRoleValue;
  readonly reason: DisputeReasonValue;
  readonly reasonDetail: string | null;
  readonly status: DisputeStatusValue;
  readonly resolutionNotes: string | null;
  readonly resolvedByUserId: string | null;
  readonly resolvedAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface AdminBookingRecurrenceRow {
  readonly seriesId: string;
  readonly rrule: string;
  readonly endDate: Date | null;
  readonly count: number | null;
  readonly occurrenceCount: number;
  readonly seriesIndex: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface AdminBookingDetailRow extends AdminBookingRow {
  readonly visitNote: AdminBookingVisitNoteRow | null;
  readonly checkIns: readonly AdminBookingCheckInRow[];
  readonly disputes: readonly AdminBookingDisputeRow[];
  readonly recurrence: AdminBookingRecurrenceRow | null;
}

export interface ListBookingsInput {
  readonly householdId?: string | undefined;
  readonly providerId?: string | undefined;
  readonly seniorId?: string | undefined;
  readonly serviceKind?: ServiceKindValue | undefined;
  readonly status?: BookingStatusValue | undefined;
  readonly cursor?: string | undefined;
  readonly limit: number;
}

export interface GetBookingByIdInput {
  readonly bookingId: string;
}

/**
 * Admin bookings management service (TS-128 Slice 1).
 *
 * Owns the read-only `GET /api/v1/admin/bookings` and
 * `GET /api/v1/admin/bookings/:id` surfaces. Both endpoints are gated
 * upstream by `AccessTokenGuard` + `SuperAdminRoleGuard`; this service
 * does NOT re-check authorisation — it trusts the controller layer to
 * have done so.
 *
 * **Cursor pagination.** Opaque base64-encoded `{createdAt-ISO, id}`
 * pair. Server-side fixed ordering: `createdAt DESC, id DESC` (newest
 * first). Stable secondary sort on `id` so equal-`createdAt` rows page
 * deterministically. Mirrors the TS-126 / TS-127 cursor codec so admin
 * tooling has one shape across surfaces.
 *
 * **Filter shape.** Every filter is exact-match — householdId,
 * providerId, seniorId, serviceKind, status. No substring search in
 * Slice 1; admin operators arrive at a booking either through the
 * household / provider detail pages or via a known id.
 *
 * **Detail view.** The booking detail bundles related-row reads in
 * parallel via `Promise.all`:
 *   - the one-row-max visit notes (filtered to non-deleted),
 *   - the at-most-two check-ins,
 *   - the newest-first disputes (capped at `DISPUTES_LIMIT`),
 *   - the recurrence record when the booking is part of a series.
 *
 * Money math: the row carries `Decimal` for the price columns; the
 * mapper layer converts to integer minor units. The service does no
 * money math itself (CLAUDE.md §17.6).
 */
@Injectable()
export class AdminBookingsService {
  private readonly logger = new Logger(AdminBookingsService.name);

  constructor(private readonly prisma: PrismaService) {}

  async list(input: ListBookingsInput): Promise<AdminBookingListPage> {
    const limit = clampLimit(input.limit);
    const decoded = decodeCursor(input.cursor);

    const where = {
      ...(input.householdId !== undefined ? { householdId: input.householdId } : {}),
      ...(input.providerId !== undefined ? { providerId: input.providerId } : {}),
      ...(input.seniorId !== undefined ? { seniorId: input.seniorId } : {}),
      ...(input.serviceKind !== undefined ? { serviceKind: input.serviceKind } : {}),
      ...(input.status !== undefined ? { status: input.status } : {}),
      ...(decoded !== null
        ? {
            OR: [
              { createdAt: { lt: decoded.createdAt } },
              {
                AND: [{ createdAt: decoded.createdAt }, { id: { lt: decoded.id } }],
              },
            ],
          }
        : {}),
    };

    const rows = (await this.prisma.booking.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
    })) as AdminBookingRow[];

    const trimmed = rows.slice(0, limit);
    const last = trimmed.at(-1);
    const hasMore = rows.length > limit;
    const nextCursor = hasMore && last !== undefined ? encodeCursor(last.createdAt, last.id) : null;

    this.logger.log(
      {
        actorId: '<admin>',
        resultCount: trimmed.length,
        hasMore,
        filters: {
          householdId: input.householdId ?? null,
          providerId: input.providerId ?? null,
          seniorId: input.seniorId ?? null,
          serviceKind: input.serviceKind ?? null,
          status: input.status ?? null,
        },
      },
      'admin.bookings.list',
    );

    return { bookings: trimmed, nextCursor };
  }

  async getById(input: GetBookingByIdInput): Promise<AdminBookingDetailRow | null> {
    const booking = (await this.prisma.booking.findUnique({
      where: { id: input.bookingId },
    })) as AdminBookingRow | null;
    if (booking === null) return null;

    const [visitNote, checkInsRaw, disputesRaw, recurrenceRow] = await Promise.all([
      this.prisma.bookingVisitNote.findUnique({
        where: { bookingId: booking.id },
      }) as Promise<AdminBookingVisitNoteRow | null>,
      this.prisma.bookingCheckIn.findMany({
        where: { bookingId: booking.id },
        orderBy: { occurredAt: 'asc' },
        take: CHECK_INS_LIMIT,
      }) as Promise<AdminBookingCheckInRow[]>,
      this.prisma.bookingDispute.findMany({
        where: { bookingId: booking.id },
        orderBy: { createdAt: 'desc' },
        take: DISPUTES_LIMIT,
      }) as Promise<AdminBookingDisputeRow[]>,
      booking.seriesId !== null
        ? (this.prisma.bookingRecurrence.findUnique({
            where: { seriesId: booking.seriesId },
          }) as Promise<Omit<AdminBookingRecurrenceRow, 'seriesIndex'> | null>)
        : Promise.resolve(null),
    ]);

    let recurrence: AdminBookingRecurrenceRow | null = null;
    if (recurrenceRow !== null && booking.seriesIndex !== null) {
      recurrence = {
        seriesId: recurrenceRow.seriesId,
        rrule: recurrenceRow.rrule,
        endDate: recurrenceRow.endDate,
        count: recurrenceRow.count,
        occurrenceCount: recurrenceRow.occurrenceCount,
        seriesIndex: booking.seriesIndex,
        createdAt: recurrenceRow.createdAt,
        updatedAt: recurrenceRow.updatedAt,
      };
    }

    this.logger.log({ actorId: '<admin>', targetBookingId: booking.id }, 'admin.bookings.detail');

    return {
      ...booking,
      visitNote,
      checkIns: checkInsRaw,
      disputes: disputesRaw,
      recurrence,
    };
  }
}

function clampLimit(requested: number): number {
  if (!Number.isFinite(requested) || requested <= 0) return DEFAULT_LIMIT;
  if (requested > MAX_LIMIT) return MAX_LIMIT;
  return Math.floor(requested);
}

/**
 * Cursor codec: base64url of `${createdAtIso}|${id}`. Mirrors the codec
 * in service-identity / service-subscription admin services so admin
 * tooling has one shape across surfaces.
 */
export function encodeCursor(createdAt: Date, id: string): string {
  const payload = `${createdAt.toISOString()}|${id}`;
  return Buffer.from(payload, 'utf8').toString('base64url');
}

export function decodeCursor(raw: string | undefined): { createdAt: Date; id: string } | null {
  if (raw === undefined) return null;
  try {
    const decoded = Buffer.from(raw, 'base64url').toString('utf8');
    const pipe = decoded.indexOf('|');
    if (pipe < 0) return null;
    const iso = decoded.slice(0, pipe);
    const id = decoded.slice(pipe + 1);
    if (id.length === 0) return null;
    const createdAt = new Date(iso);
    if (Number.isNaN(createdAt.getTime())) return null;
    return { createdAt, id };
  } catch {
    return null;
  }
}
