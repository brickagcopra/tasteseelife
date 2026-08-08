import { SUBSCRIPTION_PAUSED } from '@taste-and-see/contracts';
import type { HandleArgs } from '@taste-and-see/nest-outbox-consumer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  PauseRecognitionOutput,
  SubscriptionRevenueRecognizerService,
} from '../../revenue-recognition/services/subscription-revenue-recognizer.service';
import { SubscriptionPausedHandler } from './subscription-paused.handler';

/**
 * Minimal mock of the recogniser covering only `pauseRecognition` — the
 * handler under test never touches the activation, cancel, resume or
 * daily-sweep surfaces. Every call is recorded so the tests can assert
 * on the boundary translation from event payload to request.
 */
class FakeRecognizer {
  public calls: Array<Parameters<SubscriptionRevenueRecognizerService['pauseRecognition']>[0]> = [];
  public nextOutput: PauseRecognitionOutput = {
    subscriptionId: 'sub_001',
    result: 'applied',
    balanceIds: ['drb_001'],
  };

  pauseRecognition = vi.fn(
    async (
      request: Parameters<SubscriptionRevenueRecognizerService['pauseRecognition']>[0],
    ): Promise<PauseRecognitionOutput> => {
      this.calls.push(request);
      return this.nextOutput;
    },
  );
}

function buildHandleArgs(
  overrides: Partial<HandleArgs<typeof SUBSCRIPTION_PAUSED>['payload']> = {},
): HandleArgs<typeof SUBSCRIPTION_PAUSED> {
  const occurredAt = new Date('2026-06-11T12:00:00.000Z');
  return {
    envelope: {
      eventId: 'sub_001.paused',
      eventName: SUBSCRIPTION_PAUSED,
      occurredAt,
      producerService: 'service-subscription',
      producerSchema: 'subscription',
    },
    payload: {
      eventId: 'sub_001.paused',
      occurredAt: occurredAt.toISOString(),
      subscriptionId: 'sub_001',
      customerId: 'hh_001',
      pausedAt: '2026-06-11T00:00:00.000Z',
      resumesAt: null,
      hasReason: true,
      requesterUserId: 'usr_001',
      fromStatus: 'active',
      ...overrides,
    },
  };
}

describe('SubscriptionPausedHandler', () => {
  let recognizer: FakeRecognizer;
  let handler: SubscriptionPausedHandler;

  beforeEach(() => {
    recognizer = new FakeRecognizer();
    handler = new SubscriptionPausedHandler(
      recognizer as unknown as SubscriptionRevenueRecognizerService,
    );
  });

  it('translates the event payload into a PauseRecognitionRequest', async () => {
    await handler.handle(buildHandleArgs());

    expect(recognizer.pauseRecognition).toHaveBeenCalledTimes(1);
    const request = recognizer.calls[0];
    if (request === undefined) throw new Error('expected one call');
    expect(request.subscriptionId).toBe('sub_001');
    expect(request.pausedAt).toBe('2026-06-11T00:00:00.000Z');
    expect(request.fromStatus).toBe('active');
    expect(request.hasReason).toBe(true);
  });

  it('uses the DOMAIN pause instant, not the envelope clock', async () => {
    await handler.handle(buildHandleArgs());

    const request = recognizer.calls[0];
    if (request === undefined) throw new Error('expected one call');
    // The envelope was stamped at 12:00; the pause took effect at 00:00.
    // The extension applied on resume is measured from the domain
    // instant, so a twelve-hour discrepancy here is twelve hours of
    // service a family would not get back.
    expect(request.pausedAt).not.toBe('2026-06-11T12:00:00.000Z');
  });

  it('maps the relay event id 1:1 into the recogniser sourceEventId', async () => {
    await handler.handle(buildHandleArgs());

    const request = recognizer.calls[0];
    if (request === undefined) throw new Error('expected one call');
    expect(request.sourceEventId).toBe('sub_001.paused');
  });

  it('forwards no free text — the request shape carries only hasReason', async () => {
    await handler.handle(buildHandleArgs({ hasReason: true }));

    const request = recognizer.calls[0];
    if (request === undefined) throw new Error('expected one call');
    // A pause reason on this platform is very often a health or
    // bereavement disclosure about a named senior (CLAUDE.md §3.9, §12).
    // The event withholds it and so must this boundary.
    expect(Object.keys(request).sort()).toEqual([
      'fromStatus',
      'hasReason',
      'pausedAt',
      'sourceEventId',
      'subscriptionId',
    ]);
  });

  it('does not throw when there is no balance to suspend', async () => {
    recognizer.nextOutput = {
      subscriptionId: 'sub_001',
      result: 'no_balance',
      balanceIds: [],
    };

    // Throwing would leave the entry in the PEL and redeliver forever
    // for a subscription that legitimately has nothing to suspend.
    await expect(handler.handle(buildHandleArgs())).resolves.toBeUndefined();
  });

  it('does not throw on an idempotent replay', async () => {
    recognizer.nextOutput = {
      subscriptionId: 'sub_001',
      result: 'idempotent_replay',
      balanceIds: [],
    };

    await expect(handler.handle(buildHandleArgs())).resolves.toBeUndefined();
  });

  it('propagates a recogniser error so the SDK redelivers', async () => {
    recognizer.pauseRecognition.mockRejectedValueOnce(new Error('db down'));

    await expect(handler.handle(buildHandleArgs())).rejects.toThrow('db down');
  });
});
