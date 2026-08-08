import {
  STRIPE_INVOICE_CHANGED,
  STRIPE_PAYMENT_METHOD_CHANGED,
  STRIPE_RELAYED_EVENT_TYPES,
  STRIPE_SUBSCRIPTION_CHANGED,
  StripeInvoiceChangedSchema,
  StripePaymentMethodChangedSchema,
  StripeSubscriptionChangedSchema,
  getEventSchema,
} from '@taste-and-see/contracts';
import type Stripe from 'stripe';
import { describe, expect, it } from 'vitest';

import { StripeRelayMappingError, mapStripeEventToOutbox } from './stripe-event-relay';

function makeEvent(
  type: string,
  object: Record<string, unknown>,
  overrides?: Partial<Stripe.Event>,
): Stripe.Event {
  return {
    id: 'evt_map_test',
    object: 'event',
    api_version: '2024-06-20',
    created: 1_754_000_000,
    data: { object } as unknown as Stripe.Event.Data,
    livemode: true,
    pending_webhooks: 1,
    request: null,
    type,
    ...overrides,
  } as unknown as Stripe.Event;
}

describe('mapStripeEventToOutbox — routing', () => {
  it('maps every declared type in the contract allow-list to a payload', () => {
    // The drift guard. A type added to the contract without a mapping here
    // would be declared-and-dropped: the allow-list would say we relay it and
    // nothing would.
    const objects: Record<string, Record<string, unknown>> = {
      'customer.subscription': { id: 'sub_1', customer: 'cus_1' },
      invoice: { id: 'in_1', customer: 'cus_1', subscription: 'sub_1' },
      payment_method: { id: 'pm_1', customer: 'cus_1' },
    };

    for (const type of STRIPE_RELAYED_EVENT_TYPES) {
      const key = type.startsWith('invoice.')
        ? 'invoice'
        : type.startsWith('payment_method.')
          ? 'payment_method'
          : 'customer.subscription';
      const mapped = mapStripeEventToOutbox(makeEvent(type, objects[key]!));
      expect(mapped, `no mapping for declared type ${type}`).not.toBeNull();

      // Every produced payload parses against the schema the registry holds
      // for the name the mapper chose — the producer boundary the outbox SDK
      // would otherwise reject at runtime.
      const schema = getEventSchema(mapped!.eventName);
      expect(schema, `no registry schema for ${mapped!.eventName}`).toBeDefined();
      expect(schema!.safeParse(mapped!.payload).success, `payload invalid for ${type}`).toBe(true);
    }
  });

  it('returns null for a Stripe type outside the allow-list', () => {
    for (const type of [
      'identity.verification_session.verified',
      'charge.succeeded',
      'customer.subscription.trial_will_end',
      'invoice.upcoming',
      'payment_intent.succeeded',
    ]) {
      expect(mapStripeEventToOutbox(makeEvent(type, { id: 'obj_1' })), type).toBeNull();
    }
  });

  it('routes each object class to its own event name', () => {
    expect(
      mapStripeEventToOutbox(makeEvent('customer.subscription.created', { id: 'sub_1' }))
        ?.eventName,
    ).toBe(STRIPE_SUBSCRIPTION_CHANGED);
    expect(mapStripeEventToOutbox(makeEvent('invoice.finalized', { id: 'in_1' }))?.eventName).toBe(
      STRIPE_INVOICE_CHANGED,
    );
    expect(
      mapStripeEventToOutbox(makeEvent('payment_method.attached', { id: 'pm_1' }))?.eventName,
    ).toBe(STRIPE_PAYMENT_METHOD_CHANGED);
  });

  it('relays customer.subscription.deleted like any other change', () => {
    // Stripe still serves the object afterwards with status `canceled`, so the
    // consumer's single re-fetch path covers cancellation too.
    const mapped = mapStripeEventToOutbox(
      makeEvent('customer.subscription.deleted', { id: 'sub_gone', customer: 'cus_1' }),
    );
    expect(mapped?.eventName).toBe(STRIPE_SUBSCRIPTION_CHANGED);
    expect(StripeSubscriptionChangedSchema.parse(mapped!.payload).stripeEventType).toBe(
      'customer.subscription.deleted',
    );
  });
});

