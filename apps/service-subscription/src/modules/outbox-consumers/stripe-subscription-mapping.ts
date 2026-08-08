import type {
  AdminSubscriptionHistoryEvent as SubscriptionHistoryEvent,
  SubscriptionStatus,
} from '@taste-and-see/contracts';
import type Stripe from 'stripe';

/**
 * Pure mapping from a freshly-fetched Stripe subscription to the local row
 * shape (TS-041b-followup-3a).
 *
 * Kept free of Prisma, Stripe SDK calls, logging and the clock so the two
 * decisions that are easy to get quietly wrong — how a Stripe status becomes
 * ours, and what counts as a change worth writing — are testable against
 * literals.
 */

/**
 * The local statuses. Mirrors `subscription.subscription_status`; restated
 * here as a `const` set so an unrecognised Stripe status is a *detected*
 * condition rather than a cast.
 */
const LOCAL_STATUSES = [
  'incomplete',
  'incomplete_expired',
  'trialing',
  'active',
  'past_due',
  'unpaid',
  'canceled',
  'paused',
] as const;

function isLocalStatus(value: string): value is SubscriptionStatus {
  return (LOCAL_STATUSES as readonly string[]).includes(value);
}

/**
 * The outcome of reading a Stripe status. `unknown_status` is a first-class
 * result rather than a thrown error because the caller's correct response is
 * to write NOTHING and say so loudly — see {@link mapStripeSubscription}.
 */
export type StatusMapping =
  | { readonly kind: 'mapped'; readonly status: SubscriptionStatus }
  | { readonly kind: 'unknown_status'; readonly stripeStatus: string };

/**
 * Map Stripe's subscription status to ours.
 *
 * **`pause_collection` wins over `status`, and that is the whole point of
 * this function.** This platform's `paused` status means "collection is
 * paused" — that is what `DunningService.pauseCollection` writes when an
 * operator or customer pauses, and it sets `status: 'paused'` locally while
 * calling Stripe's `subscriptions.update({ pause_collection: ... })`. Stripe
 * does NOT change `subscription.status` for a paused collection; the
 * subscription stays `active` on their side. So a handler that copied
 * `stripeSubscription.status` across would flip every paused subscription
 * back to `active` on the very next webhook — the platform would show a
 * family as actively billing while Stripe collected nothing from them, and
 * nothing would report the disagreement.
 *
 * Stripe's own `paused` status (a trial that ended with no payment method) is
 * a different situation that lands on the same local value, correctly.
 */
export function mapStripeStatus(subscription: Stripe.Subscription): StatusMapping {
  if (subscription.pause_collection !== null && subscription.pause_collection !== undefined) {
    return { kind: 'mapped', status: 'paused' };
  }

  const stripeStatus: string = subscription.status;
  if (!isLocalStatus(stripeStatus)) {
    return { kind: 'unknown_status', stripeStatus };
  }
  return { kind: 'mapped', status: stripeStatus };
}

/**
 * The subset of the local row this reconciler owns.
 *
 * **What is deliberately absent is as much of the design as what is
 * present.** Each omission has an owner that would be overwritten:
 *
 *   - `dunningAttempts` / `dunningLastAttemptAt` / `dunningGraceUntil` —
 *     owned by `DunningService`, driven by invoice events (TS-042-followup-4).
 *     A subscription reconciler that reset them would erase the grace window
 *     a family is currently inside.
 *   - `planId` / `billingInterval` — a plan change made in the Stripe
 *     Dashboard would need a price→plan reverse lookup that does not exist.
 *     Out-of-band plan changes therefore leave the local plan stale
 *     (TS-041b-followup-3a-1). Guessing is worse: the plan drives entitlement.
 *   - `defaultPaymentMethodId` — a local `payment_methods.id`, not a Stripe
 *     `pm_...`; the join belongs with the payment-method handler
 *     (TS-041b-followup-4).
 *   - `pauseReason` — operator/customer free text. Stripe has no such field,
 *     so it can only be CLEARED here (on a resume), never set.
 */
export interface ReconcilableSubscriptionFields {
  readonly status: SubscriptionStatus;
  readonly currentPeriodStart: Date;
  readonly currentPeriodEnd: Date;
  readonly trialEnd: Date | null;
  readonly cancelAtPeriodEnd: boolean;
  readonly canceledAt: Date | null;
  readonly pauseCollectionStartedAt: Date | null;
  readonly pauseCollectionResumesAt: Date | null;
  readonly pauseReason: string | null;
}

export type MapResult =
  | { readonly kind: 'mapped'; readonly fields: ReconcilableSubscriptionFields }
  | { readonly kind: 'unknown_status'; readonly stripeStatus: string };

/**
 * Build the local field set from the fetched Stripe subscription.
 *
 * @param existing the current local values the mapper needs to preserve or
 *        clear — passed in rather than read here so this stays pure.
 * @param observedAt the event's `occurredAt`. Used only as the stamp for a
 *        pause we are learning about after the fact (Stripe records that a
 *        collection is paused, never when it was paused).
 */
