import Decimal from 'decimal.js';
import type Stripe from 'stripe';

/**
 * Pure mapping from a freshly-fetched Stripe invoice to the local row shape
 * (TS-041b-followup-3b).
 *
 * Two things here are easy to get quietly and expensively wrong, so both live
 * in a file with no I/O in it: **money units** and **which Stripe line
 * becomes which local `kind`**.
 */

/** Mirrors `subscription.invoice_status`. */
export type LocalInvoiceStatus = 'draft' | 'open' | 'paid' | 'void' | 'uncollectible';

/** Mirrors `subscription.invoice_line_item_kind`. */
export type LocalLineItemKind = 'subscription' | 'addon' | 'discount' | 'tax' | 'proration';

/**
 * Stripe speaks integer MINOR units (cents); the local `Decimal(12,2)`
 * columns hold MAJOR units (dollars-and-cents), the same convention
 * `plans.monthly_price` carries and the inverse of the `decimalToMinorUnits`
 * the DTOs use on the way out.
 *
 * **Converted with `Decimal`, never `Number` (CLAUDE.md §17.6).** `4900 / 100`
 * happens to be exact, but the moment a currency with a different exponent or
 * a proration remainder enters, float division starts producing values that
 * are one cent wrong in a column that is the financial source of truth.
 */
export function minorUnitsToDecimal(minor: number): Decimal {
  return new Decimal(minor).div(100).toDecimalPlaces(2, Decimal.ROUND_HALF_EVEN);
}

/**
 * Map Stripe's invoice status onto ours.
 *
 * `deleted` collapses to `void` per the schema's own doc-comment — it is a
 * Stripe-internal state for discarded drafts and no consumer here
 * distinguishes it. Anything else is reported rather than coerced, on the same
 * reasoning as the subscription mapper: a wrong invoice status is a wrong
 * answer to "did this family pay".
 */
export function mapInvoiceStatus(
  status: string | null,
):
  | { readonly kind: 'mapped'; readonly status: LocalInvoiceStatus }
  | { readonly kind: 'unknown_status'; readonly stripeStatus: string } {
  switch (status) {
    case 'draft':
    case 'open':
    case 'paid':
    case 'void':
    case 'uncollectible':
      return { kind: 'mapped', status };
    case 'deleted':
      return { kind: 'mapped', status: 'void' };
    default:
      return { kind: 'unknown_status', stripeStatus: status ?? 'null' };
  }
}

/**
 * Classify a Stripe invoice line.
 *
 * **`proration` is checked FIRST and that ordering is the point.** A
 * mid-cycle plan change emits proration lines whose `type` is
 * `subscription` — classifying by `type` alone would file every upgrade
 * credit and charge as ordinary subscription revenue, and the accounting
 * service amortises those two differently (CLAUDE.md §6). Stripe flags them
 * with `proration: true`.
 *
 * A negative non-proration amount is a `discount` — a coupon line arrives as
 * an invoice item with a negative amount, and calling it an `addon` would put
 * a credit in the charges column.
 *
 * `tax` never appears as its own line in Stripe's `lines` collection (it is
 * `invoice.tax` plus per-line `tax_amounts`), so nothing maps to it here; the
 * enum member exists for the local shape and stays unused until a tax line is
 * modelled separately.
 */
export function mapLineItemKind(line: Stripe.InvoiceLineItem): LocalLineItemKind {
  if (readBoolean(line, 'proration')) return 'proration';
  if (line.amount < 0) return 'discount';
  if (readString(line, 'type') === 'subscription') return 'subscription';
  return 'addon';
}

export interface MappedLineItem {
  readonly stripeLineItemId: string;
  readonly kind: LocalLineItemKind;
  readonly description: string;
  readonly amount: Decimal;
  readonly currency: string;
  readonly periodStart: Date | null;
  readonly periodEnd: Date | null;
}

export interface MappedInvoice {
  readonly stripeInvoiceId: string;
  readonly status: LocalInvoiceStatus;
  readonly total: Decimal;
  readonly tax: Decimal;
  readonly amountPaid: Decimal;
  readonly currency: string;
  readonly issuedAt: Date;
  readonly paidAt: Date | null;
  readonly hostedInvoiceUrl: string | null;
  readonly invoicePdfUrl: string | null;
}

export type MapInvoiceResult =
  | {
      readonly kind: 'mapped';
      readonly invoice: MappedInvoice;
      readonly lines: readonly MappedLineItem[];
    }
  | { readonly kind: 'unknown_status'; readonly stripeStatus: string };

