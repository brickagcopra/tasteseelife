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
  Patch,
  Post,
  Req,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import {
  BookingDisputeResponseSchema,
  BookingDisputesListResponseSchema,
  OpenBookingDisputeRequestSchema,
  UpdateBookingDisputeRequestSchema,
  type BookingDisputeResponse,
  type BookingDisputesListResponse,
  type OpenBookingDisputeRequest,
  type UpdateBookingDisputeRequest,
} from '@taste-and-see/contracts';
import { AccessTokenGuard, type RequestWithContext } from '@taste-and-see/nest-auth';
import { ZodValidationPipe } from '@taste-and-see/nest-common';
import { Idempotent } from '@taste-and-see/nest-idempotency';

import { toBookingDisputeResponse } from '../mappers/disputes.mapper';
import { DisputesService, type DisputesServiceFailure } from '../services/disputes.service';

/**
 * Booking disputes HTTP boundary (TS-065; PRD §10.5).
 *
 * Four endpoints span the dispute lifecycle:
 *
 *   POST /api/v1/bookings/:bookingId/disputes
 *     Open a new dispute against a booking. Idempotent on
 *     `Idempotency-Key`. The opener supplies a categorical `reason`
 *     plus optional freeform `reasonDetail`. The service stamps
 *     `openedByUserId` (the authenticated actor) and derives
 *     `openedByRole` from the actor's role assignments — neither is
 *     client-supplied (CLAUDE.md §3.2).
 *
 *   GET /api/v1/bookings/:bookingId/disputes
 *     List every dispute for the booking, ordered by `createdAt`
 *     ascending. Multiple disputes per booking are permitted.
 *
 *   GET /api/v1/disputes/:disputeId
 *     Read a single dispute by id.
 *
 *   PATCH /api/v1/disputes/:disputeId
 *     Transition the dispute status (under_review / resolved /
 *     dismissed). Idempotent on `Idempotency-Key`. The service
 *     enforces the state-machine matrix; the controller exposes the
 *     subset of transitionable targets (the API never lets a caller
 *     flip back to `open`).
 *
 * Authentication. Every endpoint requires a valid Bearer access token
 * minted by `service-identity`. The `AccessTokenGuard` attaches a
 * decoded `requestContext` to the request; the controller forwards
 * `requestContext.userId` AND the active role names to the service.
 *
 * Authorization. Phase-1 service-layer "actor must be a household
 * member / the assigned provider / an admin", but the cross-service
 * membership lookups (TS-141 Prisma extension) haven't landed yet —
 * service today trusts the authenticated `userId` and records it on
 * the row for downstream audit. The endpoint stays usable today AND
 * the gate can be tightened without a contract change.
 * TS-065-followup captures the actor / household / provider /
 * admin-staff match checks.
 *
 * Idempotency. POST + PATCH wear `@Idempotent()` so a retried request
 * returns the cached response rather than mutating twice
 * (CLAUDE.md §3.3 / §17.5). GETs don't need it.
 */
@Controller()
export class DisputesController {
  constructor(private readonly disputes: DisputesService) {}

  /**
   * POST /api/v1/bookings/:bookingId/disputes — open a new dispute.
   *
   * Status codes:
   *   201 Created             — body is the new dispute row.
   *   400 Bad Request         — payload failed validation OR
   *                              service-layer invalid_request.
   *   401 Unauthorized        — missing / invalid access token.
   *   404 Not Found           — booking does not exist.
   *   409 Conflict            — booking is in `pending` (no service
   *                              rendered yet; cancel instead).
   *   500 Internal Server Error — outbox payload validation failed
   *                                (server-side bug — never client-
   *                                triggerable because the contract
   *                                pipe gates the input).
   */
  @Post('api/v1/bookings/:bookingId/disputes')
  @HttpCode(HttpStatus.CREATED)
  @UseGuards(AccessTokenGuard)
  @Idempotent()
  async openDispute(
    @Param('bookingId') bookingId: string,
    @Body(new ZodValidationPipe(OpenBookingDisputeRequestSchema)) body: OpenBookingDisputeRequest,
    @Req() request: RequestWithContext,
  ): Promise<BookingDisputeResponse> {
    const ctx = requireRequestContext(request);
    const result = await this.disputes.openDispute({
      actorUserId: ctx.userId,
      actorRoleNames: ctx.roleNames,
      bookingId,
      request: body,
    });
    if (!result.ok) {
      throwDisputesFailure(result.error);
    }
    return BookingDisputeResponseSchema.parse(toBookingDisputeResponse(result.value));
  }

