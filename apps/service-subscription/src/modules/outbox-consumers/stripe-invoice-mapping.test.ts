import Decimal from 'decimal.js';
import type Stripe from 'stripe';
import { describe, expect, it } from 'vitest';

import {
  StripeInvoiceShapeError,
  invoiceDiffers,
  linesDiffer,
  mapInvoiceStatus,
  mapLineItemKind,
  mapStripeInvoice,
  minorUnitsToDecimal,
  type MappedInvoice,
  type MappedLineItem,
} from './stripe-invoice-mapping';

const CREATED = 1_754_000_000;

function makeInvoice(overrides: Record<string, unknown> = {}): Stripe.Invoice {
  return {
    id: 'in_1',
    object: 'invoice',
    status: 'open',
    total: 4900,
    tax: 0,
    amount_paid: 0,
    currency: 'usd',
    created: CREATED,
    status_transitions: { paid_at: null },
    hosted_invoice_url: null,
    invoice_pdf: null,
    ...overrides,
  } as unknown as Stripe.Invoice;
}

function makeLine(overrides: Record<string, unknown> = {}): Stripe.InvoiceLineItem {
  return {
    id: 'il_1',
    object: 'line_item',
    type: 'subscription',
    description: 'Tier 2 — August',
    amount: 4900,
    currency: 'usd',
    proration: false,
    period: { start: CREATED, end: CREATED + 2_678_400 },
    ...overrides,
  } as unknown as Stripe.InvoiceLineItem;
}

describe('minorUnitsToDecimal', () => {
  it('converts Stripe cents to the local major-unit Decimal', () => {
    // The columns are Decimal(12,2) holding dollars-and-cents — the same
    // convention `plans.monthly_price` carries. The schema doc-comment used to
    // claim minor units, which would have stored every invoice 100x too large.
    expect(minorUnitsToDecimal(4900).toString()).toBe('49');
    expect(minorUnitsToDecimal(4999).toString()).toBe('49.99');
    expect(minorUnitsToDecimal(1).toString()).toBe('0.01');
    expect(minorUnitsToDecimal(0).toString()).toBe('0');
  });

  it('handles negative amounts — a discount line is negative', () => {
    expect(minorUnitsToDecimal(-1500).toString()).toBe('-15');
  });

  it('returns a Decimal, not a number', () => {
    expect(minorUnitsToDecimal(4900)).toBeInstanceOf(Decimal);
  });
});

describe('mapInvoiceStatus', () => {
  it('maps each Stripe status onto the identically-named local status', () => {
    for (const status of ['draft', 'open', 'paid', 'void', 'uncollectible']) {
      expect(mapInvoiceStatus(status)).toEqual({ kind: 'mapped', status });
    }
  });

  it('collapses Stripe`s internal `deleted` to `void`', () => {
    expect(mapInvoiceStatus('deleted')).toEqual({ kind: 'mapped', status: 'void' });
  });

  it('reports an unrecognised status instead of coercing it', () => {
    // A wrong invoice status is a wrong answer to "did this family pay".
    expect(mapInvoiceStatus('some_future_status')).toEqual({
      kind: 'unknown_status',
      stripeStatus: 'some_future_status',
    });
    expect(mapInvoiceStatus(null)).toEqual({ kind: 'unknown_status', stripeStatus: 'null' });
  });
});

describe('mapLineItemKind', () => {
  it('classifies a PRORATION before its type — the ordering is the point', () => {
    // A mid-cycle plan change emits proration lines whose `type` is
    // `subscription`. Classifying by type alone would file every upgrade
    // credit and charge as ordinary subscription revenue, which the
    // accounting service amortises differently.
    expect(mapLineItemKind(makeLine({ proration: true, type: 'subscription' }))).toBe('proration');
    expect(mapLineItemKind(makeLine({ proration: true, amount: -1200 }))).toBe('proration');
  });

  it('classifies a negative non-proration line as a discount', () => {
    // A coupon arrives as an invoice item with a negative amount. Calling it
    // an addon would put a credit in the charges column.
    expect(mapLineItemKind(makeLine({ type: 'invoiceitem', amount: -1500 }))).toBe('discount');
  });

  it('classifies an ordinary subscription line', () => {
    expect(mapLineItemKind(makeLine())).toBe('subscription');
  });

  it('falls back to addon for a positive non-subscription line', () => {
    expect(mapLineItemKind(makeLine({ type: 'invoiceitem', amount: 2500 }))).toBe('addon');
  });
});

