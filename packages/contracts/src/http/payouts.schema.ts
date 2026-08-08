import { z } from 'zod';

/**
 * Payouts HTTP DTOs (TS-090; PDD §11.3 provider payouts + §7.2 service
 * inventory entry #11; CLAUDE.md §6 accounting/payments care).
 *
 * Scope so far: Stripe Connect Express onboarding surface.
 *
 *   1. **Connect-account creation** — a provider asks the platform to
 *      create (or echo) their Stripe Connect Express account. The
 *      service idempotently issues one Express account per provider.
 *
 *   2. **Onboarding link** — the provider asks for a fresh onboarding
 *      URL (`account_link` of `type=account_onboarding`). Links are
 *      short-lived (≤ 10 min per Stripe defaults); the endpoint mints a
 *      new one each call rather than caching.
 *
 *   3. **Account-status read** — provider + admin surfaces both read
 *      the persisted account state (charges_enabled, payouts_enabled,
 *      details_submitted, requirements).
 *
 *   4. **Internal `account.updated` ingest** — service-webhook hands off
 *      Stripe `account.updated` events here so the local cache stays in
 *      sync with Stripe truth. Idempotent on `stripeEventId`.
 *
 * **Live SDK wiring is Phase 1 stub-only**: when `STRIPE_SECRET_KEY` is
 * absent (or the explicit stub sentinel `sk_test_stub_*`), the service
 * returns deterministic synthetic `acct_*` ids and `https://stub-...`
 * onboarding URLs. Live SDK calls land as TS-090-followup-1.
 *
 * **T+2 disbursement, payout statements, 1099 prep** are TS-091 / future
 * follow-ups — not part of TS-090's contract surface.
 *
 * **`.strict()` everywhere** — typo in a field name is a 400, not a
 * silently-dropped knob (CLAUDE.md §3.3).
 */

// ─── Bounded length constants ───────────────────────────────────────────

/** Soft-FK to `provider.providers.id` (mirrors PROVIDER_ID_MAX shapes). */
export const PAYOUT_PROVIDER_ID_MAX_LENGTH = 128;

/**
 * Stripe Connect account ids are `acct_` + 16 random base58 chars
 * (`acct_1NfXyZAbCd012345`). 40 is a defensive cap that fits Stripe's
 * current shape plus the prefix.
 */
export const PAYOUT_STRIPE_ACCOUNT_ID_MAX_LENGTH = 40;

/** Stripe webhook event id (`evt_*`). */
export const PAYOUT_STRIPE_EVENT_ID_MAX_LENGTH = 128;

/** ISO 3166-1 alpha-2 country code. */
export const PAYOUT_COUNTRY_CODE_LENGTH = 2;

/** ISO 4217 currency code (Phase 1: USD only — PRD §11.4). */
export const PAYOUT_CURRENCY_CODE_LENGTH = 3;

/** Onboarding redirect URLs (refresh + return) — cap at a safe URL length. */
export const PAYOUT_ONBOARDING_URL_MAX_LENGTH = 2_000;

/** Stripe `requirements.disabled_reason` and similar free-text strings. */
export const PAYOUT_DISABLED_REASON_MAX_LENGTH = 200;

/** Free-text capability/requirement key (`transfers`, `external_account`, …). */
export const PAYOUT_REQUIREMENT_KEY_MAX_LENGTH = 80;

/** Max keys in the requirements arrays — defensive against Stripe payload bloat. */
export const PAYOUT_REQUIREMENTS_MAX_ENTRIES = 50;

/** Pagination caps for admin list endpoints. */
export const PAYOUT_LIST_LIMIT_DEFAULT = 50;
export const PAYOUT_LIST_LIMIT_MAX = 200;

/** Stripe-emitted event payload cap (defensive — pruned to scalar fields server-side). */
export const PAYOUT_STRIPE_EVENT_PAYLOAD_MAX_BYTES = 32_000;

// ─── Enums ──────────────────────────────────────────────────────────────

/**
 * Onboarding lifecycle status for a `provider_payout_accounts` row.
 *
 *   - `pending_onboarding` — Stripe Express account exists but the
 *     provider has not completed the onboarding form. `details_submitted`
 *     is false; `charges_enabled` + `payouts_enabled` are false.
 *
 *   - `restricted` — Stripe accepted the onboarding details but flagged
 *     outstanding requirements (e.g. additional document upload).
 *     Disbursements blocked until cleared.
 *
 *   - `active` — Stripe says `charges_enabled` + `payouts_enabled` are
 *     true and no past-due requirements exist. Disbursements proceed.
 *
 *   - `disabled` — Stripe disabled the account (compliance failure,
 *     manual block, fraud detection). Disbursements halted; admin
 *     intervention required.
 */
export const PayoutAccountStatusSchema = z.enum([
  'pending_onboarding',
  'restricted',
  'active',
  'disabled',
]);
export type PayoutAccountStatus = z.infer<typeof PayoutAccountStatusSchema>;

