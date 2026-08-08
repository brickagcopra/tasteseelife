import { SUBSCRIPTION_ACTIVATED } from '@taste-and-see/contracts';
import type { HandleArgs } from '@taste-and-see/nest-outbox-consumer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  CancelDeferredRevenueFailure,
  CancelDeferredRevenueOutput,
  RecognizeActivationFailure,
  RecognizeActivationOutput,
  Result,
  SubscriptionRevenueRecognizerService,
} from '../../revenue-recognition/services/subscription-revenue-recognizer.service';
import { SubscriptionActivatedHandler } from './subscription-activated.handler';

/**
 * Minimal mock of `SubscriptionRevenueRecognizerService` covering only
 * `recognizeActivation` — the handler under test never touches the
 * cancel or daily-sweep methods. The mock records every call so the
 * tests can assert on the boundary translation between the event
 * payload and the `RecognizeActivationRequest` shape.
 */
class FakeRecognizer implements Pick<SubscriptionRevenueRecognizerService, 'recognizeActivation'> {
  public calls: Array<Parameters<SubscriptionRevenueRecognizerService['recognizeActivation']>[0]> =
    [];
  public nextResult: Result<RecognizeActivationOutput, RecognizeActivationFailure> = {
    ok: true,
    value: defaultSuccessOutput(),
  };

  recognizeActivation = vi.fn(
    async (
      request: Parameters<SubscriptionRevenueRecognizerService['recognizeActivation']>[0],
    ): Promise<Result<RecognizeActivationOutput, RecognizeActivationFailure>> => {
      this.calls.push(request);
      return this.nextResult;
    },
  );

  // The service interface requires these too; stub them so the
  // TS pick + the runtime class shape stay aligned.
  cancelDeferredRevenue = vi.fn(
    async (): Promise<Result<CancelDeferredRevenueOutput, CancelDeferredRevenueFailure>> => {
      throw new Error('not used in this test');
    },
  );
  recognizeDaily = vi.fn(async () => {
    throw new Error('not used in this test');
  });
}

function defaultSuccessOutput(): RecognizeActivationOutput {
  return {
    balanceId: 'bal_001',
    subscriptionId: 'sub_001',
    activationJournalId: 'jou_001',
    originalAmountMinor: 19_900,
    recognizedAmountMinor: 0,
    currency: 'USD',
    servicePeriodStart: new Date('2026-05-07T00:00:00.000Z'),
    servicePeriodEnd: new Date('2026-06-07T00:00:00.000Z'),
    status: 'active',
    result: 'created',
  };
}

function buildHandleArgs(
  overrides: Partial<HandleArgs<typeof SUBSCRIPTION_ACTIVATED>['payload']> = {},
): HandleArgs<typeof SUBSCRIPTION_ACTIVATED> {
  const occurredAt = new Date('2026-05-07T12:00:00.000Z');
  return {
    envelope: {
      eventId: 'sub_001.activated',
      eventName: SUBSCRIPTION_ACTIVATED,
      occurredAt,
      producerService: 'service-subscription',
      producerSchema: 'subscription',
    },
    payload: {
      eventId: 'sub_001.activated',
      occurredAt: occurredAt.toISOString(),
      subscriptionId: 'sub_001',
      customerId: 'hh_001',
      customerGroup: 'family',
      planId: 'plan_essential',
      planCode: 'family.tier2',
      periodStart: '2026-05-07T00:00:00.000Z',
      periodEnd: '2026-06-07T00:00:00.000Z',
      amountMinor: 19_900,
      currency: 'USD',
      ...overrides,
    },
  };
}

