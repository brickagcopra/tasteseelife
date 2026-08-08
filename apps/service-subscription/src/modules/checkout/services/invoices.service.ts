import { Inject, Injectable, Logger } from '@nestjs/common';
import type {
  InvoiceResponse,
  InvoiceStatus,
  InvoicesListResponse,
  PlanCurrency,
} from '@taste-and-see/contracts';
import type Stripe from 'stripe';

import { PrismaService } from '../../../prisma/prisma.service';
import { STRIPE_SDK_TOKEN } from '../../stripe/stripe.constants';
import { err, ok, type Result } from '../../subscriptions/result';

/**
 * Failure shapes returned by the InvoicesService. Discriminated so the
 * controller's branch is explicit (CLAUDE.md §2.1).
 */
export type InvoicesFailure =
  | { readonly reason: 'subscription_not_found'; readonly subscriptionId: string }
  | { readonly reason: 'stripe_unavailable'; readonly cause: unknown };

export interface ListInvoicesInput {
  readonly subscriptionId: string;
  /**
   * The household the caller is acting in, resolved from the token's
   * `tenantScope` by the controller — **never** from the request body or
   * query (TS-124-followup-scoping). It is a required part of the lookup
   * predicate, not an afterthought check, so a future caller of this
   * service cannot obtain an unscoped read by omitting it.
   */
  readonly householdId: string;
  readonly requesterUserId: string;
  readonly limit: number;
  readonly startingAfter?: string;
}

/**
 * `InvoicesService` — read-through projection of Stripe invoices keyed
 * by a local `Subscription.id` (TS-124).
 *
 * Stripe is authoritative for invoice state in Phase 1; the platform
 * does not persist invoices locally. The service:
 *
 *   1. Looks up the local `Subscription` row **scoped to the caller's
 *      household** to translate `subscriptionId` →
 *      `stripeSubscriptionId`. A row that is not this household's is
 *      indistinguishable from one that does not exist.
 *
 *   2. Calls `stripe.invoices.list({subscription, limit, starting_after})`.
 *
 *   3. Projects each Stripe `Invoice` onto the platform's
 *      `InvoiceResponse` DTO (stable wire shape; hides Stripe-internal
 *      fields).
 *
 * **Authorization (TS-124-followup-scoping).** Authentication comes from
 * the controller's `AccessTokenGuard`; row-level scoping is here, in the
 * `where` clause. The lookup is
 * `WHERE id = :subscriptionId AND customer_id = :householdId AND customer_group = 'family'`,
 * so a caller can only ever reach their own household's subscriptions.
 *
 * Three deliberate choices:
 *
 *   - **The scope is part of the predicate, not a post-hoc comparison.**
 *     A check performed after an unscoped read is one `if` away from
 *     being dropped; a `where` clause cannot return the row in the first
 *     place (CLAUDE.md §3.2).
 *
 *   - **`customerGroup` is matched too, not just `customerId`.**
 *     `subscriptions.customer_id` is a soft FK whose target schema
 *     depends on `customer_group` — household, provider, or user — so
 *     the id alone does not identify a household. Matching the group is
 *     what makes the predicate mean what it reads as.
 *
 *   - **Not-yours and not-there collapse to one outcome.** Both return
 *     `subscription_not_found` → 404. Distinguishing them would confirm
 *     that a guessed subscription id exists, which is itself a
 *     disclosure (the TS-309a precedent). The distinction survives in
 *     the log, where it belongs, and only there.
 *
 * Invoices carry amounts, dates and the plan tier — a household's care
 * spend — which is why this is scoped ahead of the broader TS-141
 * tenant-scoping work rather than with it.
 *
 * **Money math.** Stripe returns money fields as integer minor units
 * directly (`amount_due`, `amount_paid`, `amount_remaining`), matching
 * our wire shape — no `Decimal` round-trip needed.
 */
@Injectable()
export class InvoicesService {
  private readonly logger = new Logger(InvoicesService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(STRIPE_SDK_TOKEN) private readonly stripe: Stripe,
  ) {}

  async list(input: ListInvoicesInput): Promise<Result<InvoicesListResponse, InvoicesFailure>> {
    // `findFirst`, not `findUnique`: the predicate is no longer the
    // primary key alone. The extra two columns are what make this a
    // scoped read (see the class doc-comment).
    const subscription = await this.prisma.subscription.findFirst({
      where: {
        id: input.subscriptionId,
        customerId: input.householdId,
        customerGroup: 'family',
      },
      select: {
        id: true,
        stripeSubscriptionId: true,
        stripeCustomerId: true,
        customerId: true,
      },
    });
    if (subscription === null) {
      await this.logScopeMiss(input);
      return err({ reason: 'subscription_not_found', subscriptionId: input.subscriptionId });
    }

    let page: Stripe.ApiList<Stripe.Invoice>;
    try {
      page = await this.stripe.invoices.list({
        subscription: subscription.stripeSubscriptionId,
        limit: input.limit,
        ...(input.startingAfter !== undefined && { starting_after: input.startingAfter }),
      });
    } catch (cause) {
      this.logger.warn(
        {
          subscriptionId: input.subscriptionId,
          stripeSubscriptionId: subscription.stripeSubscriptionId,
          err: stripeErrorMessage(cause),
        },
        'invoices.list stripe failure',
      );
      return err({ reason: 'stripe_unavailable', cause });
    }

    const invoices = page.data.map((invoice) =>
      mapInvoice(invoice, {
        subscriptionId: subscription.id,
        stripeSubscriptionId: subscription.stripeSubscriptionId,
      }),
    );
    const last = invoices[invoices.length - 1];
    const nextStartingAfter = page.has_more && last !== undefined ? last.id : null;

    this.logger.log(
      {
        subscriptionId: subscription.id,
        count: invoices.length,
        hasMore: page.has_more,
      },
      'invoices.list ok',
    );

    return ok({
      invoices,
      hasMore: page.has_more,
      nextStartingAfter,
    });
  }

