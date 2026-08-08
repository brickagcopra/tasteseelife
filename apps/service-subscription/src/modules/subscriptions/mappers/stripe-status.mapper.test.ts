import type Stripe from 'stripe';
import { describe, expect, it } from 'vitest';

import { mapStripeStatus } from './stripe-status.mapper';

/**
 * The status mapper is small but load-bearing — every Stripe webhook +
 * the outbound create/patch/cancel flows feed through it. Each known
 * value gets a passthrough; unknown future Stripe statuses fall back
 * to `incomplete` (fail-safe — treats unknown as not-yet-active).
 */
describe('mapStripeStatus', () => {
  const passthroughs: ReadonlyArray<Stripe.Subscription.Status> = [
    'incomplete',
    'incomplete_expired',
    'trialing',
    'active',
    'past_due',
    'unpaid',
    'canceled',
  ];

  for (const status of passthroughs) {
    it(`passes through Stripe status "${status}" unchanged`, () => {
      expect(mapStripeStatus(status)).toBe(status);
    });
  }

  it('passes through Stripe status "paused" to domain "paused"', () => {
    expect(mapStripeStatus('paused')).toBe('paused');
  });

  it('falls back to "incomplete" for any unrecognised Stripe status (fail-safe)', () => {
    // Cast through unknown so the test exercises the runtime fallback
    // path without breaking exhaustiveness at the type layer.
    const future = 'pending_activation' as unknown as Stripe.Subscription.Status;
    expect(mapStripeStatus(future)).toBe('incomplete');
  });
});