/**
 * Stripe account-link `type` we mint. TS-090 supports onboarding +
 * update; future follow-ups (settings, KYC re-verification) can extend.
 */
export const PayoutAccountLinkKindSchema = z.enum(['account_onboarding', 'account_update']);
export type PayoutAccountLinkKind = z.infer<typeof PayoutAccountLinkKindSchema>;

// ─── Field schemas (re-used) ────────────────────────────────────────────

const ProviderIdSchema = z.string().min(1).max(PAYOUT_PROVIDER_ID_MAX_LENGTH);

/**
 * Country-code is a fixed 2-character upper-case ISO 3166-1 alpha-2.
 * Stripe Connect Express requires this at account creation. Phase 1
 * defaults to `US`; the schema accepts any 2-letter upper-case input so
 * the surface stays ready for future expansion.
 */
const CountryCodeSchema = z
  .string()
  .length(PAYOUT_COUNTRY_CODE_LENGTH)
  .regex(/^[A-Z]{2}$/, 'country must be a 2-letter ISO 3166-1 alpha-2 code (upper-case)');

/**
 * ISO 4217 currency. Phase 1 accepts only `USD` (PRD §11.4); the schema
 * is generic so the multi-currency Phase 3 surface (PDD §11.2) needs no
 * contract rewrite.
 */
const CurrencyCodeSchema = z
  .string()
  .length(PAYOUT_CURRENCY_CODE_LENGTH)
  .regex(/^[A-Z]{3}$/, 'currency must be a 3-letter ISO 4217 code (upper-case)');

/** Onboarding redirect URL — HTTPS only outside dev; we accept any URL here. */
const OnboardingUrlSchema = z
  .string()
  .url('onboarding redirect must be a valid URL')
  .max(PAYOUT_ONBOARDING_URL_MAX_LENGTH);

const RequirementKeySchema = z.string().min(1).max(PAYOUT_REQUIREMENT_KEY_MAX_LENGTH);

const RequirementsArraySchema = z.array(RequirementKeySchema).max(PAYOUT_REQUIREMENTS_MAX_ENTRIES);

// ─── Request schemas ────────────────────────────────────────────────────

/**
 * Provider self-service: create-or-fetch the Stripe Express account.
 *
 * Idempotent at the service layer — a provider may call this any number
 * of times and only receives one Stripe account. The optional `country`
 * defaults to `US` server-side.
 *
 * Body intentionally minimal: every other field (`email`, business
 * profile, etc.) is collected during the Stripe-hosted onboarding flow.
 */
export const CreateConnectAccountRequestSchema = z
  .object({
    country: CountryCodeSchema.optional(),
    defaultCurrency: CurrencyCodeSchema.optional(),
  })
  .strict();
export type CreateConnectAccountRequest = z.infer<typeof CreateConnectAccountRequestSchema>;

/**
 * Provider self-service: mint a fresh onboarding (or update) link.
 *
 * `refreshUrl` and `returnUrl` are the post-onboarding redirect targets
 * required by Stripe. The platform validates that they are HTTPS in
 * production at the controller layer (Phase 1: trust the contract cap).
 */
export const CreateAccountLinkRequestSchema = z
  .object({
    kind: PayoutAccountLinkKindSchema.optional(),
    refreshUrl: OnboardingUrlSchema,
    returnUrl: OnboardingUrlSchema,
  })
  .strict();
export type CreateAccountLinkRequest = z.infer<typeof CreateAccountLinkRequestSchema>;

/**
 * Internal: Stripe `account.updated` (and sibling) ingest. Service-
 * webhook hands the event off here after signature verification +
 * persistence in `stripe_processed_events` (TS-041a).
 *
 * `payload` carries the scalar fields the payouts service cares about
 * — `details_submitted`, `charges_enabled`, `payouts_enabled`,
 * `requirements.currently_due[]`, `requirements.past_due[]`,
 * `requirements.disabled_reason`. The full Stripe envelope is bigger;
 * the producer down-projects to this shape so the payouts schema isn't
 * coupled to Stripe SDK release notes.
 *
 * Idempotent on `stripeEventId` — a retry replays into the existing
 * `stripe_account_events` row without re-applying the state update.
 */
export const IngestStripeAccountEventRequestSchema = z
  .object({
    /** `evt_*` from Stripe — the dedup key. */
    stripeEventId: z.string().min(1).max(PAYOUT_STRIPE_EVENT_ID_MAX_LENGTH),
    /** Stripe event type — for now `account.updated` is the only consumer. */
    eventType: z.string().min(1).max(PAYOUT_REQUIREMENT_KEY_MAX_LENGTH),
    /** `acct_*` — the Stripe Connect account this event concerns. */
    stripeAccountId: z.string().min(1).max(PAYOUT_STRIPE_ACCOUNT_ID_MAX_LENGTH),
    /**
     * Wall-clock from Stripe (`event.created` UNIX). ISO 8601 string
     * for cross-service portability; the service stores it as
     * TIMESTAMPTZ.
     */
    occurredAt: z.string().datetime({ offset: true }),
    /** Down-projected scalar payload — only the fields the service mutates from. */
    payload: z
      .object({
        detailsSubmitted: z.boolean(),
        chargesEnabled: z.boolean(),
        payoutsEnabled: z.boolean(),
        disabledReason: z.string().max(PAYOUT_DISABLED_REASON_MAX_LENGTH).nullable().optional(),
        requirementsCurrentlyDue: RequirementsArraySchema.optional(),
        requirementsPastDue: RequirementsArraySchema.optional(),
        defaultCurrency: CurrencyCodeSchema.nullable().optional(),
      })
      .strict(),
  })
  .strict();
