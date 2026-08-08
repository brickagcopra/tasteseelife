import { z } from 'zod';

/**
 * Stripe Billing Portal session HTTP DTOs (TS-042-followup-3a3-followup-1).
 *
 * The dunning ladder (TS-042-followup-3a2 / -3a3) emails a family whose
 * payment did not go through and points them at their billing page. Until
 * this endpoint existed that page was **read-only** — the platform asked
 * families to fix a payment problem and gave them nowhere to fix it. The
 * dunning copy was deliberately written around the absence ("review your
 * billing details", never "update your card") with a test enforcing it.
 *
 * This surface mints a short-lived Stripe-hosted Billing Portal session
 * and hands back the URL to redirect to. Stripe owns the card form, so
 * no PAN ever touches this platform (CLAUDE.md §3.9, §17.1).
 *
 * **There is no request body, and that is the security property.**
 * A portal session confers full billing control over the customer it is
 * minted for — update the payment method, read every invoice, cancel the
 * subscription. So the customer is derived from the caller's token
 * (`tenantScope`, established by the gateway's `HouseholdScopeInterceptor`),
 * never from anything the caller sends. An id in the body would be a claim
 * the caller is not entitled to make; the same asymmetry as concierge
 * emergency, trust-safety intake, and — since TS-124-followup-scoping —
 * the invoice list this replaces the read-only half of.
 *
 * The `return_url` is likewise **not** caller-supplied: it comes from
 * service-subscription's `BILLING_PORTAL_RETURN_URL`. Accepting it from
 * the wire would make this an open redirect wearing Stripe's branding.
 */

/**
 * Response for `POST /api/v1/billing/portal-sessions`.
 *
 * One field on purpose. Stripe's session object also carries the
 * configuration id, the customer id, the livemode flag and the return
 * url; none of them are the client's business, and a DTO that mirrors an
 * upstream object is a DTO that leaks the next field the upstream adds
 * (CLAUDE.md §3.3).
 *
 * **The URL is single-use and short-lived.** It is not a durable link:
 * it must be followed immediately by redirect, never stored, emailed,
 * logged, or rendered as an anchor the user might come back to later.
 * That is a property of Stripe's portal, not of this platform, and it is
 * why the response carries no expiry to reason about — there is nothing
 * useful a client could do with one.
 */
export const BillingPortalSessionResponseSchema = z
  .object({
    url: z
      .string()
      .url()
      .describe(
        'Stripe-hosted Billing Portal URL. Single-use, short-lived — redirect immediately; never persist.',
      ),
  })
  .strict();
export type BillingPortalSessionResponse = z.infer<typeof BillingPortalSessionResponseSchema>;

/**
 * Request body for `POST /api/v1/billing/portal-sessions`.
 *
 * Empty, and `.strict()` makes that enforceable rather than merely
 * conventional: a client that sends `{"customerId": "..."}` or
 * `{"returnUrl": "https://evil.example"}` gets a 400, instead of having
 * the field silently ignored. A silently-ignored field is how a caller
 * comes to believe it works.
 */
export const CreateBillingPortalSessionRequestSchema = z.object({}).strict();
export type CreateBillingPortalSessionRequest = z.infer<
  typeof CreateBillingPortalSessionRequestSchema
>;
