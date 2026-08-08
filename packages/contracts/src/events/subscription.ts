import { z } from 'zod';

import { PlanCustomerGroupSchema } from '../http/plan.schema';

/**
 * Event names are dot-notation, past tense (CLAUDE.md §2.2). The constants
 * below are the single source of truth — services import these literals
 * rather than typing the strings, so a rename is a TS error at every call
 * site.
 */
export const SUBSCRIPTION_ACTIVATED = 'subscription.activated' as const;
export const SUBSCRIPTION_CANCELED = 'subscription.canceled' as const;
export const SUBSCRIPTION_PAYMENT_FAILED = 'subscription.payment_failed' as const;
export const SUBSCRIPTION_PAYMENT_SUCCEEDED = 'subscription.payment_succeeded' as const;
export const SUBSCRIPTION_DUNNING_EXHAUSTED = 'subscription.dunning_exhausted' as const;
export const SUBSCRIPTION_PAUSED = 'subscription.paused' as const;
export const SUBSCRIPTION_RESUMED = 'subscription.resumed' as const;

/**
 * Common event envelope fields shared by every event in the catalog.
 * `eventId` is the deduplication key — consumers MUST be idempotent on this
 * (CLAUDE.md §5.3). `occurredAt` is the producer's wall-clock timestamp.
 */
const EventEnvelopeSchema = z.object({
  eventId: z.string().min(1).max(128),
  occurredAt: z.string().datetime(),
});

/**
 * `subscription.activated` payload.
 *
 * Emitted by service-subscription when a paid subscription is first
 * created (TS-142-followup-9). Consumed by service-accounting's
 * revenue-recognition driver (TS-142-followup-2-followup-2) to post
 * the activation journal + create the deferred-revenue balance.
 *
 * **Amount.** `amountMinor` carries the full activation amount for
 * the service period in integer USD minor units (cents) — CLAUDE.md
 * §17.6, never floats. For a monthly tier this is one month's price;
 * for an annual tier it is the annual price (the service period
 * spans the full year). The consumer recognises this amount over
 * `[periodStart, periodEnd]` per CLAUDE.md §17.17.
 *
 * `currency` is the ISO-4217 alpha-3 code. Phase 1 only emits USD;
 * the field is included to make the consumer's currency-aware
 * journal-posting path explicit (CLAUDE.md §6 — accounting is
 * surgery).
 */
export const SubscriptionActivatedSchema = EventEnvelopeSchema.extend({
  subscriptionId: z.string().min(1).max(64),
  customerId: z.string().min(1).max(64),
  customerGroup: PlanCustomerGroupSchema,
  planId: z.string().min(1).max(64),
  planCode: z.string().min(1).max(64),
  periodStart: z.string().datetime(),
  periodEnd: z.string().datetime(),
  /**
   * Activation amount for `[periodStart, periodEnd]` in integer USD
   * minor units (cents). MUST be > 0 — a zero-dollar activation is
   * a contract error.
   */
  amountMinor: z.number().int().positive(),
  /**
   * ISO-4217 alpha-3 currency code (e.g. `USD`). Phase 1 only emits
   * `USD`; downstream services may safely narrow to that single
   * value while the contract type stays open for future expansion.
   */
  currency: z.string().length(3).default('USD'),
}).strict();
export type SubscriptionActivated = z.infer<typeof SubscriptionActivatedSchema>;

export const SubscriptionCanceledSchema = EventEnvelopeSchema.extend({
  subscriptionId: z.string().min(1).max(64),
  customerId: z.string().min(1).max(64),
  reason: z.enum([
    'customer_request',
    'payment_failure',
    'fraud',
    'admin_action',
    'partner_termination',
  ]),
  effectiveAt: z.string().datetime(),
}).strict();
export type SubscriptionCanceled = z.infer<typeof SubscriptionCanceledSchema>;

/**
 * Which customer population `customerId` refers to. REQUIRED on every
 * dunning event (TS-042-followup-3a2a).
 *
 * `subscriptions.customer_id` is a soft FK whose TARGET SCHEMA depends on
 * this field — `household.households.id` for `family`, `provider.providers.id`
 * for `provider`, `identity.users.id` for `academy`. Without it a consumer
 * holding a dunning payload cannot tell which service to ask for the billing
 * contact, and the failure mode is silent: asking service-household for a
 * provider id returns an empty contact list, so the notification is simply
 * never sent and nothing reports an error. `subscription.activated` has
 * always carried it; these three were specified before they had a consumer.
 */

