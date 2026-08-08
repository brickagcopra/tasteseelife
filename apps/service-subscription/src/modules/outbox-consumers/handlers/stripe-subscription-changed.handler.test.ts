import {
  STRIPE_SUBSCRIPTION_CHANGED,
  type StripeSubscriptionChanged,
} from '@taste-and-see/contracts';
import type { HandleArgs } from '@taste-and-see/nest-outbox-consumer';
import { describe, expect, it, vi } from 'vitest';

import type { SubscriptionMetrics } from '../../../observability/subscription-metrics';
import type { StripeSubscriptionReconcilerService } from '../stripe-subscription-reconciler.service';
import { StripeSubscriptionChangedHandler } from './stripe-subscription-changed.handler';

function payload(overrides: Partial<StripeSubscriptionChanged> = {}): StripeSubscriptionChanged {
  return {
    eventId: 'evt_1',
    occurredAt: '2026-08-01T12:00:00.000Z',
    stripeEventId: 'evt_1',
    livemode: true,
    stripeCustomerId: 'cus_1',
    apiVersion: '2024-06-20',
    stripeEventType: 'customer.subscription.updated',
    stripeSubscriptionId: 'sub_1',
    ...overrides,
  };
}

function args(
  overrides: Partial<StripeSubscriptionChanged> = {},
): HandleArgs<typeof STRIPE_SUBSCRIPTION_CHANGED> {
  return {
    envelope: {
      eventId: 'evt_1',
      eventName: STRIPE_SUBSCRIPTION_CHANGED,
      occurredAt: new Date('2026-08-01T12:00:00.000Z'),
    },
    payload: payload(overrides),
  } as unknown as HandleArgs<typeof STRIPE_SUBSCRIPTION_CHANGED>;
}

function build(livemode = true) {
  const reconcile = vi.fn().mockResolvedValue({ kind: 'reconciled', changed: ['status'] });
  const recordStripeReconcile = vi.fn();
  const handler = new StripeSubscriptionChangedHandler(
    { reconcile } as unknown as StripeSubscriptionReconcilerService,
    { recordStripeReconcile } as unknown as SubscriptionMetrics,
    livemode,
  );
  return { handler, reconcile, recordStripeReconcile };
}

describe('StripeSubscriptionChangedHandler', () => {
  it('delegates to the reconciler with the payload handle and the event clock', async () => {
    const { handler, reconcile } = build();

    await handler.handle(args());

    expect(reconcile).toHaveBeenCalledTimes(1);
    expect(reconcile).toHaveBeenCalledWith({
      stripeSubscriptionId: 'sub_1',
      stripeEventId: 'evt_1',
      stripeEventType: 'customer.subscription.updated',
      // The EVENT's clock, not ours — a redelivered event must stamp an
      // out-of-band pause with when we first heard of it, not with now.
      observedAt: new Date('2026-08-01T12:00:00.000Z'),
    });
  });

  it('records the reconciler outcome as the metric label', async () => {
    const { handler, reconcile, recordStripeReconcile } = build();
    reconcile.mockResolvedValue({ kind: 'not_tracked' });

    await handler.handle(args());

    expect(recordStripeReconcile).toHaveBeenCalledTimes(1);
    expect(recordStripeReconcile).toHaveBeenCalledWith('subscription', 'not_tracked');
  });

  it('DROPS a test-mode event on a live pod and never touches the reconciler', async () => {
    // Test and live traffic share this pipe and `livemode` is the only thing
    // that tells them apart. A test-mode `customer.subscription.deleted`
    // applied to production rows would cancel a real family's care, and no
    // retry recovers from that.
    const { handler, reconcile, recordStripeReconcile } = build(true);

    await handler.handle(args({ livemode: false }));

    expect(reconcile).not.toHaveBeenCalled();
    expect(recordStripeReconcile).toHaveBeenCalledWith('subscription', 'mode_mismatch');
  });

  it('DROPS a live event on a test-mode pod', async () => {
    const { handler, reconcile } = build(false);

    await handler.handle(args({ livemode: true }));

    expect(reconcile).not.toHaveBeenCalled();
  });

  it('processes a test-mode event on a test-mode pod', async () => {
    const { handler, reconcile } = build(false);

    await handler.handle(args({ livemode: false }));

    expect(reconcile).toHaveBeenCalledTimes(1);
  });

  it('lets a reconciler throw propagate so the SDK retries', async () => {
    // Transient failures are the SDK's job, not the handler's. Swallowing one
    // here would mark a billing change processed that never landed.
    const { handler, reconcile, recordStripeReconcile } = build();
    const boom = new Error('ECONNRESET');
    reconcile.mockRejectedValue(boom);

    await expect(handler.handle(args())).rejects.toBe(boom);
    expect(recordStripeReconcile).not.toHaveBeenCalled();
  });
});
