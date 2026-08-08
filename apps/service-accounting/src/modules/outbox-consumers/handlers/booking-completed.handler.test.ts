import { BOOKING_COMPLETED } from '@taste-and-see/contracts';
import type { HandleArgs } from '@taste-and-see/nest-outbox-consumer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  BookingCommissionRecognizerService,
  RecognizeBookingCompletionFailure,
  RecognizeBookingCompletionOutput,
  Result,
} from '../../booking-commission/services/booking-commission-recognizer.service';
import { BookingCompletedHandler } from './booking-completed.handler';

/**
 * Minimal mock of `BookingCommissionRecognizerService` covering only
 * `recognizeBookingCompleted` — the handler under test never touches the
 * balance-read methods. The mock records every call so the tests can
 * assert on the boundary translation between the `booking.completed`
 * event payload and the `BookingCommissionRequest` shape.
 */
class FakeRecognizer
  implements Pick<BookingCommissionRecognizerService, 'recognizeBookingCompleted'>
{
  public calls: Array<
    Parameters<BookingCommissionRecognizerService['recognizeBookingCompleted']>[0]
  > = [];
  public nextResult: Result<RecognizeBookingCompletionOutput, RecognizeBookingCompletionFailure> = {
    ok: true,
    value: defaultSuccessOutput(),
  };

  recognizeBookingCompleted = vi.fn(
    async (
      request: Parameters<BookingCommissionRecognizerService['recognizeBookingCompleted']>[0],
    ): Promise<Result<RecognizeBookingCompletionOutput, RecognizeBookingCompletionFailure>> => {
      this.calls.push(request);
      return this.nextResult;
    },
  );
}

function defaultSuccessOutput(): RecognizeBookingCompletionOutput {
  return {
    journalId: 'jou_booking_001',
    bookingId: 'bk_001',
    providerId: 'prov_001',
    grossAmountMinor: 15_000,
    providerAmountMinor: 12_000,
    marketplaceAmountMinor: 3_000,
    commissionRateBps: 2_000,
    currency: 'USD',
    runningPayableMinor: 12_000,
    result: 'created',
  };
}

function buildHandleArgs(
  overrides: Partial<HandleArgs<typeof BOOKING_COMPLETED>['payload']> = {},
): HandleArgs<typeof BOOKING_COMPLETED> {
  const occurredAt = new Date('2026-05-13T12:00:00.000Z');
  return {
    envelope: {
      eventId: 'bk_001.completed',
      eventName: BOOKING_COMPLETED,
      occurredAt,
      producerService: 'service-booking',
      producerSchema: 'booking',
    },
    payload: {
      eventId: 'bk_001.completed',
      occurredAt: occurredAt.toISOString(),
      bookingId: 'bk_001',
      householdId: 'hh_001',
      seniorId: 'sen_001',
      providerId: 'prov_001',
      serviceKind: 'companion_dining',
      completedAt: '2026-05-13T11:30:00.000Z',
      currency: 'USD',
      grossAmountMinor: 15_000,
      providerAmountMinor: 12_000,
      marketplaceAmountMinor: 3_000,
      commissionRateBps: 2_000,
      ...overrides,
    },
  };
}

