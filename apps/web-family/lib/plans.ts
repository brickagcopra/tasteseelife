/**
 * Phase-1 plan catalog snapshot (TS-121).
 *
 * The full plan catalog lives in `service-subscription` and is fetched
 * via `GET /api/v1/plans` (which the gateway proxies). The signup
 * surface, however, runs BEFORE the user is authenticated — and the
 * gateway gates `/plans` on a Bearer token. Rather than open the plans
 * endpoint to anonymous callers (a change that ripples to the
 * service-subscription contract), the family-portal signup page reads
 * from this small in-app snapshot.
 *
 * The snapshot is intentionally narrow — only the two consumer-facing
 * PRD §5.1 tiers families pick during signup. Tier 3 Concierge
 * Lifestyle is a Tier-3-only on-boarding path (handled by ops + the
 * concierge ops console, TS-220), not a self-serve signup option. The
 * catalog endpoint remains the source of truth for everything else
 * (admin tooling, the dashboard's "current plan" display, future
 * upgrade flows).
 *
 * Drift risk: when `service-subscription`'s plans catalog changes the
 * Phase-1 prices, this snapshot needs to stay in step. Captured as a
 * TS-121 follow-up — once the gateway grows a public-plans surface,
 * the snapshot retires.
 */

export interface FamilyTierOption {
  readonly code: 'family.tier1' | 'family.tier2';
  readonly name: string;
  readonly monthlyPriceLabel: string;
  readonly description: string;
}

export const FAMILY_TIER_OPTIONS: readonly FamilyTierOption[] = [
  {
    code: 'family.tier1',
    name: 'Essential',
    monthlyPriceLabel: '$29 / month',
    description:
      'App access, wellness resources, family dashboard, monthly check-ins, and our memory-meal library — the warm baseline.',
  },
  {
    code: 'family.tier2',
    name: 'Companion Dining',
    monthlyPriceLabel: '$199 / month',
    description:
      'Monthly companion-dining sessions with a trained chef, priority scheduling, grocery coordination, and wellness summaries delivered to the family.',
  },
];
