import type { AdTargetingAudience } from '@taste-and-see/contracts';

/**
 * Derive the ad-targeting audience (the TS-273 grammar) that the
 * sponsored-listings resolve (TS-218a) evaluates a viewer against for a
 * provider-search query.
 *
 * **Phase 1 is deliberately minimal — and fail-closed.** service-search holds
 * none of the targeting dimensions locally: persona, subscription tier,
 * household region, and behaviour cohorts all live in other bounded contexts
 * (service-identity / service-subscription / service-household /
 * service-analytics), and reaching them is a cross-service read this query
 * path does not (yet) make (CLAUDE.md §2.3). So every single-valued dimension
 * is left UNKNOWN (null) and the cohort set empty.
 *
 * The targeting evaluator treats an unknown dimension as fail-closed for
 * inclusion rules (`any_of` / `all_of` on a null dimension does NOT match —
 * the viewer is not provably in the targeted set) and pass for exclusion
 * (`none_of`). The practical Phase-1 effect: only UNtargeted campaigns (no
 * rules) deliver a sponsored slot, and a mis-targeted ad can never be shown
 * to the wrong viewer. Enriching the audience — persona from the actor's
 * role, tier from service-subscription, region from the household — is the
 * carved TS-218b-followup; it is a strict widening of reach that needs no
 * contract change (the audience shape already carries every dimension).
 */
export function deriveSearchAudience(): AdTargetingAudience {
  return { behaviorCohorts: [] };
}
