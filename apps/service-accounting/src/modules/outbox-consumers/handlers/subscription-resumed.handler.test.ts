import { SUBSCRIPTION_RESUMED } from '@taste-and-see/contracts';
import type { HandleArgs } from '@taste-and-see/nest-outbox-consumer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  ResumeRecognitionOutput,
  SubscriptionRevenueRecognizerService,
} from '../../revenue-recognition/services/subscription-revenue-recognizer.service';
import { SubscriptionResumedHandler } from './subscription-resumed.handler';

class FakeRecognizer {
  public calls: Array<Parameters<SubscriptionRevenueRecognizerService['resumeRecognition']>[0]> =
    [];
  public nextOutput: ResumeRecognitionOutput = {
    subscriptionId: 'sub_001',
    result: 'applied',
    balanceIds: ['drb_001'],
    extendedBySeconds: 864_000,
  };

  resumeRecognition = vi.fn(
    async (
      request: Parameters<SubscriptionRevenueRecognizerService['resumeRecognition']>[0],
    ): Promise<ResumeRecognitionOutput> => {
      this.calls.push(request);
      return this.nextOutput;
    },
  );
}

function buildHandleArgs(
  overrides: Partial<HandleArgs<typeof SUBSCRIPTION_RESUMED>['payload']> = {},
): HandleArgs<typeof SUBSCRIPTION_RESUMED> {
  const occurredAt = new Date('2026-06-21T12:00:00.000Z');
  return {
    envelope: {
      eventId: 'sub_001.resumed',
      eventName: SUBSCRIPTION_RESUMED,
      occurredAt,
      producerService: 'service-subscription',
      producerSchema: 'subscription',
    },
    payload: {
      eventId: 'sub_001.resumed',
      occurredAt: occurredAt.toISOString(),
      subscriptionId: 'sub_001',
      customerId: 'hh_001',
      resumedAt: '2026-06-21T00:00:00.000Z',
      requesterUserId: 'usr_001',
      toStatus: 'active',
      hasNote: false,
      ...overrides,
    },
  };
}

describe('SubscriptionResumedHandler', () => {
  let recognizer: FakeRecognizer;
  let handler: SubscriptionResumedHandler;

  beforeEach(() => {
    recognizer = new FakeRecognizer();
    handler = new SubscriptionResumedHandler(
      recognizer as unknown as SubscriptionRevenueRecognizerService,
    );
  });

  it('translates the event payload into a ResumeRecognitionRequest', async () => {
    await handler.handle(buildHandleArgs());

    expect(recognizer.resumeRecognition).toHaveBeenCalledTimes(1);
    const request = recognizer.calls[0];
    if (request === undefined) throw new Error('expected one call');
    expect(request.subscriptionId).toBe('sub_001');
    expect(request.resumedAt).toBe('2026-06-21T00:00:00.000Z');
    expect(request.sourceEventId).toBe('sub_001.resumed');
    expect(request.hasNote).toBe(false);
  });

  it('READS toStatus off the payload rather than assuming active', async () => {
    await handler.handle(buildHandleArgs({ toStatus: 'past_due' }));

    const request = recognizer.calls[0];
    if (request === undefined) throw new Error('expected one call');
    // Resume adopts whatever status Stripe reports, which is `past_due`
    // for a subscription paused mid-dunning. The event's own doc-block
    // says so explicitly.
    expect(request.toStatus).toBe('past_due');
  });

  it('still resumes a past_due subscription — unpaid keeps accruing (TS-042-followup-3b3)', async () => {
    await handler.handle(buildHandleArgs({ toStatus: 'unpaid' }));

    // The platform has already invoiced and may still collect; halting
    // recognition on a receivable it expects to realise is a different
    // accounting position from halting it on service not delivered. If
    // it goes bad it becomes a write-off (TS-084), not an
    // un-recognition. So the handler forwards, never gates.
    expect(recognizer.resumeRecognition).toHaveBeenCalledTimes(1);
    const request = recognizer.calls[0];
    if (request === undefined) throw new Error('expected one call');
    expect(request.toStatus).toBe('unpaid');
  });

  it('uses the DOMAIN resume instant, not the envelope clock', async () => {
    await handler.handle(buildHandleArgs());

    const request = recognizer.calls[0];
    if (request === undefined) throw new Error('expected one call');
    expect(request.resumedAt).not.toBe('2026-06-21T12:00:00.000Z');
  });

  it('forwards no free text — the request shape carries only hasNote', async () => {
    await handler.handle(buildHandleArgs({ hasNote: true }));

    const request = recognizer.calls[0];
    if (request === undefined) throw new Error('expected one call');
    expect(Object.keys(request).sort()).toEqual([
      'hasNote',
      'resumedAt',
      'sourceEventId',
      'subscriptionId',
      'toStatus',
    ]);
  });

  it('does not throw when there is no paused balance', async () => {
    recognizer.nextOutput = {
      subscriptionId: 'sub_001',
      result: 'no_balance',
      balanceIds: [],
      extendedBySeconds: 0,
    };

    await expect(handler.handle(buildHandleArgs())).resolves.toBeUndefined();
  });

  it('does not throw on an idempotent replay', async () => {
    recognizer.nextOutput = {
      subscriptionId: 'sub_001',
      result: 'idempotent_replay',
      balanceIds: [],
      extendedBySeconds: 0,
    };

    await expect(handler.handle(buildHandleArgs())).resolves.toBeUndefined();
  });

  it('propagates a recogniser error so the SDK redelivers', async () => {
    recognizer.resumeRecognition.mockRejectedValueOnce(new Error('db down'));

    await expect(handler.handle(buildHandleArgs())).rejects.toThrow('db down');
  });
});
