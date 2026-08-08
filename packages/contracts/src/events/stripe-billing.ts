import { z } from 'zod';

/**
 * Relayed Stripe billing events (TS-041a-followup-2; PDD §7.3, §11.1;
 * CLAUDE.md §5.3, §6).
 *
 * These are the platform-side *notifications* that `service-webhook` appends
 * to `webhook.outbox_events` — in the same transaction as the
 * `webhook.stripe_processed_events` ingress row — when a signature-verified
 * Stripe webhook of an allow-listed type arrives. The relay forwards them
 * onto the bus; `service-subscription` (and later `service-accounting`)
 * consume them to bring local rows back in step with Stripe.
 *
 * ---
 *
 * **Why the `stripe.` prefix and not `subscription.` / `invoice.`.** Every
 * other name in this catalog is a *platform domain* event — something this
 * business decided. These three are the opposite: a third party told us
 * something changed. `service-subscription` already owns
 * `subscription.activated` / `.canceled` / `.payment_failed`, which it emits
 * from its own decisions; conflating the two would make "we cancelled this"
 * and "Stripe says this is cancelled" indistinguishable on the bus, and they
 * have different authority. The prefix names the origin.
 *
 * **Why one event per object class rather than one per Stripe type.** The
 * consumer SDK registers handlers per event *name*, so the name is the
 * routing key. One name per Stripe type would put a dozen near-identical
 * registrations in every consumer; a single `stripe.event_received` would
 * wake every consumer for every event, including the Identity/KYC traffic
 * that has nothing to do with billing. One name per object class is the
 * granularity at which a consumer actually differs, and `stripeEventType`
 * carries the rest.
 *
 * **THE PAYLOAD IS A NOTIFICATION, NOT A SNAPSHOT — this is load-bearing.**
 * It carries opaque Stripe handles and nothing else: no amounts, no status,
 * no period boundaries, no card metadata, no email. Two independent reasons,
 * either sufficient:
 *
 *   1. **PII (CLAUDE.md §3.9, §17.2).** A Stripe event body routinely
 *      contains `customer.email`, billing addresses and payment-method
 *      `last4`. An event is the most widely-replicated artefact this
 *      platform produces — it lands in the relay, in Redis Streams, in every
 *      consumer's dedup table and in any future audit sink. Copying a card
 *      brand and last4 into that fan-out to save an API call is the trade
 *      §3.9 exists to refuse.
 *   2. **Staleness (the correctness reason, and the stronger one).** Stripe
 *      does not guarantee webhook ordering. A `customer.subscription.updated`
 *      delivered after a later one — routine on retry — would, if the payload
 *      were a snapshot, write an OLDER status over a newer one and leave the
 *      local row permanently wrong with no error anywhere. Because the
 *      payload carries only `objectId`, the consumer must re-fetch the object
 *      from Stripe, which always yields current state. Out-of-order delivery
 *      then converges instead of corrupting, and the handler is idempotent by
 *      construction rather than by discipline.
 *
 * Consumers dedup on `eventId` (CLAUDE.md §5.3). Here `eventId` IS Stripe's
 * own `evt_...` id: one Stripe event maps to exactly one platform event, so
 * reusing it makes the outbox row's primary key and the ingress row's primary
 * key the same value, and exactly-once-effective delivery survives the
 * dispatch boundary without a second correlation table.
 *
 * Event names are dot-notation, past tense (CLAUDE.md §2.2). The constants
 * are the single source of truth — services import the literal, so a rename
 * is a TS error at every call site.
 */
export const STRIPE_SUBSCRIPTION_CHANGED = 'stripe.subscription.changed' as const;
export const STRIPE_INVOICE_CHANGED = 'stripe.invoice.changed' as const;
export const STRIPE_PAYMENT_METHOD_CHANGED = 'stripe.payment_method.changed' as const;

/**
 * Soft cap for Stripe object identifiers (`evt_`, `sub_`, `in_`, `pm_`,
 * `cus_`). Live ids sit around 30 characters; 255 is deliberate headroom —
 * truncating one here would silently address the wrong object, and a billing
 * event is the wrong place to be clever about bytes.
 */
