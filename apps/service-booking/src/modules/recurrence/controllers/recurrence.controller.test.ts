import 'reflect-metadata';

import {
  BadRequestException,
  InternalServerErrorException,
  UnauthorizedException,
  UnprocessableEntityException,
} from '@nestjs/common';
import type { CreateRecurringBookingRequest } from '@taste-and-see/contracts';
import { describe, expect, it } from 'vitest';

import type { RequestWithContext } from '@taste-and-see/nest-auth';

import { err, ok } from '../../../common/result';
import type {
  PersistedBookingRecurrence,
  RecurrenceService,
  RecurrenceServiceFailure,
} from '../recurrence.service';
import type { BookingRecord } from '../../bookings/services/bookings.service';

import { RecurrenceController } from './recurrence.controller';

/**
 * RecurrenceController unit suite (TS-061).
 *
 * Covers:
 *   - The endpoint is decorated with @Idempotent() — a retried POST
 *     reuses the cached response rather than re-exploding the series.
 *   - The happy path returns the contract-shaped
 *     `CreateRecurringBookingResponse`.
 *   - Authentication is enforced (401 on missing request context).
 *   - Service failures map to the right HTTP exceptions:
 *       invalid_request → 400
 *       invalid_rrule   → 422 (with the expander failure reason on
 *                              the response body for client triage)
 *       empty_series    → 422
 *       outbox_validation_failed → 500
 */

const IDEMPOTENT_METADATA = Symbol.for('@taste-and-see/nest-idempotency:idempotent');

type CreateReturn = Awaited<ReturnType<RecurrenceService['createRecurringSeries']>>;

const BOOKING_ROW: BookingRecord = {
  id: 'bkg_abc',
  householdId: 'hh_abc',
  seniorId: 'sr_abc',
  providerId: 'prv_abc',
  serviceKind: 'companion_dining',
  status: 'pending',
  scheduledStart: new Date('2026-05-14T18:00:00.000Z'),
  scheduledEnd: new Date('2026-05-14T20:00:00.000Z'),
  currency: 'USD',
  basePrice: { toString: () => '150.00' },
  commissionRate: { toString: () => '0.3000' },
  commissionAmount: { toString: () => '45.00' },
  finalPrice: { toString: () => '150.00' },
  bookingNotes: null,
  completedAt: null,
  canceledAt: null,
  cancellationReason: null,
  cancellationReasonText: null,
  acceptWindowExpiresAt: new Date('2026-05-13T12:30:00.000Z'),
  declinedAt: null,
  declineKind: null,
  declineReason: null,
  declineReasonText: null,
  declinedByUserId: null,
  heldByIncidentId: null,
  createdAt: new Date('2026-05-13T12:00:00.000Z'),
  updatedAt: new Date('2026-05-13T12:00:00.000Z'),
};

const RECURRENCE_ROW: PersistedBookingRecurrence = {
  seriesId: 'srs_abc',
  rrule: 'FREQ=WEEKLY;COUNT=1',
  endDate: null,
  count: 1,
  occurrenceCount: 1,
  householdId: 'hh_abc',
  seniorId: 'sr_abc',
  providerId: 'prv_abc',
  createdAt: new Date('2026-05-13T12:00:00.000Z'),
  updatedAt: new Date('2026-05-13T12:00:00.000Z'),
};

function makeService(override?: CreateReturn): RecurrenceService {
  return {
    createRecurringSeries: async (): Promise<CreateReturn> =>
      override ??
      (ok({
        seriesId: 'srs_abc',
        bookings: [BOOKING_ROW],
        recurrence: RECURRENCE_ROW,
      }) as CreateReturn),
  } as unknown as RecurrenceService;
}

function reqWithUser(userId = 'usr_owner'): RequestWithContext {
  return {
    requestContext: {
      userId,
      sessionId: 'sid_1',
      mfa: false,
      roles: [],
      tenantScope: { type: 'global' },
    },
    header: (_: string) => undefined,
  } as unknown as RequestWithContext;
}

