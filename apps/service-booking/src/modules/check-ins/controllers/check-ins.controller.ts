import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  InternalServerErrorException,
  NotFoundException,
  Param,
  Post,
  Req,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import {
  BookingCheckInsListResponseSchema,
  BookingResponseSchema,
  RecordBookingCheckInRequestSchema,
  RecordBookingCheckInResponseSchema,
  type BookingCheckInsListResponse,
  type RecordBookingCheckInRequest,
  type RecordBookingCheckInResponse,
} from '@taste-and-see/contracts';
import { AccessTokenGuard, type RequestWithContext } from '@taste-and-see/nest-auth';
import { ZodValidationPipe } from '@taste-and-see/nest-common';
import { Idempotent } from '@taste-and-see/nest-idempotency';

import { toBookingResponse } from '../../bookings/mappers/booking.mapper';
import { toBookingCheckInResponse } from '../mappers/check-ins.mapper';
import { CheckInsService, type CheckInsServiceFailure } from '../services/check-ins.service';

/**
 * Booking check-ins HTTP boundary (TS-063).
 *
 * Two endpoints:
 *
 *   POST /api/v1/bookings/:bookingId/check-ins
 *     Record a geo check-in or check-out. Idempotent on
 *     `Idempotency-Key`. The transition fires server-side: the same
 *     request that records the row flips the booking's lifecycle
 *     status (confirmed → in_progress for `check_in`; in_progress →
 *     completed for `check_out`) and emits the matching `booking.*`
 *     outbox event. Returns `{ checkIn, booking }` so the client
 *     observes the new status without a follow-up GET.
 *
 *   GET /api/v1/bookings/:bookingId/check-ins
 *     List every check-in row for the booking, ordered oldest-first.
 *     Powers the family / provider / admin portals' visit timeline.
 *
 * Authentication. Both endpoints require a valid Bearer access token
 * minted by `service-identity`. The `AccessTokenGuard` attaches a
 * decoded `requestContext` to the request; the controller passes
 * `request.requestContext.userId` to the service for the
 * `recordedByUserId` stamp + future row-level access enforcement.
 *
 * Authorization. Phase-1 tenant scoping is service-layer "actor must
 * be the assigned provider for writes OR a household member for
 * reads", but the cross-service membership lookups (TS-141 Prisma
 * extension) haven't landed yet — service today trusts the
 * authenticated `userId` and records it on the row for downstream
 * audit. The endpoint stays usable today AND the gate can be
 * tightened without a contract change. TS-063-followup captures the
 * actor / provider match check.
 *
 * Idempotency. POST wears `@Idempotent()` so a retried request
 * returns the cached response rather than mutating twice
 * (CLAUDE.md §3.3 / §17.5). The DB-layer `(bookingId, kind)` UNIQUE
 * index is the second line of defence against an unkeyed retry.
 */
@Controller()
export class CheckInsController {
  constructor(private readonly checkIns: CheckInsService) {}

  /**
   * POST /api/v1/bookings/:bookingId/check-ins — record check-in /
   * check-out + atomically transition booking status.
   *
   * Status codes:
   *   201 Created             — body is `{ checkIn, booking }`.
   *   400 Bad Request         — payload failed validation OR
   *                              service-layer invalid_request.
   *   401 Unauthorized        — missing / invalid access token.
   *   404 Not Found           — booking does not exist.
   *   409 Conflict            — booking is not in the status the
   *                              `kind` requires (e.g. `check_in` on
   *                              a `pending` booking) OR a sibling
   *                              row of this kind already exists.
   *   500 Internal Server Error — outbox payload validation failed
   *                                (server-side bug — never client-
   *                                triggerable because the contract
   *                                pipe gates the input).
   */
  @Post('api/v1/bookings/:bookingId/check-ins')
  @HttpCode(HttpStatus.CREATED)
  @UseGuards(AccessTokenGuard)
  @Idempotent()
  async record(
    @Param('bookingId') bookingId: string,
    @Body(new ZodValidationPipe(RecordBookingCheckInRequestSchema))
    body: RecordBookingCheckInRequest,
    @Req() request: RequestWithContext,
  ): Promise<RecordBookingCheckInResponse> {
    const userId = requireUserId(request);
    const result = await this.checkIns.record({
      actorUserId: userId,
      bookingId,
      request: body,
    });
    if (!result.ok) {
      throwCheckInsFailure(result.error);
    }
    return RecordBookingCheckInResponseSchema.parse({
      checkIn: toBookingCheckInResponse(result.value.checkIn),
      booking: BookingResponseSchema.parse(toBookingResponse(result.value.booking)),
    });
  }

  /**
   * GET /api/v1/bookings/:bookingId/check-ins — list check-ins for
   * the booking, ordered by `occurredAt` ascending.
   *
   * Status codes:
   *   200 OK              — body is `{ items: BookingCheckInResponse[] }`.
   *   401 Unauthorized    — missing / invalid access token.
   *   404 Not Found       — booking does not exist. The empty case
   *                          (booking exists, no check-ins yet) is a
   *                          200 with `items: []`.
   */
  @Get('api/v1/bookings/:bookingId/check-ins')
  @HttpCode(HttpStatus.OK)
  @UseGuards(AccessTokenGuard)
  async list(
    @Param('bookingId') bookingId: string,
    @Req() request: RequestWithContext,
  ): Promise<BookingCheckInsListResponse> {
    const userId = requireUserId(request);
    const result = await this.checkIns.listByBookingId({
      actorUserId: userId,
      bookingId,
    });
    if (!result.ok) {
      throwCheckInsFailure(result.error);
    }
    return BookingCheckInsListResponseSchema.parse({
      items: result.value.map((row) => toBookingCheckInResponse(row)),
    });
  }
}

function throwCheckInsFailure(failure: CheckInsServiceFailure): never {
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
    case 'invalid_lifecycle_state':
      throw new ConflictException({
        type: 'about:blank',
        title: 'Conflict',
        status: 409,
        detail: `Cannot record ${failure.kind} while booking is in ${failure.bookingStatus} (required: ${failure.requiredStatus}).`,
        bookingStatus: failure.bookingStatus,
        requiredStatus: failure.requiredStatus,
        kind: failure.kind,
      });
    case 'already_recorded':
      throw new ConflictException({
        type: 'about:blank',
        title: 'Conflict',
        status: 409,
        detail: `Booking ${failure.bookingId} already has a ${failure.kind} row.`,
        kind: failure.kind,
      });
    case 'booking_held':
      // TS-302e. Deliberately vague, and modelled on the TS-304 booking-create
      // 409: a hold means the provider, the senior, or the household is under
      // review for a high or critical concern, and the person reading this may
      // BE that subject. A check-in screen, with no context and nobody to ask,
      // is not where somebody should learn they are under review
      // (CLAUDE.md §3.9, §12). The incident id is NOT in the body — unlike the
      // booking-create 409, whose caller is the family portal's server side;
      // this response goes to a provider's phone.
      throw new ConflictException({
        type: 'about:blank',
        title: 'Conflict',
        status: 409,
        detail:
          'This visit is on hold and should not go ahead. Please contact the operations team and they will take it from here.',
        kind: failure.kind,
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