/**
 * Status values a dunning lifecycle event may report. Deliberately the
 * same literal set as `SubscriptionStatusSchema` rather than an import —
 * `packages/contracts/src/http/subscription.schema.ts` owns the HTTP DTO
 * surface, and an event payload that silently tracked a DTO refactor would
 * violate CLAUDE.md §5.3 (events evolve backward-compatibly on their own
 * schedule). The `events.test.ts` suite asserts the two stay in step, so a
 * divergence is a failing test rather than a silent drift.
 */
const DunningStatusSchema = z.enum([
  'trialing',
  'active',
  'past_due',
  'paused',
  'canceled',
  'unpaid',
  'incomplete',
  'incomplete_expired',
]);

/**
 * `subscription.payment_failed` payload.
 *
 * Emitted by `DunningService.recordPaymentFailure` inside the same
 * transaction as the `past_due` status write (TS-042-followup-3).
 *
 * **`graceUntil` is the field this event exists for.** It is the instant
 * *this platform* stops serving an unpaid subscription — distinct from
 * `nextAttemptAt`, which is when *Stripe* will next try the card. The
 * dunning-ladder consumer (service-notification) needs the former to tell a
 * family how long they have; nothing else on the platform carries it.
 *
 * **`invoiceId` / `amountUsdMinor` are optional and are not populated by
 * the dunning state machine.** They were specified before this event had a
 * producer. The producer is driven by `stripe.invoice.changed`, which
 * carries handles only and no money (TS-041b-followup-3b: the payload is a
 * notification, not a snapshot) — so the emitter would have to invent the
 * amount from the plan price, which differs from the invoice total whenever
 * a proration or coupon applies. Money for a failed payment lives on the
 * `invoices` table and the ledger, which are its source of truth
 * (CLAUDE.md §6); restating a possibly-disagreeing copy here would make two.
 * The fields stay in the schema, optional, so a future producer that
 * genuinely holds an invoice can populate them without a breaking change.
 */
export const SubscriptionPaymentFailedSchema = EventEnvelopeSchema.extend({
  subscriptionId: z.string().min(1).max(64),
  customerId: z.string().min(1).max(64),
  customerGroup: PlanCustomerGroupSchema,
  invoiceId: z.string().min(1).max(64).optional(),
  amountUsdMinor: z.number().int().min(0).optional(),
  attemptCount: z.number().int().min(1),
  nextAttemptAt: z.string().datetime().optional(),
  /** Instant of the failed payment attempt — Stripe's clock, not ours. */
  attemptedAt: z.string().datetime(),
  /**
   * Instant this platform's grace window expires, after which
   * `applyDunningExhaustion` moves the subscription to `unpaid`. Null only
   * if the grace window could not be established.
   */
  graceUntil: z.string().datetime().nullable(),
  /** Status the subscription moved from. `toStatus` is always `past_due`. */
  fromStatus: DunningStatusSchema,
}).strict();
export type SubscriptionPaymentFailed = z.infer<typeof SubscriptionPaymentFailedSchema>;

/**
 * `subscription.payment_succeeded` payload.
 *
 * Emitted by `DunningService.recordPaymentSuccess` in-transaction.
 *
 * **`recovered` is the discriminator that matters.** A routine renewal
 * payment and a payment that rescued a `past_due` subscription are the same
 * Stripe event but completely different customer moments: only the second
 * warrants a "you're all set" email, and only the second closes a dunning
 * funnel step. Consumers that treat every success alike will mail families
 * monthly about a problem they never had.
 */
export const SubscriptionPaymentSucceededSchema = EventEnvelopeSchema.extend({
  subscriptionId: z.string().min(1).max(64),
  customerId: z.string().min(1).max(64),
  customerGroup: PlanCustomerGroupSchema,
  succeededAt: z.string().datetime(),
  /** True when this payment cleared a `past_due` / `unpaid` subscription. */
  recovered: z.boolean(),
  fromStatus: DunningStatusSchema,
  toStatus: DunningStatusSchema,
  /**
   * Failed attempts cleared by this payment. Zero on a routine renewal
   * (which is exactly when `recovered` is false).
   */
  attemptsCleared: z.number().int().min(0),
}).strict();
export type SubscriptionPaymentSucceeded = z.infer<typeof SubscriptionPaymentSucceededSchema>;

/**
 * `subscription.dunning_exhausted` payload.
 *
 * Emitted by `DunningService.applyDunningExhaustion` in-transaction when the
 * grace window has expired and the subscription moves `past_due` → `unpaid`.
 * This is the end of the dunning ladder, not a retry — the consumer that
 * suspends entitlements keys on this event, never on `payment_failed`.
 */
