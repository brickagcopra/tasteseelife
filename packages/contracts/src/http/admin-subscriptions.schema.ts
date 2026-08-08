import { z } from 'zod';

import { PlanCurrencySchema, PlanCustomerGroupSchema } from './plan.schema';
import {
  BillingIntervalSchema,
  SubscriptionCancelReasonSchema,
  SubscriptionStatusSchema,
} from './subscription.schema';

/**
 * Admin subscriptions management HTTP DTOs (TS-127 Slice 1; PRD §10.3).
 *
 * Two read-only surfaces:
 *
 *   - `GET /api/v1/admin/subscriptions?customerGroup=&status=&planId=
 *      &customerId=&cursor=&limit=`
 *     Cursor-paginated search across the subscription service's
 *     `subscriptions` table. Returns a denormalised summary per row
 *     (plan code + name, payment-method brand/last4 if available, dunning
 *     state at a glance, pause + cancel flags) so the list page renders
 *     without an N+1 detail fetch.
 *
 *   - `GET /api/v1/admin/subscriptions/:id`
 *     Full subscription-detail view. Carries the subscription row plus
 *     denormalised plan summary, default payment-method summary (brand /
 *     last4 / expiry / kind), dunning + pause + cancellation columns, and
 *     the chronological change-history audit trail
 *     (`subscription_history` rows).
 *
 * **Slice 1 scope.** Read-only. Mutations (comp / refund / extend-trial /
 * prorate — captured as TS-127-followup-1), plan-catalog edit
 * (TS-127-followup-2), bulk cohort operations (TS-127-followup-3),
 * revenue-recognition reporting (TS-127-followup-4), manual dunning
 * recovery (TS-127-followup-5), audit-event emission (TS-127-followup-6),
 * Playwright E2E (TS-127-followup-7), OTel + Prometheus
 * (TS-127-followup-8), OpenAPI generator registration
 * (TS-127-followup-9), and the PermissionGuard lift (TS-127-followup-10)
 * arrive in subsequent TS-127 follow-ups. Each deferred capability has a
 * named owner so the gates don't drift.
 *
 * **Authorisation.** The downstream service-subscription endpoint is
 * gated by an `AdminRoleGuard` that requires the access token's
 * `roles[]` claim to carry an active `super_admin` assignment. The
 * api-gateway proxy enforces the same gate at the edge for
 * defence-in-depth (and to avoid serving any downstream call when the
 * caller is non-admin). Future per-permission gating (`subscription:read`
 * for ops + finance + auditor) lands with TS-127-followup-10.
 *
 * **Audit.** Admin reads do NOT emit audit events in Slice 1 — only
 * mutations do, and Slice 1 has no mutations. Read auditing arrives with
 * TS-127-followup-6 once the audit pipe is operational.
 *
 * **Money fields.** Integer USD minor units (`unitPriceMinor`) per
 * CLAUDE.md §17.6 — no floats over the wire. The DTOs mirror
 * `SubscriptionResponseSchema`'s shape for the columns they share.
 *
 * **`.strict()`** everywhere — unknown fields are a parse error so a typo
 * or stray field never silently round-trips.
 */

/**
 * Cursor max length. Opaque to the consumer; the service emits a
 * base64-encoded `(createdAt-ISO, id)` pair. 256 bytes is well past the
 * maximum encoded size; the cap exists to bound query-string abuse, not
 * to constrain the cursor format. Mirrors
 * `ADMIN_USERS_LIST_CURSOR_MAX_LENGTH`.
 */
export const ADMIN_SUBSCRIPTIONS_LIST_CURSOR_MAX_LENGTH = 256;

/** Default page size for `GET /api/v1/admin/subscriptions`. */
export const ADMIN_SUBSCRIPTIONS_LIST_LIMIT_DEFAULT = 25;

/** Maximum page size for `GET /api/v1/admin/subscriptions`. */
export const ADMIN_SUBSCRIPTIONS_LIST_LIMIT_MAX = 100;

/**
 * Subscription / customer / plan id path-parameter max length. CUID2 +
 * safety margin. Matches the cap used across other contracts.
 */
export const ADMIN_SUBSCRIPTIONS_ID_MAX_LENGTH = 64;

/**
 * Maximum number of `subscription_history` rows returned in the detail
 * response. Slice-1 surfaces the most-recent N entries; the full audit
 * trail with cursor pagination lands as a future follow-up (TS-127
 * change-history view). Bounds the response size against a noisy
 * subscription with hundreds of audit rows.
 */
export const ADMIN_SUBSCRIPTIONS_HISTORY_MAX = 50;

/**
 * Maximum `pauseReason` length surfaced through the admin DTO. Mirrors
 * the contract-layer cap on `PauseSubscriptionRequest.reason`
 * (`PAUSE_REASON_MAX_LENGTH`) so the read-back never exposes a value the
 * write surface wouldn't accept.
 */
