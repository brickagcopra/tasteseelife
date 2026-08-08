import { z } from 'zod';

/**
 * Search ranking config HTTP DTOs (TS-211; PRD §6.3, §10.5; PDD §14.1).
 *
 * Two surfaces share this contract:
 *
 *   1. **Internal admin** — `GET|PUT|DELETE /api/v1/internal/search/ranking-config{/:regionCode}`.
 *      Maintained by ops; pinned to a shared-secret header on service-search
 *      so the api-gateway BFF (TS-211-followup-1) can forward super_admin-gated
 *      writes from web-admin (TS-211-followup-2) without leaking the secret
 *      to the browser. The shared-secret surface is the canonical ops path
 *      until the BFF + UI land — runbook for Phase-1 is `curl` against
 *      service-search directly with the shared-secret header.
 *
 *   2. **Service-search ranking layer** — the resolved weights are read by
 *      `InMemorySearchBackend.searchProviders` (TS-211) per query to apply
 *      tier-aware boosting (PDD §14.1 "Tier-aware boosting (Elite > Certified
 *      > Basic) configurable").
 *
 * **Region resolution** — Phase 1 always resolves to the seeded `global`
 * row; the schema supports per-region override but the consumption layer
 * does not yet route a search request's geo to a region code. Captured as
 * TS-211-followup-3.
 *
 * **`.strict()` everywhere** — typo in a field is a 400, not a silently-
 * dropped knob (CLAUDE.md §3.3).
 */

// ─── Bounded length / range constants ───────────────────────────────────

/** Region code cap — wide enough for `manhattan_upper_east_side`-shaped slugs. */
export const SEARCH_RANKING_REGION_CODE_MAX_LENGTH = 64;

/** Free-text description cap shown on the admin UI per row. */
export const SEARCH_RANKING_DESCRIPTION_MAX_LENGTH = 500;

/** CUID/CUID2-shaped row id cap. */
export const SEARCH_RANKING_CONFIG_ID_MAX_LENGTH = 64;

/** Updater user id cap — populated when the write was actor-attributed. */
export const SEARCH_RANKING_UPDATED_BY_USER_ID_MAX_LENGTH = 64;

/**
 * Tier-weight bounds. Generous so per-region experimentation is unblocked
 * without tripping a contract floor; a sane experiment never breaches [0.1,
 * 10]. The lower bound is `> 0` so a zero-weight tier can't silently make
 * an entire tier disappear from results (the explicit way is to filter by
 * tier in the request).
 */
export const SEARCH_RANKING_TIER_WEIGHT_MIN = 0.1;
export const SEARCH_RANKING_TIER_WEIGHT_MAX = 10;

/**
 * The canonical "every-region default" row. TS-211 seeds a single row at
 * this region code on first migration; service-search's resolver falls
 * back to this row whenever a per-region row is absent.
 */
export const SEARCH_RANKING_REGION_CODE_GLOBAL = 'global';

/**
 * Default tier weights per TS-211 acceptance: Elite ×1.5, Certified ×1.2,
 * Basic ×1.0. These ship as the seeded `global` row + the env-fallback
 * floor in service-search (used when the DB row is absent / unreachable
 * during boot).
 */
export const SEARCH_RANKING_TIER_WEIGHT_BASIC_DEFAULT = 1.0;
export const SEARCH_RANKING_TIER_WEIGHT_CERTIFIED_DEFAULT = 1.2;
export const SEARCH_RANKING_TIER_WEIGHT_ELITE_DEFAULT = 1.5;

// ─── Field schemas ──────────────────────────────────────────────────────

/**
 * Region code. Lowercase alphanumeric + `_` + `-`; must start with a
 * letter or digit. Captures slugs like `global`, `nyc`, `manhattan`,
 * `bay_area`. Length-bounded so a malformed slug can't dodge the index.
 */
export const SearchRankingConfigRegionCodeSchema = z
  .string()
  .min(1)
  .max(SEARCH_RANKING_REGION_CODE_MAX_LENGTH)
  .regex(/^[a-z0-9][a-z0-9_-]*$/, 'region code must be lower-case alphanumeric / _ / -');

/**
 * Tier weight — finite positive number bounded above to keep a wayward
 * write from making the ranker explode.
 */
export const SearchRankingTierWeightSchema = z
  .number()
  .finite()
  .gt(0)
  .gte(SEARCH_RANKING_TIER_WEIGHT_MIN)
  .lte(SEARCH_RANKING_TIER_WEIGHT_MAX);

const IdSchema = z.string().min(1).max(SEARCH_RANKING_CONFIG_ID_MAX_LENGTH);
const DescriptionSchema = z.string().min(1).max(SEARCH_RANKING_DESCRIPTION_MAX_LENGTH);
const UpdatedByUserIdSchema = z.string().min(1).max(SEARCH_RANKING_UPDATED_BY_USER_ID_MAX_LENGTH);

