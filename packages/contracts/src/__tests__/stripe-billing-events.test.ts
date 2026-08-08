import { describe, expect, it } from 'vitest';

import {
  STRIPE_EVENT_ID_MAX_LENGTH,
  STRIPE_INVOICE_CHANGED,
  STRIPE_PAYMENT_METHOD_CHANGED,
  STRIPE_RELAYED_EVENT_TYPES,
  STRIPE_RELAYED_INVOICE_EVENT_TYPES,
  STRIPE_RELAYED_PAYMENT_METHOD_EVENT_TYPES,
  STRIPE_RELAYED_SUBSCRIPTION_EVENT_TYPES,
  STRIPE_SUBSCRIPTION_CHANGED,
  StripeInvoiceChangedSchema,
  StripePaymentMethodChangedSchema,
  StripeSubscriptionChangedSchema,
  eventRegistry,
  getEventSchema,
  isStripeRelayedEventType,
} from '../index';

/**
 * TS-041a-followup-2 — the relayed Stripe billing events.
 *
 * The assertions that matter here are the negative ones. These payloads are
 * the boundary between a third party's data and this platform's event bus,
 * and the property being defended is that no Stripe field ever crosses it
 * except an opaque handle (CLAUDE.md §3.9). `.strict()` is what enforces it,
 * so it is tested by name and by attempt, not assumed.
 */

const subscriptionPayload = {
  eventId: 'evt_1PabcDEfGhIjKlMn',
  occurredAt: '2026-08-01T10:00:00.000Z',
  stripeEventId: 'evt_1PabcDEfGhIjKlMn',
  livemode: true,
  stripeCustomerId: 'cus_QabcDEfGhIjKlM',
  apiVersion: '2024-06-20',
  stripeEventType: 'customer.subscription.updated',
  stripeSubscriptionId: 'sub_1PabcDEfGhIjKlMn',
} as const;

const invoicePayload = {
  eventId: 'evt_1PinvDEfGhIjKlMn',
  occurredAt: '2026-08-01T10:00:00.000Z',
  stripeEventId: 'evt_1PinvDEfGhIjKlMn',
  livemode: false,
  stripeCustomerId: 'cus_QabcDEfGhIjKlM',
  apiVersion: null,
  stripeEventType: 'invoice.payment_failed',
  stripeInvoiceId: 'in_1PabcDEfGhIjKlMn',
  stripeSubscriptionId: 'sub_1PabcDEfGhIjKlMn',
} as const;

const paymentMethodPayload = {
  eventId: 'evt_1PpmDEfGhIjKlMno',
  occurredAt: '2026-08-01T10:00:00.000Z',
  stripeEventId: 'evt_1PpmDEfGhIjKlMno',
  livemode: true,
  stripeCustomerId: null,
  apiVersion: '2024-06-20',
  stripeEventType: 'payment_method.detached',
  stripePaymentMethodId: 'pm_1PabcDEfGhIjKlMn',
} as const;

describe('TS-041a-followup-2 stripe relay events — registry wiring', () => {
  it('registers all three names in the event registry', () => {
    expect(getEventSchema(STRIPE_SUBSCRIPTION_CHANGED)).toBe(StripeSubscriptionChangedSchema);
    expect(getEventSchema(STRIPE_INVOICE_CHANGED)).toBe(StripeInvoiceChangedSchema);
    expect(getEventSchema(STRIPE_PAYMENT_METHOD_CHANGED)).toBe(StripePaymentMethodChangedSchema);
  });

  it('names them under the `stripe.` prefix, not a platform-domain prefix', () => {
    // The prefix is the distinction between "we decided this" and "Stripe told
    // us this" — see the module doc-block. `subscription.activated` already
    // exists and means something else.
    for (const name of [
      STRIPE_SUBSCRIPTION_CHANGED,
      STRIPE_INVOICE_CHANGED,
      STRIPE_PAYMENT_METHOD_CHANGED,
    ]) {
      expect(name.startsWith('stripe.')).toBe(true);
      expect(Object.keys(eventRegistry)).toContain(name);
    }
  });
});

describe('TS-041a-followup-2 stripe relay events — the allow-list', () => {
  it('is the concatenation of the three per-class lists, with no duplicates', () => {
    expect(STRIPE_RELAYED_EVENT_TYPES).toEqual([
      ...STRIPE_RELAYED_SUBSCRIPTION_EVENT_TYPES,
      ...STRIPE_RELAYED_INVOICE_EVENT_TYPES,
      ...STRIPE_RELAYED_PAYMENT_METHOD_EVENT_TYPES,
    ]);
    expect(new Set(STRIPE_RELAYED_EVENT_TYPES).size).toBe(STRIPE_RELAYED_EVENT_TYPES.length);
  });

  it('recognises a declared type and rejects an undeclared one', () => {
    expect(isStripeRelayedEventType('invoice.payment_failed')).toBe(true);
    // Real Stripe types that this platform deliberately does not relay.
    expect(isStripeRelayedEventType('customer.subscription.trial_will_end')).toBe(false);
    expect(isStripeRelayedEventType('identity.verification_session.verified')).toBe(false);
    expect(isStripeRelayedEventType('charge.succeeded')).toBe(false);
  });

  it('does not relay a type by prefix match', () => {
    // A prefix rule (`startsWith('invoice.')`) would quietly grow the bus
    // surface every time Stripe ships a new event type. The guard is an
    // explicit list, and this is the assertion that says so.
    expect(isStripeRelayedEventType('invoice.upcoming')).toBe(false);
    expect(isStripeRelayedEventType('customer.subscription.pending_update_applied')).toBe(false);
    expect(isStripeRelayedEventType('payment_method.card_automatically_updated')).toBe(false);
  });

  it('relays both invoice.paid and invoice.payment_succeeded', () => {
    // They are not synonyms — an out-of-band or credit-balance payment raises
    // `paid` alone. Dropping either loses a real settlement.
    expect(STRIPE_RELAYED_INVOICE_EVENT_TYPES).toContain('invoice.paid');
    expect(STRIPE_RELAYED_INVOICE_EVENT_TYPES).toContain('invoice.payment_succeeded');
  });
});

