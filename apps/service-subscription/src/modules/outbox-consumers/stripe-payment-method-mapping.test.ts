import type Stripe from 'stripe';
import { describe, expect, it } from 'vitest';

import {
  mapStripePaymentMethod,
  paymentMethodDiffers,
  type MappedPaymentMethod,
} from './stripe-payment-method-mapping';

function makeCard(overrides: Record<string, unknown> = {}): Stripe.PaymentMethod {
  return {
    id: 'pm_1',
    object: 'payment_method',
    type: 'card',
    card: { brand: 'visa', last4: '4242', exp_month: 4, exp_year: 2030 },
    ...overrides,
  } as unknown as Stripe.PaymentMethod;
}

describe('mapStripePaymentMethod — cards', () => {
  it('extracts the four display fields the local row has never had', () => {
    const result = mapStripePaymentMethod(makeCard());
    expect(result).toEqual({
      kind: 'mapped',
      fields: { kind: 'card', brand: 'visa', last4: '4242', expiryMonth: 4, expiryYear: 2030 },
    });
  });

  it('tolerates a card object Stripe did not include', () => {
    // The columns are nullable precisely so a partial shape does not have to
    // be faked. A method with no display fields renders as "card on file",
    // which is honest; a fabricated `••0000` is not.
    const result = mapStripePaymentMethod(makeCard({ card: null }));
    expect(result).toEqual({
      kind: 'mapped',
      fields: { kind: 'card', brand: null, last4: null, expiryMonth: null, expiryYear: null },
    });
  });

  it('rejects a last4 that is not exactly four characters', () => {
    // The column is VarChar(4). A longer value would be rejected by Postgres
    // at write time and surface as a dead-lettered event rather than as
    // anything readable — and nothing here uses last4 for identity.
    for (const last4 of ['42', '42424', '']) {
      const result = mapStripePaymentMethod(
        makeCard({ card: { brand: 'visa', last4, exp_month: 4, exp_year: 2030 } }),
      );
      if (result.kind !== 'mapped') throw new Error('expected mapped');
      expect(result.fields.last4).toBeNull();
    }
  });

  it('ignores a non-integer expiry', () => {
    const result = mapStripePaymentMethod(
      makeCard({ card: { brand: 'visa', last4: '4242', exp_month: '4', exp_year: 2030.5 } }),
    );
    if (result.kind !== 'mapped') throw new Error('expected mapped');
    expect(result.fields.expiryMonth).toBeNull();
    expect(result.fields.expiryYear).toBeNull();
  });
});

describe('mapStripePaymentMethod — bank accounts', () => {
  it('maps a US bank account to bank_account with its bank name as the brand', () => {
    const result = mapStripePaymentMethod(
      makeCard({
        type: 'us_bank_account',
        card: undefined,
        us_bank_account: { bank_name: 'Chase', last4: '6789' },
      }),
    );
    expect(result).toEqual({
      kind: 'mapped',
      fields: {
        kind: 'bank_account',
        brand: 'Chase',
        last4: '6789',
        // Expiry does not exist for a bank account and is left null rather
        // than faked — which is why the columns are nullable.
        expiryMonth: null,
        expiryYear: null,
      },
    });
  });

  it('maps the other debit rails to bank_account', () => {
    for (const type of ['sepa_debit', 'acss_debit', 'bacs_debit', 'au_becs_debit']) {
      const result = mapStripePaymentMethod(
        makeCard({ type, card: undefined, [type]: { last4: '1234' } }),
      );
      if (result.kind !== 'mapped') throw new Error(`expected mapped for ${type}`);
      expect(result.fields.kind).toBe('bank_account');
      expect(result.fields.last4).toBe('1234');
    }
  });
});

describe('mapStripePaymentMethod — unrepresentable types', () => {
  it('REPORTS an unknown type rather than defaulting it to bank_account', () => {
    // A `type === 'card' ? card : bank_account` fallback would file a BNPL
    // method or a wallet as a bank account and render null display fields
    // beside it. A payment method a family cannot recognise on their own
    // billing page is worse than one we admit we do not understand.
    for (const type of ['klarna', 'link', 'cashapp', 'affirm', 'some_future_rail']) {
      expect(mapStripePaymentMethod(makeCard({ type, card: undefined }))).toEqual({
        kind: 'unknown_kind',
        stripeType: type,
      });
    }
  });
});

describe('paymentMethodDiffers', () => {
  const base: MappedPaymentMethod = {
    kind: 'card',
    brand: 'visa',
    last4: '4242',
    expiryMonth: 4,
    expiryYear: 2030,
  };

  it('is false when nothing moved — the redelivery case', () => {
    expect(paymentMethodDiffers({ ...base }, base)).toBe(false);
  });

  it('detects the account-updater case: a new expiry on the same last4', () => {
    // `payment_method.automatically_updated` is Stripe replacing an expired
    // card behind the scenes. Ignoring it is how a billing page shows an
    // expiry that passed months ago on a card that is still charging fine.
    expect(paymentMethodDiffers({ ...base, expiryYear: 2032 }, base)).toBe(true);
  });

  it('detects a replaced card and a changed kind', () => {
    expect(paymentMethodDiffers({ ...base, last4: '1881' }, base)).toBe(true);
    expect(paymentMethodDiffers({ ...base, kind: 'bank_account' }, base)).toBe(true);
  });

  it('detects fields arriving for the first time', () => {
    // The migration-from-nothing case: every existing row has all four null.
    const empty: MappedPaymentMethod = {
      kind: 'card',
      brand: null,
      last4: null,
      expiryMonth: null,
      expiryYear: null,
    };
    expect(paymentMethodDiffers(base, empty)).toBe(true);
  });
});