describe('SubscriptionActivatedHandler', () => {
  let recognizer: FakeRecognizer;
  let handler: SubscriptionActivatedHandler;

  beforeEach(() => {
    recognizer = new FakeRecognizer();
    handler = new SubscriptionActivatedHandler(
      recognizer as unknown as SubscriptionRevenueRecognizerService,
    );
  });

  describe('happy path', () => {
    it('translates the event payload into a RecognizeActivationRequest and invokes the recognizer', async () => {
      await handler.handle(buildHandleArgs());
      expect(recognizer.recognizeActivation).toHaveBeenCalledTimes(1);
      const request = recognizer.calls[0];
      if (request === undefined) throw new Error('expected one call');
      expect(request.subscriptionId).toBe('sub_001');
      expect(request.customerId).toBe('hh_001');
      expect(request.customerGroup).toBe('family');
      expect(request.planCode).toBe('family.tier2');
      expect(request.amountMinor).toBe(19_900);
      expect(request.currency).toBe('USD');
      expect(request.servicePeriodStart).toBe('2026-05-07T00:00:00.000Z');
      expect(request.servicePeriodEnd).toBe('2026-06-07T00:00:00.000Z');
    });

    it('maps the envelope eventId 1:1 onto the recognizer sourceEventId', async () => {
      await handler.handle(buildHandleArgs());
      const request = recognizer.calls[0];
      if (request === undefined) throw new Error('expected one call');
      expect(request.sourceEventId).toBe('sub_001.activated');
    });

    it('forwards the envelope occurredAt as ISO 8601', async () => {
      await handler.handle(buildHandleArgs());
      const request = recognizer.calls[0];
      if (request === undefined) throw new Error('expected one call');
      expect(request.occurredAt).toBe('2026-05-07T12:00:00.000Z');
    });

    it('passes producer service + producer schema + planId on the context', async () => {
      await handler.handle(buildHandleArgs());
      const request = recognizer.calls[0];
      if (request === undefined) throw new Error('expected one call');
      expect(request.context).toEqual({
        producerService: 'service-subscription',
        producerSchema: 'subscription',
        planId: 'plan_essential',
      });
    });

    it('returns successfully when the recognizer reports idempotent_replay', async () => {
      recognizer.nextResult = {
        ok: true,
        value: { ...defaultSuccessOutput(), result: 'idempotent_replay' },
      };
      await expect(handler.handle(buildHandleArgs())).resolves.toBeUndefined();
      expect(recognizer.recognizeActivation).toHaveBeenCalledTimes(1);
    });

    it('honours a non-default planCode (Tier 1)', async () => {
      await handler.handle(buildHandleArgs({ planCode: 'family.tier1', amountMinor: 2_900 }));
      const request = recognizer.calls[0];
      if (request === undefined) throw new Error('expected one call');
      expect(request.planCode).toBe('family.tier1');
      expect(request.amountMinor).toBe(2_900);
    });
  });

  describe('currency gating', () => {
    it('throws on non-USD currency without calling the recognizer', async () => {
      await expect(handler.handle(buildHandleArgs({ currency: 'EUR' }))).rejects.toThrow(
        /unsupported currency 'EUR'/,
      );
      expect(recognizer.recognizeActivation).not.toHaveBeenCalled();
    });

    it('throws on GBP / JPY / any non-USD code (Phase 1 cap)', async () => {
      await expect(handler.handle(buildHandleArgs({ currency: 'GBP' }))).rejects.toThrow(
        /unsupported currency 'GBP'/,
      );
      await expect(handler.handle(buildHandleArgs({ currency: 'JPY' }))).rejects.toThrow(
        /unsupported currency 'JPY'/,
      );
      expect(recognizer.recognizeActivation).not.toHaveBeenCalled();
    });
  });

  describe('recognizer failure surfaces', () => {
    it('rethrows the failure as Error("period_inverted: ...") on period_inverted', async () => {
      recognizer.nextResult = {
        ok: false,
        failure: { kind: 'period_inverted' },
      };
      await expect(handler.handle(buildHandleArgs())).rejects.toThrow(/^period_inverted:/);
    });

    it('rethrows on amount_non_positive', async () => {
      recognizer.nextResult = {
        ok: false,
        failure: { kind: 'amount_non_positive' },
      };
      await expect(handler.handle(buildHandleArgs())).rejects.toThrow(/^amount_non_positive:/);
    });

    it('rethrows on subscription_period_conflict with the conflict pair', async () => {
      recognizer.nextResult = {
        ok: false,
        failure: {
          kind: 'subscription_period_conflict',
          subscriptionId: 'sub_001',
          servicePeriodStart: '2026-05-07T00:00:00.000Z',
        },
      };
      await expect(handler.handle(buildHandleArgs())).rejects.toThrow(/subscriptionId=sub_001/);
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
        failure: { kind: 'period_inverted' },
      };
      await expect(handler.handle(buildHandleArgs())).rejects.toThrow();
      expect(recognizer.recognizeActivation).toHaveBeenCalledTimes(1);
    });
  });
});
