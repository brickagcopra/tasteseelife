import { STRIPE_INVOICE_CHANGED, type StripeInvoiceChanged } from '@taste-and-see/contracts';
import type { HandleArgs } from '@taste-and-see/nest-outbox-consumer';
import { describe, expect, it, vi } from 'vitest';

import type { SubscriptionMetrics } from '../../../observability/subscription-metrics';
import type { StripeDunningBridgeService } from '../stripe-dunning-bridge.service';
import type { StripeInvoiceReconcilerService } from '../stripe-invoice-reconciler.service';
import { StripeInvoiceChangedHandler } from './stripe-invoice-changed.handler';

function args(
  overrides: Partial<StripeInvoiceChanged> = {},
): HandleArgs<typeof STRIPE_INVOICE_CHANGED> {
  return {
    envelope: {
      eventId: 'evt_1',
      eventName: STRIPE_INVOICE_CHANGED,
      occurredAt: new Date('2026-08-01T12:00:00.000Z'),
    },
    payload: {
      eventId: 'evt_1',
      occurredAt: '2026-08-01T12:00:00.000Z',
      stripeEventId: 'evt_1',
      livemode: true,
      stripeCustomerId: 'cus_1',
      apiVersion: '2024-06-20',
      stripeEventType: 'invoice.payment_failed',
      stripeInvoiceId: 'in_1',
      stripeSubscriptionId: 'sub_1',
      ...overrides,
    },
  } as unknown as HandleArgs<typeof STRIPE_INVOICE_CHANGED>;
}

function build(livemode = true) {
  const reconcile = vi.fn().mockResolvedValue({ kind: 'reconciled', changed: ['invoice'] });
  const applyDunning = vi.fn().mockResolvedValue('skipped');
  const recordStripeReconcile = vi.fn();
  const recordDunningBridge = vi.fn();
  const handler = new StripeInvoiceChangedHandler(
    { reconcile } as unknown as StripeInvoiceReconcilerService,
    { apply: applyDunning } as unknown as StripeDunningBridgeService,
    { recordStripeReconcile, recordDunningBridge } as unknown as SubscriptionMetrics,
    livemode,
  );
  return { handler, reconcile, applyDunning, recordStripeReconcile, recordDunningBridge };
}

describe('StripeInvoiceChangedHandler', () => {
  it('delegates both handles to the reconciler', async () => {
    const { handler, reconcile } = build();

    await handler.handle(args());

    expect(reconcile).toHaveBeenCalledWith({
      stripeInvoiceId: 'in_1',
      stripeSubscriptionId: 'sub_1',
      stripeEventId: 'evt_1',
      stripeEventType: 'invoice.payment_failed',
    });
  });

  it('passes a NULL subscription handle straight through — the one-off case', async () => {
    // The reconciler decides; the handler must not pre-filter, or the one_off
    // outcome would never be recorded and a real gap would look like silence.
    const { handler, reconcile, recordStripeReconcile } = build();
    reconcile.mockResolvedValue({ kind: 'one_off' });

    await handler.handle(args({ stripeSubscriptionId: null }));

    expect(reconcile).toHaveBeenCalledTimes(1);
    expect(reconcile.mock.calls[0]![0]).toMatchObject({ stripeSubscriptionId: null });
    expect(recordStripeReconcile).toHaveBeenCalledWith('invoice', 'one_off');
  });

  it('records the outcome under the `invoice` object label', async () => {
    const { handler, reconcile, recordStripeReconcile } = build();
    reconcile.mockResolvedValue({ kind: 'stripe_missing' });

    await handler.handle(args());

    expect(recordStripeReconcile).toHaveBeenCalledWith('invoice', 'stripe_missing');
  });

  it('DROPS a test-mode event on a live pod', async () => {
    const { handler, reconcile, recordStripeReconcile } = build(true);

    await handler.handle(args({ livemode: false }));

    expect(reconcile).not.toHaveBeenCalled();
    expect(recordStripeReconcile).toHaveBeenCalledWith('invoice', 'mode_mismatch');
  });

  it('lets a reconciler throw propagate so the SDK retries', async () => {
    const { handler, reconcile } = build();
    const boom = new Error('ECONNRESET');
    reconcile.mockRejectedValue(boom);

    await expect(handler.handle(args())).rejects.toBe(boom);
  });

  describe('dunning bridge (TS-042-followup-4)', () => {
    it('drives dunning AFTER the invoice row is current', async () => {
      const order: string[] = [];
      const { handler, reconcile, applyDunning } = build();
      reconcile.mockImplementation(() => {
        order.push('reconcile');
        return Promise.resolve({ kind: 'reconciled', changed: ['invoice'] });
      });
      applyDunning.mockImplementation(() => {
        order.push('dunning');
        return Promise.resolve('applied');
      });

      await handler.handle(args());

      expect(order).toEqual(['reconcile', 'dunning']);
    });

    it('drives dunning even when the invoice write was a NO-OP redelivery', async () => {
      // The two are independent questions. Gating dunning on `reconciled`
      // would silently drop a payment failure whose invoice happened to be up
      // to date already — and the bridge has its own idempotency.
      const { handler, reconcile, applyDunning } = build();
      reconcile.mockResolvedValue({ kind: 'no_change' });

      await handler.handle(args());

      expect(applyDunning).toHaveBeenCalledTimes(1);
    });

    it('passes the EVENT`s clock through — it is the dunning dedup key', async () => {
      const { handler, applyDunning } = build();

      await handler.handle(args());

      expect(applyDunning).toHaveBeenCalledWith({
        stripeEventType: 'invoice.payment_failed',
        stripeEventId: 'evt_1',
        stripeSubscriptionId: 'sub_1',
        occurredAt: new Date('2026-08-01T12:00:00.000Z'),
      });
    });

    it('records the bridge outcome, except for `skipped`', async () => {
      // Most relayed invoice events are not dunning signals; counting them
      // would bury `applied` under a number that is large by design.
      const { handler, applyDunning, recordDunningBridge } = build();

      applyDunning.mockResolvedValue('skipped');
      await handler.handle(args());
      expect(recordDunningBridge).not.toHaveBeenCalled();

      applyDunning.mockResolvedValue('rejected');
      await handler.handle(args());
      expect(recordDunningBridge).toHaveBeenCalledWith('rejected');
    });

    it('does NOT drive dunning for a dropped mode-mismatched event', async () => {
      const { handler, applyDunning } = build(true);

      await handler.handle(args({ livemode: false }));

      expect(applyDunning).not.toHaveBeenCalled();
    });
  });
});