export const ADMIN_SUBSCRIPTIONS_PAUSE_REASON_MAX_LENGTH = 500;

/**
 * Append-only event kinds for `subscription_history`. Mirrors the
 * `SubscriptionHistoryEvent` Postgres enum in service-subscription
 * exactly. We deliberately mirror rather than re-export from a sibling
 * schema so the admin contract is self-contained (no circular module
 * coupling) and so a drift between the Postgres enum and the contract
 * surfaces here at parse time rather than in the consumer.
 *
 * Adding a new kind is a breaking-but-explicit contract change.
 */
export const AdminSubscriptionHistoryEventSchema = z.enum([
  'created',
  'status_changed',
  'plan_changed',
  'payment_method_changed',
  'trial_extended',
  'paused',
  'resumed',
  'canceled',
  'reactivated',
]);
export type AdminSubscriptionHistoryEvent = z.infer<typeof AdminSubscriptionHistoryEventSchema>;

/**
 * Categorical actor kind on each `subscription_history` row. Drives the
 * "who did this" column on the change-history table.
 *
 *   - `user`   — customer-initiated change (the family payer canceled,
 *                paused, switched plan).
 *   - `admin`  — ops override (admin tooling — TS-127 mutations once
 *                they land).
 *   - `system` — webhook-driven, dunning sweep, or job-triggered. The
 *                row's `source` column carries the originating event id.
 */
export const AdminSubscriptionHistoryActorKindSchema = z.enum(['user', 'admin', 'system']);
export type AdminSubscriptionHistoryActorKind = z.infer<
  typeof AdminSubscriptionHistoryActorKindSchema
>;

/**
 * Payment-method kind mirror. Mirrors `PaymentMethodKind` in the
 * service-subscription Prisma schema. Same self-containment rationale as
 * `AdminSubscriptionHistoryEventSchema`.
 */
export const AdminPaymentMethodKindSchema = z.enum(['card', 'bank_account']);
export type AdminPaymentMethodKind = z.infer<typeof AdminPaymentMethodKindSchema>;

/**
 * Denormalised plan summary on every admin row. Lets the list + detail
 * pages render the plan name without expanding the relation graph.
 */
export const AdminSubscriptionPlanSummarySchema = z
  .object({
    id: z.string().min(1).max(ADMIN_SUBSCRIPTIONS_ID_MAX_LENGTH),
    code: z.string().min(1).max(64),
    name: z.string().min(1).max(160),
    customerGroup: PlanCustomerGroupSchema,
    /** Monthly price in integer USD minor units. */
    monthlyPriceMinor: z.number().int().min(0),
    /** Annual price in integer USD minor units. */
    annualPriceMinor: z.number().int().min(0),
    currency: PlanCurrencySchema.default('USD'),
    /** Whether the plan is currently visible on the public pricing page. */
    active: z.boolean(),
  })
  .strict();
export type AdminSubscriptionPlanSummary = z.infer<typeof AdminSubscriptionPlanSummarySchema>;

/**
 * Denormalised default-payment-method summary on the detail view. Null
 * when the subscription is `incomplete` (no method attached yet) or when
 * the row's `default_payment_method_id` points at a method that has been
 * detached from the customer.
 *
 * **No card data lands here.** The columns echo what Stripe already
 * exposes for display (brand, last4, expiry) — never the PAN, CVV, or
 * full expiry. The cap on the DTO ensures the contract is the
 * defence-in-depth gate against accidental leakage.
 */
export const AdminSubscriptionPaymentMethodSummarySchema = z
  .object({
    id: z.string().min(1).max(ADMIN_SUBSCRIPTIONS_ID_MAX_LENGTH),
    stripePaymentMethodId: z.string().min(1).max(64),
    kind: AdminPaymentMethodKindSchema,
    /** Card brand (visa, mastercard, amex, etc). Null for bank_account. */
    brand: z.string().min(1).max(32).nullable(),
    /** Last 4 digits — display only. Null when not applicable. */
    last4: z
      .string()
      .regex(/^\d{4}$/)
      .nullable(),
    expiryMonth: z.number().int().min(1).max(12).nullable(),
    expiryYear: z.number().int().min(2000).max(9999).nullable(),
    isDefault: z.boolean(),
  })
  .strict();
export type AdminSubscriptionPaymentMethodSummary = z.infer<
  typeof AdminSubscriptionPaymentMethodSummarySchema
>;

/**
 * Dunning snapshot on every admin row. Mirrors the four dunning columns
 * on `subscriptions` plus a derived `inGracePeriod` flag so the list page
 * can highlight at-risk subscriptions without recomputing the predicate.
 *
 * Service derives `inGracePeriod` as
 *   `status === 'past_due' && dunningGraceUntil !== null && dunningGraceUntil > now()`
 * so the value reflects the call instant — callers should not cache.
 */
