import {
  STRIPE_INVOICE_CHANGED,
  STRIPE_PAYMENT_METHOD_CHANGED,
  STRIPE_RELAYED_INVOICE_EVENT_TYPES,
  STRIPE_RELAYED_PAYMENT_METHOD_EVENT_TYPES,
  STRIPE_RELAYED_SUBSCRIPTION_EVENT_TYPES,
  STRIPE_SUBSCRIPTION_CHANGED,
  type StripeInvoiceChanged,
  type StripePaymentMethodChanged,
  type StripeRelayedInvoiceEventType,
  type StripeRelayedPaymentMethodEventType,
  type StripeRelayedSubscriptionEventType,
  type StripeSubscriptionChanged,
} from '@taste-and-see/contracts';
import type Stripe from 'stripe';

/**
 * Maps a signature-verified Stripe event onto the platform event this service
 * appends to `webhook.outbox_events` (TS-041a-followup-2).
 *
 * **Pure and total.** No I/O, no clock, no logger — the ingress service owns
 * the transaction and this owns the decision, so the mapping is testable
 * against a literal event object and the same input always yields the same
 * row. `null` means "not relayed", which is the answer for the large majority
 * of Stripe's catalog.
 *
 * **Why the wire shape is read as `unknown` rather than through the SDK's
 * union.** `Stripe.Event` in the SDK is a discriminated union over ~250
 * `type` literals, and the fields we want move between API versions —
 * `Invoice.subscription` is a top-level string today and is nested under
 * `parent.subscription_details` on newer versions. A `switch` over the SDK
 * union would compile against whichever shape the pinned SDK happens to
 * declare and then read `undefined` at runtime the day the account's API
 * version moves, silently relaying an invoice with no subscription link.
 * Reading the JSON defensively is the shape that survives that, and the
 * readers below are small enough to be obviously correct.
 */

export type StripeRelayAppend =
  | {
      readonly eventName: typeof STRIPE_SUBSCRIPTION_CHANGED;
      readonly payload: StripeSubscriptionChanged;
    }
  | { readonly eventName: typeof STRIPE_INVOICE_CHANGED; readonly payload: StripeInvoiceChanged }
  | {
      readonly eventName: typeof STRIPE_PAYMENT_METHOD_CHANGED;
      readonly payload: StripePaymentMethodChanged;
    };

/**
 * Raised when an allow-listed event arrives without the object handle the
 * payload requires.
 *
 * **This throws rather than returning null on purpose.** Returning null would
 * make a malformed billing event indistinguishable from an event we chose not
 * to relay — the ingress row would commit, Stripe would get its 200, and the
 * subscription state change would be lost with nothing anywhere saying so.
 * Throwing rolls the ingress transaction back, so Stripe retries (it does so
 * for three days) and the failure is visible. A Stripe event of these types
 * without an `id` on its object is not a case that should happen; if it does,
 * loudly is the only safe way to find out.
 */
export class StripeRelayMappingError extends Error {
  constructor(
    readonly stripeEventId: string,
    readonly stripeEventType: string,
    readonly missingField: string,
  ) {
    super(
      `stripe event ${stripeEventId} of type ${stripeEventType} is missing ${missingField}; cannot relay`,
    );
    this.name = 'StripeRelayMappingError';
  }
}

const SUBSCRIPTION_TYPES: ReadonlySet<string> = new Set(STRIPE_RELAYED_SUBSCRIPTION_EVENT_TYPES);
const INVOICE_TYPES: ReadonlySet<string> = new Set(STRIPE_RELAYED_INVOICE_EVENT_TYPES);
const PAYMENT_METHOD_TYPES: ReadonlySet<string> = new Set(
  STRIPE_RELAYED_PAYMENT_METHOD_EVENT_TYPES,
);

export function mapStripeEventToOutbox(event: Stripe.Event): StripeRelayAppend | null {
  const eventType: string = event.type;
  if (
    !SUBSCRIPTION_TYPES.has(eventType) &&
    !INVOICE_TYPES.has(eventType) &&
    !PAYMENT_METHOD_TYPES.has(eventType)
  ) {
    return null;
  }

  const object: unknown = event.data.object;
  const envelope = {
    // Stripe's own event id is the platform event id — one Stripe event maps
    // to exactly one platform event, so the outbox primary key and the
    // ingress primary key are the same value and exactly-once-effective
    // delivery survives the dispatch boundary (see the contract doc-block).
    eventId: event.id,
    // Stripe's clock, not ours: a redelivery three days later must not
    // re-date the event.
    occurredAt: new Date(event.created * 1000).toISOString(),
    stripeEventId: event.id,
    livemode: event.livemode,
    stripeCustomerId: readStripeId(readField(object, 'customer')),
    apiVersion: nonEmpty(event.api_version),
  } as const;

  if (SUBSCRIPTION_TYPES.has(eventType)) {
    return {
      eventName: STRIPE_SUBSCRIPTION_CHANGED,
      payload: {
        ...envelope,
        stripeEventType: eventType as StripeRelayedSubscriptionEventType,
        stripeSubscriptionId: requireObjectId(event, 'subscription id'),
      },
    };
  }

  if (INVOICE_TYPES.has(eventType)) {
    return {
      eventName: STRIPE_INVOICE_CHANGED,
      payload: {
        ...envelope,
        stripeEventType: eventType as StripeRelayedInvoiceEventType,
        stripeInvoiceId: requireObjectId(event, 'invoice id'),
        stripeSubscriptionId: readInvoiceSubscriptionId(object),
      },
    };
  }

  return {
    eventName: STRIPE_PAYMENT_METHOD_CHANGED,
    payload: {
      ...envelope,
      stripeEventType: eventType as StripeRelayedPaymentMethodEventType,
      stripePaymentMethodId: requireObjectId(event, 'payment method id'),
    },
  };
}

/**
 * The invoice's subscription handle, across both shapes Stripe has used.
 *
 * Through API version `2024-11-20` it is a top-level `subscription`; from
 * `2025-03-31` it moved to `parent.subscription_details.subscription`. Both
 * are read because the account's API version — not this SDK's pin — decides
 * which arrives, and an invoice that silently loses its subscription link
 * becomes an invoice the consumer files against nothing.
 */
function readInvoiceSubscriptionId(object: unknown): string | null {
  const topLevel = readStripeId(readField(object, 'subscription'));
  if (topLevel !== null) return topLevel;

  const parent = readField(object, 'parent');
  const details = readField(parent, 'subscription_details');
  return readStripeId(readField(details, 'subscription'));
}

/**
 * The changed object's own id. Absence is a hard error, never a skip — see
 * {@link StripeRelayMappingError}.
 */
function requireObjectId(event: Stripe.Event, label: string): string {
  const id = readStripeId(readField(event.data.object, 'id'));
  if (id === null) {
    throw new StripeRelayMappingError(event.id, event.type, label);
  }
  return id;
}

/** Property read that tolerates any non-object without throwing. */
function readField(source: unknown, key: string): unknown {
  if (source === null || typeof source !== 'object') return undefined;
  return (source as Record<string, unknown>)[key];
}

/**
 * A Stripe reference is either the bare id string or the expanded object.
 * Both are accepted because expansion is an account/request-level setting we
 * do not control on inbound webhooks. A deleted-customer stub still carries
 * its id, which is the handle we want.
 */
function readStripeId(value: unknown): string | null {
  if (typeof value === 'string') return value.length === 0 ? null : value;
  const nested = readField(value, 'id');
  return typeof nested === 'string' && nested.length > 0 ? nested : null;
}

function nonEmpty(value: string | null | undefined): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}