describe('mapStripeEventToOutbox — envelope', () => {
  it('takes occurredAt from Stripe`s created, not from our clock', () => {
    const mapped = mapStripeEventToOutbox(
      makeEvent('invoice.paid', { id: 'in_1' }, { created: 1_700_000_000 }),
    );
    expect(mapped!.payload.occurredAt).toBe(new Date(1_700_000_000 * 1000).toISOString());
  });

  it('uses Stripe`s event id as both eventId and stripeEventId', () => {
    const mapped = mapStripeEventToOutbox(
      makeEvent('invoice.paid', { id: 'in_1' }, { id: 'evt_specific' }),
    );
    expect(mapped!.payload.eventId).toBe('evt_specific');
    expect(mapped!.payload.stripeEventId).toBe('evt_specific');
  });

  it('carries livemode through unchanged', () => {
    const live = mapStripeEventToOutbox(makeEvent('invoice.paid', { id: 'in_1' }));
    const test = mapStripeEventToOutbox(
      makeEvent('invoice.paid', { id: 'in_1' }, { livemode: false }),
    );
    expect(live!.payload.livemode).toBe(true);
    expect(test!.payload.livemode).toBe(false);
  });

  it('nulls an absent or empty api_version', () => {
    expect(
      mapStripeEventToOutbox(
        makeEvent('invoice.paid', { id: 'in_1' }, { api_version: null as unknown as string }),
      )!.payload.apiVersion,
    ).toBeNull();
    expect(
      mapStripeEventToOutbox(makeEvent('invoice.paid', { id: 'in_1' }, { api_version: '' }))!
        .payload.apiVersion,
    ).toBeNull();
  });
});

describe('mapStripeEventToOutbox — handle extraction', () => {
  it('accepts a bare-string customer reference', () => {
    const mapped = mapStripeEventToOutbox(
      makeEvent('customer.subscription.updated', { id: 'sub_1', customer: 'cus_bare' }),
    );
    expect(mapped!.payload.stripeCustomerId).toBe('cus_bare');
  });

  it('accepts an EXPANDED customer object and takes only its id', () => {
    // Expansion is an account/request-level setting we do not control on
    // inbound webhooks. If the expanded object arrived and we read it as a
    // non-string, `stripeCustomerId` would silently be null — and an expanded
    // customer object is exactly where the email lives, so reading only `id`
    // is also what keeps PII off the wire.
    const mapped = mapStripeEventToOutbox(
      makeEvent('customer.subscription.updated', {
        id: 'sub_1',
        customer: { id: 'cus_expanded', object: 'customer', email: 'gran@example.com' },
      }),
    );
    expect(mapped!.payload.stripeCustomerId).toBe('cus_expanded');
    expect(JSON.stringify(mapped!.payload)).not.toContain('gran@example.com');
  });

  it('nulls a missing customer rather than failing', () => {
    const mapped = mapStripeEventToOutbox(makeEvent('payment_method.detached', { id: 'pm_1' }));
    expect(mapped!.payload.stripeCustomerId).toBeNull();
  });

  it('reads the invoice subscription from the legacy top-level field', () => {
    const mapped = mapStripeEventToOutbox(
      makeEvent('invoice.created', { id: 'in_1', subscription: 'sub_legacy' }),
    );
    expect(StripeInvoiceChangedSchema.parse(mapped!.payload).stripeSubscriptionId).toBe(
      'sub_legacy',
    );
  });

  it('reads the invoice subscription from the newer nested parent shape', () => {
    // API version 2025-03-31 moved it under parent.subscription_details. An
    // invoice that silently loses its subscription link is an invoice the
    // consumer files against nothing.
    const mapped = mapStripeEventToOutbox(
      makeEvent('invoice.created', {
        id: 'in_1',
        parent: { type: 'subscription_details', subscription_details: { subscription: 'sub_new' } },
      }),
    );
    expect(StripeInvoiceChangedSchema.parse(mapped!.payload).stripeSubscriptionId).toBe('sub_new');
  });

  it('nulls the invoice subscription for a genuine one-off invoice', () => {
    const mapped = mapStripeEventToOutbox(
      makeEvent('invoice.created', { id: 'in_oneoff', customer: 'cus_1' }),
    );
    expect(StripeInvoiceChangedSchema.parse(mapped!.payload).stripeSubscriptionId).toBeNull();
  });

  it('prefers the top-level subscription when both shapes are present', () => {
    const mapped = mapStripeEventToOutbox(
      makeEvent('invoice.paid', {
        id: 'in_1',
        subscription: 'sub_top',
        parent: { subscription_details: { subscription: 'sub_nested' } },
      }),
    );
    expect(StripeInvoiceChangedSchema.parse(mapped!.payload).stripeSubscriptionId).toBe('sub_top');
  });
});

