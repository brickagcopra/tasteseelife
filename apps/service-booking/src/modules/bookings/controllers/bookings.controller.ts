import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  HttpStatus,
  InternalServerErrorException,
  NotFoundException,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UnauthorizedException,
  UseGuards,
  UsePipes,
} from '@nestjs/common';
import { holdsAdminRole } from '@taste-and-see/auth-sdk';
import {
  AcceptBookingRequestSchema,
  BookingResponseSchema,
  BookingsListResponseSchema,
  type AcceptBookingRequest,
  type BookingResponse,
  type BookingsListResponse,
  type CreateBookingRequest,
  CreateBookingRequestSchema,
  type DeclineBookingRequest,
  DeclineBookingRequestSchema,
  type ListBookingsQuery,
  ListBookingsQuerySchema,
  type TransitionBookingStatusRequest,
  TransitionBookingStatusRequestSchema,
} from '@taste-and-see/contracts';
import { AccessTokenGuard, type RequestWithContext } from '@taste-and-see/nest-auth';
import { ZodValidationPipe } from '@taste-and-see/nest-common';
import { Idempotent } from '@taste-and-see/nest-idempotency';

import { toBookingResponse } from '../mappers/booking.mapper';
import { BookingsListService } from '../services/bookings-list.service';
import { BookingsService, type BookingsServiceFailure } from '../services/bookings.service';

/**
 * Booking HTTP boundary (TS-060-followup-1). Three endpoints:
 *
 *   POST /api/v1/bookings
 *     Create a new booking in `pending`. Idempotent on
 *     `Idempotency-Key` header.
 *
 *   PATCH /api/v1/bookings/:id/status
 *     Transition a booking's lifecycle status (confirmed →
 *     in_progress → completed | canceled). Server validates the
 *     state-machine matrix and rejects illegal transitions with 409.
 *     Idempotent on `Idempotency-Key` so a retried PATCH lands at most
 *     once.
 *
 *   GET /api/v1/bookings/:id
 *     Read a single booking. Row-level access today is a thin marker
 *     (the actor's userId is logged); full row-level enforcement
 *     lands with TS-141 + the gateway BFF's tenant scoping (TS-140).
 *
 * Authentication. Every endpoint requires a valid Bearer access token
 * minted by `service-identity` (CLAUDE.md §3.2). The
 * `AccessTokenGuard` attaches a decoded `requestContext` to the
 * request; the controller passes `request.requestContext.userId` to
 * the service for row-level / audit purposes.
 *
 * Authorization. Phase-1 tenant scoping is service-layer "actor must
 * be a member of this household OR the assigned provider", but the
 * cross-service membership lookups (TS-064 tier gating + TS-141
 * Prisma extension) haven't landed yet, so today the service trusts
 * the controller's authenticated `userId` and records it on the
 * cancel event for downstream audit. The endpoint stays usable today
 * AND the gate can be tightened without a contract change.
 *
 * Idempotency. Both write endpoints wear `@Idempotent()` so a
 * retried request returns the cached response rather than mutating
 * twice (CLAUDE.md §3.3 / §17.5).
 */
@Controller()
export class BookingsController {
  constructor(
    private readonly bookings: BookingsService,
    private readonly bookingsList: BookingsListService,
  ) {}

  /**
   * POST /api/v1/bookings — create a new booking in `pending`.
   *
   * Status codes:
   *   201 Created          — body is the BookingResponse.
   *   400 Bad Request      — payload failed validation OR
   *                          service-layer invalid_request.
   *   401 Unauthorized     — missing / invalid access token.
   *   500 Internal Server Error — outbox payload validation failed
   *                                (server-side bug — never client-
   *                                triggerable because the contract
   *                                pipe gates the input).
   */
  @Post('api/v1/bookings')
  @HttpCode(HttpStatus.CREATED)
  @UseGuards(AccessTokenGuard)
  @UsePipes(new ZodValidationPipe(CreateBookingRequestSchema))
  @Idempotent()
  async createBooking(
    @Body() body: CreateBookingRequest,
    @Req() request: RequestWithContext,
  ): Promise<BookingResponse> {
    const userId = requireUserId(request);
    const result = await this.bookings.createBooking({
      actorUserId: userId,
      request: body,
    });
    if (!result.ok) {
      throwBookingsFailure(result.error);
    }
    return BookingResponseSchema.parse(toBookingResponse(result.value));
  }

