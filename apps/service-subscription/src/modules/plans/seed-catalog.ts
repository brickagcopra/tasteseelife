import Decimal from 'decimal.js';

/**
 * Phase-1 plan catalog — the canonical seven plans seeded into
 * `subscription.plans` by `pnpm seed:plans`.
 *
 * **Pricing rationale.** PRD §5 gives a price range per tier (e.g. Tier 1
 * "$29–$99/mo"); the platform actively explores its pricing in Year 1, so
 * the seed picks the **bottom of each range** as the canonical starting
 * price. Ops can override at any time via admin tooling (TS-127) or a
 * direct catalog edit — the seed function is idempotent on `code`, so a
 * rerun against a hand-edited row only touches the columns explicitly
 * named in the `update` clause.
 *
 *   | code                  | name                                       | monthly | annual  | source              |
 *   |-----------------------|--------------------------------------------|---------|---------|---------------------|
 *   | family.tier1          | Essential                                  | $29     | $290    | PRD §5.1            |
 *   | family.tier2          | Companion Dining                           | $199    | $1,990  | PRD §5.1            |
 *   | family.tier3          | Concierge Lifestyle                        | $1,000  | $10,000 | PRD §5.1            |
 *   | provider.basic        | Basic Provider                             | $29     | $290    | PRD §5.2            |
 *   | provider.certified    | Certified Culinary Companion               | $99     | $990    | PRD §5.2            |
 *   | provider.elite        | Elite Concierge Provider                   | $199    | $1,990  | PRD §5.2            |
 *   | academy.membership    | Academy Membership                         | $49     | $490    | PRD §5.3            |
 *
 * **Annual discount convention.** Every plan ships at `annual = monthly * 10`
 * (i.e. "two months free" — the SaaS industry convention). Bespoke
 * per-tier discounts can be set by ops at any time; the seed only
 * provides the starting point.
 *
 * **`code` vocabulary.** Two-segment dot-notation:
 *   - `family.tierN`              — family/senior membership tiers
 *   - `provider.basic|certified|elite` — chef/caregiver subscription tiers
 *   - `academy.membership`        — Cooking Academy monthly membership
 *
 * The code is the stable identifier referenced by `subscription.activated`
 * event payloads, accounting reports, and customer-facing receipts.
 * **Codes are stable forever** — if a plan needs a new identity, retire
 * the old one (`active = false`) and create a new code.
 *
 * **Sort position.** Within each customer_group:
 *   - family:    Tier 1 (0) → Tier 2 (1) → Tier 3 (2)
 *   - provider:  Basic (0)  → Certified (1) → Elite (2)
 *   - academy:   Membership (0)
 *
 * **One-time Academy products** (Online Certification $297–$997 and
 * Elite In-Person Certification $2,000–$5,000+ per PRD §5.3) are
 * intentionally NOT in the plan catalog — those are one-shot purchases
 * with a separate product model. A `service-academy` (TS-250) will own
 * the one-time-product catalog when it lands.
 *
 * **Cooking Academy Online Certification not in catalog.** Same reason:
 * one-time purchase, not a recurring subscription. The Academy
 * Membership tier IS in the catalog because PRD §5.3 prices it as
 * `$49-$199/mo` — a recurring subscription.
 */
export interface SeedPlanEntry {
  readonly code: string;
  readonly name: string;
  readonly description: string;
  readonly customerGroup: 'family' | 'provider' | 'academy';
  readonly monthlyPrice: Decimal;
  readonly annualPrice: Decimal;
  readonly currency: 'USD';
  readonly features: readonly string[];
  readonly active: boolean;
  readonly sortPosition: number;
}

const usd = (value: string): Decimal => new Decimal(value);