describe('mapStripeInvoice', () => {
  it('maps the canonical invoice + one line', () => {
    const result = mapStripeInvoice({ invoice: makeInvoice(), lines: [makeLine()] });

    expect(result.kind).toBe('mapped');
    if (result.kind !== 'mapped') return;
    expect(result.invoice.stripeInvoiceId).toBe('in_1');
    expect(result.invoice.status).toBe('open');
    expect(result.invoice.total.toString()).toBe('49');
    expect(result.invoice.amountPaid.toString()).toBe('0');
    expect(result.invoice.issuedAt).toEqual(new Date(CREATED * 1000));
    expect(result.invoice.paidAt).toBeNull();
    expect(result.lines).toHaveLength(1);
    expect(result.lines[0]!.kind).toBe('subscription');
    expect(result.lines[0]!.amount.toString()).toBe('49');
  });

  it('UPPERCASES the currency Stripe sends lower-case', () => {
    // The column is CHAR(3) and the rest of this schema stores `USD`. A
    // mismatched case makes an equality filter miss rows that are there.
    const result = mapStripeInvoice({ invoice: makeInvoice(), lines: [makeLine()] });
    if (result.kind !== 'mapped') return;
    expect(result.invoice.currency).toBe('USD');
    expect(result.lines[0]!.currency).toBe('USD');
  });

  it('stamps paidAt from status_transitions', () => {
    const result = mapStripeInvoice({
      invoice: makeInvoice({
        status: 'paid',
        amount_paid: 4900,
        status_transitions: { paid_at: CREATED + 60 },
      }),
      lines: [],
    });
    if (result.kind !== 'mapped') return;
    expect(result.invoice.paidAt).toEqual(new Date((CREATED + 60) * 1000));
    expect(result.invoice.amountPaid.toString()).toBe('49');
  });

  it('returns unknown_status without any invoice — never a partial write', () => {
    const result = mapStripeInvoice({
      invoice: makeInvoice({ status: 'quantum' }),
      lines: [makeLine()],
    });
    expect(result).toEqual({ kind: 'unknown_status', stripeStatus: 'quantum' });
  });

  it('supplies a readable description when Stripe sends none', () => {
    // The column is NOT NULL and a family reads this text on their billing
    // page — an empty row reads as a bug.
    const result = mapStripeInvoice({
      invoice: makeInvoice(),
      lines: [
        makeLine({ description: null }),
        makeLine({ id: 'il_2', description: null, proration: true }),
      ],
    });
    if (result.kind !== 'mapped') return;
    expect(result.lines[0]!.description).toBe('Subscription charge');
    expect(result.lines[1]!.description).toBe('Plan change adjustment');
  });

  it('nulls both period bounds for a line with no period', () => {
    const result = mapStripeInvoice({
      invoice: makeInvoice(),
      lines: [makeLine({ period: null, type: 'invoiceitem' })],
    });
    if (result.kind !== 'mapped') return;
    expect(result.lines[0]!.periodStart).toBeNull();
    expect(result.lines[0]!.periodEnd).toBeNull();
  });

  it('THROWS on a line with no id rather than inventing one', () => {
    expect(() =>
      mapStripeInvoice({ invoice: makeInvoice(), lines: [makeLine({ id: undefined })] }),
    ).toThrow(StripeInvoiceShapeError);
  });

  it('preserves a discount line as a NEGATIVE amount', () => {
    const result = mapStripeInvoice({
      invoice: makeInvoice({ total: 3400 }),
      lines: [makeLine(), makeLine({ id: 'il_2', type: 'invoiceitem', amount: -1500 })],
    });
    if (result.kind !== 'mapped') return;
    expect(result.lines[1]!.kind).toBe('discount');
    expect(result.lines[1]!.amount.toString()).toBe('-15');
    // And the lines still reconcile to the invoice total.
    const sum = result.lines.reduce((acc, line) => acc.plus(line.amount), new Decimal(0));
    expect(sum.toString()).toBe(result.invoice.total.toString());
  });
});

describe('invoiceDiffers / linesDiffer', () => {
  const base: MappedInvoice = {
    stripeInvoiceId: 'in_1',
    status: 'open',
    total: new Decimal('49.00'),
    tax: new Decimal('0'),
    amountPaid: new Decimal('0'),
    currency: 'USD',
    issuedAt: new Date(CREATED * 1000),
    paidAt: null,
    hostedInvoiceUrl: null,
    invoicePdfUrl: null,
  };
  const line: MappedLineItem = {
    stripeLineItemId: 'il_1',
    kind: 'subscription',
    description: 'Tier 2 — August',
    amount: new Decimal('49.00'),
    currency: 'USD',
    periodStart: new Date(CREATED * 1000),
    periodEnd: null,
  };

  it('is false when nothing moved — the redelivery case', () => {
    expect(invoiceDiffers({ ...base }, base)).toBe(false);
    expect(linesDiffer([{ ...line }], [line])).toBe(false);
  });

  it('compares Decimals by VALUE, not by identity or string form', () => {
    // `49` and `49.00` are the same money. Prisma returns one form and the
    // mapper produces the other, so a string comparison would report every
    // invoice as changed on every event and churn the line-item primary keys.
    expect(invoiceDiffers({ ...base, total: new Decimal('49') }, base)).toBe(false);
    expect(linesDiffer([{ ...line, amount: new Decimal('49') }], [line])).toBe(false);
  });

  it('detects a payment landing', () => {
    expect(
      invoiceDiffers(
        { ...base, status: 'paid', amountPaid: new Decimal('49.00'), paidAt: new Date() },
        base,
      ),
    ).toBe(true);
  });

  it('detects an added, removed or altered line', () => {
    expect(linesDiffer([line, { ...line, stripeLineItemId: 'il_2' }], [line])).toBe(true);
    expect(linesDiffer([], [line])).toBe(true);
    expect(linesDiffer([{ ...line, amount: new Decimal('59.00') }], [line])).toBe(true);
    expect(linesDiffer([{ ...line, kind: 'proration' }], [line])).toBe(true);
  });

  it('detects a REPLACED line even when the count is unchanged', () => {
    // The case a length check alone would miss.
    expect(linesDiffer([{ ...line, stripeLineItemId: 'il_other' }], [line])).toBe(true);
  });
});
