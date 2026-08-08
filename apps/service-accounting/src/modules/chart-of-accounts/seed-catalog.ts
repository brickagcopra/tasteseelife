/**
 * Phase-1 chart of accounts — the SaaS-standard chart seeded into
 * `accounting.chart_of_accounts` by `pnpm seed:chart-of-accounts`.
 *
 * Modelled on PDD §11.2 ("Chart of accounts with sub-accounts per
 * business line — subscription revenue per tier, marketplace
 * commission revenue, academy revenue, partnership revenue, refunds,
 * payment processing fees, payouts payable, deferred revenue, taxes
 * payable, etc.") + PDD Appendix A (sample journal entries name the
 * specific accounts each posting flow touches: Cash, Deferred Revenue,
 * Subscription Revenue per tier, Marketplace Revenue gross + contra,
 * Provider Payable, Coupon Discount, Refunds).
 *
 * **Numbering**. Standard SaaS chart conventions:
 *   - 1xxx — Assets
 *   - 2xxx — Liabilities
 *   - 3xxx — Equity
 *   - 4xxx — Revenue
 *   - 45xx / 46xx — Contra-revenue (Coupon Discount, Refunds)
 *   - 5xxx — Expenses
 *
 * **Sub-accounts use dot-notation** appended to the parent code:
 *   - `2000.family.tier2`  — Deferred Revenue → Tier 2 Companion Dining
 *   - `4000.family.tier2`  — Subscription Revenue → Tier 2
 *
 * The per-tier sub-accounts mirror the seven Phase-1 plans (PRD §5.1
 * Family Tier 1/2/3, §5.2 Provider Basic/Certified/Elite, §5.3
 * Academy Membership). Adding a plan ALSO adds the matching deferred-
 * revenue + subscription-revenue sub-accounts; the catalog stays in
 * step with the plans catalog manually for Phase 1, with a TS-080
 * follow-up to auto-derive once both catalogs are stable.
 *
 * **Normal-balance discipline**. Each entry pins its canonical
 * "increases on the [debit|credit] side":
 *   - asset           → debit
 *   - liability       → credit
 *   - equity          → credit
 *   - revenue         → credit
 *   - contra_revenue  → debit  (the EXCEPTION — debits this account
 *                                reduces gross revenue)
 *   - expense         → debit
 *
 * The TS-081 JournalPostingService will read `normalBalance` to compute
 * increase/decrease semantics. Hard-coding the value in the seed (and
 * making it `NOT NULL` in the schema) means the catalog itself is the
 * authority — application code that wants to flip the convention has
 * to flip it here, not silently in service logic.
 *
 * **Catalog is the source of truth, not application enums.** The
 * journal-posting service references accounts by their `code` (e.g.
 * looks up `1000` to resolve the Cash account id). The code constants
 * are NOT in application code as `as const` enums — that would create
 * a second source of truth that could drift from the database. Tests
 * load the seed and assert against the persisted catalog.
 *
 * **Why provider-tier subscription accounts ARE in the catalog.**
 * PRD §5.2 spells out three provider subscription tiers (Basic,
 * Certified, Elite). Their MRR contribution is reported separately
 * (PRD §10.3 dunning + churn analytics). Keeping a per-tier sub-account
 * is the right SaaS shape — and the marginal cost is one row each,
 * not a maintenance burden.
 */

export type SeedAccountType =
  | 'asset'
  | 'liability'
  | 'equity'
  | 'revenue'
  | 'contra_revenue'
  | 'expense';

export type SeedAccountNormalBalance = 'debit' | 'credit';

export interface SeedAccountEntry {
  readonly code: string;
  readonly name: string;
  readonly description: string;
  readonly type: SeedAccountType;
  readonly normalBalance: SeedAccountNormalBalance;
  /**
   * Stable code of the parent account, or `null` for a top-level
   * account. The seed resolves parent ids by looking up the persisted
   * row's id post-insert; parents are emitted BEFORE their children
   * in this catalog so a streaming insert never hits an unresolved
   * pointer.
   */
  readonly parentCode: string | null;
  readonly currency: 'USD';
  readonly active: boolean;
}

/**
 * The catalog. Order matters — parents come before children so the seed
 * function's single-pass insert can resolve `parent_id` from already-
 * inserted rows without buffering. The compile-time guard below
 * enforces that invariant.
 */