export const STRIPE_EVENT_ID_MAX_LENGTH = 255;

/**
 * Stripe's `api_version` on the event (e.g. `2024-06-20`). Some accounts
 * carry a beta suffix (`2024-06-20; custom_checkout_beta=v1`), hence the
 * headroom over a bare date.
 */
export const STRIPE_EVENT_API_VERSION_MAX_LENGTH = 64;

const StripeIdSchema = z.string().min(1).max(STRIPE_EVENT_ID_MAX_LENGTH);

/**
 * Envelope shared by every relayed Stripe event.
 *
 * `eventId` is Stripe's `evt_...` (see the module doc-block); `occurredAt` is
 * derived from Stripe's `created`, NOT from our ingress clock — the event
 * semantically happened when Stripe recorded it, and a redelivery three days
 * later must not re-date it.
 */
const StripeRelayEnvelopeSchema = z.object({
  eventId: StripeIdSchema,
  occurredAt: z.string().datetime(),
  /** Stripe's event id, repeated for consumers that read the payload alone. */
  stripeEventId: StripeIdSchema,
  /**
   * `false` for test-mode traffic. Carried so a consumer can refuse to mutate
   * production rows from a test-mode event — the two share this pipe, and
   * nothing downstream can otherwise tell them apart.
   */
  livemode: z.boolean(),
  /**
   * Stripe's `customer` handle when the object carries one, else null.
   * Opaque; not PII. Present so a consumer can route or reject before
   * spending a Stripe round-trip.
   */
  stripeCustomerId: StripeIdSchema.nullable(),
  /** Stripe's API version for the event, when the event declares one. */
  apiVersion: z.string().min(1).max(STRIPE_EVENT_API_VERSION_MAX_LENGTH).nullable(),
});

/**
 * The Stripe subscription event types this platform relays.
 *
 * **An allow-list, not a prefix match.** `service-webhook` receives every
 * event type the account is subscribed to; only the ones with a consumer are
 * put on the bus. Adding a type is a deliberate one-line change here plus a
 * handler — the shape of a decision, not a wildcard that quietly grows.
 *
 * `trial_will_end` is deliberately absent: it is a reminder, not a state
 * change, and re-fetching a subscription that has not changed teaches a
 * handler to do nothing, which is how a handler that should do something
 * gets written wrong.
 */
export const STRIPE_RELAYED_SUBSCRIPTION_EVENT_TYPES = [
  'customer.subscription.created',
  'customer.subscription.updated',
  'customer.subscription.deleted',
  'customer.subscription.paused',
  'customer.subscription.resumed',
] as const;

export const StripeRelayedSubscriptionEventTypeSchema = z.enum(
  STRIPE_RELAYED_SUBSCRIPTION_EVENT_TYPES,
);
export type StripeRelayedSubscriptionEventType = z.infer<
  typeof StripeRelayedSubscriptionEventTypeSchema
>;

/**
 * `stripe.subscription.changed` payload.
 *
 * `stripeSubscriptionId` is the handle to re-fetch. Note that
 * `customer.subscription.deleted` is relayed like any other change rather
 * than being special-cased into its own event: Stripe still serves the
 * object afterwards with `status: 'canceled'`, so the consumer's single
 * re-fetch-and-reconcile path covers it, and one path is one place for the
 * cancellation semantics to be right.
 */
export const StripeSubscriptionChangedSchema = StripeRelayEnvelopeSchema.extend({
  stripeEventType: StripeRelayedSubscriptionEventTypeSchema,
  stripeSubscriptionId: StripeIdSchema,
}).strict();
export type StripeSubscriptionChanged = z.infer<typeof StripeSubscriptionChangedSchema>;

/**
 * The Stripe invoice event types this platform relays.
 *
 * `invoice.paid` and `invoice.payment_succeeded` are BOTH relayed even though
 * Stripe fires them together for a normal card payment. They are not
 * synonyms — an invoice paid out of credit balance or marked paid out of band
 * raises `paid` with no `payment_succeeded` — and dropping one would lose
 * exactly the non-card payments a wellness platform's partner billing tends
 * to use. The consumer's re-fetch makes the duplicate harmless.
 */