// ─── Record / response shapes ───────────────────────────────────────────

/**
 * Full record shape returned by every read endpoint.
 *
 * `description` is nullable — ops can omit it for the canonical `global`
 * row; per-region rows usually carry one ("NYC weights — boost Certified
 * because…").
 *
 * `updatedByUserId` is nullable — populated when the write was attributed
 * to an authenticated actor (forwarded through the BFF). When the row is
 * seeded by migration or written by a system process, this is null.
 */
export const SearchRankingConfigSchema = z
  .object({
    id: IdSchema,
    regionCode: SearchRankingConfigRegionCodeSchema,
    description: DescriptionSchema.nullable(),
    tierWeightBasic: SearchRankingTierWeightSchema,
    tierWeightCertified: SearchRankingTierWeightSchema,
    tierWeightElite: SearchRankingTierWeightSchema,
    updatedByUserId: UpdatedByUserIdSchema.nullable(),
    createdAt: z.string().datetime({ offset: true }),
    updatedAt: z.string().datetime({ offset: true }),
  })
  .strict();
export type SearchRankingConfig = z.infer<typeof SearchRankingConfigSchema>;

/**
 * `PUT /api/v1/internal/search/ranking-config/:regionCode` request body.
 *
 * Idempotent — the same body sent twice yields one persisted row (the
 * second write returns `unchanged`).
 */
export const UpsertSearchRankingConfigRequestSchema = z
  .object({
    description: DescriptionSchema.optional(),
    tierWeightBasic: SearchRankingTierWeightSchema,
    tierWeightCertified: SearchRankingTierWeightSchema,
    tierWeightElite: SearchRankingTierWeightSchema,
    /**
     * Optional attributing user id — when the gateway forwards this from
     * an authenticated admin actor, ops audit can see who last tweaked
     * the weights. Bypassed by direct curl callers (which is why it's
     * optional; the persistence layer keeps it null in that case).
     */
    updatedByUserId: UpdatedByUserIdSchema.optional(),
  })
  .strict();
export type UpsertSearchRankingConfigRequest = z.infer<
  typeof UpsertSearchRankingConfigRequestSchema
>;

/**
 * `PUT /api/v1/internal/search/ranking-config/:regionCode` response.
 *
 *   - `created` — no prior row for `regionCode`; one inserted.
 *   - `updated` — row existed; one or more weight columns changed.
 *   - `unchanged` — row existed; the supplied weights matched the
 *     stored ones byte-for-byte. The persistence layer skips the write
 *     so `updatedAt` does not drift on a no-op replay.
 */
export const UpsertSearchRankingConfigResponseSchema = z
  .object({
    outcome: z.enum(['created', 'updated', 'unchanged']),
    config: SearchRankingConfigSchema,
  })
  .strict();
export type UpsertSearchRankingConfigResponse = z.infer<
  typeof UpsertSearchRankingConfigResponseSchema
>;

/**
 * `GET /api/v1/internal/search/ranking-config` response — list. Sorted
 * by `regionCode` so the `global` row is always present and the per-region
 * rows render in stable order.
 */
export const ListSearchRankingConfigResponseSchema = z
  .object({
    configs: z.array(SearchRankingConfigSchema),
  })
  .strict();
export type ListSearchRankingConfigResponse = z.infer<typeof ListSearchRankingConfigResponseSchema>;

/**
 * `GET /api/v1/internal/search/ranking-config/:regionCode` response.
 *
 * Discriminated by `kind` — a missing row is a contract-level signal, not
 * a 404 from the gateway perspective (the row may legitimately not exist
 * when ops haven't authored per-region weights yet). The 404 mapping
 * happens in the api-gateway BFF (TS-211-followup-1) for the web-admin
 * UX; service-search returns `not_found` so the BFF can decide.
 */
export const GetSearchRankingConfigResponseSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('found'),
      config: SearchRankingConfigSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal('not_found'),
      regionCode: SearchRankingConfigRegionCodeSchema,
    })
    .strict(),
]);
export type GetSearchRankingConfigResponse = z.infer<typeof GetSearchRankingConfigResponseSchema>;

/**
 * `DELETE /api/v1/internal/search/ranking-config/:regionCode` response.
 *
 * Deleting the `global` row is rejected at the service layer with a 422
 * — the row is load-bearing as the fallback for unscoped regions and
 * for the env-default safety floor's persistence shape. Ops must replace
 * `global` weights via PUT, not by DELETE-then-PUT.
 */
export const DeleteSearchRankingConfigResponseSchema = z
  .object({
    outcome: z.enum(['deleted', 'not_found']),
    regionCode: SearchRankingConfigRegionCodeSchema,
  })
  .strict();
export type DeleteSearchRankingConfigResponse = z.infer<
  typeof DeleteSearchRankingConfigResponseSchema
>;
