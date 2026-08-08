import { Inject, Injectable, Logger } from '@nestjs/common';
import Decimal from 'decimal.js';
import Stripe from 'stripe';

import { PrismaService, type PrismaTransactionClient } from '../../prisma/prisma.service';
import { STRIPE_SDK_TOKEN } from '../stripe/stripe.constants';
import {
  StripeInvoiceShapeError,
  invoiceDiffers,
  linesDiffer,
  mapStripeInvoice,
  type MappedInvoice,
  type MappedLineItem,
} from './stripe-invoice-mapping';

/**
 * Upper bound on line-item pages fetched for one invoice. 10 pages × 100 =
 * 1,000 lines, orders of magnitude above anything a wellness subscription
 * produces. Exceeding it THROWS rather than truncating — an invoice stored
 * with some of its lines has a `total` that does not equal the sum of what is
 * shown, which is the one defect a billing page must never have.
 */
const MAX_LINE_PAGES = 10;
const LINE_PAGE_SIZE = 100;

export type InvoiceReconcileOutcome =
  | { readonly kind: 'reconciled'; readonly changed: readonly string[] }
  | { readonly kind: 'no_change' }
  | { readonly kind: 'not_tracked' }
  | { readonly kind: 'one_off' }
  | { readonly kind: 'stripe_missing' }
  | { readonly kind: 'unknown_status'; readonly stripeStatus: string };

/**
 * Populates `subscription.invoices` + `subscription.invoice_line_items` from
 * Stripe (TS-041b-followup-3b; PDD §11.1; CLAUDE.md §6, §17.6).
 *
 * **These two tables have existed since TS-041b and had never received a
 * single write.** The persistence shape was designed and then left empty,
 * because the events that would have filled it did not exist until
 * TS-041a-followup-2 and this service could not consume them until
 * TS-041b-followup-3a. A family's billing history page had nothing to render.
 *
 * Inherits its posture wholesale from the subscription reconciler — re-fetch
 * rather than trust the payload, terminal conditions do not retry, transient
 * ones throw — and adds three decisions of its own:
 *
 *   1. **A one-off invoice is skipped without a Stripe call.** `invoices`
 *      requires a `subscription_id` (a real FK, both tables live in this
 *      schema), so an invoice belonging to no subscription is not
 *      representable. The relayed payload models `stripeSubscriptionId` as
 *      nullable precisely so this costs nothing to decide.
 *   2. **Line items are REPLACED, never merged.** Stripe recomputes the whole
 *      collection on finalisation — proration lines appear, a discount is
 *      recalculated — so merging accumulates lines and doubles an invoice's
 *      apparent total. The replace happens inside the same transaction as the
 *      invoice write, so no reader ever sees an invoice with no lines.
 *   3. **All pages of lines, or none.** See {@link MAX_LINE_PAGES}.
 */
@Injectable()
export class StripeInvoiceReconcilerService {
  private readonly logger = new Logger(StripeInvoiceReconcilerService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(STRIPE_SDK_TOKEN) private readonly stripe: Stripe,
  ) {}

