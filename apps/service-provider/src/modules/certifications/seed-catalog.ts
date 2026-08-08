/**
 * Phase-1 certification catalog — the canonical credentials seeded
 * into `provider.certifications` by `pnpm seed:certifications`
 * (TS-052).
 *
 * **What lives here**. The four credentials Taste & See recognises in
 * Phase 1. Two of them gate marketplace tier (PRD §5.2 / PDD §15.2);
 * the other two are specialty credentials surfaced on the family-
 * portal search filters but not gating tier.
 *
 *   | code                | name                              | validity | gates tier      |
 *   |---------------------|-----------------------------------|----------|-----------------|
 *   | ccc                 | Certified Culinary Companion      | 24 mo    | certified       |
 *   | ecc                 | Elite Concierge Provider          | 24 mo    | elite (+ ccc)   |
 *   | dementia_sensitive  | Dementia-Sensitive Dining         | 36 mo    | —               |
 *   | therapeutic_meals   | Therapeutic Meals                 | 36 mo    | —               |
 *
 * **Renewal cadence**. PRD §9.3 calls for 24-month renewal on the
 * core academy certifications and 36-month on specialty tracks. The
 * `default_validity_months` here is the *default* — admin tooling can
 * override per-grant for special cases.
 *
 * **`code` vocabulary**. Lower-snake_case, stable forever. The
 * tier-promotion service (`TierPromotionService`) hard-codes
 * references to `ccc` and `ecc` — those two codes carry semantic
 * weight beyond the seed. To retire a gate cert, ship a follow-up
 * task that renames the rule first, then the catalog can flip
 * `active = false`.
 *
 * **One-time Academy purchase products** (Online Certification
 * $297–$997, Elite In-Person Certification $2,000–$5,000+ per PRD
 * §5.3) are intentionally NOT in this catalog — those are course
 * purchase products and live in `service-academy` (TS-250). The
 * *credential* a course produces lives here; the *purchase* lives
 * there.
 */
export interface SeedCertificationEntry {
  readonly code: string;
  readonly name: string;
  readonly description: string;
  readonly issuer: string;
  readonly defaultValidityMonths: number | null;
  readonly sortPosition: number;
  readonly active: boolean;
}

/**
 * Catalog literal. The TierPromotionService references the `ccc` /
 * `ecc` codes by name; renaming either is a coordinated change.
 */
export const CERTIFICATION_CATALOG: readonly SeedCertificationEntry[] = [
  {
    code: 'ccc',
    name: 'Certified Culinary Companion',
    description:
      'Core Taste & See Cooking Academy credential. Covers companion dining ' +
      'fundamentals, hospitality posture, dietary literacy, and the platform ' +
      'standards every provider serving Tier 2 households is expected to hold.',
    issuer: 'Taste & See Cooking Academy',
    defaultValidityMonths: 24,
    sortPosition: 0,
    active: true,
  },
  {
    code: 'ecc',
    name: 'Elite Concierge Provider',
    description:
      'Advanced credential gating eligibility to serve Concierge Lifestyle ' +
      '(Tier 3) households. Builds on the CCC core with luxury-tier ' +
      'hospitality, event dining, multi-course service, and the elevated ' +
      'standards Concierge Lifestyle families expect.',
    issuer: 'Taste & See Cooking Academy',
    defaultValidityMonths: 24,
    sortPosition: 1,
    active: true,
  },
  {
    code: 'dementia_sensitive',
    name: 'Dementia-Sensitive Dining',
    description:
      'Specialty credential covering dementia-aware meal planning, mealtime ' +
      'cues, and communication patterns appropriate for households where one ' +
      'or more seniors lives with cognitive impairment.',
    issuer: 'Taste & See Cooking Academy',
    defaultValidityMonths: 36,
    sortPosition: 2,
    active: true,
  },
  {
    code: 'therapeutic_meals',
    name: 'Therapeutic Meals',
    description:
      'Specialty credential covering therapeutic dietary patterns — renal, ' +
      'diabetic, low-sodium, cardiac, and oncology-supportive meal planning.',
    issuer: 'Taste & See Cooking Academy',
    defaultValidityMonths: 36,
    sortPosition: 3,
    active: true,
  },
] as const;

/**
 * Compile-time guard against a duplicate `code` landing in the
 * catalog. The seed itself is idempotent on `code`, but a duplicate
 * here would silently let one entry overwrite another.
 */
const seenCodes = new Set<string>();
for (const entry of CERTIFICATION_CATALOG) {
  if (seenCodes.has(entry.code)) {
    throw new Error(`CERTIFICATION_CATALOG duplicate code: ${entry.code}`);
  }
  seenCodes.add(entry.code);
}

/**
 * The two codes that gate tier promotion. Re-exported so the
 * tier-promotion service and the unit tests share a single source.
 */
export const CERTIFIED_TIER_CODE = 'ccc' as const;
export const ELITE_TIER_CODE = 'ecc' as const;