export const AdminSubscriptionDunningSummarySchema = z
  .object({
    attempts: z.number().int().min(0),
    lastAttemptAt: z.string().datetime().nullable(),
    graceUntil: z.string().datetime().nullable(),
    /** Derived "is currently inside the dunning grace window" flag. */
    inGracePeriod: z.boolean(),
  })
  .strict();
export type AdminSubscriptionDunningSummary = z.infer<typeof AdminSubscriptionDunningSummarySchema>;

/**
 * Pause snapshot on every admin row. Mirrors the three pause columns on
 * `subscriptions` plus a derived `isPaused` flag.
 *
 * `isPaused` is `status === 'paused' || pauseCollectionStartedAt !== null`
 * — captures both the canonical platform status and the Stripe-side
 * `pause_collection` window.
 */
export const AdminSubscriptionPauseSummarySchema = z
  .object({
    isPaused: z.boolean(),
    pauseCollectionStartedAt: z.string().datetime().nullable(),
    pauseCollectionResumesAt: z.string().datetime().nullable(),
    pauseReason: z.string().min(1).max(ADMIN_SUBSCRIPTIONS_PAUSE_REASON_MAX_LENGTH).nullable(),
  })
  .strict();
export type AdminSubscriptionPauseSummary = z.infer<typeof AdminSubscriptionPauseSummarySchema>;

/**
 * Row shape for the list response. Carries only what the list page needs
 * to render — full plan / payment-method / history graph is reserved for
 * the detail endpoint.
 */