export function mapStripeSubscription(args: {
  readonly subscription: Stripe.Subscription;
  readonly existing: Pick<
    ReconcilableSubscriptionFields,
    'pauseCollectionStartedAt' | 'pauseReason'
  >;
  readonly observedAt: Date;
}): MapResult {
  const { subscription, existing, observedAt } = args;

  const status = mapStripeStatus(subscription);
  if (status.kind === 'unknown_status') return status;

  const paused = subscription.pause_collection ?? null;

  return {
    kind: 'mapped',
    fields: {
      status: status.status,
      currentPeriodStart: fromUnix(readPeriod(subscription, 'current_period_start')),
      currentPeriodEnd: fromUnix(readPeriod(subscription, 'current_period_end')),
      trialEnd: optionalUnix(subscription.trial_end),
      cancelAtPeriodEnd: subscription.cancel_at_period_end,
      canceledAt: optionalUnix(subscription.canceled_at),
      // Stripe tells us THAT collection is paused, never WHEN. Preserve the
      // local stamp when we already had one (the pause we performed), and
      // fall back to the moment we observed it for a pause applied out of
      // band in the Dashboard. Cleared entirely on resume.
      pauseCollectionStartedAt:
        paused === null ? null : (existing.pauseCollectionStartedAt ?? observedAt),
      pauseCollectionResumesAt: paused === null ? null : optionalUnix(paused.resumes_at ?? null),
      // Never SET from Stripe (there is no such field there); cleared when
      // the pause it explains is gone.
      pauseReason: paused === null ? null : existing.pauseReason,
    },
  };
}

/**
 * The `SubscriptionHistory` event a status transition should be recorded
 * under.
 *
 * `canceled` and `paused` have their own enum members and reading a history
 * of `status_changed → canceled` when `canceled` exists makes the audit trail
 * harder to query for exactly the transitions anyone asks about.
 */
export function historyEventForStatus(to: SubscriptionStatus): SubscriptionHistoryEvent {
  if (to === 'canceled') return 'canceled';
  if (to === 'paused') return 'paused';
  return 'status_changed';
}

/**
 * Fields whose value differs between the fetched Stripe state and the local
 * row. Empty means the redelivery (or the no-op webhook) changes nothing and
 * must not be written.
 *
 * **Why "changed" is computed rather than just issuing the UPDATE.** An
 * unconditional write is harmless to the row but not to
 * `subscription_history`, which is append-only: every Stripe redelivery would
 * leave another indistinguishable row in a family's audit trail. Comparing
 * first is what keeps the history a record of transitions rather than a
 * record of webhook traffic.
 */
export function changedFields(
  next: ReconcilableSubscriptionFields,
  current: ReconcilableSubscriptionFields,
): ReadonlyArray<keyof ReconcilableSubscriptionFields> {
  const keys: ReadonlyArray<keyof ReconcilableSubscriptionFields> = [
    'status',
    'currentPeriodStart',
    'currentPeriodEnd',
    'trialEnd',
    'cancelAtPeriodEnd',
    'canceledAt',
    'pauseCollectionStartedAt',
    'pauseCollectionResumesAt',
    'pauseReason',
  ];
  return keys.filter((key) => !sameValue(next[key], current[key]));
}

function sameValue(a: unknown, b: unknown): boolean {
  if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime();
  if (a instanceof Date || b instanceof Date) return false;
  return a === b;
}

/**
 * Read a period boundary across both shapes Stripe has used.
 *
 * `current_period_start` / `current_period_end` sat on the subscription
 * through API version 2024-11-20 and moved onto each subscription ITEM in
 * 2025-03-31. Reading only the top level would, on a newer account API
 * version, yield `undefined` and put the epoch into a billing period — so the
 * item is the documented fallback, and the absence of both is a hard error
 * rather than a silent 1970.
 */
function readPeriod(
  subscription: Stripe.Subscription,
  key: 'current_period_start' | 'current_period_end',
): number {
  const topLevel = (subscription as unknown as Record<string, unknown>)[key];
  if (typeof topLevel === 'number') return topLevel;

  const items = subscription.items?.data ?? [];
  for (const item of items) {
    const onItem = (item as unknown as Record<string, unknown>)[key];
    if (typeof onItem === 'number') return onItem;
  }

  throw new StripeSubscriptionShapeError(subscription.id, key);
}

/**
 * Raised when a fetched Stripe subscription carries neither shape of a
 * billing-period boundary. Thrown rather than defaulted: a subscription row
 * whose period silently became 1970 reads as wildly overdue to every sweep
 * and dashboard that touches it.
 */
export class StripeSubscriptionShapeError extends Error {
  constructor(
    readonly stripeSubscriptionId: string,
    readonly missingField: string,
  ) {
    super(`stripe subscription ${stripeSubscriptionId} carries no ${missingField}`);
    this.name = 'StripeSubscriptionShapeError';
  }
}

function fromUnix(seconds: number): Date {
  return new Date(seconds * 1000);
}

function optionalUnix(seconds: number | null | undefined): Date | null {
  return typeof seconds === 'number' ? new Date(seconds * 1000) : null;
}