export const CHART_OF_ACCOUNTS_CATALOG: readonly SeedAccountEntry[] = [
  // ── Assets (1xxx) ────────────────────────────────────────────────────
  {
    code: '1000',
    name: 'Cash',
    description:
      'Cash held in operating bank accounts + Stripe balance. Increased by customer charges (subscription invoices, booking completions) and decreased by provider payouts + refunds + processing fees.',
    type: 'asset',
    normalBalance: 'debit',
    parentCode: null,
    currency: 'USD',
    active: true,
  },
  {
    code: '1100',
    name: 'Accounts Receivable',
    description:
      'Amounts owed by customers for issued-but-unpaid invoices. Used by future B2B / partner billing flows where invoices are sent and paid out-of-band of Stripe Checkout.',
    type: 'asset',
    normalBalance: 'debit',
    parentCode: null,
    currency: 'USD',
    active: true,
  },

  // ── Liabilities (2xxx) ───────────────────────────────────────────────
  // Deferred Revenue parent + per-plan sub-accounts. Subscription revenue
  // is recognised over the service period (CLAUDE.md §17.17); the cash
  // collected lands as a credit to Deferred Revenue and is amortised
  // into Subscription Revenue as the period elapses (TS-082).
  {
    code: '2000',
    name: 'Deferred Revenue',
    description:
      'Liability — subscription cash collected but not yet earned. Amortises into Subscription Revenue (4xxx) over the service period (CLAUDE.md §17.17). Per-plan sub-accounts (2000.family.tier1, 2000.family.tier2, ...) track per-tier remaining liability so a Tier-2 churn cohort report can be assembled from ledger primitives.',
    type: 'liability',
    normalBalance: 'credit',
    parentCode: null,
    currency: 'USD',
    active: true,
  },
  {
    code: '2000.family.tier1',
    name: 'Deferred Revenue — Family Tier 1 Essential',
    description:
      'Per-plan deferred revenue for `family.tier1` (PRD §5.1 Essential). Credited at charge time, debited (with offsetting credit to Subscription Revenue — Tier 1) as the period elapses.',
    type: 'liability',
    normalBalance: 'credit',
    parentCode: '2000',
    currency: 'USD',
    active: true,
  },
  {
    code: '2000.family.tier2',
    name: 'Deferred Revenue — Family Tier 2 Companion Dining',
    description: 'Per-plan deferred revenue for `family.tier2` (PRD §5.1 Companion Dining).',
    type: 'liability',
    normalBalance: 'credit',
    parentCode: '2000',
    currency: 'USD',
    active: true,
  },
  {
    code: '2000.family.tier3',
    name: 'Deferred Revenue — Family Tier 3 Concierge Lifestyle',
    description: 'Per-plan deferred revenue for `family.tier3` (PRD §5.1 Concierge Lifestyle).',
    type: 'liability',
    normalBalance: 'credit',
    parentCode: '2000',
    currency: 'USD',
    active: true,
  },
  {
    code: '2000.provider.basic',
    name: 'Deferred Revenue — Provider Basic',
    description: 'Per-plan deferred revenue for `provider.basic` (PRD §5.2 Basic Provider).',
    type: 'liability',
    normalBalance: 'credit',
    parentCode: '2000',
    currency: 'USD',
    active: true,
  },
  {
    code: '2000.provider.certified',
    name: 'Deferred Revenue — Provider Certified',
    description:
      'Per-plan deferred revenue for `provider.certified` (PRD §5.2 Certified Culinary Companion).',
    type: 'liability',
    normalBalance: 'credit',
    parentCode: '2000',
    currency: 'USD',
    active: true,
  },
  {
    code: '2000.provider.elite',
    name: 'Deferred Revenue — Provider Elite',
    description:
      'Per-plan deferred revenue for `provider.elite` (PRD §5.2 Elite Concierge Provider).',
    type: 'liability',
    normalBalance: 'credit',
    parentCode: '2000',
    currency: 'USD',
    active: true,
  },
  {
    code: '2000.academy.membership',
    name: 'Deferred Revenue — Academy Membership',
    description:
      'Per-plan deferred revenue for `academy.membership` (PRD §5.3 monthly Cooking Academy subscription).',
    type: 'liability',
    normalBalance: 'credit',
    parentCode: '2000',
    currency: 'USD',
    active: true,
  },

  // Provider payable + taxes payable. PDD Appendix A: booking-completion
  // postings credit Provider Payable (the provider portion of the gross
  // commission); the payout-disbursement posting debits Provider Payable
  // and credits Cash on the Stripe transfer success webhook.
  {
    code: '2100',
    name: 'Provider Payable',
    description:
      'Liability — amounts owed to providers for completed bookings, held until disbursement (T+2 schedule per PDD §11.3). Credited on booking completion, debited on Stripe transfer success.',
    type: 'liability',
    normalBalance: 'credit',
    parentCode: null,
    currency: 'USD',
    active: true,
  },
  {
    code: '2200',
    name: 'Taxes Payable',
    description:
      'Liability — sales / service taxes collected via Stripe Tax (PDD §11.1, §11.2), held until remittance. Credited at invoice time, debited on tax remittance.',
    type: 'liability',
    normalBalance: 'credit',
    parentCode: null,
    currency: 'USD',
    active: true,
  },

  // ── Equity (3xxx) ────────────────────────────────────────────────────
  {
    code: '3000',
    name: 'Retained Earnings',
    description:
      'Cumulative platform net income (revenue minus expenses) carried forward across closed periods. Updated by the period-close roll-up (TS-085).',
    type: 'equity',
    normalBalance: 'credit',
    parentCode: null,
    currency: 'USD',
    active: true,
  },

  // ── Revenue (4xxx) ───────────────────────────────────────────────────
  // Subscription revenue parent + per-plan sub-accounts mirroring the
  // deferred-revenue tree. Revenue is recognised over the service
  // period — the per-plan sub-accounts give finance the granularity to
  // report MRR / churn per plan tier.
  {
    code: '4000',
    name: 'Subscription Revenue',
    description:
      'Recognised subscription revenue, amortised from Deferred Revenue (2000) over the service period (CLAUDE.md §17.17). Per-plan sub-accounts mirror the seven Phase-1 plans.',
    type: 'revenue',
    normalBalance: 'credit',
    parentCode: null,
    currency: 'USD',
    active: true,
  },
  {
    code: '4000.family.tier1',
    name: 'Subscription Revenue — Family Tier 1 Essential',
    description:
      'Recognised revenue for `family.tier1` subscriptions. Drives Tier-1 MRR + ARR roll-ups.',
    type: 'revenue',
    normalBalance: 'credit',
    parentCode: '4000',
    currency: 'USD',
    active: true,
  },
  {
    code: '4000.family.tier2',
    name: 'Subscription Revenue — Family Tier 2 Companion Dining',
    description: 'Recognised revenue for `family.tier2` subscriptions.',
    type: 'revenue',
    normalBalance: 'credit',
    parentCode: '4000',
    currency: 'USD',
    active: true,
  },
  {
    code: '4000.family.tier3',
    name: 'Subscription Revenue — Family Tier 3 Concierge Lifestyle',
    description:
      'Recognised revenue for `family.tier3` subscriptions. The flagship Upper-East-Side concierge tier.',
    type: 'revenue',
    normalBalance: 'credit',
    parentCode: '4000',
    currency: 'USD',
    active: true,
  },
  {
    code: '4000.provider.basic',
    name: 'Subscription Revenue — Provider Basic',
    description: 'Recognised revenue for `provider.basic` subscriptions.',
    type: 'revenue',
    normalBalance: 'credit',
    parentCode: '4000',
    currency: 'USD',
    active: true,
  },
  {
    code: '4000.provider.certified',
    name: 'Subscription Revenue — Provider Certified',
    description: 'Recognised revenue for `provider.certified` subscriptions.',
    type: 'revenue',
    normalBalance: 'credit',
    parentCode: '4000',
    currency: 'USD',
    active: true,
  },
  {
    code: '4000.provider.elite',
    name: 'Subscription Revenue — Provider Elite',
    description: 'Recognised revenue for `provider.elite` subscriptions.',
    type: 'revenue',
    normalBalance: 'credit',
    parentCode: '4000',
    currency: 'USD',
    active: true,
  },
  {
    code: '4000.academy.membership',
    name: 'Subscription Revenue — Academy Membership',
    description: 'Recognised revenue for `academy.membership` subscriptions.',
    type: 'revenue',
    normalBalance: 'credit',
    parentCode: '4000',
    currency: 'USD',
    active: true,
  },

  // Marketplace revenue — booking commission. PDD Appendix A:
  //   booking completed ($150, 20% commission):
  //     DR Cash $150 / CR Marketplace Revenue $150       (gross)
  //     DR Marketplace Revenue $120 / CR Provider Payable $120 (contra)
  // The marketplace tree carries gross at parent; the contra entry hits
  // the same account (which is fine — the trial balance nets to the
  // 20% net) but keeping a dedicated "Marketplace Revenue Contra"
  // sub-account lets finance report gross GMV and net revenue
  // independently. Keep it as a SUB of contra-revenue (45xx) so the
  // income statement carves gross from net cleanly.
  {
    code: '4100',
    name: 'Marketplace Revenue',
    description:
      'Gross merchandise value (GMV) of completed bookings — the full amount the customer pays. Per PDD §9.2 + Appendix A, the customer-paid amount lands here, and the provider portion (typically 70–90% by tier) is immediately reclassified to Provider Payable via the contra entry in 4500.marketplace-contra.',
    type: 'revenue',
    normalBalance: 'credit',
    parentCode: null,
    currency: 'USD',
    active: true,
  },
  {
    code: '4200',
    name: 'Academy Revenue',
    description:
      'One-time Cooking Academy product revenue — online certification + elite in-person certification fees (PRD §5.3). The monthly Academy MEMBERSHIP is in 4000.academy.membership (recurring subscription); this account covers the one-shot certifications.',
    type: 'revenue',
    normalBalance: 'credit',
    parentCode: null,
    currency: 'USD',
    active: true,
  },
  {
    code: '4300',
    name: 'Partnership Revenue',
    description:
      'Enterprise / partnership revenue — luxury-residence per-building licensing, corporate caregiver benefit programs, healthcare partnerships (MLTC, Medicare Advantage, hospital discharge), and adult-day-care subscription bundles (PRD §5.5).',
    type: 'revenue',
    normalBalance: 'credit',
    parentCode: null,
    currency: 'USD',
    active: true,
  },

  // ── Contra-revenue (45xx / 46xx) ─────────────────────────────────────
  // The contra-revenue tree carries debit-balanced accounts that REDUCE
  // gross revenue. Each is its own top-level (no parent under 4xxx)
  // because finance reports gross vs. net independently — Coupon
  // Discount and Refunds shouldn't be netted against Subscription
  // Revenue at the sub-account level.
  {
    code: '4500',
    name: 'Marketplace Revenue Contra (Provider Portion)',
    description:
      'Contra-revenue — the provider portion of marketplace bookings, reclassified out of gross Marketplace Revenue (4100) into Provider Payable (2100) at booking-completion time. Debit balance — increases reduce gross revenue.',
    type: 'contra_revenue',
    normalBalance: 'debit',
    parentCode: null,
    currency: 'USD',
    active: true,
  },
  {
    code: '4510',
    name: 'Coupon Discount',
    description:
      'Contra-revenue — coupon redemptions applied to subscription + booking invoices (PDD Appendix A: "Coupon $50 applied to invoice → DR Coupon Discount $50 / CR Subscription Revenue $50"). Tracks promotional discount cost separately from gross revenue.',
    type: 'contra_revenue',
    normalBalance: 'debit',
    parentCode: null,
    currency: 'USD',
    active: true,
  },
  {
    code: '4520',
    name: 'Refunds',
    description:
      'Contra-revenue — customer refunds (full or partial). Per PDD Appendix A: "Refund issued $99 → DR Subscription Revenue $99 / CR Cash $99". Phase 1 lumps refunds at the parent; per-tier sub-accounts can land later if churn analytics need them.',
    type: 'contra_revenue',
    normalBalance: 'debit',
    parentCode: null,
    currency: 'USD',
    active: true,
  },

  // ── Expenses (5xxx) ──────────────────────────────────────────────────
  {
    code: '5000',
    name: 'Payment Processing Fees',
    description:
      'Stripe processing fees on subscription charges + booking completions (typically 2.9% + 30¢ per Stripe). Debited when the Stripe webhook surfaces the per-charge fee.',
    type: 'expense',
    normalBalance: 'debit',
    parentCode: null,
    currency: 'USD',
    active: true,
  },
  {
    code: '5100',
    name: 'Provider Payout Fees',
    description:
      'Stripe Connect Express payout fees — the per-payout cost of disbursing the Provider Payable balance to a provider connected account.',
    type: 'expense',
    normalBalance: 'debit',
    parentCode: null,
    currency: 'USD',
    active: true,
  },
];

/**
 * Compile-time guards.
 *   1. No duplicate `code` values.
 *   2. Parent comes BEFORE child (single-pass seed contract).
 *   3. Every non-null `parentCode` resolves inside this catalog.
 *
 * Run at module-load time so a mis-ordered catalog never reaches the seed.
 */
const seenCodes = new Set<string>();
for (const entry of CHART_OF_ACCOUNTS_CATALOG) {
  if (seenCodes.has(entry.code)) {
    throw new Error(`CHART_OF_ACCOUNTS_CATALOG duplicate code: ${entry.code}`);
  }
  if (entry.parentCode !== null && !seenCodes.has(entry.parentCode)) {
    throw new Error(
      `CHART_OF_ACCOUNTS_CATALOG entry ${entry.code} references parent ${entry.parentCode} which has not been declared yet (order matters)`,
    );
  }
  seenCodes.add(entry.code);
}