  /**
   * Separate the two reasons a scoped read came back empty, in the log
   * only. The caller is told the same thing either way (see the class
   * doc-comment) — but "this id does not exist" is a stale bookmark and
   * "this id exists and belongs to another household" is somebody
   * walking ids, and an operator cannot tell those apart from a 404
   * count. The extra query runs on the miss path exclusively and
   * projects nothing but the primary key, so it discloses nothing to
   * the process beyond existence.
   *
   * Best-effort: a failure here must not turn a correct 404 into a 500.
   */
  private async logScopeMiss(input: ListInvoicesInput): Promise<void> {
    let exists = false;
    try {
      const row = await this.prisma.subscription.findUnique({
        where: { id: input.subscriptionId },
        select: { id: true },
      });
      exists = row !== null;
    } catch (cause) {
      this.logger.debug(
        { subscriptionId: input.subscriptionId, err: stripeErrorMessage(cause) },
        'invoices.list scope-miss probe failed',
      );
      return;
    }

    if (exists) {
      this.logger.warn(
        {
          subscriptionId: input.subscriptionId,
          requesterUserId: input.requesterUserId,
          householdId: input.householdId,
        },
        'invoices.list denied: subscription belongs to another household',
      );
      return;
    }

    this.logger.log(
      {
        subscriptionId: input.subscriptionId,
        requesterUserId: input.requesterUserId,
        householdId: input.householdId,
      },
      'invoices.list miss: no such subscription',
    );
  }
}

interface SubscriptionContext {
  readonly subscriptionId: string;
  readonly stripeSubscriptionId: string;
}

/**
 * Project a Stripe Invoice onto the platform's wire shape. The mapping
 * is intentionally tight — every field we expose is documented in
 * `invoice.schema.ts`; anything Stripe adds in a future API version
 * lands as a no-op until we choose to surface it.
 */
function mapInvoice(invoice: Stripe.Invoice, ctx: SubscriptionContext): InvoiceResponse {
  const stripeCustomerId =
    typeof invoice.customer === 'string' ? invoice.customer : (invoice.customer?.id ?? '');
  return {
    id: invoice.id,
    subscriptionId: ctx.subscriptionId,
    stripeSubscriptionId: ctx.stripeSubscriptionId,
    stripeCustomerId,
    status: mapInvoiceStatus(invoice.status),
    number: invoice.number ?? null,
    description: invoice.description ?? null,
    currency: narrowCurrency(invoice.currency),
    amountDueUsdMinor: invoice.amount_due,
    amountPaidUsdMinor: invoice.amount_paid,
    amountRemainingUsdMinor: invoice.amount_remaining,
    hostedInvoiceUrl: invoice.hosted_invoice_url ?? null,
    invoicePdf: invoice.invoice_pdf ?? null,
    periodStart: unixToIsoDate(invoice.period_start),
    periodEnd: unixToIsoDate(invoice.period_end),
    createdAt: unixToIsoDate(invoice.created),
    paidAt: mapPaidAt(invoice),
    dueAt: invoice.due_date !== null ? unixToIsoDate(invoice.due_date) : null,
  };
}

function mapInvoiceStatus(status: Stripe.Invoice.Status | null): InvoiceStatus {
  switch (status) {
    case 'draft':
      return 'draft';
    case 'open':
      return 'open';
    case 'paid':
      return 'paid';
    case 'uncollectible':
      return 'uncollectible';
    case 'void':
      return 'void';
    default:
      // Defensive: Stripe's enum is the source of truth. A null or unknown
      // value (an SDK that ships a new state ahead of our mapper) lands
      // as `draft` — the safest assumption for an unknown lifecycle stage.
      return 'draft';
  }
}

function mapPaidAt(invoice: Stripe.Invoice): string | null {
  // `status_transitions.paid_at` is the authoritative paid timestamp.
  const paidAt = invoice.status_transitions?.paid_at;
  if (typeof paidAt === 'number') return unixToIsoDate(paidAt);
  return null;
}

function unixToIsoDate(seconds: number): string {
  return new Date(seconds * 1000).toISOString();
}

/**
 * Phase 1 is USD-only; the contract enum mirrors that. A future-currency
 * invoice (manually created in the Stripe Dashboard for an enterprise
 * partner, say) surfaces a clean 500 rather than passing through an
 * unsupported wire value.
 */
function narrowCurrency(value: string): PlanCurrency {
  const upper = value.toUpperCase();
  if (upper !== 'USD') {
    throw new Error(`unsupported invoice currency: ${value}`);
  }
  return 'USD';
}

function stripeErrorMessage(cause: unknown): string {
  if (typeof cause === 'object' && cause !== null && 'message' in cause) {
    const message = (cause as { message: unknown }).message;
    if (typeof message === 'string') return message;
  }
  return 'unknown stripe error';
}
