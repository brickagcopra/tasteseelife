import { z } from 'zod';

import { ProviderDiscoveryDocumentSchema } from './provider-discovery.schema';

/**
 * Provider match-recommendation HTTP DTOs (TS-213; PRD §6.3 "Match
 * recommendations based on senior preferences and household intake";
 * PDD §14.1 provider discovery).
 *
 * Two surfaces, mirroring the TS-208 visit-prep split:
 *
 *   1. **Internal scoring** — `POST /api/v1/internal/search/recommendations`
 *      on service-search. Pinned by the `SEARCH_INDEX_*` shared secret.
 *      Accepts a **de-identified senior signal profile** (no seniorId,
 *      no name, no PII — just the matching signals) and returns the
 *      top-N providers scored against it, each with explainability
 *      metadata naming which signals contributed. service-search owns
 *      the scoring engine but never reads senior data — the gateway
 *      assembles the profile and hands it over (CLAUDE.md §2.3, §12).
 *
 *   2. **Public, senior-keyed** — `GET /api/v1/seniors/:seniorId/recommended-providers`
 *      on the api-gateway BFF. The gateway does actor↔senior authz
 *      (via the actor-scoped senior-preferences read), assembles the
 *      signal profile from the senior's intake + preference cues, calls
 *      surface #1, and returns the recommendations keyed by senior.
 *
 * **Why the gateway owns the senior-keyed endpoint.** service-search
 * has no cross-service access to the household domain (no FK, no DB
 * read — CLAUDE.md §2.3). The PRD phrases the endpoint as living on
 * service-search; in practice the scoring lives there and the
 * senior-keyed surface + authz lives at the gateway. Exactly the
 * TS-208 visit-prep pattern.
 *
 * **Privacy.** The profile carries no senior identifier — service-search
 * scores against anonymous signals (languages / dietary tags / cuisine
 * cues / a dementia-sensitive flag). The seniorId never leaves the
 * gateway hop. CLAUDE.md §12 — don't over-share senior data.
 *
 * `.strict()` everywhere — a stray field is a 400, never a silent
 * round-trip (CLAUDE.md §3.3).
 */

// ─── Bounded length / range constants ───────────────────────────────────

/** Soft-FK identifier cap (seniorId on the gateway response). */
export const RECOMMENDATION_ID_MAX_LENGTH = 64;

/** Per-facet tag cap on the signal profile (languages / dietary / cuisine). */
export const RECOMMENDATION_PROFILE_TAGS_MAX = 32;

/** Per-tag length cap. Matches the provider-discovery tag cap. */
export const RECOMMENDATION_TAG_MAX_LENGTH = 64;

/** Default + ceiling on the number of recommendations returned. */
export const RECOMMENDATION_LIMIT_DEFAULT = 10;
export const RECOMMENDATION_LIMIT_MAX = 25;

/**
 * Max explainability signals attached to a single recommendation. Four
 * match signals (language / dietary / cuisine / dementia) + three
 * quality signals (rating / popularity / tier) = 7 today; capped
 * generously at 12 so a future signal kind is non-breaking.
 */
export const RECOMMENDATION_SIGNALS_MAX = 12;

/** Max matched values echoed back per signal (e.g. the matched languages). */
export const RECOMMENDATION_SIGNAL_MATCHED_VALUES_MAX = 16;

// ─── Field schemas ──────────────────────────────────────────────────────

/**
 * A signal tag on the profile. Same lower-case alphanumeric + `._-`
 * shape as the provider-discovery document tags, so a profile tag can
 * match a document tag by exact set membership. The gateway normalises
 * upstream intake tags (which may be snake_case or BCP-47) to this
 * shape before sending — anything that doesn't conform is dropped
 * rather than rejected (best-effort matching).
 */
const ProfileTagSchema = z
  .string()
  .min(1)
  .max(RECOMMENDATION_TAG_MAX_LENGTH)
  .regex(/^[a-z0-9][a-z0-9._-]*$/, 'tag must be lower-case alphanumeric / . _ -');

const ProfileTagArraySchema = z.array(ProfileTagSchema).max(RECOMMENDATION_PROFILE_TAGS_MAX);

/**
 * The de-identified senior signal profile. Built by the gateway from
 * the senior's operational intake (TS-031: languages, dietary tags,
 * dementia status) + memory-profile preference cues (TS-033/TS-214:
 * favourite cuisine, regional tradition). Carries **no senior
 * identifier** — service-search scores anonymous signals only.
 *
 *   - `languages` — BCP-47-ish language tags (normalised lower-case).
 *     Matched against the provider doc's `languages`.
 *   - `dietaryTags` — dietary categories (kosher / halal / vegetarian /
 *     low_sodium …). Matched against the provider doc's
 *     `dietaryExpertise`.
 *   - `cuisinePreferences` — cuisine cues derived from the senior's
 *     favourite-cuisine / regional-tradition preference values. Matched
 *     against the provider doc's `cuisines`.
 *   - `dementiaSensitive` — true when the senior's intake dementia
 *     status is anything other than `none`. Boosts providers whose
 *     specialties include a dementia-sensitive / memory-care tag.
 */