  /**
   * PATCH /api/v1/bookings/:id/status — transition status.
   *
   * Status codes:
   *   200 OK               — body is the updated BookingResponse.
   *   400 Bad Request      — payload failed validation.
   *   401 Unauthorized     — missing / invalid access token.
   *   404 Not Found        — booking id does not exist.
   *   409 Conflict         — illegal state-machine transition.
   *   500 Internal Server Error — outbox validation failure.
   */
  @Patch('api/v1/bookings/:id/status')
  @HttpCode(HttpStatus.OK)
  @UseGuards(AccessTokenGuard)
  @Idempotent()
  async transitionStatus(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(TransitionBookingStatusRequestSchema))
    body: TransitionBookingStatusRequest,
    @Req() request: RequestWithContext,
  ): Promise<BookingResponse> {
    const userId = requireUserId(request);
    const result = await this.bookings.transitionStatus({
      actorUserId: userId,
      actorKind: requireActorKind(request),
      bookingId: id,
      targetStatus: body.targetStatus,
      ...(body.cancellationReason !== undefined && {
        cancellationReason: body.cancellationReason,
      }),
      ...(body.cancellationReasonText !== undefined && {
        cancellationReasonText: body.cancellationReasonText,
      }),
    });
    if (!result.ok) {
      throwBookingsFailure(result.error);
    }
    return BookingResponseSchema.parse(toBookingResponse(result.value));
  }

  /**
   * POST /api/v1/bookings/:id/accept (TS-205) — provider accepts the
   * inbound booking request, transitioning `pending` → `confirmed`.
   *
   * Status codes:
   *   200 OK              — body is the updated BookingResponse.
   *   400 Bad Request     — payload failed validation (the body is
   *                          intentionally empty today; this fires
   *                          only for unknown fields per `.strict()`).
   *   401 Unauthorized    — missing / invalid access token.
   *   404 Not Found       — booking id does not exist.
   *   409 Conflict        — booking is no longer in `pending`
   *                          (illegal_transition) OR the accept window
   *                          has expired (accept_window_expired).
   *   500 Internal Server Error — outbox validation failure.
   */
  @Post('api/v1/bookings/:id/accept')
  @HttpCode(HttpStatus.OK)
  @UseGuards(AccessTokenGuard)
  @Idempotent()
  async acceptBooking(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(AcceptBookingRequestSchema)) _body: AcceptBookingRequest,
    @Req() request: RequestWithContext,
  ): Promise<BookingResponse> {
    const userId = requireUserId(request);
    const result = await this.bookings.acceptBooking({
      actorUserId: userId,
      bookingId: id,
    });
    if (!result.ok) {
      throwBookingsFailure(result.error);
    }
    return BookingResponseSchema.parse(toBookingResponse(result.value));
  }

  /**
   * POST /api/v1/bookings/:id/decline (TS-205) — provider declines
   * the inbound booking request, transitioning `pending` → `declined`.
   *
   * Status codes:
   *   200 OK              — body is the updated BookingResponse.
   *   400 Bad Request     — payload failed validation (missing
   *                          declineReason, unknown decline reason,
   *                          unknown fields, etc.).
   *   401 Unauthorized    — missing / invalid access token.
   *   404 Not Found       — booking id does not exist.
   *   409 Conflict        — booking is no longer in `pending`
   *                          (illegal_transition).
   *   500 Internal Server Error — outbox validation failure.
   */
  @Post('api/v1/bookings/:id/decline')
  @HttpCode(HttpStatus.OK)
  @UseGuards(AccessTokenGuard)
  @Idempotent()
  async declineBooking(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(DeclineBookingRequestSchema)) body: DeclineBookingRequest,
    @Req() request: RequestWithContext,
  ): Promise<BookingResponse> {
    const userId = requireUserId(request);
    const result = await this.bookings.declineBooking({
      actorUserId: userId,
      bookingId: id,
      declineKind: 'provider_declined',
      declineReason: body.declineReason,
      ...(body.declineReasonText !== undefined && {
        declineReasonText: body.declineReasonText,
      }),
    });
    if (!result.ok) {
      throwBookingsFailure(result.error);
    }
    return BookingResponseSchema.parse(toBookingResponse(result.value));
  }

  /**
   * GET /api/v1/bookings?householdId=...&limit=...&cursor=... (TS-125).
   *
   * Lists bookings for a single household, newest-first, with opaque
   * cursor pagination. Drives the family-portal `/bookings` page.
   *
   * Status codes:
   *   200 OK              — body is the BookingsListResponse.
   *   400 Bad Request     — query failed validation (missing householdId, etc.).
   *   401 Unauthorized    — missing / invalid access token.
   */
  @Get('api/v1/bookings')
  @HttpCode(HttpStatus.OK)
  @UseGuards(AccessTokenGuard)
  async listBookings(
    @Query(new ZodValidationPipe(ListBookingsQuerySchema)) query: ListBookingsQuery,
    @Req() request: RequestWithContext,
  ): Promise<BookingsListResponse> {
    const userId = requireUserId(request);
    const result = await this.bookingsList.listByHousehold({
      actorUserId: userId,
      householdId: query.householdId,
      limit: query.limit,
      cursor: query.cursor,
    });
    return BookingsListResponseSchema.parse({
      bookings: result.rows.map((row) => toBookingResponse(row)),
      nextCursor: result.nextCursor,
    });
  }

  /**
   * GET /api/v1/bookings/:id — read a single booking.
   *
   * Status codes:
   *   200 OK              — body is the BookingResponse.
   *   401 Unauthorized    — missing / invalid access token.
   *   404 Not Found       — booking id does not exist.
   */
  @Get('api/v1/bookings/:id')
  @HttpCode(HttpStatus.OK)
  @UseGuards(AccessTokenGuard)
  async getBooking(
    @Param('id') id: string,
    @Req() request: RequestWithContext,
  ): Promise<BookingResponse> {
    const userId = requireUserId(request);
    const result = await this.bookings.getById({ actorUserId: userId, bookingId: id });
    if (!result.ok) {
      throwBookingsFailure(result.error);
    }
    return BookingResponseSchema.parse(toBookingResponse(result.value));
  }
}