export const STRIPE_RELAYED_INVOICE_EVENT_TYPES = [
  'invoice.created',
  'invoice.finalized',
  'invoice.paid',
  'invoice.payment_succeeded',
  'invoice.payment_failed',
  'invoice.voided',
  'invoice.marked_uncollectible',
] as const;

export const StripeRelayedInvoiceEventTypeSchema = z.enum(STRIPE_RELAYED_INVOICE_EVENT_TYPES);
export type StripeRelayedInvoiceEventType = z.infer<typeof StripeRelayedInvoiceEventTypeSchema>;

/**
 * `stripe.invoice.changed` payload.
 *
 * `stripeSubscriptionId` is nullable: a one-off invoice belongs to no
 * subscription. A consumer that only cares about subscription billing skips
 * on null rather than re-fetching to discover the same thing.
 */
export const StripeInvoiceChangedSchema = StripeRelayEnvelopeSchema.extend({
  stripeEventType: StripeRelayedInvoiceEventTypeSchema,
  stripeInvoiceId: StripeIdSchema,
  stripeSubscriptionId: StripeIdSchema.nullable(),
}).strict();
export type StripeInvoiceChanged = z.infer<typeof StripeInvoiceChangedSchema>;

/**
 * The Stripe payment-method event types this platform relays.
 *
 * `automatically_updated` is the card-account-updater path — Stripe replaces
 * an expired card's number/expiry behind the scenes. Omitting it is how a
 * billing page ends up showing an expiry date that passed months ago on a
 * card that is still charging fine.
 */
export const STRIPE_RELAYED_PAYMENT_METHOD_EVENT_TYPES = [
  'payment_method.attached',
  'payment_method.updated',
  'payment_method.automatically_updated',
  'payment_method.detached',
] as const;

export const StripeRelayedPaymentMethodEventTypeSchema = z.enum(
  STRIPE_RELAYED_PAYMENT_METHOD_EVENT_TYPES,
);
export type StripeRelayedPaymentMethodEventType = z.infer<
  typeof StripeRelayedPaymentMethodEventTypeSchema
>;

/**
 * `stripe.payment_method.changed` payload.
 *
 * Deliberately carries NO brand / last4 / expiry. Those are the display
 * fields the consumer exists to populate (TS-041b-followup-4) and they are
 * exactly the card metadata §3.9 keeps off the wire — the consumer reads them
 * from Stripe on the authenticated fetch and writes them straight to its own
 * row.
 *
 * On `payment_method.detached` Stripe has already cleared the customer link,
 * so `stripeCustomerId` is null on that branch; the consumer identifies the
 * row by `stripePaymentMethodId`, which is why that field is the one that is
 * never nullable.
 */
export const StripePaymentMethodChangedSchema = StripeRelayEnvelopeSchema.extend({
  stripeEventType: StripeRelayedPaymentMethodEventTypeSchema,
  stripePaymentMethodId: StripeIdSchema,
}).strict();
export type StripePaymentMethodChanged = z.infer<typeof StripePaymentMethodChangedSchema>;

/**
 * Every Stripe event type this platform relays, across all three classes.
 *
 * Exported so the producer's dispatch table and the contract cannot drift:
 * `service-webhook`'s mapper is asserted to cover exactly this set, so a type
 * added here without a mapping — or mapped without being declared — fails a
 * test rather than silently dropping a billing event.
 */
export const STRIPE_RELAYED_EVENT_TYPES = [
  ...STRIPE_RELAYED_SUBSCRIPTION_EVENT_TYPES,
  ...STRIPE_RELAYED_INVOICE_EVENT_TYPES,
  ...STRIPE_RELAYED_PAYMENT_METHOD_EVENT_TYPES,
] as const;

export type StripeRelayedEventType = (typeof STRIPE_RELAYED_EVENT_TYPES)[number];

/** True when `service-webhook` should put this Stripe event type on the bus. */
export function isStripeRelayedEventType(eventType: string): eventType is StripeRelayedEventType {
  return (STRIPE_RELAYED_EVENT_TYPES as readonly string[]).includes(eventType);
}