export type IngestStripeAccountEventRequest = z.infer<typeof IngestStripeAccountEventRequestSchema>;

// ─── Response schemas ───────────────────────────────────────────────────

/**
 * Outwards-facing payout-account state — visible to the provider on
 * their own account, and to admin on the admin surface. Stripe truth is
 * the authority; this is the local cache.
 */
export const PayoutAccountResponseSchema = z
  .object({
    providerId: ProviderIdSchema,
    stripeAccountId: z.string().min(1).max(PAYOUT_STRIPE_ACCOUNT_ID_MAX_LENGTH),
    country: CountryCodeSchema,
    defaultCurrency: CurrencyCodeSchema,
    status: PayoutAccountStatusSchema,
    chargesEnabled: z.boolean(),
    payoutsEnabled: z.boolean(),
    detailsSubmitted: z.boolean(),
    /** Whether the SDK is wired live (`true`) or running in stub mode (`false`). */
    liveMode: z.boolean(),
    requirementsCurrentlyDue: RequirementsArraySchema,
    requirementsPastDue: RequirementsArraySchema,
    disabledReason: z.string().max(PAYOUT_DISABLED_REASON_MAX_LENGTH).nullable(),
    createdAt: z.string().datetime({ offset: true }),
    updatedAt: z.string().datetime({ offset: true }),
  })
  .strict();
export type PayoutAccountResponse = z.infer<typeof PayoutAccountResponseSchema>;

/**
 * Response for `POST /payouts/me/connect-account` — wraps the account
 * with an `outcome` flag so the caller can distinguish a fresh create
 * from an idempotent echo (useful for analytics + dev tooling).
 */
export const CreateConnectAccountResponseSchema = z
  .object({
    outcome: z.enum(['created', 'existing']),
    account: PayoutAccountResponseSchema,
  })
  .strict();
export type CreateConnectAccountResponse = z.infer<typeof CreateConnectAccountResponseSchema>;

/**
 * Response for `POST /payouts/me/onboarding-link`. The URL is single-use
 * + short-lived (Stripe enforces this on the live side; stubs return a
 * deterministic `https://stub-onboarding.tasteandsee.example.com/<id>`).
 */
export const CreateAccountLinkResponseSchema = z
  .object({
    kind: PayoutAccountLinkKindSchema,
    url: OnboardingUrlSchema,
    expiresAt: z.string().datetime({ offset: true }),
    /** Whether the SDK is wired live (`true`) or running in stub mode (`false`). */
    liveMode: z.boolean(),
  })
  .strict();
export type CreateAccountLinkResponse = z.infer<typeof CreateAccountLinkResponseSchema>;

/**
 * Response for the internal `account.updated` ingest. `outcome` is
 * `applied` on first delivery, `replayed` on a same-`stripeEventId`
 * retry, or `ignored` when the event targets an unknown account (e.g.
 * the Stripe Connect account was deleted before the payouts service
 * had a chance to bind it to a provider).
 */
export const IngestStripeAccountEventResponseSchema = z
  .object({
    outcome: z.enum(['applied', 'replayed', 'ignored']),
    account: PayoutAccountResponseSchema.nullable(),
  })
  .strict();
export type IngestStripeAccountEventResponse = z.infer<
  typeof IngestStripeAccountEventResponseSchema
>;

// ─── Admin list / query schemas ─────────────────────────────────────────

/** Admin: list payout accounts with optional status filter + cursor pagination. */
export const ListPayoutAccountsQuerySchema = z
  .object({
    limit: z.coerce
      .number()
      .int()
      .positive()
      .max(PAYOUT_LIST_LIMIT_MAX)
      .default(PAYOUT_LIST_LIMIT_DEFAULT),
    status: PayoutAccountStatusSchema.optional(),
    cursor: z.string().min(1).max(256).optional(),
  })
  .strict();
export type ListPayoutAccountsQuery = z.infer<typeof ListPayoutAccountsQuerySchema>;

export const PayoutAccountsListResponseSchema = z
  .object({
    rows: z.array(PayoutAccountResponseSchema),
    nextCursor: z.string().min(1).max(256).nullable(),
  })
  .strict();
export type PayoutAccountsListResponse = z.infer<typeof PayoutAccountsListResponseSchema>;
