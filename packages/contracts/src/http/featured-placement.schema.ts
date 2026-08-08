import { z } from 'zod';

import { ProviderDiscoveryTierSchema } from './provider-discovery.schema';

/**
 * Featured-placement scheduling HTTP DTOs (TS-207; PRD §7.2, §10.5;
 * PDD §14.1).
 *
 * Two surfaces share this contract:
 *
 *   1. **Internal admin** — `GET|POST /api/v1/internal/search/featured-placements`
 *      + `DELETE /api/v1/internal/search/featured-placements/:placementId`.
 *      Maintained by ops; pinned to the same `SEARCH_INDEX_*` shared-secret
 *      header pair on service-search that the TS-053 indexer worker and the
 *      TS-211 ranking-config endpoints use, so the api-gateway BFF
 *      (`AdminFeaturedPlacementsProxyController`) can forward super_admin-gated
 *      writes from web-admin without leaking the secret to the browser.
 *
 *   2. **Service-search ranking layer** — at query time service-search
 *      resolves the *active* placements (window contains now) and applies a
 *      configurable score multiplier to matching providers, then flags the
 *      resulting hit as `featured` so the family-portal can render a badge.
 *
 * **Why this lives in service-search, not in the indexed document.** A
 * placement is scoped "per provider × geo × tier" and time-windowed — whether
 * a provider is featured *for a given search* depends on the query's region /
 * tier context and the wall clock, none of which can be statically baked into
 * the indexed doc by the search-indexer. So the boost is resolved at query
 * time in the ranking layer, mirroring the TS-211 tier-weight resolver. The
 * search-indexer is uninvolved.
 *
 * **Phase-1 region resolution is identity.** Same caveat as TS-211: a
 * `SearchProvidersRequest` does not yet carry a resolved region, so a
 * placement scoped to a specific `regionCode` cannot be matched yet — only
 * `regionCode: null` ("every region") placements apply. Per-region matching
 * lands alongside TS-211-followup-3's region resolution.
 *
 * **`.strict()` everywhere** — a typo in a field name is a 400, not a
 * silently-dropped knob (CLAUDE.md §3.3).
 */

// ─── Bounded length / range constants ───────────────────────────────────

/** CUID/CUID2-shaped placement-row id cap. */
export const FEATURED_PLACEMENT_ID_MAX_LENGTH = 64;

/** Soft-FK provider id cap — matches `provider.providers.id`. */
export const FEATURED_PLACEMENT_PROVIDER_ID_MAX_LENGTH = 64;

/** Region-code cap — mirrors `SEARCH_RANKING_REGION_CODE_MAX_LENGTH`. */
export const FEATURED_PLACEMENT_REGION_CODE_MAX_LENGTH = 64;

/** Free-text ops note shown on the admin row. */
export const FEATURED_PLACEMENT_NOTE_MAX_LENGTH = 500;

/** Attributing admin user id cap — populated when the gateway forwards it. */
export const FEATURED_PLACEMENT_CREATED_BY_USER_ID_MAX_LENGTH = 64;

/**
 * Boost-multiplier bounds. The floor is `1.0` so a "featured" window can
 * never *demote* a provider — featuring only ever amplifies (the explicit
 * way to demote a tier is the ranking-config weights, TS-211). The ceiling
 * keeps a wayward write from drowning out every organic result.
 */
export const FEATURED_PLACEMENT_BOOST_MIN = 1.0;
export const FEATURED_PLACEMENT_BOOST_MAX = 10;
export const FEATURED_PLACEMENT_BOOST_DEFAULT = 2.0;

/** Admin-list pagination caps. Ops tool, low volume — bounded, no cursor (Phase 1). */
export const FEATURED_PLACEMENT_LIST_LIMIT_DEFAULT = 50;
export const FEATURED_PLACEMENT_LIST_LIMIT_MAX = 200;

// ─── Field schemas ──────────────────────────────────────────────────────

const IdSchema = z.string().min(1).max(FEATURED_PLACEMENT_ID_MAX_LENGTH);
const ProviderIdSchema = z.string().min(1).max(FEATURED_PLACEMENT_PROVIDER_ID_MAX_LENGTH);
const NoteSchema = z.string().min(1).max(FEATURED_PLACEMENT_NOTE_MAX_LENGTH);
const CreatedByUserIdSchema = z
  .string()
  .min(1)
  .max(FEATURED_PLACEMENT_CREATED_BY_USER_ID_MAX_LENGTH);

/**
 * Region scope. Lowercase alphanumeric + `_` + `-`, must start with a
 * letter or digit — the same slug shape `SearchRankingConfigRegionCodeSchema`
 * enforces (TS-211), kept as a sibling definition so the two region
 * vocabularies stay aligned without a cross-schema import. `null` on a
 * record means "applies in every region".
 */
export const FeaturedPlacementRegionCodeSchema = z
  .string()
  .min(1)
  .max(FEATURED_PLACEMENT_REGION_CODE_MAX_LENGTH)
  .regex(/^[a-z0-9][a-z0-9_-]*$/, 'region code must be lower-case alphanumeric / _ / -');

/**
 * Boost multiplier — finite number in `[1, 10]`. Applied to the provider's
 * computed relevance score during an active window.
 */