export const SubscriptionDunningExhaustedSchema = EventEnvelopeSchema.extend({
  subscriptionId: z.string().min(1).max(64),
  customerId: z.string().min(1).max(64),
  customerGroup: PlanCustomerGroupSchema,
  /** Instant exhaustion was applied (the sweep's clock). */
  exhaustedAt: z.string().datetime(),
  /** Grace deadline that expired. Always in the past relative to `exhaustedAt`. */
  graceUntil: z.string().datetime(),
  /** Failed attempts accumulated before exhaustion. */
  attemptCount: z.number().int().min(0),
}).strict();
export type SubscriptionDunningExhausted = z.infer<typeof SubscriptionDunningExhaustedSchema>;

/**
 * `subscription.paused` payload.
 *
 * Emitted by `DunningService.pauseSubscription` in-transaction, after Stripe
 * has accepted the `pause_collection` write, AND by
 * `StripeSubscriptionReconcilerService` when it observes collection being
 * paused out of band (the Stripe Dashboard). On the reconciler path
 * `requesterUserId` is `null`, `hasReason` is `false`, and `pausedAt` is the
 * observation instant — Stripe reports THAT collection is paused, never when.
 *
 * **The pause reason does NOT cross the wire.** `PauseSubscriptionRequest.reason`
 * is documented free-form operator/customer text, and on this platform a
 * pause reason is very often a health or bereavement disclosure about a named
 * senior. An event fans out to the relay, Redis Streams, and every consumer's
 * dedup table — far wider replication than the single `subscriptions.pause_reason`
 * column it was written into (CLAUDE.md §3.9, §12). `hasReason` carries the
 * only part a consumer can act on: whether an operator recorded context that a
 * human should go and read at the source.
 */
export const SubscriptionPausedSchema = EventEnvelopeSchema.extend({
  subscriptionId: z.string().min(1).max(64),
  customerId: z.string().min(1).max(64),
  pausedAt: z.string().datetime(),
  /** Instant Stripe will auto-resume collection, when one was requested. */
  resumesAt: z.string().datetime().nullable(),
  /** Whether free-form context was recorded. The text itself stays in the row. */
  hasReason: z.boolean(),
  /**
   * The platform user who requested the pause, or `null` when nobody on
   * this platform did.
   *
   * **`null` is the discriminator for an out-of-band change, not a
   * missing value.** Collection can be paused from the Stripe Dashboard,
   * in which case the change is first observed by
   * `StripeSubscriptionReconcilerService` and there is no requester to
   * name — inventing a sentinel user id would put a value that is not a
   * user into a field typed as one. A consumer that needs to distinguish
   * "a person did this here" from "we found this at Stripe" tests for
   * `null`; the reconciler's `subscription_history` row carries the
   * Stripe event id for the full trace.
   */
  requesterUserId: z.string().min(1).max(64).nullable(),
  /** Status the subscription moved from. `toStatus` is always `paused`. */
  fromStatus: DunningStatusSchema,
}).strict();
export type SubscriptionPaused = z.infer<typeof SubscriptionPausedSchema>;

/**
 * `subscription.resumed` payload.
 *
 * Emitted by `DunningService.resumeSubscription` in-transaction.
 *
 * **`toStatus` is not always `active`.** Resume clears `pause_collection` and
 * adopts whatever status Stripe reports, which is `past_due` when the
 * subscription was paused mid-dunning. A consumer that resumes revenue accrual
 * on this event must read `toStatus`, not assume recovery. The resume `note`
 * is withheld for the same reason as the pause reason.
 *
 * **Also emitted by `StripeSubscriptionReconcilerService`** when Stripe
 * auto-resumes collection at the `resumes_at` the pause requested, or when an
 * operator resumes from the Dashboard. Without that second producer a
 * consumer which suspends work on `subscription.paused` would never be told to
 * restart it — service-accounting's deferred-revenue balance would sit
 * suspended forever while Stripe and this service both looked correct. On that
 * path `requesterUserId` is `null` and `resumedAt` is the OBSERVATION instant,
 * not the true resume instant: Stripe reports that collection has resumed, not
 * when. The observation is always at or after the truth, which for a consumer
 * that compensates for suspended time errs in the customer's favour.
 */
export const SubscriptionResumedSchema = EventEnvelopeSchema.extend({
  subscriptionId: z.string().min(1).max(64),
  customerId: z.string().min(1).max(64),
  resumedAt: z.string().datetime(),
  /** See `SubscriptionPausedSchema.requesterUserId` — `null` means Stripe-observed. */
  requesterUserId: z.string().min(1).max(64).nullable(),
  /** Status adopted from Stripe. `fromStatus` is always `paused`. */
  toStatus: DunningStatusSchema,
  /** Whether a free-form note was recorded. The text itself stays in history. */
  hasNote: z.boolean(),
}).strict();
export type SubscriptionResumed = z.infer<typeof SubscriptionResumedSchema>;
