import {
  BadRequestException,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  BookingHoldListResponseSchema,
  ListBookingHoldsQuerySchema,
  type BookingHoldListResponse,
  type BookingHoldRow,
} from '@taste-and-see/contracts';
import { AccessTokenGuard, PermissionGuard, RequirePermissions } from '@taste-and-see/nest-auth';

import {
  SubjectHoldsReadService,
  type BookingHoldRecord,
} from '../services/subject-holds-read.service';

/**
 * Admin booking-hold read (TS-304-followup-3; PRD §10.14, PDD §16.1).
 *
 *   GET /api/v1/admin/booking-holds?status=&incidentId=&subjectKind=&subjectId=&limit=&offset=
 *     What is currently suspended, since when, by which incident, and
 *     how much care that is interrupting.
 *
 * **Gated `trust_safety:read`, not a booking permission.** The question
 * this answers belongs to the trust & safety console: a hold exists
 * because of an incident, and the person who needs to see it is the one
 * deliberating on that incident. Gating it on `booking:read` would put
 * the roster of who is under investigation in front of every operator
 * who works the booking queue — the row is thin (ids, a severity word,
 * a category word) but "this provider is held on a `safety` concern" is
 * exactly the inference CLAUDE.md §12 says not to spread. The
 * permission already exists and is held by `super_admin` and
 * `trust_safety` (TS-303c1), so **no `pnpm seed:rbac` re-run**.
 *
 * **This is the read half of a deliberately one-sided surface.** TS-304
 * shipped no HTTP way to place or lift a hold from the booking side and
 * this does not add one: a hold originates from an incident and is
 * lifted by the committee closing it, so a write endpoint here would be
 * a way to un-suspend a provider without touching the incident that
 * suspended them.
 *
 * **No free text on this surface.** The row carries the incident's
 * `severity` and `category` — two enum-shaped words snapshotted at hold
 * time — and never the concern's narrative. That string is a family's
 * account of what happened to a named senior and lives behind
 * `trust_safety:write` on the incident detail (TS-303c2d), one click
 * away for a reader who holds it.
 *
 * **Read-only, no idempotency key, no audit emission.** GET is
 * naturally idempotent; read-audit for admin surfaces is a
 * platform-wide question (TS-128-followup-7) and solving it here alone
 * would put this service out of step with the other twenty.
 */
@Controller()
export class AdminBookingHoldsController {
  constructor(private readonly holds: SubjectHoldsReadService) {}

  @Get('api/v1/admin/booking-holds')
  @HttpCode(HttpStatus.OK)
  @UseGuards(AccessTokenGuard, PermissionGuard)
  @RequirePermissions('trust_safety:read')
  async listHolds(@Query() rawQuery: Record<string, unknown>): Promise<BookingHoldListResponse> {
    const parsed = ListBookingHoldsQuerySchema.safeParse(rawQuery);
    if (!parsed.success) {
      throw new BadRequestException({
        type: 'about:blank',
        title: 'Bad Request',
        status: HttpStatus.BAD_REQUEST,
        detail: 'Booking hold query failed validation.',
        issues: parsed.error.issues,
      });
    }

    const page = await this.holds.listHolds(parsed.data);

    const response: BookingHoldListResponse = {
      holds: page.rows.map((row) =>
        toHoldRowDto(row, page.suspendedBookingCounts.get(row.incidentId) ?? 0),
      ),
      total: page.total,
      limit: parsed.data.limit,
      offset: parsed.data.offset,
    };
    return BookingHoldListResponseSchema.parse(response);
  }
}

/**
 * Project a hold record to the wire DTO.
 *
 * A missing count is ZERO, not absent: an incident with no
 * currently-suspended bookings simply does not appear in the grouped
 * query's result, and "this hold is interrupting nothing right now" is
 * a real answer the committee wants — not missing data.
 */
function toHoldRowDto(row: BookingHoldRecord, suspendedBookingCount: number): BookingHoldRow {
  return {
    id: row.id,
    incidentId: row.incidentId,
    subjectKind: row.subjectKind,
    subjectId: row.subjectId,
    severity: row.severity,
    category: row.category,
    heldAt: row.heldAt.toISOString(),
    releasedAt: row.releasedAt !== null ? row.releasedAt.toISOString() : null,
    incidentSuspendedBookingCount: suspendedBookingCount,
  };
}
