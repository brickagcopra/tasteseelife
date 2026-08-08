import {
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Param,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ADMIN_BOOKINGS_ID_MAX_LENGTH,
  AdminBookingDetailResponseSchema,
  AdminBookingsListQuerySchema,
  AdminBookingsListResponseSchema,
  type AdminBookingDetailResponse,
  type AdminBookingsListQuery,
  type AdminBookingsListResponse,
} from '@taste-and-see/contracts';
import { AccessTokenGuard } from '@taste-and-see/nest-auth';
import { ZodValidationPipe } from '@taste-and-see/nest-common';

import { SuperAdminRoleGuard } from '../../../common/guards/admin-role.guard';
import { detailRowToDto, summaryRowToDto } from '../mappers/admin-booking.mapper';
import { AdminBookingsService } from '../services/admin-bookings.service';

/**
 * Admin bookings management HTTP boundary (TS-128 Slice 1; PRD §10.5).
 *
 *   GET /api/v1/admin/bookings
 *     Cursor-paginated search across the booking service's `bookings`
 *     table. See `AdminBookingsListQuerySchema` for the filter shape
 *     (householdId / providerId / seniorId / serviceKind / status).
 *     Response: AdminBookingsListResponse (rows + nextCursor).
 *
 *   GET /api/v1/admin/bookings/:id
 *     Full booking-detail view including visit notes, check-ins,
 *     disputes, and recurrence record (when the booking belongs to a
 *     series). 404 when the id does not resolve.
 *
 * **Slice 1 scope.** Read-only. Mutations (manual concierge booking
 * creation — TS-128-followup-1, cancel/refund — TS-128-followup-2,
 * dispute open/resolve — TS-128-followup-3), provider tier + commission
 * management (TS-128-followup-4), featured-placement scheduling
 * (TS-128-followup-5), service-catalog management (TS-128-followup-6),
 * audit-event emission (TS-128-followup-7), Playwright E2E
 * (TS-128-followup-8), OTel + Prometheus (TS-128-followup-9), and
 * OpenAPI generator registration (TS-128-followup-10) arrive in
 * subsequent TS-128 follow-ups.
 *
 * **Authorisation.** Both endpoints sit behind `AccessTokenGuard`
 * (bearer-token verification) followed by `SuperAdminRoleGuard` (active
 * super_admin role required). The gateway-side proxy enforces the same
 * gate at the edge.
 *
 * **Audit emission.** Admin reads do NOT emit audit events today —
 * Slice 1 has no mutations. The read-event audit pipe lands with
 * TS-128-followup-7 once the audit pipe is operational.
 *
 * **Idempotency.** Both endpoints are GET — `@Idempotent()` is the
 * write-endpoint surface and does not apply here.
 */
@Controller()
@UseGuards(AccessTokenGuard, SuperAdminRoleGuard)
export class AdminBookingsController {
  constructor(private readonly bookings: AdminBookingsService) {}

  @Get('api/v1/admin/bookings')
  @HttpCode(HttpStatus.OK)
  async list(
    @Query(new ZodValidationPipe(AdminBookingsListQuerySchema))
    query: AdminBookingsListQuery,
  ): Promise<AdminBookingsListResponse> {
    const page = await this.bookings.list({
      ...(query.householdId !== undefined ? { householdId: query.householdId } : {}),
      ...(query.providerId !== undefined ? { providerId: query.providerId } : {}),
      ...(query.seniorId !== undefined ? { seniorId: query.seniorId } : {}),
      ...(query.serviceKind !== undefined ? { serviceKind: query.serviceKind } : {}),
      ...(query.status !== undefined ? { status: query.status } : {}),
      ...(query.cursor !== undefined ? { cursor: query.cursor } : {}),
      limit: query.limit,
    });

    const response: AdminBookingsListResponse = {
      bookings: page.bookings.map(summaryRowToDto),
      nextCursor: page.nextCursor,
    };
    return AdminBookingsListResponseSchema.parse(response);
  }

  @Get('api/v1/admin/bookings/:id')
  @HttpCode(HttpStatus.OK)
  async getById(@Param('id') id: string): Promise<AdminBookingDetailResponse> {
    if (id.length === 0 || id.length > ADMIN_BOOKINGS_ID_MAX_LENGTH) {
      throw new NotFoundException(notFoundBody(id));
    }

    const row = await this.bookings.getById({ bookingId: id });
    if (row === null) {
      throw new NotFoundException(notFoundBody(id));
    }

    const response: AdminBookingDetailResponse = {
      booking: detailRowToDto(row),
    };
    return AdminBookingDetailResponseSchema.parse(response);
  }
}

function notFoundBody(id: string): {
  readonly type: 'about:blank';
  readonly title: 'Not Found';
  readonly status: 404;
  readonly detail: string;
} {
  return {
    type: 'about:blank',
    title: 'Not Found',
    status: 404,
    detail: `Booking ${truncateForError(id)} not found.`,
  };
}

function truncateForError(value: string): string {
  if (value.length <= 32) return value;
  return `${value.slice(0, 29)}...`;
}
