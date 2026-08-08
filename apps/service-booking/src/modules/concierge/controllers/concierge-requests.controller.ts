import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  ForbiddenException,
  HttpCode,
  HttpStatus,
  InternalServerErrorException,
  NotFoundException,
  Post,
  Req,
  UnauthorizedException,
  UseGuards,
  UsePipes,
} from '@nestjs/common';
import {
  BookingResponseSchema,
  CreateConciergeBookingRequestSchema,
  type BookingResponse,
  type CreateConciergeBookingRequest,
} from '@taste-and-see/contracts';
import { AccessTokenGuard, type RequestWithContext } from '@taste-and-see/nest-auth';
import { ZodValidationPipe } from '@taste-and-see/nest-common';
import { Idempotent } from '@taste-and-see/nest-idempotency';

import { toBookingResponse } from '../../bookings/mappers/booking.mapper';
import type { BookingsServiceFailure } from '../../bookings/services/bookings.service';
import { ConciergeRequestsService } from '../services/concierge-requests.service';

/**
 * Concierge booking-request HTTP boundary (TS-125).
 *
 *   POST /api/v1/bookings/concierge-request
 *     Family-portal manual-matching surface. Accepts a price-free
 *     booking request, derives platform-default pricing server-side,
 *     and delegates to `BookingsService.createBooking` (which emits
 *     `booking.created` transactionally with the row insert). The
 *     concierge team then matches + confirms via admin tooling
 *     (TS-128).
 *
 * Auth + idempotency same as the canonical `POST /api/v1/bookings` —
 * `AccessTokenGuard` + `@Idempotent()`.
 */
@Controller()
export class ConciergeRequestsController {
  constructor(private readonly requests: ConciergeRequestsService) {}

  @Post('api/v1/bookings/concierge-request')
  @HttpCode(HttpStatus.CREATED)
  @UseGuards(AccessTokenGuard)
  @UsePipes(new ZodValidationPipe(CreateConciergeBookingRequestSchema))
  @Idempotent()
  async create(
    @Body() body: CreateConciergeBookingRequest,
    @Req() request: RequestWithContext,
  ): Promise<BookingResponse> {
    const userId = requireUserId(request);
    const result = await this.requests.createRequest({
      actorUserId: userId,
      request: body,
    });
    if (!result.ok) {
      throwFailure(result.error);
    }
    return BookingResponseSchema.parse(toBookingResponse(result.value));
  }
}

function throwFailure(failure: BookingsServiceFailure): never {
  switch (failure.reason) {
    case 'invalid_request':
      throw new BadRequestException({
        type: 'about:blank',
        title: 'Bad Request',
        status: 400,
        detail: failure.message,
      });
    case 'not_found':
      throw new NotFoundException({
        type: 'about:blank',
        title: 'Not Found',
        status: 404,
        detail: `Booking ${failure.bookingId} not found.`,
      });
    case 'forbidden':
      throw new ForbiddenException({
        type: 'about:blank',
        title: 'Forbidden',
        status: 403,
        detail: failure.message,
      });
    case 'invalid_transition':
      throw new ConflictException({
        type: 'about:blank',
        title: 'Conflict',
        status: 409,
        detail: `Illegal transition ${failure.from} → ${failure.to}.`,
      });
    case 'tier_gating_violation':
      throw new ConflictException({
        type: 'about:blank',
        title: 'Conflict',
        status: 409,
        detail:
          failure.violationReason === 'tier_3_requires_elite'
            ? 'Tier 3 Concierge households can only book Elite Concierge providers.'
            : 'Tier-gating policy rejected the booking.',
        violationReason: failure.violationReason,
        householdTier: failure.householdTier,
        providerTier: failure.providerTier,
      });
    case 'accept_window_expired':
      // Concierge requests funnel through `createBooking`; the
      // accept-window failure shape is only emitted by
      // `acceptBooking` (TS-205). Surface as a 500 so the
      // unexpected path is loud rather than swallowed — the
      // concierge flow does not consume this branch today.
      throw new InternalServerErrorException({
        type: 'about:blank',
        title: 'Internal Server Error',
        status: 500,
        detail: 'Unexpected accept-window failure on concierge booking creation.',
      });
    case 'subject_on_hold':
      // TS-304. Same 409 + same deliberately vague prose as the canonical
      // `POST /api/v1/bookings` — this is the FAMILY-portal concierge
      // request surface (`AccessTokenGuard`, a family member's token), not
      // an ops one, so the disclosure calculus is identical: a hold means
      // someone is under review for a serious concern, and a booking form
      // is not where a family learns that (CLAUDE.md §3.9, §12).
      throw new ConflictException({
        type: 'about:blank',
        title: 'Conflict',
        status: 409,
        detail:
          'Booking is temporarily unavailable while our care team completes a review. Please contact your concierge and we will help you arrange this visit.',
        incidentId: failure.incidentId,
        subjectKind: failure.subjectKind,
      });
    case 'outbox_validation_failed':
      throw new InternalServerErrorException({
        type: 'about:blank',
        title: 'Internal Server Error',
        status: 500,
        detail: 'A server-side event payload failed validation.',
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