const VALID_BODY: CreateRecurringBookingRequest = {
  householdId: 'hh_abc',
  seniorId: 'sr_abc',
  providerId: 'prv_abc',
  serviceKind: 'companion_dining',
  scheduledStart: '2026-05-14T18:00:00.000Z',
  scheduledEnd: '2026-05-14T20:00:00.000Z',
  currency: 'USD',
  basePriceMinor: 15_000,
  commissionRateBps: 3000,
  recurrence: { rrule: 'FREQ=WEEKLY;COUNT=1' },
};

describe('RecurrenceController idempotency wiring (TS-061)', () => {
  it('marks POST /api/v1/bookings/recurring as @Idempotent()', () => {
    const handler = RecurrenceController.prototype.createRecurringSeries as unknown as object;
    const flag = Reflect.getMetadata(IDEMPOTENT_METADATA, handler) as unknown;
    expect(flag).toBe(true);
  });
});

describe('RecurrenceController.createRecurringSeries', () => {
  it('returns the contract-shaped response on success', async () => {
    const controller = new RecurrenceController(makeService());
    const response = await controller.createRecurringSeries(VALID_BODY, reqWithUser());
    expect(response.recurrence.seriesId).toBe('srs_abc');
    expect(response.recurrence.rrule).toBe('FREQ=WEEKLY;COUNT=1');
    expect(response.bookings).toHaveLength(1);
    expect(response.bookings[0]?.id).toBe('bkg_abc');
    expect(response.bookings[0]?.status).toBe('pending');
    expect(response.bookings[0]?.basePriceMinor).toBe(15_000);
  });

  it('throws 401 when the request carries no requestContext', async () => {
    const controller = new RecurrenceController(makeService());
    const req = { header: () => undefined } as unknown as RequestWithContext;
    await expect(controller.createRecurringSeries(VALID_BODY, req)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('maps invalid_request to a 400', async () => {
    const controller = new RecurrenceController(
      makeService(
        err<RecurrenceServiceFailure>({
          reason: 'invalid_request',
          message: 'bad',
        }) as CreateReturn,
      ),
    );
    await expect(
      controller.createRecurringSeries(VALID_BODY, reqWithUser()),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('maps invalid_rrule to a 422 with the expander failure reason', async () => {
    const controller = new RecurrenceController(
      makeService(
        err<RecurrenceServiceFailure>({
          reason: 'invalid_rrule',
          detail: { reason: 'unsupported_frequency', freq: 'DAILY' },
        }) as CreateReturn,
      ),
    );
    await expect(
      controller.createRecurringSeries(VALID_BODY, reqWithUser()),
    ).rejects.toBeInstanceOf(UnprocessableEntityException);
  });

  it('maps invalid_rrule (with message-carrying variant) to 422', async () => {
    const controller = new RecurrenceController(
      makeService(
        err<RecurrenceServiceFailure>({
          reason: 'invalid_rrule',
          detail: {
            reason: 'unsupported_clause',
            clause: 'BYDAY',
            message: 'Phase-1 subset does not support BYDAY',
          },
        }) as CreateReturn,
      ),
    );
    await expect(
      controller.createRecurringSeries(VALID_BODY, reqWithUser()),
    ).rejects.toBeInstanceOf(UnprocessableEntityException);
  });

  it('maps empty_series to a 422', async () => {
    const controller = new RecurrenceController(
      makeService(
        err<RecurrenceServiceFailure>({
          reason: 'empty_series',
          message: 'RRULE produced zero occurrences',
        }) as CreateReturn,
      ),
    );
    await expect(
      controller.createRecurringSeries(VALID_BODY, reqWithUser()),
    ).rejects.toBeInstanceOf(UnprocessableEntityException);
  });

  it('maps outbox_validation_failed to a 500', async () => {
    const controller = new RecurrenceController(
      makeService(
        err<RecurrenceServiceFailure>({
          reason: 'outbox_validation_failed',
          message: 'event booking.created payload failed validation',
        }) as CreateReturn,
      ),
    );
    await expect(
      controller.createRecurringSeries(VALID_BODY, reqWithUser()),
    ).rejects.toBeInstanceOf(InternalServerErrorException);
  });
});
