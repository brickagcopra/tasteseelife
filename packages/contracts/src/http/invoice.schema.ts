import { z } from 'zod';

import { PlanCurrencySchema } from './plan.schema';

/**
 * Invoice listing HTTP DTOs (TS-124).
 *
 * Stripe is the source of truth for invoices — when a subscription is
 * billed, Stripe issues an invoice (`in_...`) and is responsible for
 * dunning, retries, hosted-page rendering, and PDF generation. The
 * platform exposes a thin read-through that fetches invoices for a
 * subscription via the Stripe API, projects them onto a stable DTO,
 * and surfaces the hosted Stripe URLs the customer can use to view
 * or download.
 *
 * No invoice data is persisted locally yet — the read-through pattern
 * keeps Stripe authoritative and avoids a sync job for Phase 1. When
 * accounting reconciliation (TS-260) grows a full Invoice mirror,
 * this endpoint shifts to reading from the local mirror.
 *
 * `.strict()` everywhere — unknown fields are a parse error.
 */

/**
 * Bound on the `subscriptionId` query parameter. Mirrors the bound on
 * the `SubscriptionResponse.id` field — the value is a local
 * `subscriptions.id`.
 */
export const INVOICE_LIST_SUBSCRIPTION_ID_MAX_LENGTH = 64;

/**
 * Page-size bounds. Stripe lists invoices in reverse-chronological order
 * 10 at a time by default; we cap higher to surface a year of monthly
 * invoices on a single page without pagination. Cursor-based pagination
 * (matching the activity / audit feeds) lands when the invoice list grows
 * beyond a year of history.
 */
export const INVOICE_LIST_LIMIT_DEFAULT = 12;
export const INVOICE_LIST_LIMIT_MAX = 100;

/**
 * Invoice lifecycle status mirrored from Stripe. Documented in the
 * Stripe API: an invoice transitions `draft` → `open` → `paid` for
 * the happy path; `uncollectible` and `void` are the manual states.
 */
export const InvoiceStatusSchema = z.enum(['draft', 'open', 'paid', 'uncollectible', 'void']);
export type InvoiceStatus = z.infer<typeof InvoiceStatusSchema>;

/**
 * Query schema for `GET /api/v1/invoices?subscriptionId=...`.
 *
 *   - `subscriptionId`  REQUIRED. Local `subscriptions.id`. The service
 *                       resolves it to the Stripe subscription id and
 *                       calls `stripe.invoices.list({subscription})`.
 *   - `limit`           default 12, max 100.
 *   - `startingAfter`   Stripe cursor (Stripe invoice id). Caller passes
 *                       through the previous page's last invoice id.
 */
export const ListInvoicesQuerySchema = z
  .object({
    subscriptionId: z.string().min(1).max(INVOICE_LIST_SUBSCRIPTION_ID_MAX_LENGTH),
    limit: z.coerce
      .number()
      .int()
      .min(1)
      .max(INVOICE_LIST_LIMIT_MAX)
      .default(INVOICE_LIST_LIMIT_DEFAULT),
    startingAfter: z.string().min(1).max(120).optional(),
  })
  .strict();
export type ListInvoicesQuery = z.infer<typeof ListInvoicesQuerySchema>;

/**
 * Single invoice DTO.
 *
 * Money fields are integer USD minor units (`amountDueUsdMinor`,
 * `amountPaidUsdMinor`, `amountRemainingUsdMinor`) per CLAUDE.md §17.6 —
 * no floats over the wire.
 *
 * Stripe URLs (`hostedInvoiceUrl`, `invoicePdf`) are time-bounded but
 * not single-use — Stripe accepts the same URL for the life of the
 * invoice. They MAY be null in edge cases (a `draft` invoice has no
 * hosted page yet; an old archived invoice may have lost its PDF
 * rendering window). The portal degrades gracefully when null.
 */
export const InvoiceResponseSchema = z
  .object({
    id: z.string().min(1).max(120),
    /**
     * Local subscription id this invoice belongs to. Echoed for the
     * client's correlation needs even though it's also the query
     * parameter.
     */
    subscriptionId: z.string().min(1).max(INVOICE_LIST_SUBSCRIPTION_ID_MAX_LENGTH),
    stripeSubscriptionId: z.string().min(1).max(64),
    /**
     * Stripe Customer id. Echoed for client-side correlation.
     */
    stripeCustomerId: z.string().min(1).max(64),
    status: InvoiceStatusSchema,
    /**
     * Stripe's `number` field (e.g. "ABCD1234-0001"). Visible on the
     * hosted page. Null while the invoice is in draft.
     */
    number: z.string().min(1).max(64).nullable(),
    /**
     * Invoice description — typically the plan name + period. Stripe
     * generates this when not supplied; we don't currently override.
     */
    description: z.string().max(2000).nullable(),
    currency: PlanCurrencySchema.default('USD'),
    amountDueUsdMinor: z.number().int().min(0),
    amountPaidUsdMinor: z.number().int().min(0),
    amountRemainingUsdMinor: z.number().int().min(0),
    /**
     * Hosted Stripe invoice page URL. The portal renders this as a
     * "view receipt" link. Null when Stripe has not yet generated the
     * page (draft invoices).
     */
    hostedInvoiceUrl: z.string().url().max(2048).nullable(),
    /**
     * Downloadable PDF URL. The portal renders this as a "download
     * receipt" link.
     */
    invoicePdf: z.string().url().max(2048).nullable(),
    /**
     * Stripe's `period_start` (inclusive) for the billing period the
     * invoice covers.
     */
    periodStart: z.string().datetime(),
    /**
     * Stripe's `period_end` (exclusive) for the billing period.
     */
    periodEnd: z.string().datetime(),
    /**
     * Stripe's `created` timestamp.
     */
    createdAt: z.string().datetime(),
    /**
     * Stripe's `status_transitions.paid_at`. Null until paid.
     */
    paidAt: z.string().datetime().nullable(),
    /**
     * Stripe's `due_date`. Null when there is no explicit due date
     * (typical for auto-charged subscription invoices).
     */
    dueAt: z.string().datetime().nullable(),
  })
  .strict();
export type InvoiceResponse = z.infer<typeof InvoiceResponseSchema>;

/**
 * Response shape for `GET /api/v1/invoices`.
 *
 * Wrapped in `{ invoices, hasMore, nextStartingAfter }` so the client
 * can paginate via Stripe's cursor (`startingAfter`) on the next call.
 * `hasMore` mirrors Stripe's response field; `nextStartingAfter` is the
 * id of the last invoice on this page (the cursor for the next request)
 * when `hasMore` is true.
 */
export const InvoicesListResponseSchema = z
  .object({
    invoices: z.array(InvoiceResponseSchema),
    hasMore: z.boolean(),
    nextStartingAfter: z.string().min(1).max(120).nullable(),
  })
  .strict();
export type InvoicesListResponse = z.infer<typeof InvoicesListResponseSchema>;