describe('TS-041a-followup-2 stripe relay events — payloads carry handles only', () => {
  it('accepts the three canonical payloads', () => {
    expect(StripeSubscriptionChangedSchema.parse(subscriptionPayload)).toEqual(subscriptionPayload);
    expect(StripeInvoiceChangedSchema.parse(invoicePayload)).toEqual(invoicePayload);
    expect(StripePaymentMethodChangedSchema.parse(paymentMethodPayload)).toEqual(
      paymentMethodPayload,
    );
  });

  it('REJECTS customer PII smuggled onto a payload', () => {
    // The single most important property of this contract. A well-meaning
    // change that adds `email` to save the consumer a lookup must fail here.
    for (const extra of [
      { customerEmail: 'gran@example.com' },
      { billingAddress: { line1: '1 Elm St' } },
      { name: 'Mary Whitfield' },
    ]) {
      const result = StripeSubscriptionChangedSchema.safeParse({
        ...subscriptionPayload,
        ...extra,
      });
      expect(result.success).toBe(false);
    }
  });

  it('REJECTS card metadata on the payment-method payload', () => {
    // brand/last4/exp are what TS-041b-followup-4 populates — from an
    // authenticated Stripe fetch, never from the bus.
    for (const extra of [{ brand: 'visa' }, { last4: '4242' }, { expiryMonth: 4 }]) {
      const result = StripePaymentMethodChangedSchema.safeParse({
        ...paymentMethodPayload,
        ...extra,
      });
      expect(result.success).toBe(false);
    }
  });

  it('REJECTS a status or amount snapshot on the payloads', () => {
    // The staleness half of the doc-block: a snapshot lets an out-of-order
    // redelivery write older state over newer. There is no field to put it in.
    expect(
      StripeSubscriptionChangedSchema.safeParse({ ...subscriptionPayload, status: 'active' })
        .success,
    ).toBe(false);
    expect(
      StripeInvoiceChangedSchema.safeParse({ ...invoicePayload, amountDueMinor: 4900 }).success,
    ).toBe(false);
  });

  it('requires the object handle on every class and never allows it to be null', () => {
    expect(
      StripeSubscriptionChangedSchema.safeParse({
        ...subscriptionPayload,
        stripeSubscriptionId: null,
      }).success,
    ).toBe(false);
    expect(
      StripeInvoiceChangedSchema.safeParse({ ...invoicePayload, stripeInvoiceId: null }).success,
    ).toBe(false);
    expect(
      StripePaymentMethodChangedSchema.safeParse({
        ...paymentMethodPayload,
        stripePaymentMethodId: null,
      }).success,
    ).toBe(false);
  });

  it('allows a null subscription handle on an invoice but not a null invoice handle', () => {
    // A one-off invoice belongs to no subscription; the consumer skips on null.
    const oneOff = { ...invoicePayload, stripeSubscriptionId: null };
    expect(StripeInvoiceChangedSchema.parse(oneOff)).toEqual(oneOff);
  });

  it('allows a null customer handle — detached payment methods have none', () => {
    expect(
      StripePaymentMethodChangedSchema.parse(paymentMethodPayload).stripeCustomerId,
    ).toBeNull();
  });

  it('requires livemode — the two modes share this pipe', () => {
    const { livemode: _livemode, ...withoutLivemode } = subscriptionPayload;
    expect(StripeSubscriptionChangedSchema.safeParse(withoutLivemode).success).toBe(false);
  });

  it('rejects a stripeEventType outside the class it belongs to', () => {
    // An invoice type on a subscription payload is a mapper bug; the enum per
    // class is what makes it a parse failure rather than a mis-routed handler.
    expect(
      StripeSubscriptionChangedSchema.safeParse({
        ...subscriptionPayload,
        stripeEventType: 'invoice.created',
      }).success,
    ).toBe(false);
  });

  it('caps identifier length rather than truncating', () => {
    const tooLong = 'sub_'.padEnd(STRIPE_EVENT_ID_MAX_LENGTH + 1, 'x');
    expect(
      StripeSubscriptionChangedSchema.safeParse({
        ...subscriptionPayload,
        stripeSubscriptionId: tooLong,
      }).success,
    ).toBe(false);
  });

  it('requires occurredAt to be an ISO datetime', () => {
    expect(
      StripeSubscriptionChangedSchema.safeParse({
        ...subscriptionPayload,
        occurredAt: '2026-08-01',
      }).success,
    ).toBe(false);
  });
});
