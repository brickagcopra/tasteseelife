/**
 * Phase-1 provider tier catalog snapshot (TS-122).
 *
 * Mirrors `apps/web-family/lib/plans.ts` — the full plan catalog lives
 * in `service-subscription` and is fetched via `GET /api/v1/plans`
 * (which the gateway proxies). The signup surface, however, runs BEFORE
 * the user is authenticated — and the gateway gates `/plans` on a
 * Bearer token. Rather than open the plans endpoint to anonymous
 * callers (a change that ripples to the service-subscription contract),
 * the provider-portal signup page reads from this small in-app
 * snapshot.
 *
 * The three plan codes here are the canonical codes seeded by
 * `service-subscription`'s `seedPlanCatalog` (PRD §5.2; see
 * `apps/service-subscription/src/modules/plans/seed-catalog.ts`):
 * `provider.basic`, `provider.certified`, `provider.elite`. Drift risk
 * is bounded — seed-catalog is the source of truth that the snapshot
 * mirrors. A TS-122 follow-up retires the snapshot once the gateway
 * grows a public-plans surface (same retirement path as TS-121-followup-4).
 *
 * "Elite" is the only Phase-1 tier eligible to serve Concierge Lifestyle
 * (Tier 3) clients (PRD §5.4 + CLAUDE.md §12 "Provider tier gating").
 * That gating is enforced at the booking-svc layer, not here — the
 * picker just exposes the tier; the back-end enforces the matchmaking
 * rules.
 */

export interface ProviderTierOption {
  readonly code: 'provider.basic' | 'provider.certified' | 'provider.elite';
  readonly name: string;
  readonly monthlyPriceLabel: string;
  readonly description: string;
}

export const PROVIDER_TIER_OPTIONS: readonly ProviderTierOption[] = [
  {
    code: 'provider.basic',
    name: 'Basic Provider',
    monthlyPriceLabel: '$29 / month',
    description:
      'Profile listing, booking access, in-app messaging, and the standard commission — the entry tier for chefs and caregivers joining the marketplace.',
  },
  {
    code: 'provider.certified',
    name: 'Certified Culinary Companion',
    monthlyPriceLabel: '$99 / month',
    description:
      'Premium listing with the Certified Culinary Companion badge, featured placement, training access, marketing co-op support, and a reduced commission rate.',
  },
  {
    code: 'provider.elite',
    name: 'Elite Concierge Provider',
    monthlyPriceLabel: '$199 / month',
    description:
      'Luxury client access for Concierge Lifestyle households, advanced certifications, branding support, priority referrals, and our lowest commission rate.',
  },
];