export const RecommendationSeniorProfileSchema = z
  .object({
    languages: ProfileTagArraySchema,
    dietaryTags: ProfileTagArraySchema,
    cuisinePreferences: ProfileTagArraySchema,
    dementiaSensitive: z.boolean(),
  })
  .strict();
export type RecommendationSeniorProfile = z.infer<typeof RecommendationSeniorProfileSchema>;

/**
 * `POST /api/v1/internal/search/recommendations` request. The profile
 * plus a bounded result count.
 */
export const RecommendProvidersRequestSchema = z
  .object({
    profile: RecommendationSeniorProfileSchema,
    limit: z
      .number()
      .int()
      .positive()
      .max(RECOMMENDATION_LIMIT_MAX)
      .default(RECOMMENDATION_LIMIT_DEFAULT),
  })
  .strict();
export type RecommendProvidersRequest = z.infer<typeof RecommendProvidersRequestSchema>;

// ─── Explainability ─────────────────────────────────────────────────────

/**
 * The signal kinds that contribute to a recommendation score. Four
 * match signals + three quality signals:
 *
 *   - `language`            — the senior's language(s) overlap the
 *                             provider's spoken languages.
 *   - `dietary`             — the senior's dietary categories overlap the
 *                             provider's dietary expertise.
 *   - `cuisine`             — the senior's cuisine cues overlap the
 *                             provider's cuisines.
 *   - `dementia_experience` — the senior has cognitive needs and the
 *                             provider carries a dementia-sensitive /
 *                             memory-care specialty.
 *   - `rating`              — the provider's average rating (always
 *                             present; quality baseline).
 *   - `popularity`          — the provider's completed-booking volume
 *                             (always present; quality baseline).
 *   - `tier`                — the provider's tier multiplier (always
 *                             present; Elite > Certified > Basic).
 */
export const RecommendationSignalKindSchema = z.enum([
  'language',
  'dietary',
  'cuisine',
  'dementia_experience',
  'rating',
  'popularity',
  'tier',
]);
export type RecommendationSignalKind = z.infer<typeof RecommendationSignalKindSchema>;

/**
 * One contributing signal in a recommendation's explainability trail.
 * `matchedValues` carries the specific tags that matched (e.g. the
 * matched languages) for the match signals; it is empty for the
 * quality baselines (`rating` / `popularity` / `tier`). `contribution`
 * is the additive amount this signal added to the provider's total
 * score — the sum of all signals' contributions equals the
 * recommendation `score`.
 */
export const RecommendationSignalSchema = z
  .object({
    kind: RecommendationSignalKindSchema,
    matchedValues: z
      .array(z.string().min(1).max(RECOMMENDATION_TAG_MAX_LENGTH))
      .max(RECOMMENDATION_SIGNAL_MATCHED_VALUES_MAX),
    contribution: z.number().nonnegative(),
  })
  .strict();
export type RecommendationSignal = z.infer<typeof RecommendationSignalSchema>;

/**
 * A single scored recommendation: the denormalised provider document
 * (so the family-portal renders the provider card without a second
 * round-trip), the total score, and the explainability signal trail.
 */
export const RecommendedProviderSchema = z
  .object({
    document: ProviderDiscoveryDocumentSchema,
    score: z.number().nonnegative(),
    signals: z.array(RecommendationSignalSchema).max(RECOMMENDATION_SIGNALS_MAX),
  })
  .strict();
export type RecommendedProvider = z.infer<typeof RecommendedProviderSchema>;

/**
 * `POST /api/v1/internal/search/recommendations` response. Ordered by
 * `score` descending (tie-broken by rating then providerId for
 * stability). `liveMode` marks the backend provenance for ops
 * visibility, same as the search response.
 */
export const RecommendProvidersResponseSchema = z
  .object({
    recommendations: z.array(RecommendedProviderSchema),
    liveMode: z.boolean(),
  })
  .strict();
export type RecommendProvidersResponse = z.infer<typeof RecommendProvidersResponseSchema>;

/**
 * `GET /api/v1/seniors/:seniorId/recommended-providers` response (the
 * api-gateway BFF surface). Echoes the `seniorId` it was keyed on +
 * `generatedAt` (gateway wall-clock at composition) so the family-portal
 * can render "as of …" without a separate round-trip. `liveMode` is an
 * internal ops detail, so it is deliberately NOT echoed on the public
 * response.
 */
export const SeniorRecommendedProvidersResponseSchema = z
  .object({
    seniorId: z.string().min(1).max(RECOMMENDATION_ID_MAX_LENGTH),
    recommendations: z.array(RecommendedProviderSchema),
    generatedAt: z.string().datetime(),
  })
  .strict();
export type SeniorRecommendedProvidersResponse = z.infer<
  typeof SeniorRecommendedProvidersResponseSchema
>;
