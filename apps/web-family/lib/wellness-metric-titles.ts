import type { WellnessTrendMetric } from '@taste-and-see/contracts';

/**
 * Warm, non-clinical titles for the four wellness scales (CLAUDE.md §12 —
 * "hospitality, not clinical"). A pure data module (no `next/headers`),
 * so it is safe to import from both server components (the wellness page
 * + its early-signal banner, TS-236) and client components (the TS-231
 * sparklines). The per-level axis labels are derived from the ordinal
 * enum directly elsewhere, so they never drift from the contract.
 */
export const WELLNESS_METRIC_TITLE: Record<WellnessTrendMetric, string> = {
  mood: 'Spirits',
  appetite: 'Appetite',
  hydration: 'Hydration',
  social_engagement: 'Company',
};
