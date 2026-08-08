import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Param,
  Put,
  Req,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import {
  UpsertVisitNotesRequestSchema,
  VisitNotesResponseSchema,
  type UpsertVisitNotesRequest,
  type VisitNotesResponse,
} from '@taste-and-see/contracts';
import { AccessTokenGuard, type RequestWithContext } from '@taste-and-see/nest-auth';
import { ZodValidationPipe } from '@taste-and-see/nest-common';
import { Idempotent } from '@taste-and-see/nest-idempotency';

import { toVisitNotesResponse } from '../mappers/visit-notes.mapper';
import { VisitNotesService, type VisitNotesServiceFailure } from '../services/visit-notes.service';

/**
 * Booking visit notes HTTP boundary (TS-062).
 *
 * Two endpoints:
 *
 *   PUT /api/v1/bookings/:bookingId/visit-notes
 *     Upsert the visit-notes row for the booking. Idempotent on
 *     `Idempotency-Key`. Rejects with 409 when the booking is not
 *     in `in_progress` or `completed` (the provider can only record
 *     a note during the visit or immediately after check-out).
 *
 *   GET /api/v1/bookings/:bookingId/visit-notes
 *     Read the visit-notes row. 404 when the booking exists but no
 *     note has been recorded yet — the family-portal renders the
 *     empty-state placeholder.
 *
 * Authentication. Both endpoints require a valid Bearer access token
 * minted by `service-identity`. The `AccessTokenGuard` attaches a
 * decoded `requestContext` to the request; the controller passes
 * `request.requestContext.userId` to the service for the
 * `recordedByUserId` stamp.
 *
 * Authorization. Phase-1 tenant scoping is service-layer "actor must
 * be the assigned provider for writes OR a household member for
 * reads", but the cross-service membership lookups (TS-141 Prisma
 * extension) haven't landed yet — service today trusts the
 * authenticated `userId` and records it on the row for downstream
 * audit. The endpoint stays usable today AND the gate can be
 * tightened without a contract change. TS-062-followup-1 captures the
 * actor / provider match check.
 *
 * Idempotency. PUT wears `@Idempotent()` so a retried request returns
 * the cached response rather than mutating twice (CLAUDE.md §3.3 /
 * §17.5).
 */
@Controller()
export class VisitNotesController {
  constructor(private readonly visitNotes: VisitNotesService) {}

  /**
   * PUT /api/v1/bookings/:bookingId/visit-notes — upsert the
   * visit-notes row.
   *
   * Status codes:
   *   200 OK              — body is the VisitNotesResponse (always
   *                          200 — upsert; the first call inserts
   *                          and the response shape is identical to
   *                          subsequent updates).
   *   400 Bad Request     — payload failed validation OR service-
   *                          layer invalid_request.
   *   401 Unauthorized    — missing / invalid access token.
   *   404 Not Found       — booking does not exist.
   *   409 Conflict        — booking is not in a status that permits
   *                          visit-notes write (pending / confirmed
   *                          / canceled).
   */
  @Put('api/v1/bookings/:bookingId/visit-notes')
  @HttpCode(HttpStatus.OK)
  @UseGuards(AccessTokenGuard)
  @Idempotent()
  async upsert(
    @Param('bookingId') bookingId: string,
    @Body(new ZodValidationPipe(UpsertVisitNotesRequestSchema)) body: UpsertVisitNotesRequest,
    @Req() request: RequestWithContext,
  ): Promise<VisitNotesResponse> {
    const userId = requireUserId(request);
    const result = await this.visitNotes.upsert({
      actorUserId: userId,
      bookingId,
      request: body,
    });
    if (!result.ok) {
      throwVisitNotesFailure(result.error);
    }
    return VisitNotesResponseSchema.parse(toVisitNotesResponse(result.value));
  }

  /**
   * GET /api/v1/bookings/:bookingId/visit-notes — read the
   * visit-notes row.
   *
   * Status codes:
   *   200 OK              — body is the VisitNotesResponse.
   *   401 Unauthorized    — missing / invalid access token.
   *   404 Not Found       — booking does not exist OR no visit
   *                          notes have been recorded yet for this
   *                          booking. The two cases share a status
   *                          code (and a different `detail` body)
   *                          so a probing client cannot distinguish
   *                          "booking exists" from "booking doesn't
   *                          exist" without authorisation to read
   *                          the booking.
   */
  @Get('api/v1/bookings/:bookingId/visit-notes')
  @HttpCode(HttpStatus.OK)
  @UseGuards(AccessTokenGuard)
  async getByBookingId(
    @Param('bookingId') bookingId: string,
    @Req() request: RequestWithContext,
  ): Promise<VisitNotesResponse> {
    const userId = requireUserId(request);
    const result = await this.visitNotes.getByBookingId({
      actorUserId: userId,
      bookingId,
    });
    if (!result.ok) {
      throwVisitNotesFailure(result.error);
    }
    return VisitNotesResponseSchema.parse(toVisitNotesResponse(result.value));
  }
}

function throwVisitNotesFailure(failure: VisitNotesServiceFailure): never {
  switch (failure.reason) {
    case 'invalid_request':
      throw new BadRequestException({
        type: 'about:blank',
        title: 'Bad Request',
        status: 400,
        detail: failure.message,
      });
    case 'booking_not_found':
      throw new NotFoundException({
        type: 'about:blank',
        title: 'Not Found',
        status: 404,
        detail: `Booking ${failure.bookingId} not found.`,
      });
    case 'visit_notes_not_found':
      throw new NotFoundException({
        type: 'about:blank',
        title: 'Not Found',
        status: 404,
        detail: `No visit notes recorded for booking ${failure.bookingId}.`,
      });
    case 'invalid_lifecycle_state':
      throw new ConflictException({
        type: 'about:blank',
        title: 'Conflict',
        status: 409,
        detail: `Visit notes cannot be written while the booking is in ${failure.bookingStatus}.`,
        allowedStatuses: failure.allowed,
      });
  }
}

function requireUserId(request: RequestWithContext): string {
  const ctx = request.requestContext;
  if (ctx === undefined) {
    throw new UnauthorizedException({
      type: 'about:blank',
      title: 'Unauthorized',
      status: 401,
      detail: 'Authentication required.',
    });
  }
  return ctx.userId;
}
