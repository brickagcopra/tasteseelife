import type { SubscriptionStatus } from '@taste-and-see/contracts';
import type Stripe from 'stripe';

/**
 * Map a Stripe subscription status to the platform's domain enum.
 *
 * Stripe's status set has two values that don't map 1:1 to ours:
 *   - `incomplete` and `incomplete_expired` are direct passthroughs.
 *   - `paused` exists in our enum but Stripe expresses pause via
 *     `pause_collection` on an `active` subscription. Our `paused`
 *     status is therefore set by the dunning service (TS-042) when it
 *     applies pause_collection; this mapper never returns `paused`.
 *
 * Falls back to `incomplete` for any unknown future Stripe status — this
 * is fail-safe (a subscription in an unrecognised state is treated as
 * not-yet-active, which is the conservative default for billing/access).
 * The unknown value is logged via the call site for ops visibility.
 */
export function mapStripeStatus(status: Stripe.Subscription.Status): SubscriptionStatus {
  switch (status) {
    case 'incomplete':
    case 'incomplete_expired':
    case 'trialing':
    case 'active':
    case 'past_due':
    case 'unpaid':
    case 'canceled':
      return status;
    case 'paused':
      // Stripe added a top-level `paused` status in a more recent API
      // version; map it through to our domain `paused`.
      return 'paused';
    default:
      // Exhaustiveness fallback — any status added to Stripe's enum we
      // don't yet recognise is treated as `incomplete`.
      return 'incomplete';
  }
}