function throwBookingsFailure(failure: BookingsServiceFailure): never {
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
        allowedTransitions: failure.allowed,
      });
    case 'tier_gating_violation':
      throw new ConflictException({
        type: 'about:blank',
        title: 'Conflict',
        status: 409,
        detail: tierGatingDetail(failure.violationReason),
        violationReason: failure.violationReason,
        householdTier: failure.householdTier,
        providerTier: failure.providerTier,
      });
    case 'accept_window_expired':
      throw new ConflictException({
        type: 'about:blank',
        title: 'Conflict',
        status: 409,
        detail: `Accept window expired at ${failure.windowExpiredAt.toISOString()}; booking is past the configured response window.`,
        windowExpiredAt: failure.windowExpiredAt.toISOString(),
      });
    case 'subject_on_hold':
      // 409, not 403: the request is well-formed and the caller is
      // authorised — it conflicts with an active hold, exactly as the
      // tier-gating refusal above conflicts with an active policy. The
      // `incidentId` is here for ops correlation, NOT for the family's
      // eyes; see `subjectHoldDetail` for the disclosure reasoning.
      throw new ConflictException({
        type: 'about:blank',
        title: 'Conflict',
        status: 409,
        detail: subjectHoldDetail(),
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

/**
 * The family-facing message for a trust & safety hold (TS-304).
 *
 * Deliberately vague about WHY. A hold means the provider, the senior, or
 * the household is under review for a `high` / `critical` concern, and the
 * person reading this is often the family member who booked — sometimes the
 * very person a conduct report names. Disclosing the category ("welfare",
 * "safety") or who is implicated would leak an allegation through a booking
 * form (CLAUDE.md §3.9, §12). The incident id rides in a separate field so
 * support and ops can navigate to it from a request id; the prose stays
 * hospitality-framed and points at a human.
 *
 * "Temporarily unavailable" is accurate, not a euphemism: the hold is
 * reversible and lifts when the review closes.
 */
function subjectHoldDetail(): string {
  return 'Booking is temporarily unavailable while our care team completes a review. Please contact support and we will help you arrange this visit.';
}

function tierGatingDetail(reason: string): string {
  switch (reason) {
    case 'tier_3_requires_elite':
      return 'Tier 3 Concierge households can only book Elite Concierge providers.';
    case 'household_snapshot_unknown':
      return 'Household subscription tier is unknown; cannot evaluate eligibility.';
    case 'provider_snapshot_unknown':
      return 'Provider tier is unknown; cannot evaluate eligibility.';
    case 'service_kind_requires_higher_tier':
      return 'This service requires a higher-tier provider than the one assigned.';
    default:
      return 'Tier-gating policy rejected the booking.';
  }
}

/**
 * Derive the actor's KIND from the VERIFIED token (TS-308c-followup-3).
 *
 * The request boundary is the only place on this platform where the
 * question is answerable: `service-booking` cannot resolve who a user id
 * belongs to (CLAUDE.md §2.3), but the token's `roles` claim already
 * says whether the caller holds an admin-staff role, and `holdsAdminRole`
 * is the same predicate `service-identity` uses for the staff MFA gate —
 * so issuer and verifier cannot drift on what "staff" means.
 *
 * Read from `request.requestContext`, never from a body: a caller who
 * could name their own kind could exempt themselves from a safety
 * detector, which is the whole point of the field.
 *
 * A missing context is the 401 `requireUserId` already raises; this is
 * only reached after it.
 */
function requireActorKind(request: RequestWithContext): 'staff' | 'customer' {
  const ctx = request.requestContext;
  if (ctx === undefined) return 'customer';
  return holdsAdminRole(ctx.roles) ? 'staff' : 'customer';
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