  async reconcile(args: {
    readonly stripeInvoiceId: string;
    readonly stripeSubscriptionId: string | null;
    readonly stripeEventId: string;
    readonly stripeEventType: string;
  }): Promise<InvoiceReconcileOutcome> {
    const { stripeInvoiceId, stripeSubscriptionId, stripeEventId, stripeEventType } = args;

    if (stripeSubscriptionId === null) {
      this.logger.log(
        `stripe.invoice.reconcile.one_off ${JSON.stringify({
          stripeEventId,
          stripeEventType,
          stripeInvoiceId,
        })} — invoice belongs to no subscription; not representable locally`,
      );
      return { kind: 'one_off' };
    }

    const subscription = await this.prisma.subscription.findUnique({
      where: { stripeSubscriptionId },
      select: { id: true },
    });

    if (subscription === null) {
      // Same reasoning as the subscription reconciler's `not_tracked`, plus
      // one narrower case worth naming: an `invoice.created` can overtake our
      // own subscription-row commit. That invoice is not lost — Stripe emits
      // `invoice.finalized` and `invoice.paid` for the same object moments
      // later, and by then the row exists. Converging beats special-casing a
      // race.
      this.logger.log(
        `stripe.invoice.reconcile.not_tracked ${JSON.stringify({
          stripeEventId,
          stripeEventType,
          stripeInvoiceId,
          stripeSubscriptionId,
        })}`,
      );
      return { kind: 'not_tracked' };
    }

    const fetched = await this.fetch(stripeInvoiceId);
    if (fetched === null) {
      this.logger.error(
        `stripe.invoice.reconcile.stripe_missing ${JSON.stringify({
          stripeEventId,
          stripeEventType,
          stripeInvoiceId,
        })}`,
      );
      return { kind: 'stripe_missing' };
    }

    const lines = await this.fetchLines(stripeInvoiceId);
    const mapped = mapStripeInvoice({ invoice: fetched, lines });
    if (mapped.kind === 'unknown_status') {
      this.logger.error(
        `stripe.invoice.reconcile.unknown_status ${JSON.stringify({
          stripeEventId,
          stripeInvoiceId,
          stripeStatus: mapped.stripeStatus,
        })} — refusing to write a partial invoice`,
      );
      return { kind: 'unknown_status', stripeStatus: mapped.stripeStatus };
    }

    const existing = await this.prisma.invoice.findUnique({
      where: { stripeInvoiceId },
      select: {
        id: true,
        status: true,
        total: true,
        tax: true,
        amountPaid: true,
        currency: true,
        issuedAt: true,
        paidAt: true,
        hostedInvoiceUrl: true,
        invoicePdfUrl: true,
        lineItems: {
          select: {
            stripeLineItemId: true,
            kind: true,
            description: true,
            amount: true,
            currency: true,
            periodStart: true,
            periodEnd: true,
          },
        },
      },
    });

    const changed = this.diff(mapped.invoice, mapped.lines, existing);
    if (existing !== null && changed.length === 0) {
      return { kind: 'no_change' };
    }

    await this.prisma.$transaction(async (tx: PrismaTransactionClient) => {
      const invoiceId = await this.upsertInvoice(tx, {
        subscriptionId: subscription.id,
        invoice: mapped.invoice,
        existingId: existing?.id ?? null,
      });

      // REPLACE, not merge — Stripe recomputes the whole collection on
      // finalisation. Inside the same transaction, so no reader observes an
      // invoice with no lines.
      await tx.invoiceLineItem.deleteMany({ where: { invoiceId } });
      if (mapped.lines.length > 0) {
        await tx.invoiceLineItem.createMany({
          data: mapped.lines.map((line) => ({
            invoiceId,
            stripeLineItemId: line.stripeLineItemId,
            kind: line.kind,
            description: line.description,
            amount: line.amount,
            currency: line.currency,
            periodStart: line.periodStart,
            periodEnd: line.periodEnd,
          })),
        });
      }
    });

    this.logger.log(
      `stripe.invoice.reconciled ${JSON.stringify({
        stripeEventId,
        stripeEventType,
        stripeInvoiceId,
        subscriptionId: subscription.id,
        status: mapped.invoice.status,
        lineCount: mapped.lines.length,
        changed,
      })}`,
    );

    return { kind: 'reconciled', changed };
  }

  private diff(
    invoice: MappedInvoice,
    lines: readonly MappedLineItem[],
    existing: ExistingInvoiceRow | null,
  ): readonly string[] {
    if (existing === null) return ['created'];

    const changed: string[] = [];
    if (invoiceDiffers(invoice, toMappedInvoice(existing))) changed.push('invoice');
    if (linesDiffer(lines, existing.lineItems.map(toMappedLineItem))) changed.push('lineItems');
    return changed;
  }

  private async upsertInvoice(
    tx: PrismaTransactionClient,
    args: {
      readonly subscriptionId: string;
      readonly invoice: MappedInvoice;
      readonly existingId: string | null;
    },
  ): Promise<string> {
    const { subscriptionId, invoice, existingId } = args;
    const data = {
      status: invoice.status,
      total: invoice.total,
      tax: invoice.tax,
      amountPaid: invoice.amountPaid,
      currency: invoice.currency,
      issuedAt: invoice.issuedAt,
      paidAt: invoice.paidAt,
      hostedInvoiceUrl: invoice.hostedInvoiceUrl,
      invoicePdfUrl: invoice.invoicePdfUrl,
    };

    if (existingId !== null) {
      // `subscriptionId` is deliberately NOT in the update payload. An
      // invoice never changes which subscription it belongs to, and leaving
      // it out means a bug elsewhere cannot silently re-parent a financial
      // record.
      await tx.invoice.update({ where: { id: existingId }, data });
      return existingId;
    }

    const created = await tx.invoice.create({
      data: { stripeInvoiceId: invoice.stripeInvoiceId, subscriptionId, ...data },
    });
    return created.id;
  }