export const FeaturedPlacementBoostSchema = z
  .number()
  .finite()
  .gte(FEATURED_PLACEMENT_BOOST_MIN)
  .lte(FEATURED_PLACEMENT_BOOST_MAX);

// ─── Record / response shapes ───────────────────────────────────────────

/**
 * Full placement record returned by every read endpoint.
 *
 *   - `regionCode: null`  — applies in every region.
 *   - `tier: null`        — applies to the provider regardless of tier.
 *   - `note` / `createdByUserId` — nullable ops metadata (the latter is
 *     populated when the write was attributed to an authenticated admin
 *     actor forwarded through the gateway BFF).
 *   - `startsAt` / `endsAt` — the window; the ranking layer applies the
 *     boost when `startsAt <= now < endsAt`.
 */
export const FeaturedPlacementRecordSchema = z
  .object({
    id: IdSchema,
    providerId: ProviderIdSchema,
    regionCode: FeaturedPlacementRegionCodeSchema.nullable(),
    tier: ProviderDiscoveryTierSchema.nullable(),
    boostMultiplier: FeaturedPlacementBoostSchema,
    startsAt: z.string().datetime({ offset: true }),
    endsAt: z.string().datetime({ offset: true }),
    note: NoteSchema.nullable(),
    createdByUserId: CreatedByUserIdSchema.nullable(),
    createdAt: z.string().datetime({ offset: true }),
    updatedAt: z.string().datetime({ offset: true }),
  })
  .strict();
export type FeaturedPlacementRecord = z.infer<typeof FeaturedPlacementRecordSchema>;

/**
 * `POST /api/v1/internal/search/featured-placements` body — schedule a new
 * featured window for a provider.
 *
 * `regionCode` / `tier` omitted ⇒ the window applies in every region / to
 * every tier. `startsAt` must be strictly before `endsAt` (a zero-length
 * window would never apply).
 */
export const ScheduleFeaturedPlacementRequestSchema = z
  .object({
    providerId: ProviderIdSchema,
    regionCode: FeaturedPlacementRegionCodeSchema.optional(),
    tier: ProviderDiscoveryTierSchema.optional(),
    boostMultiplier: FeaturedPlacementBoostSchema.default(FEATURED_PLACEMENT_BOOST_DEFAULT),
    startsAt: z.string().datetime({ offset: true }),
    endsAt: z.string().datetime({ offset: true }),
    note: NoteSchema.optional(),
    /**
     * Optional attributing admin user id — when the gateway forwards this
     * from an authenticated super_admin actor, ops audit can see who
     * scheduled the placement. Bypassed by direct curl callers (kept null
     * in that case).
     */
    createdByUserId: CreatedByUserIdSchema.optional(),
  })
  .strict()
  .superRefine((req, ctx) => {
    if (Date.parse(req.startsAt) >= Date.parse(req.endsAt)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['endsAt'],
        message: 'endsAt must be strictly after startsAt',
      });
    }
  });
export type ScheduleFeaturedPlacementRequest = z.infer<
  typeof ScheduleFeaturedPlacementRequestSchema
>;

/**
 * `POST /api/v1/internal/search/featured-placements` response — the created
 * row.
 */
export const ScheduleFeaturedPlacementResponseSchema = z
  .object({
    placement: FeaturedPlacementRecordSchema,
  })
  .strict();
export type ScheduleFeaturedPlacementResponse = z.infer<
  typeof ScheduleFeaturedPlacementResponseSchema
>;

/**
 * `GET /api/v1/internal/search/featured-placements` query. Optional filters
 * + a bounded limit. Phase-1 ops tool — no cursor pagination (the volume is
 * small and admin-only); captured as a follow-up if it ever grows.
 *
 * `activeOnly=true` restricts the result to placements whose window contains
 * the current instant.
 */
export const ListFeaturedPlacementsQuerySchema = z
  .object({
    providerId: ProviderIdSchema.optional(),
    activeOnly: z
      .union([z.literal('true'), z.literal('false')])
      .transform((value) => value === 'true')
      .optional(),
    limit: z.coerce
      .number()
      .int()
      .positive()
      .max(FEATURED_PLACEMENT_LIST_LIMIT_MAX)
      .default(FEATURED_PLACEMENT_LIST_LIMIT_DEFAULT),
  })
  .strict();
export type ListFeaturedPlacementsQuery = z.infer<typeof ListFeaturedPlacementsQuerySchema>;

/**
 * `GET /api/v1/internal/search/featured-placements` response — ordered by
 * `startsAt` descending (most recently-scheduled windows first).
 */
export const FeaturedPlacementsListResponseSchema = z
  .object({
    placements: z.array(FeaturedPlacementRecordSchema),
  })
  .strict();
export type FeaturedPlacementsListResponse = z.infer<typeof FeaturedPlacementsListResponseSchema>;

/**
 * `DELETE /api/v1/internal/search/featured-placements/:placementId` response.
 * Idempotent — deleting an already-gone placement returns `not_found`
 * rather than erroring, so a retry collapses cleanly.
 */
export const DeleteFeaturedPlacementResponseSchema = z
  .object({
    outcome: z.enum(['deleted', 'not_found']),
    placementId: IdSchema,
  })
  .strict();
export type DeleteFeaturedPlacementResponse = z.infer<typeof DeleteFeaturedPlacementResponseSchema>;
