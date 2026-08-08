import { describe, expect, it, vi } from 'vitest';

import type { PrismaService } from '../../prisma/prisma.service';
import type { DunningService } from '../subscriptions/services/dunning.service';
import {
  StripeDunningBridgeService,
  StripeDunningBridgeUnavailableError,
} from './stripe-dunning-bridge.service';

const OCCURRED_AT = new Date('2026-08-01T12:00:00.000Z');

function build(args?: { readonly subscription?: { id: string } | null }) {
  const findUnique = vi
    .fn()
    .mockResolvedValue(
      args?.subscription === undefined ? { id: 'sub_local_1' } : args.subscription,
    );
  const recordPaymentFailure = vi.fn().mockResolvedValue({ ok: true, value: {} });
  const recordPaymentSuccess = vi.fn().mockResolvedValue({ ok: true, value: {} });

  const prisma = { subscription: { findUnique } };
  const dunning = { recordPaymentFailure, recordPaymentSuccess };

  const service = new StripeDunningBridgeService(
    prisma as unknown as PrismaService,
    dunning as unknown as DunningService,
  );
  return { service, findUnique, recordPaymentFailure, recordPaymentSuccess };
}

function apply(
  service: StripeDunningBridgeService,
  stripeEventType: string,
  stripeSubscriptionId: string | null = 'sub_stripe_1',
) {
  return service.apply({
    stripeEventType,
    stripeEventId: 'evt_1',
    stripeSubscriptionId,
    occurredAt: OCCURRED_AT,
  });
}

describe('StripeDunningBridgeService — which events drive dunning', () => {
  it('routes invoice.payment_failed into recordPaymentFailure', async () => {
    const { service, recordPaymentFailure } = build();

    await expect(apply(service, 'invoice.payment_failed')).resolves.toBe('applied');

    expect(recordPaymentFailure).toHaveBeenCalledWith({
      subscriptionId: 'sub_local_1',
      sourceEventId: 'evt_1',
      // Stripe's clock, not ours — this IS the dedup key
      // (`dunning_last_attempt_at == attemptedAt`). A replay that slips past
      // the SDK's dedup table must count the same failure once, not twice: a
      // double-counted failure pushes a family toward cancellation a cycle
      // early.
      attemptedAt: OCCURRED_AT,
      actorKind: 'system',
    });
  });

  it('routes invoice.paid into recordPaymentSuccess', async () => {
    const { service, recordPaymentSuccess } = build();

    await expect(apply(service, 'invoice.paid')).resolves.toBe('applied');
    expect(recordPaymentSuccess).toHaveBeenCalledWith({
      subscriptionId: 'sub_local_1',
      sourceEventId: 'evt_1',
      succeededAt: OCCURRED_AT,
      actorKind: 'system',
    });
  });

  it('does NOT treat invoice.payment_succeeded as a recovery', async () => {
    // Stripe fires `paid` AND `payment_succeeded` for an ordinary card charge,
    // and `recordPaymentSuccess` writes a history row unconditionally — so
    // honouring both would put two rows in a family's audit trail for one
    // payment. `paid` is the strictly more general signal (an out-of-band or
    // credit-balance settlement raises it alone), and a PARTIAL payment raises
    // `payment_succeeded` without `paid` on an invoice that is still open.
    const { service, recordPaymentSuccess, recordPaymentFailure, findUnique } = build();

    await expect(apply(service, 'invoice.payment_succeeded')).resolves.toBe('skipped');

    expect(recordPaymentSuccess).not.toHaveBeenCalled();
    expect(recordPaymentFailure).not.toHaveBeenCalled();
    // And it costs no database lookup to decide.
    expect(findUnique).not.toHaveBeenCalled();
  });

  it('does NOT drive dunning from the lifecycle-only invoice events', async () => {
    const { service, recordPaymentFailure, recordPaymentSuccess } = build();

    for (const eventType of [
      'invoice.created',
      'invoice.finalized',
      'invoice.voided',
      // Uncollectible is the END of a dunning cycle; the transition out of it
      // belongs to the exhaustion sweep, which owns the grace-window
      // arithmetic. Two writers of that transition would race.
      'invoice.marked_uncollectible',
    ]) {
      await expect(apply(service, eventType)).resolves.toBe('skipped');
    }

    expect(recordPaymentFailure).not.toHaveBeenCalled();
    expect(recordPaymentSuccess).not.toHaveBeenCalled();
  });

  it('skips a one-off invoice — there is no subscription to dun', async () => {
    const { service, findUnique } = build();
    await expect(apply(service, 'invoice.payment_failed', null)).resolves.toBe('skipped');
    expect(findUnique).not.toHaveBeenCalled();
  });
});

describe('StripeDunningBridgeService — outcomes', () => {
  it('reports not_tracked for a subscription this platform does not hold', async () => {
    const { service, recordPaymentFailure } = build({ subscription: null });

    await expect(apply(service, 'invoice.payment_failed')).resolves.toBe('not_tracked');
    expect(recordPaymentFailure).not.toHaveBeenCalled();
  });

  it('reports rejected — TERMINALLY — when dunning refuses the transition', async () => {
    // e.g. the subscription is already canceled. Retrying ten times changes
    // nothing and buries the dead-letter queue's signal.
    const { service, recordPaymentFailure } = build();
    recordPaymentFailure.mockResolvedValue({
      ok: false,
      error: { reason: 'invalid_state', subscriptionId: 'sub_local_1' },
    });

    await expect(apply(service, 'invoice.payment_failed')).resolves.toBe('rejected');
  });

  it('THROWS on stripe_unavailable so the SDK retries', async () => {
    // The other half of the split. Swallowing this would lose a real payment
    // failure to a Stripe blip — the family never enters dunning and nobody
    // finds out.
    const { service, recordPaymentFailure } = build();
    recordPaymentFailure.mockResolvedValue({
      ok: false,
      error: { reason: 'stripe_unavailable', cause: new Error('timeout') },
    });

    await expect(apply(service, 'invoice.payment_failed')).rejects.toBeInstanceOf(
      StripeDunningBridgeUnavailableError,
    );
  });

  it('lets a thrown dunning error propagate untouched', async () => {
    const { service, recordPaymentSuccess } = build();
    const boom = new Error('db down');
    recordPaymentSuccess.mockRejectedValue(boom);

    await expect(apply(service, 'invoice.paid')).rejects.toBe(boom);
  });
});