describe('mapStripeEventToOutbox — malformed allow-listed events', () => {
  it('THROWS rather than returning null when the object has no id', () => {
    // Returning null would make "malformed billing event" indistinguishable
    // from "type we chose not to relay" — the ingress row would commit,
    // Stripe would be acked, and the change would be lost silently.
    expect(() =>
      mapStripeEventToOutbox(makeEvent('customer.subscription.updated', { customer: 'cus_1' })),
    ).toThrow(StripeRelayMappingError);
  });

  it('names the event and the missing field in the error', () => {
    try {
      mapStripeEventToOutbox(makeEvent('invoice.paid', {}, { id: 'evt_broken' }));
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(StripeRelayMappingError);
      const mappingError = err as StripeRelayMappingError;
      expect(mappingError.stripeEventId).toBe('evt_broken');
      expect(mappingError.stripeEventType).toBe('invoice.paid');
      expect(mappingError.missingField).toBe('invoice id');
    }
  });

  it('does NOT throw for a non-relayed event with no object id', () => {
    // The allow-list decision comes first: we do not validate events we have
    // no intention of relaying.
    expect(mapStripeEventToOutbox(makeEvent('charge.succeeded', {}))).toBeNull();
  });

  it('treats an empty-string id as missing', () => {
    expect(() => mapStripeEventToOutbox(makeEvent('payment_method.attached', { id: '' }))).toThrow(
      StripeRelayMappingError,
    );
  });

  it('tolerates a non-object data payload without crashing', () => {
    expect(() =>
      mapStripeEventToOutbox(makeEvent('invoice.paid', null as unknown as Record<string, unknown>)),
    ).toThrow(StripeRelayMappingError);
  });
});

describe('mapStripeEventToOutbox — nothing but handles crosses the wire', () => {
  it('drops every field of a realistic Stripe object except the handles', () => {
    // The end-to-end statement of the contract's PII property, made against a
    // payload shaped like the real thing rather than against `.strict()` alone.
    const mapped = mapStripeEventToOutbox(
      makeEvent('invoice.payment_failed', {
        id: 'in_real',
        customer: 'cus_real',
        subscription: 'sub_real',
        customer_email: 'family@example.com',
        customer_name: 'Mary Whitfield',
        customer_address: { line1: '12 Orchard Lane', postal_code: '90210' },
        amount_due: 24900,
        hosted_invoice_url: 'https://invoice.stripe.com/i/acct_x/test_y',
        lines: { data: [{ description: 'Concierge tier — August' }] },
      }),
    );

    expect(StripePaymentMethodChangedSchema.safeParse(mapped!.payload).success).toBe(false);
    const payload = StripeInvoiceChangedSchema.parse(mapped!.payload);
    expect(Object.keys(payload).sort()).toEqual([
      'apiVersion',
      'eventId',
      'livemode',
      'occurredAt',
      'stripeCustomerId',
      'stripeEventId',
      'stripeEventType',
      'stripeInvoiceId',
      'stripeSubscriptionId',
    ]);

    const serialised = JSON.stringify(mapped!.payload);
    for (const leaked of [
      'family@example.com',
      'Mary Whitfield',
      'Orchard Lane',
      '90210',
      '24900',
      'invoice.stripe.com',
      'Concierge tier',
    ]) {
      expect(serialised, `leaked ${leaked}`).not.toContain(leaked);
    }
  });
});