export function mapStripeInvoice(args: {
  readonly invoice: Stripe.Invoice;
  readonly lines: readonly Stripe.InvoiceLineItem[];
}): MapInvoiceResult {
  const { invoice, lines } = args;

  const status = mapInvoiceStatus(invoice.status);
  if (status.kind === 'unknown_status') return status;

  const stripeInvoiceId = invoice.id;
  if (typeof stripeInvoiceId !== 'string' || stripeInvoiceId.length === 0) {
    throw new StripeInvoiceShapeError('unknown', 'id');
  }

  // Stripe lower-cases currency codes (`usd`); the column is CHAR(3) and the
  // rest of this schema stores `USD`. A mismatched case would make an
  // equality filter miss rows that are there.
  const currency = invoice.currency.toUpperCase();

  return {
    kind: 'mapped',
    invoice: {
      stripeInvoiceId,
      status: status.status,
      total: minorUnitsToDecimal(invoice.total),
      tax: minorUnitsToDecimal(readNumber(invoice, 'tax') ?? 0),
      // `amount_paid` is 0 on an unpaid invoice, which is exactly the column's
      // default — no special-casing needed.
      amountPaid: minorUnitsToDecimal(invoice.amount_paid),
      currency,
      issuedAt: new Date(invoice.created * 1000),
      paidAt: optionalUnix(invoice.status_transitions?.paid_at ?? null),
      hostedInvoiceUrl: nonEmpty(invoice.hosted_invoice_url),
      invoicePdfUrl: nonEmpty(invoice.invoice_pdf),
    },
    lines: lines.map((line) => mapLineItem(line, currency)),
  };
}

function mapLineItem(line: Stripe.InvoiceLineItem, invoiceCurrency: string): MappedLineItem {
  if (typeof line.id !== 'string' || line.id.length === 0) {
    throw new StripeInvoiceShapeError('unknown', 'line item id');
  }
  const period = line.period ?? null;
  return {
    stripeLineItemId: line.id,
    kind: mapLineItemKind(line),
    // Stripe allows a null description on some line shapes. The column is NOT
    // NULL and a family reads this text on their billing page, so a fallback
    // is required — an empty row reads as a bug, `'Subscription charge'` reads
    // as a charge.
    description: nonEmpty(line.description) ?? defaultDescriptionFor(mapLineItemKind(line)),
    amount: minorUnitsToDecimal(line.amount),
    // Lines carry their own currency; it always matches the invoice in
    // practice, and falling back to the invoice's keeps the column populated
    // if a future shape omits it.
    currency: (readString(line, 'currency') ?? invoiceCurrency).toUpperCase(),
    periodStart: optionalUnix(period === null ? null : period.start),
    periodEnd: optionalUnix(period === null ? null : period.end),
  };
}

function defaultDescriptionFor(kind: LocalLineItemKind): string {
  switch (kind) {
    case 'subscription':
      return 'Subscription charge';
    case 'proration':
      return 'Plan change adjustment';
    case 'discount':
      return 'Discount';
    case 'tax':
      return 'Tax';
    case 'addon':
      return 'Additional charge';
  }
}

/**
 * Whether the fetched state differs from what is stored.
 *
 * Same rationale as the subscription reconciler's `changedFields`: an
 * unconditional write is harmless to the invoice row but not to the line
 * items, which are DELETED and re-inserted, so an unchanged redelivery would
 * churn primary keys on rows the accounting service references.
 */
export function invoiceDiffers(next: MappedInvoice, current: MappedInvoice): boolean {
  return (
    next.status !== current.status ||
    !next.total.equals(current.total) ||
    !next.tax.equals(current.tax) ||
    !next.amountPaid.equals(current.amountPaid) ||
    next.currency !== current.currency ||
    next.issuedAt.getTime() !== current.issuedAt.getTime() ||
    optionalTime(next.paidAt) !== optionalTime(current.paidAt) ||
    next.hostedInvoiceUrl !== current.hostedInvoiceUrl ||
    next.invoicePdfUrl !== current.invoicePdfUrl
  );
}

export function linesDiffer(
  next: readonly MappedLineItem[],
  current: readonly MappedLineItem[],
): boolean {
  if (next.length !== current.length) return true;
  const byId = new Map(current.map((line) => [line.stripeLineItemId, line]));
  return next.some((line) => {
    const existing = byId.get(line.stripeLineItemId);
    if (existing === undefined) return true;
    return (
      existing.kind !== line.kind ||
      existing.description !== line.description ||
      !existing.amount.equals(line.amount) ||
      existing.currency !== line.currency ||
      optionalTime(existing.periodStart) !== optionalTime(line.periodStart) ||
      optionalTime(existing.periodEnd) !== optionalTime(line.periodEnd)
    );
  });
}

/**
 * Raised when a fetched Stripe invoice is missing something the local row
 * cannot do without. Thrown rather than defaulted for the same reason as the
 * subscription mapper's twin: a financial row with an invented value is worse
 * than an absent one.
 */
export class StripeInvoiceShapeError extends Error {
  constructor(
    readonly stripeInvoiceId: string,
    readonly missingField: string,
  ) {
    super(`stripe invoice ${stripeInvoiceId} carries no ${missingField}`);
    this.name = 'StripeInvoiceShapeError';
  }
}

function optionalTime(value: Date | null): number | null {
  return value === null ? null : value.getTime();
}

function optionalUnix(seconds: number | null | undefined): Date | null {
  return typeof seconds === 'number' ? new Date(seconds * 1000) : null;
}

function nonEmpty(value: string | null | undefined): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function readString(source: unknown, key: string): string | null {
  const value = readField(source, key);
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function readNumber(source: unknown, key: string): number | null {
  const value = readField(source, key);
  return typeof value === 'number' ? value : null;
}

function readBoolean(source: unknown, key: string): boolean {
  return readField(source, key) === true;
}

function readField(source: unknown, key: string): unknown {
  if (source === null || typeof source !== 'object') return undefined;
  return (source as Record<string, unknown>)[key];
}