export const AdminSubscriptionSummarySchema = z
  .object({
    id: z.string().min(1).max(ADMIN_SUBSCRIPTIONS_ID_MAX_LENGTH),
    stripeSubscriptionId: z.string().min(1).max(64),
    stripeCustomerId: z.string().min(1).max(64),
    customerId: z.string().min(1).max(ADMIN_SUBSCRIPTIONS_ID_MAX_LENGTH),
    customerGroup: PlanCustomerGroupSchema,
    planId: z.string().min(1).max(ADMIN_SUBSCRIPTIONS_ID_MAX_LENGTH),
    /** Denormalised plan code + name so the list doesn't N+1-fetch. */
    planCode: z.string().min(1).max(64),
    planName: z.string().min(1).max(160),
    status: SubscriptionStatusSchema,
    billingInterval: BillingIntervalSchema,
    /** Unit price for the chosen interval in integer USD minor units. */
    unitPriceMinor: z.number().int().min(0),
    currency: PlanCurrencySchema.default('USD'),
    currentPeriodStart: z.string().datetime(),
    currentPeriodEnd: z.string().datetime(),
    trialEnd: z.string().datetime().nullable(),
    cancelAtPeriodEnd: z.boolean(),
    cancelReason: SubscriptionCancelReasonSchema.nullable(),
    canceledAt: z.string().datetime().nullable(),
    /**
     * Derived "is currently inside the dunning grace window" flag — same
     * computation as `AdminSubscriptionDunningSummary.inGracePeriod`.
     * Carried on the list summary so the table can chip past-due
     * subscriptions without expanding the dunning sub-object.
     */
    inDunningGrace: z.boolean(),
    /**
     * Derived "is currently paused" flag — same computation as
     * `AdminSubscriptionPauseSummary.isPaused`. Carried on the list
     * summary for the same chip-rendering reason.
     */
    isPaused: z.boolean(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .strict();
export type AdminSubscriptionSummary = z.infer<typeof AdminSubscriptionSummarySchema>;

/**
 * Query shape for `GET /api/v1/admin/subscriptions`.
 *
 * - `customerGroup` — optional exact-match filter against `customer_group`.
 * - `status`        — optional exact-match filter against `status`.
 * - `planId`        — optional exact-match filter against `plan_id`.
 * - `customerId`    — optional exact-match filter against `customer_id`
 *                     (the soft FK into household / provider / users).
 * - `cursor`        — opaque pagination cursor from the previous page's
 *                     `nextCursor`.
 * - `limit`         — page size; defaults to 25, max 100.
 */
export const AdminSubscriptionsListQuerySchema = z
  .object({
    customerGroup: PlanCustomerGroupSchema.optional(),
    status: SubscriptionStatusSchema.optional(),
    planId: z.string().min(1).max(ADMIN_SUBSCRIPTIONS_ID_MAX_LENGTH).optional(),
    customerId: z.string().min(1).max(ADMIN_SUBSCRIPTIONS_ID_MAX_LENGTH).optional(),
    cursor: z.string().min(1).max(ADMIN_SUBSCRIPTIONS_LIST_CURSOR_MAX_LENGTH).optional(),
    limit: z.coerce
      .number()
      .int()
      .positive()
      .max(ADMIN_SUBSCRIPTIONS_LIST_LIMIT_MAX)
      .default(ADMIN_SUBSCRIPTIONS_LIST_LIMIT_DEFAULT),
  })
  .strict();
export type AdminSubscriptionsListQuery = z.infer<typeof AdminSubscriptionsListQuerySchema>;

export const AdminSubscriptionsListResponseSchema = z
  .object({
    subscriptions: z.array(AdminSubscriptionSummarySchema),
    nextCursor: z.string().min(1).max(ADMIN_SUBSCRIPTIONS_LIST_CURSOR_MAX_LENGTH).nullable(),
  })
  .strict();
export type AdminSubscriptionsListResponse = z.infer<typeof AdminSubscriptionsListResponseSchema>;

/**
 * Single `subscription_history` row for the detail view. Append-only by
 * policy (CLAUDE.md §3.6) — every state transition produces a new row,
 * never an update.
 *
 * `context` is free-form JSON capped at 8 KiB at the contract layer.
 * Common shapes:
 *   - `plan_changed`        — `{from: 'family.tier2', to: 'family.tier3'}`
 *   - `canceled`            — `{cancelAtPeriodEnd: true, reason: '...', note?: '...'}`
 *   - `paused` / `resumed`  — `{resumesAt?: '...', reason?: '...'}`
 */
export const AdminSubscriptionHistoryEntrySchema = z
  .object({
    id: z.string().min(1).max(ADMIN_SUBSCRIPTIONS_ID_MAX_LENGTH),
    event: AdminSubscriptionHistoryEventSchema,
    fromStatus: SubscriptionStatusSchema.nullable(),
    toStatus: SubscriptionStatusSchema.nullable(),
    context: z.record(z.unknown()),
    actorUserId: z.string().min(1).max(64).nullable(),
    actorKind: AdminSubscriptionHistoryActorKindSchema,
    source: z.string().min(1).max(160).nullable(),
    occurredAt: z.string().datetime(),
  })
  .strict();
export type AdminSubscriptionHistoryEntry = z.infer<typeof AdminSubscriptionHistoryEntrySchema>;

/**
 * Detail-view response for `GET /api/v1/admin/subscriptions/:id`.
 *
 * Composes the per-row columns (echoed from
 * `SubscriptionResponseSchema`) with denormalised plan + payment-method
 * summaries, the dunning + pause sub-objects, and the most-recent N
 * history entries.
 */
export const AdminSubscriptionDetailSchema = z
  .object({
    id: z.string().min(1).max(ADMIN_SUBSCRIPTIONS_ID_MAX_LENGTH),
    stripeSubscriptionId: z.string().min(1).max(64),
    stripeCustomerId: z.string().min(1).max(64),
    customerId: z.string().min(1).max(ADMIN_SUBSCRIPTIONS_ID_MAX_LENGTH),
    customerGroup: PlanCustomerGroupSchema,
    status: SubscriptionStatusSchema,
    billingInterval: BillingIntervalSchema,
    /** Unit price for the chosen interval in integer USD minor units. */
    unitPriceMinor: z.number().int().min(0),
    currency: PlanCurrencySchema.default('USD'),
    currentPeriodStart: z.string().datetime(),
    currentPeriodEnd: z.string().datetime(),
    trialEnd: z.string().datetime().nullable(),
    cancelAtPeriodEnd: z.boolean(),
    cancelReason: SubscriptionCancelReasonSchema.nullable(),
    canceledAt: z.string().datetime().nullable(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
    /**
     * Denormalised plan summary (TS-127 Slice 1). The full plan-catalog
     * edit surface arrives with TS-127-followup-2.
     */
    plan: AdminSubscriptionPlanSummarySchema,
    /**
     * Default payment-method summary. Null when no method is attached
     * (subscription is `incomplete`) or when the row's
     * `default_payment_method_id` does not resolve.
     */
    defaultPaymentMethod: AdminSubscriptionPaymentMethodSummarySchema.nullable(),
    dunning: AdminSubscriptionDunningSummarySchema,
    pause: AdminSubscriptionPauseSummarySchema,
    /**
     * Chronological audit trail of subscription state transitions —
     * `ADMIN_SUBSCRIPTIONS_HISTORY_MAX` most-recent rows newest-first.
     * The full cursor-paginated view lands as a follow-up.
     */
    history: z.array(AdminSubscriptionHistoryEntrySchema),
  })
  .strict();
export type AdminSubscriptionDetail = z.infer<typeof AdminSubscriptionDetailSchema>;

export const AdminSubscriptionDetailResponseSchema = z
  .object({
    subscription: AdminSubscriptionDetailSchema,
  })
  .strict();
export type AdminSubscriptionDetailResponse = z.infer<typeof AdminSubscriptionDetailResponseSchema>;