  /**
   * GET /api/v1/bookings/:bookingId/disputes — list disputes for the
   * booking, chronological ascending.
   *
   * Status codes:
   *   200 OK              — body is `{ items: BookingDisputeResponse[] }`.
   *                          Empty list (no disputes filed) is a 200
   *                          with `items: []`.
   *   401 Unauthorized    — missing / invalid access token.
   *   404 Not Found       — booking does not exist.
   */
  @Get('api/v1/bookings/:bookingId/disputes')
  @HttpCode(HttpStatus.OK)
  @UseGuards(AccessTokenGuard)
  async listByBookingId(
    @Param('bookingId') bookingId: string,
    @Req() request: RequestWithContext,
  ): Promise<BookingDisputesListResponse> {
    const ctx = requireRequestContext(request);
    const result = await this.disputes.listByBookingId({
      actorUserId: ctx.userId,
      bookingId,
    });
    if (!result.ok) {
      throwDisputesFailure(result.error);
    }
    return BookingDisputesListResponseSchema.parse({
      items: result.value.map((row) => toBookingDisputeResponse(row)),
    });
  }

  /**
   * GET /api/v1/disputes/:disputeId — read a single dispute.
   *
   * Status codes:
   *   200 OK              — body is the BookingDisputeResponse.
   *   401 Unauthorized    — missing / invalid access token.
   *   404 Not Found       — dispute does not exist.
   */
  @Get('api/v1/disputes/:disputeId')
  @HttpCode(HttpStatus.OK)
  @UseGuards(AccessTokenGuard)
  async getById(
    @Param('disputeId') disputeId: string,
    @Req() request: RequestWithContext,
  ): Promise<BookingDisputeResponse> {
    const ctx = requireRequestContext(request);
    const result = await this.disputes.getById({
      actorUserId: ctx.userId,
      disputeId,
    });
    if (!result.ok) {
      throwDisputesFailure(result.error);
    }
    return BookingDisputeResponseSchema.parse(toBookingDisputeResponse(result.value));
  }

  /**
   * PATCH /api/v1/disputes/:disputeId — transition the dispute
   * status.
   *
   * Status codes:
   *   200 OK              — body is the updated BookingDisputeResponse.
   *   400 Bad Request     — payload failed validation OR
   *                          service-layer invalid_request OR
   *                          resolution_notes_required.
   *   401 Unauthorized    — missing / invalid access token.
   *   404 Not Found       — dispute does not exist.
   *   409 Conflict        — requested transition is not legal from
   *                          the dispute's current status (e.g.
   *                          attempting to resolve a `resolved` row).
   *   500 Internal Server Error — outbox payload validation failed.
   */
  @Patch('api/v1/disputes/:disputeId')
  @HttpCode(HttpStatus.OK)
  @UseGuards(AccessTokenGuard)
  @Idempotent()
  async updateDispute(
    @Param('disputeId') disputeId: string,
    @Body(new ZodValidationPipe(UpdateBookingDisputeRequestSchema))
    body: UpdateBookingDisputeRequest,
    @Req() request: RequestWithContext,
  ): Promise<BookingDisputeResponse> {
    const ctx = requireRequestContext(request);
    const result = await this.disputes.updateDispute({
      actorUserId: ctx.userId,
      disputeId,
      request: body,
    });
    if (!result.ok) {
      throwDisputesFailure(result.error);
    }
    return BookingDisputeResponseSchema.parse(toBookingDisputeResponse(result.value));
  }
}

function throwDisputesFailure(failure: DisputesServiceFailure): never {
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
    case 'dispute_not_found':
      throw new NotFoundException({
        type: 'about:blank',
        title: 'Not Found',
        status: 404,
        detail: `Dispute ${failure.disputeId} not found.`,
      });
    case 'invalid_booking_status':
      throw new ConflictException({
        type: 'about:blank',
        title: 'Conflict',
        status: 409,
        detail: `Disputes cannot be opened while the booking is in ${failure.bookingStatus}.`,
        bookingStatus: failure.bookingStatus,
        allowed: failure.allowed,
      });
    case 'invalid_status_transition':
      throw new ConflictException({
        type: 'about:blank',
        title: 'Conflict',
        status: 409,
        detail: `Dispute cannot transition from ${failure.from} to ${failure.to}.`,
        from: failure.from,
        to: failure.to,
        allowed: failure.allowed,
      });
    case 'resolution_notes_required':
      throw new BadRequestException({
        type: 'about:blank',
        title: 'Bad Request',
        status: 400,
        detail: 'resolutionNotes is required when transitioning to resolved or dismissed.',
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
 * Extract the auth context — userId + active role names — from the
 * `AccessTokenGuard`-decorated request. The role names are flattened
 * from `requestContext.roles[].name` so the service layer can run a
 * single `O(roles.length)` admin / provider scan without seeing the
 * full `RoleAssignment` shape (PDD §10.2 / CLAUDE.md §3.2).
 */
function requireRequestContext(request: RequestWithContext): {
  readonly userId: string;
  readonly roleNames: readonly string[];
} {
  const ctx = request.requestContext;
  if (ctx === undefined) {
    throw new UnauthorizedException({
      type: 'about:blank',
      title: 'Unauthorized',
      status: 401,
      detail: 'Authentication required.',
    });
  }
  return {
    userId: ctx.userId,
    roleNames: ctx.roles.map((r) => r.name),
  };
}
