import {
  STRIPE_PAYMENT_METHOD_CHANGED,
  type StripePaymentMethodChanged,
} from '@taste-and-see/contracts';
import type { HandleArgs } from '@taste-and-see/nest-outbox-consumer';
import { describe, expect, it, vi } from 'vitest';

import type { SubscriptionMetrics } from '../../../observability/subscription-metrics';
import type { StripePaymentMethodReconcilerService } from '../stripe-payment-method-reconciler.service';
import { StripePaymentMethodChangedHandler } from './stripe-payment-method-changed.handler';

function args(
  overrides: Partial<StripePaymentMethodChanged> = {},
): HandleArgs<typeof STRIPE_PAYMENT_METHOD_CHANGED> {
  return {
    envelope: {
      eventId: 'evt_1',
      eventName: STRIPE_PAYMENT_METHOD_CHANGED,
      occurredAt: new Date('2026-08-01T12:00:00.000Z'),
    },
    payload: {
      eventId: 'evt_1',
      occurredAt: '2026-08-01T12:00:00.000Z',
      stripeEventId: 'evt_1',
      livemode: true,
      stripeCustomerId: 'cus_1',
      apiVersion: '2024-06-20',
      stripeEventType: 'payment_method.attached',
      stripePaymentMethodId: 'pm_1',
      ...overrides,
    },
  } as unknown as HandleArgs<typeof STRIPE_PAYMENT_METHOD_CHANGED>;
}

function build(livemode = true) {
  const reconcile = vi.fn().mockResolvedValue({ kind: 'reconciled', changed: ['displayFields'] });
  const recordStripeReconcile = vi.fn();
  const handler = new StripePaymentMethodChangedHandler(
    { reconcile } as unknown as StripePaymentMethodReconcilerService,
    { recordStripeReconcile } as unknown as SubscriptionMetrics,
    livemode,
  );
  return { handler, reconcile, recordStripeReconcile };
}

describe('StripePaymentMethodChangedHandler', () => {
  it('delegates with the payment-method handle and the Stripe event type', async () => {
    // The TYPE is passed through because the reconciler branches on
    // `detached` — the handler must not decide that itself.
    const { handler, reconcile } = build();

    await handler.handle(args());

    expect(reconcile).toHaveBeenCalledWith({
      stripePaymentMethodId: 'pm_1',
      stripeEventId: 'evt_1',
      stripeEventType: 'payment_method.attached',
    });
  });

  it('passes a DETACHED event through with its null customer handle', async () => {
    // Stripe clears the customer link before emitting `detached`, which is why
    // the contract allows a null `stripeCustomerId` and never a null
    // `stripePaymentMethodId` — the row is identified by the latter.
    const { handler, reconcile } = build();

    await handler.handle(
      args({ stripeEventType: 'payment_method.detached', stripeCustomerId: null }),
    );

    expect(reconcile.mock.calls[0]![0]).toMatchObject({
      stripeEventType: 'payment_method.detached',
    });
  });

  it('records the outcome under the `payment_method` object label', async () => {
    const { handler, reconcile, recordStripeReconcile } = build();
    reconcile.mockResolvedValue({ kind: 'unknown_kind', stripeType: 'klarna' });

    await handler.handle(args());

    expect(recordStripeReconcile).toHaveBeenCalledWith('payment_method', 'unknown_kind');
  });

  it('DROPS a test-mode event on a live pod', async () => {
    const { handler, reconcile, recordStripeReconcile } = build(true);

    await handler.handle(args({ livemode: false }));

    expect(reconcile).not.toHaveBeenCalled();
    expect(recordStripeReconcile).toHaveBeenCalledWith('payment_method', 'mode_mismatch');
  });

  it('lets a reconciler throw propagate so the SDK retries', async () => {
    const { handler, reconcile } = build();
    const boom = new Error('ECONNRESET');
    reconcile.mockRejectedValue(boom);

    await expect(handler.handle(args())).rejects.toBe(boom);
  });
});
