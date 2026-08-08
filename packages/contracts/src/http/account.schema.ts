import { z } from 'zod';

/**
 * Chart-of-accounts contracts (PDD §11.2 + Appendix A).
 *
 * The accounting service ships a read-only `GET /api/v1/accounts`
 * catalog endpoint at TS-080; the journal-posting + reporting +
 * period-close write surfaces land as TS-081..TS-085 follow-ups.
 *
 * Money values DO NOT appear on these schemas — the chart of accounts
 * is metadata, not balances. Balance / trial-balance schemas land
 * separately when the reporting endpoints arrive.
 *
 * Why a separate enum from the Prisma generated type. The contracts
 * package is the source of truth for the wire shape; consuming
 * services (admin tooling, future BI exports) import from
 * `@taste-and-see/contracts` and never reach into the Prisma client.
 * The Prisma enum is generated from the same canonical list (via the
 * schema.prisma), so they cannot drift in practice — and the
 * contract-side test loop verifies the names match.
 */

/**
 * Top-level account category. Mirrors `accounting.account_type`:
 *
 * - `asset` — Cash, Accounts Receivable.
 * - `liability` — Deferred Revenue, Provider Payable, Taxes Payable.
 * - `equity` — Retained Earnings.
 * - `revenue` — Subscription Revenue, Marketplace Revenue, Academy,
 *   Partnership.
 * - `contra_revenue` — Coupon Discount, Refunds, Marketplace Contra.
 * - `expense` — Payment Processing Fees, Provider Payout Fees.
 *
 * Adding a new variant is a breaking-but-explicit contract change.
 */
export const AccountTypeSchema = z.enum([
  'asset',
  'liability',
  'equity',
  'revenue',
  'contra_revenue',
  'expense',
]);
export type AccountType = z.infer<typeof AccountTypeSchema>;

/**
 * The "natural" side that **increases** the account's balance. Standard
 * accounting convention:
 *
 *   asset           → debit
 *   liability       → credit
 *   equity          → credit
 *   revenue         → credit
 *   contra_revenue  → debit  (exception — reduces revenue)
 *   expense         → debit
 *
 * The catalog pins the correct value per account; the contract is the
 * tight enum.
 */
export const AccountNormalBalanceSchema = z.enum(['debit', 'credit']);
export type AccountNormalBalance = z.infer<typeof AccountNormalBalanceSchema>;

/**
 * Currency code. Single-currency at launch (USD); enum-shaped so
 * adding new currencies in Phase 3 is a breaking-but-explicit contract
 * change. Mirrors `PlanCurrencySchema`.
 */
export const AccountCurrencySchema = z.enum(['USD']);
export type AccountCurrency = z.infer<typeof AccountCurrencySchema>;

/**
 * The stable accounting code regex — lower-case digits + dot/dash
 * sub-account notation. Top-level entries are bare four-digit strings
 * (`1000`, `2100`); sub-accounts use dot-notation (`4000.family.tier2`).
 *
 * The regex matches the SaaS-standard four-digit-prefix shape but
 * does NOT enforce category-by-leading-digit (4xxx = revenue) at the
 * contract layer — the catalog is the authority for `type`. A future
 * one-off code (`misc.adjustment`) lands without contract churn.
 */
export const ACCOUNT_CODE_REGEX = /^[a-z0-9][a-z0-9._-]*$/;
export const ACCOUNT_CODE_MAX_LENGTH = 64;
export const ACCOUNT_NAME_MAX_LENGTH = 200;
export const ACCOUNT_DESCRIPTION_MAX_LENGTH = 2000;

export const AccountCodeSchema = z
  .string()
  .min(1)
  .max(ACCOUNT_CODE_MAX_LENGTH)
  .regex(
    ACCOUNT_CODE_REGEX,
    'must be lower-case alphanumeric with dot/dash sub-account notation (e.g. "4000.family.tier2")',
  );

/**
 * Chart-of-accounts entry DTO.
 *
 * `parentId` is the id of the parent account (or `null` for top-level
 * entries) — clients render the chart as a tree by grouping on
 * `parentId`. The id (not the parent code) is the canonical pointer
 * because the id is immutable while a code could in theory be
 * adjusted by ops via admin tooling (TS-127 adds the surface; today
 * codes are stable).
 *
 * `.strict()` rejects unknown fields at parse time.
 */
export const AccountSchema = z
  .object({
    id: z.string().min(1).max(64),
    code: AccountCodeSchema,
    name: z.string().min(1).max(ACCOUNT_NAME_MAX_LENGTH),
    description: z.string().max(ACCOUNT_DESCRIPTION_MAX_LENGTH).optional(),
    type: AccountTypeSchema,
    parentId: z.string().min(1).max(64).nullable(),
    normalBalance: AccountNormalBalanceSchema,
    currency: AccountCurrencySchema.default('USD'),
    active: z.boolean(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .strict();
export type Account = z.infer<typeof AccountSchema>;

/**
 * Response body for `GET /api/v1/accounts`.
 *
 * Wrapped in `{ accounts: [...] }` rather than a bare array so the
 * response shape is forward-compatible with future pagination metadata
 * + summary roll-ups, neither of which we want to introduce as a
 * breaking v1 change.
 *
 * `.strict()` rejects unknown top-level fields. Service consumers that
 * support a future field set must opt in with a contract change, not
 * by silently accepting drift.
 */
export const AccountsListResponseSchema = z
  .object({
    accounts: z.array(AccountSchema),
  })
  .strict();
export type AccountsListResponse = z.infer<typeof AccountsListResponseSchema>;

/**
 * Query filter for `GET /api/v1/accounts`.
 *
 * - `type` — optional. Narrow to a single category (`asset`,
 *   `revenue`, ...).
 * - `parentId` — optional. Narrow to the children of one parent
 *   account. The literal string `'null'` (case-insensitive) returns
 *   only top-level entries; otherwise the value is treated as the
 *   parent's id.
 * - `activeOnly` — optional. Default `true` so admin consoles don't
 *   accidentally display retired accounts. Pass `false` to include
 *   inactive rows (the admin "retired accounts" view).
 *
 * `.strict()` ensures unknown query params are rejected at parse time.
 */
export const ListAccountsQuerySchema = z
  .object({
    type: AccountTypeSchema.optional(),
    parentId: z.string().min(1).max(64).optional(),
    activeOnly: z
      .union([z.literal('true'), z.literal('false')])
      .optional()
      .transform((v) => v === undefined || v === 'true'),
  })
  .strict();
export type ListAccountsQuery = z.infer<typeof ListAccountsQuerySchema>;