export const PLAN_CATALOG: readonly SeedPlanEntry[] = [
  // ── Family / Senior membership tiers (PRD §5.1) ──────────────────────
  {
    code: 'family.tier1',
    name: 'Essential',
    description:
      'Mass-market base for families and seniors — app access, family dashboard, wellness resources, the memory meal library, monthly wellness check-ins, and booking access at standard rates.',
    customerGroup: 'family',
    monthlyPrice: usd('29.00'),
    annualPrice: usd('290.00'),
    currency: 'USD',
    features: [
      'App access',
      'Family dashboard',
      'Memory meal library',
      'Cultural recipe collections',
      'Companion messaging',
      'Standard booking access',
      'Monthly wellness check-ins',
    ],
    active: true,
    sortPosition: 0,
  },
  {
    code: 'family.tier2',
    name: 'Companion Dining',
    description:
      'Sweet-spot middle market — monthly companion dining sessions, priority scheduling, grocery coordination, meal planning, wellness summaries, and virtual family meal video connections.',
    customerGroup: 'family',
    monthlyPrice: usd('199.00'),
    annualPrice: usd('1990.00'),
    currency: 'USD',
    features: [
      'Monthly companion dining sessions',
      'Chef visits',
      'Priority scheduling',
      'Grocery coordination',
      'Meal planning',
      'Wellness summaries',
      'Virtual family meal video connection',
    ],
    active: true,
    sortPosition: 1,
  },
  {
    code: 'family.tier3',
    name: 'Concierge Lifestyle',
    description:
      'White-glove concierge tier — dedicated culinary concierge, weekly chef visits, transportation coordination, social outings, wellness support, event dining, family updates, and emergency concierge assistance.',
    customerGroup: 'family',
    monthlyPrice: usd('1000.00'),
    annualPrice: usd('10000.00'),
    currency: 'USD',
    features: [
      'Dedicated culinary concierge',
      'Weekly chef visits',
      'Transportation coordination',
      'Social outings',
      'Wellness support',
      'Event dining',
      'Family updates',
      'Emergency concierge assistance',
    ],
    active: true,
    sortPosition: 2,
  },

  // ── Chef / caregiver provider subscription tiers (PRD §5.2) ──────────
  {
    code: 'provider.basic',
    name: 'Basic Provider',
    description:
      'Entry tier for chefs and caregivers — profile listing, booking access, messaging, and the standard commission rate (30%).',
    customerGroup: 'provider',
    monthlyPrice: usd('29.00'),
    annualPrice: usd('290.00'),
    currency: 'USD',
    features: ['Profile listing', 'Booking access', 'Messaging', 'Standard commission rate'],
    active: true,
    sortPosition: 0,
  },
  {
    code: 'provider.certified',
    name: 'Certified Culinary Companion',
    description:
      'Premium tier for providers who hold the Certified Culinary Companion credential — featured placement, marketing co-op support, training access, and a reduced commission rate (20%).',
    customerGroup: 'provider',
    monthlyPrice: usd('99.00'),
    annualPrice: usd('990.00'),
    currency: 'USD',
    features: [
      'Premium listing',
      'Taste & See certification badge',
      'Training access',
      'Featured placement',
      'Marketing co-op support',
      'Reduced commission (20%)',
    ],
    active: true,
    sortPosition: 1,
  },
  {
    code: 'provider.elite',
    name: 'Elite Concierge Provider',
    description:
      'Top tier for providers eligible to serve Concierge Lifestyle (Tier 3) households — luxury client access, advanced certifications, branding support, priority referrals, and the lowest commission rate (10%).',
    customerGroup: 'provider',
    monthlyPrice: usd('199.00'),
    annualPrice: usd('1990.00'),
    currency: 'USD',
    features: [
      'Luxury client access',
      'Advanced certifications',
      'Concierge tier placements',
      'Priority referrals',
      'Branding support',
      'Lowest commission rate (10%)',
    ],
    active: true,
    sortPosition: 2,
  },

  // ── Cooking Academy membership (PRD §5.3) ────────────────────────────
  {
    code: 'academy.membership',
    name: 'Academy Membership',
    description:
      'Monthly Cooking Academy subscription — access to the continuing-education library, live webinars and replays, the alumni networking directory, and members-only events.',
    customerGroup: 'academy',
    monthlyPrice: usd('49.00'),
    annualPrice: usd('490.00'),
    currency: 'USD',
    features: [
      'Continuing education library',
      'Live webinars and replays',
      'Alumni networking directory',
      'Members-only events',
    ],
    active: true,
    sortPosition: 0,
  },
] as const;

/**
 * Compile-time guard against duplicate `code` values landing in the
 * catalog. The seed itself is idempotent on `code`, but a duplicate
 * here would silently let one entry overwrite another — better caught
 * at module-load time than in the seed run.
 */
const seenCodes = new Set<string>();
for (const entry of PLAN_CATALOG) {
  if (seenCodes.has(entry.code)) {
    throw new Error(`PLAN_CATALOG duplicate code: ${entry.code}`);
  }
  seenCodes.add(entry.code);
}
