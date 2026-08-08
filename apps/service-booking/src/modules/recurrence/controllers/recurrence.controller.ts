import {
  BadRequestException,
  ConflictException,
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  InternalServerErrorException,
  Post,
  Req,
  UnauthorizedException,
  UnprocessableEntityException,
  UseGuards,
  UsePipes,
} from '@nestjs/common';
import {
  BookingResponseSchema,
  CreateRecurringBookingRequestSchema,
  CreateRecurringBookingResponseSchema,
  type CreateRecurringBookingRequest,
  type CreateRecurringBookingResponse,
} from '@taste-and-see/contracts';
import { AccessTokenGuard, type RequestWithContext } from '@taste-and-see/nest-auth';
import { ZodValidationPipe } from '@taste-and-see/nest-common';
import { Idempotent } from '@taste-and-see/nest-idempotency';

import { toBookingResponse } from '../../bookings/mappers/booking.mapper';
import { toBookingRecurrenceRecord } from '../mappers/recurrence.mapper';
import type { RruleExpanderFailure } from '../rrule-expander';
import { RecurrenceService, type RecurrenceServiceFailure } from '../recurrence.service';

/**
 * Booking-recurrence HTTP boundary (TS-061; PRD §6.3).
 *
 * One endpoint:
 *
 *   POST /api/v1/bookings/recurring
 *     Create a recurring booking series. The caller supplies the
 *     anchor occurrence (scheduledStart / scheduledEnd) + an RFC 5545
 *     RRULE; the service explodes the RRULE into a finite list of
 *     occurrences (capped at RECURRENCE_MAX_OCCURRENCES = 52) and
 *     inserts them in one transaction. Idempotent on
 *     `Idempotency-Key`.
 *
 * Authentication. Same `AccessTokenGuard` as `BookingsController` —
 * every endpoint requires a Bearer access token minted by
 * `service-identity` (CLAUDE.md §3.2). Phase-1 row-level scoping is
 * "actor is a household member OR the assigned provider"; the cross-
 * service membership lookups land with TS-141 / TS-064. Today the
 * service trusts the controller's authenticated user id.
 *
 * **RRULE failure mapping.** RRULE parse failures (malformed,
 * unsupported clause, bad termination) surface as 422 Unprocessable
 * Entity — the request was well-formed at the JSON level (the Zod
 * pipe passed it) but the business rule rejected it. Empty-series
 * (`dtstart > UNTIL`) also lands at 422 since the request shape is
 * fine. Generic invalid_request stays at 400.
 */
@Controller()
export class RecurrenceController {
  constructor(private readonly recurrence: RecurrenceService) {}

  /**
   * POST /api/v1/bookings/recurring — create a recurring booking series.
   *
   * Status codes:
   *   201 Created               — body is `CreateRecurringBookingResponse`
   *                                with the recurrence record + every
   *                                materialised child booking.
   *   400 Bad Request           — payload failed Zod validation OR
   *                                service-layer invalid_request.
   *   401 Unauthorized          — missing / invalid access token.
   *   422 Unprocessable Entity  — RRULE parse failure or empty series.
   *   500 Internal Server Error — outbox payload validation failed
   *                                (server-side bug — never client-
   *                                triggerable because the contract
   *                                pipe gates the input).
   */
  @Post('api/v1/bookings/recurring')
  @HttpCode(HttpStatus.CREATED)
  @UseGuards(AccessTokenGuard)
  @UsePipes(new ZodValidationPipe(CreateRecurringBookingRequestSchema))
  @Idempotent()
  async createRecurringSeries(
    @Body() body: CreateRecurringBookingRequest,
    @Req() request: RequestWithContext,
  ): Promise<CreateRecurringBookingResponse> {
    const userId = requireUserId(request);
    const result = await this.recurrence.createRecurringSeries({
      actorUserId: userId,
      request: body,
    });
    if (!result.ok) {
      throwRecurrenceFailure(result.error);
    }
    return CreateRecurringBookingResponseSchema.parse({
      recurrence: toBookingRecurrenceRecord(result.value.recurrence),
      bookings: result.value.bookings.map((b) => BookingResponseSchema.parse(toBookingResponse(b))),
    });
  }
}

function throwRecurrenceFailure(failure: RecurrenceServiceFailure): never {
  switch (failure.reason) {
    case 'invalid_request':
      throw new BadRequestException({
        type: 'about:blank',
        title: 'Bad Request',
        status: 400,
        detail: failure.message,
      });
    case 'invalid_rrule':
      throw new UnprocessableEntityException({
        type: 'about:blank',
        title: 'Unprocessable Entity',
        status: 422,
        detail: rruleFailureMessage(failure.detail),
        rruleFailure: failure.detail.reason,
      });
    case 'empty_series':
      throw new UnprocessableEntityException({
        type: 'about:blank',
        title: 'Unprocessable Entity',
        status: 422,
        detail: failure.message,
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

function rruleFailureMessage(detail: RruleExpanderFailure): string {
  switch (detail.reason) {
    case 'malformed_rrule':
    case 'unsupported_clause':
    case 'invalid_interval':
    case 'invalid_count':
    case 'invalid_until':
    case 'unsupported_termination':
      return detail.message;
    case 'unsupported_frequency':
      return `RRULE frequency '${detail.freq}' is not supported in the Phase-1 subset`;
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