  /** See the subscription reconciler's twin for the terminal/transient split. */
  private async fetch(stripeInvoiceId: string): Promise<Stripe.Invoice | null> {
    try {
      return await this.stripe.invoices.retrieve(stripeInvoiceId);
    } catch (err) {
      if (
        err instanceof Stripe.errors.StripeInvalidRequestError &&
        err.code === 'resource_missing'
      ) {
        return null;
      }
      throw err;
    }
  }

  /**
   * Every line, paged.
   *
   * `invoice.lines` on the retrieved object is capped at 10 by Stripe, and
   * nothing in the response makes that obvious at the call site — which is
   * how an invoice ends up stored with a `total` that does not match the sum
   * of its visible lines.
   */
  private async fetchLines(stripeInvoiceId: string): Promise<Stripe.InvoiceLineItem[]> {
    const collected: Stripe.InvoiceLineItem[] = [];
    let startingAfter: string | undefined;

    for (let page = 0; page < MAX_LINE_PAGES; page += 1) {
      const response: Stripe.ApiList<Stripe.InvoiceLineItem> =
        await this.stripe.invoices.listLineItems(stripeInvoiceId, {
          limit: LINE_PAGE_SIZE,
          ...(startingAfter === undefined ? {} : { starting_after: startingAfter }),
        });

      collected.push(...response.data);
      if (!response.has_more) return collected;

      const last = response.data.at(-1);
      if (last === undefined) return collected;
      startingAfter = last.id;
    }

    throw new StripeInvoiceShapeError(
      stripeInvoiceId,
      `fewer than ${MAX_LINE_PAGES * LINE_PAGE_SIZE} line items`,
    );
  }
}

interface ExistingLineRow {
  readonly stripeLineItemId: string;
  readonly kind: string;
  readonly description: string;
  readonly amount: { toString(): string };
  readonly currency: string;
  readonly periodStart: Date | null;
  readonly periodEnd: Date | null;
}

interface ExistingInvoiceRow {
  readonly id: string;
  readonly status: string;
  readonly total: { toString(): string };
  readonly tax: { toString(): string };
  readonly amountPaid: { toString(): string };
  readonly currency: string;
  readonly issuedAt: Date;
  readonly paidAt: Date | null;
  readonly hostedInvoiceUrl: string | null;
  readonly invoicePdfUrl: string | null;
  readonly lineItems: readonly ExistingLineRow[];
}

function toMappedInvoice(row: ExistingInvoiceRow): MappedInvoice {
  return {
    stripeInvoiceId: '',
    status: row.status as MappedInvoice['status'],
    total: toDecimal(row.total),
    tax: toDecimal(row.tax),
    amountPaid: toDecimal(row.amountPaid),
    currency: row.currency,
    issuedAt: row.issuedAt,
    paidAt: row.paidAt,
    hostedInvoiceUrl: row.hostedInvoiceUrl,
    invoicePdfUrl: row.invoicePdfUrl,
  };
}

function toMappedLineItem(row: ExistingLineRow): MappedLineItem {
  return {
    stripeLineItemId: row.stripeLineItemId,
    kind: row.kind as MappedLineItem['kind'],
    description: row.description,
    amount: toDecimal(row.amount),
    currency: row.currency,
    periodStart: row.periodStart,
    periodEnd: row.periodEnd,
  };
}

/**
 * Prisma hands back its own `Decimal`, which is `decimal.js` under a
 * different declaration and resolves as an unrelated type under this tsconfig
 * (the namespace issue TS-021-followup-3 tracks). Round-tripping through the
 * string form is exact for a `Decimal(12,2)` and keeps the comparison in
 * decimal arithmetic — never `Number` (CLAUDE.md §17.6).
 */
function toDecimal(value: { toString(): string }): Decimal {
  return new Decimal(value.toString());
}

export { StripeInvoiceShapeError };