describe('BookingCompletedHandler', () => {
  let recognizer: FakeRecognizer;
  let handler: BookingCompletedHandler;

  beforeEach(() => {
    recognizer = new FakeRecognizer();
    handler = new BookingCompletedHandler(
      recognizer as unknown as BookingCommissionRecognizerService,
    );
  });

  describe('happy path', () => {
    it('translates the event payload into a BookingCommissionRequest and invokes the recognizer', async () => {
      await handler.handle(buildHandleArgs());
      expect(recognizer.recognizeBookingCompleted).toHaveBeenCalledTimes(1);
      const request = recognizer.calls[0];
      if (request === undefined) throw new Error('expected one call');
      expect(request.bookingId).toBe('bk_001');
      expect(request.providerId).toBe('prov_001');
      expect(request.householdId).toBe('hh_001');
      expect(request.grossAmountMinor).toBe(15_000);
      expect(request.providerAmountMinor).toBe(12_000);
      expect(request.marketplaceAmountMinor).toBe(3_000);
      expect(request.commissionRateBps).toBe(2_000);
      expect(request.currency).toBe('USD');
      expect(request.completedAt).toBe('2026-05-13T11:30:00.000Z');
    });

    it('maps the envelope eventId 1:1 onto the recognizer sourceEventId', async () => {
      await handler.handle(buildHandleArgs());
      const request = recognizer.calls[0];
      if (request === undefined) throw new Error('expected one call');
      expect(request.sourceEventId).toBe('bk_001.completed');
    });

    it('passes producer service + schema + seniorId + serviceKind on the context', async () => {
      await handler.handle(buildHandleArgs());
      const request = recognizer.calls[0];
      if (request === undefined) throw new Error('expected one call');
      expect(request.context).toEqual({
        producerService: 'service-booking',
        producerSchema: 'booking',
        seniorId: 'sen_001',
        serviceKind: 'companion_dining',
      });
    });

    it('returns successfully when the recognizer reports idempotent_replay', async () => {
      recognizer.nextResult = {
        ok: true,
        value: { ...defaultSuccessOutput(), result: 'idempotent_replay' },
      };
      await expect(handler.handle(buildHandleArgs())).resolves.toBeUndefined();
      expect(recognizer.recognizeBookingCompleted).toHaveBeenCalledTimes(1);
    });

    it('honours a full-platform-retention booking (0 provider portion)', async () => {
      await handler.handle(
        buildHandleArgs({
          grossAmountMinor: 5_000,
          providerAmountMinor: 0,
          marketplaceAmountMinor: 5_000,
          commissionRateBps: 10_000,
        }),
      );
      const request = recognizer.calls[0];
      if (request === undefined) throw new Error('expected one call');
      expect(request.providerAmountMinor).toBe(0);
      expect(request.marketplaceAmountMinor).toBe(5_000);
    });
  });

  describe('currency gating', () => {
    it('throws on non-USD currency without calling the recognizer', async () => {
      await expect(handler.handle(buildHandleArgs({ currency: 'EUR' }))).rejects.toThrow(
        /unsupported currency 'EUR'/,
      );
      expect(recognizer.recognizeBookingCompleted).not.toHaveBeenCalled();
    });

    it('throws on GBP / JPY / any non-USD code (Phase 1 cap)', async () => {
      await expect(handler.handle(buildHandleArgs({ currency: 'GBP' }))).rejects.toThrow(
        /unsupported currency 'GBP'/,
      );
      await expect(handler.handle(buildHandleArgs({ currency: 'JPY' }))).rejects.toThrow(
        /unsupported currency 'JPY'/,
      );
      expect(recognizer.recognizeBookingCompleted).not.toHaveBeenCalled();
    });
  });

  describe('recognizer failure surfaces', () => {
    it('rethrows on amount_non_positive', async () => {
      recognizer.nextResult = {
        ok: false,
        failure: { kind: 'amount_non_positive' },
      };
      await expect(handler.handle(buildHandleArgs())).rejects.toThrow(/^amount_non_positive:/);
    });

    it('rethrows on amount_invariant_violated', async () => {
      recognizer.nextResult = {
        ok: false,
        failure: { kind: 'amount_invariant_violated' },
      };
      await expect(handler.handle(buildHandleArgs())).rejects.toThrow(
        /^amount_invariant_violated:/,
      );
    });

    it('rethrows on journal_post_failed with the inner failure kind', async () => {
      recognizer.nextResult = {
        ok: false,
        failure: {
          kind: 'journal_post_failed',
          failure: { kind: 'account_not_found', accountCode: '1000' },
        },
      };
      await expect(handler.handle(buildHandleArgs())).rejects.toThrow(
        /journal_post_failed: account_not_found/,
      );
    });

    it('still invokes the recognizer exactly once even when it fails (SDK redelivery is the retry mechanism)', async () => {
      recognizer.nextResult = {
        ok: false,
        failure: { kind: 'amount_non_positive' },
      };
      await expect(handler.handle(buildHandleArgs())).rejects.toThrow();
      expect(recognizer.recognizeBookingCompleted).toHaveBeenCalledTimes(1);
    });
  });
});
