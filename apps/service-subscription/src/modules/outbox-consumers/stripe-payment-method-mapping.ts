import type Stripe from 'stripe';

/**
 * Pure mapping from a freshly-fetched Stripe payment method to the local
 * display fields (TS-041b-followup-3c, which subsumes TS-041b-followup-4).
 *
 * **The fields this produces are the ones the relayed event deliberately does
 * not carry.** `brand` / `last4` / `expiryMonth` / `expiryYear` are card
 * metadata; §3.9 keeps them off the bus, so they are read here from an
 * authenticated Stripe fetch and written straight to the row. That is the
 * whole shape of the feature, and it is the reason the event is thin.
 */

/** Mirrors `subscription.payment_method_kind`. */
export type LocalPaymentMethodKind = 'card' | 'bank_account';

/**
 * Stripe payment-method types this platform can represent.
 *
 * An allow-list, not a `type === 'card' ? card : bank_account` fallback. The
 * fallback would file a BNPL method, a wallet or a future type as a bank
 * account and then render `null` display fields beside it — a payment method
 * a family cannot recognise on their own billing page is worse than one we
 * admit we do not understand.
 */
const KIND_BY_STRIPE_TYPE: Readonly<Record<string, LocalPaymentMethodKind>> = {
  card: 'card',
  us_bank_account: 'bank_account',
  sepa_debit: 'bank_account',
  acss_debit: 'bank_account',
  bacs_debit: 'bank_account',
  au_becs_debit: 'bank_account',
};

export interface MappedPaymentMethod {
  readonly kind: LocalPaymentMethodKind;
  readonly brand: string | null;
  readonly last4: string | null;
  readonly expiryMonth: number | null;
  readonly expiryYear: number | null;
}

export type MapPaymentMethodResult =
  | { readonly kind: 'mapped'; readonly fields: MappedPaymentMethod }
  | { readonly kind: 'unknown_kind'; readonly stripeType: string };

export function mapStripePaymentMethod(
  paymentMethod: Stripe.PaymentMethod,
): MapPaymentMethodResult {
  const stripeType: string = paymentMethod.type;
  const kind = KIND_BY_STRIPE_TYPE[stripeType];
  if (kind === undefined) {
    return { kind: 'unknown_kind', stripeType };
  }

  if (kind === 'card') {
    const card = paymentMethod.card ?? null;
    return {
      kind: 'mapped',
      fields: {
        kind,
        brand: readString(card, 'brand'),
        last4: readLast4(card),
        expiryMonth: readInt(card, 'exp_month'),
        expiryYear: readInt(card, 'exp_year'),
      },
    };
  }

  // Bank accounts have a last4 and, on some rails, a bank name — which is the
  // closest thing to a "brand" a family would recognise on a billing page
  // ("Chase ••1234"). Expiry does not exist for a bank account and stays null
  // rather than being faked, which is exactly why the columns are nullable.
  const account = readBankAccount(paymentMethod, stripeType);
  return {
    kind: 'mapped',
    fields: {
      kind,
      brand: readString(account, 'bank_name'),
      last4: readLast4(account),
      expiryMonth: null,
      expiryYear: null,
    },
  };
}

export function paymentMethodDiffers(
  next: MappedPaymentMethod,
  current: MappedPaymentMethod,
): boolean {
  return (
    next.kind !== current.kind ||
    next.brand !== current.brand ||
    next.last4 !== current.last4 ||
    next.expiryMonth !== current.expiryMonth ||
    next.expiryYear !== current.expiryYear
  );
}

/**
 * `last4` is `VarChar(4)`. A value longer than four characters would be
 * rejected by Postgres at write time — a failure that would arrive as a
 * dead-lettered event rather than as anything readable — so anything that is
 * not exactly four characters is treated as absent. Nothing on this platform
 * uses `last4` for identity; it is display text.
 */
function readLast4(source: unknown): string | null {
  const value = readString(source, 'last4');
  return value !== null && value.length === 4 ? value : null;
}

function readBankAccount(paymentMethod: Stripe.PaymentMethod, stripeType: string): unknown {
  return (paymentMethod as unknown as Record<string, unknown>)[stripeType];
}

function readString(source: unknown, key: string): string | null {
  const value = readField(source, key);
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function readInt(source: unknown, key: string): number | null {
  const value = readField(source, key);
  return typeof value === 'number' && Number.isInteger(value) ? value : null;
}

function readField(source: unknown, key: string): unknown {
  if (source === null || typeof source !== 'object') return undefined;
  return (source as Record<string, unknown>)[key];
}
