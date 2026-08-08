import { z } from 'zod';

import { ProviderAvailabilitySummarySchema } from './provider-availability.schema';

/**
 * Provider-discovery HTTP DTOs (TS-111; PDD §7.2 service-svc / §8.5
 * search indices / §14.1 provider discovery; PRD §6.3).
 *
 * Three surfaces:
 *
 *   1. **Public search** — `POST /api/v1/search/providers`. Family-portal
 *      provider discovery. Text query + filters (tier / language /
 *      specialty / dietary expertise / cuisine / certification / min
 *      rating) + optional geo radius + sort + cursor pagination. Returns
 *      hits + facet aggregates + opaque next cursor.
 *
 *   2. **Internal upsert** — `PUT /api/v1/internal/search/providers/:providerId`.
 *      The search-indexer worker (TS-053) materialises a denormalised
 *      provider document from the provider / household / academy domain
 *      events and PUTs it here. Idempotent — re-indexing the same
 *      version is a no-op.
 *
 *   3. **Internal delete** — `DELETE /api/v1/internal/search/providers/:providerId`.
 *      Hard remove from the index (PRD §10.7 provider suspension /
 *      archive; CLAUDE.md §12 welfare-flag holds).
 *
 * **Phase 1 stub backend.** TS-111 ships an in-memory backend behind a
 * `SearchBackend` interface; live `@elastic/elasticsearch` wiring lands
 * as TS-111-followup-1. The contract is the same in either mode.
 *
 * **`.strict()` everywhere** — typo in a field name is a 400, not a
 * silently-dropped knob (CLAUDE.md §3.3).
 */

// ─── Bounded length / range constants ───────────────────────────────────

/** CUID/CUID2-shaped identifiers (provider id, soft FKs into other services). */
export const PROVIDER_DISCOVERY_ID_MAX_LENGTH = 64;

/** Public-facing display name cap — matches `provider.providers.display_name`. */
export const PROVIDER_DISCOVERY_DISPLAY_NAME_MAX_LENGTH = 200;

/** Tagline cap — matches the provider profile `headline` field. */
export const PROVIDER_DISCOVERY_HEADLINE_MAX_LENGTH = 200;

/** Provider profile bio — capped because ES analysis cost scales with length. */
export const PROVIDER_DISCOVERY_BIO_MAX_LENGTH = 4_000;

/** IANA time-zone string (e.g. "America/New_York"). 64 chars covers every IANA entry. */
export const PROVIDER_DISCOVERY_TIME_ZONE_MAX_LENGTH = 64;

/** Free-text query (the text the family-portal types into the search box). */
export const PROVIDER_DISCOVERY_QUERY_MAX_LENGTH = 256;

/** Per-facet tag entry cap (language, specialty, cuisine, etc.). */
export const PROVIDER_DISCOVERY_TAG_MAX_LENGTH = 64;

/** Max tag entries per facet on the document side. */
export const PROVIDER_DISCOVERY_TAGS_PER_FACET_MAX = 32;

/** Max filter values per facet on a search request (e.g. tiers + languages). */
export const PROVIDER_DISCOVERY_FILTER_VALUES_MAX = 16;

/**
 * Max provider-id batch on the `providerIds` filter (TS-215-followup-2).
 * Matches the family-portal /favorites page-size cap so a single hydration
 * request covers a full page of favourites.
 */
export const PROVIDER_DISCOVERY_PROVIDER_IDS_FILTER_MAX = 24;

/** Rating bounds — 0 to 5 inclusive. */
export const PROVIDER_DISCOVERY_RATING_MIN = 0;
export const PROVIDER_DISCOVERY_RATING_MAX = 5;

/** Max booking count on a provider doc — generous future-proofed cap. */
export const PROVIDER_DISCOVERY_BOOKING_COUNT_MAX = 1_000_000;

/** Geo-radius default and ceiling (kilometres). */
export const PROVIDER_DISCOVERY_RADIUS_KM_DEFAULT = 50;
export const PROVIDER_DISCOVERY_RADIUS_KM_MAX = 500;

/** Pagination caps. */
export const PROVIDER_DISCOVERY_LIMIT_DEFAULT = 20;
export const PROVIDER_DISCOVERY_LIMIT_MAX = 100;

/** Opaque cursor — long enough for an HMAC-sealed page token. */
export const PROVIDER_DISCOVERY_CURSOR_MAX_LENGTH = 256;

/**
 * Media-key cap (S3 key length). Mirrors the `MEDIA_STORAGE_KEY_MAX_LENGTH`
 * cap in `media.schema.ts` — kept independent to avoid a circular import.
 */
export const PROVIDER_DISCOVERY_MEDIA_KEY_MAX_LENGTH = 1_024;

// ─── Field schemas (re-used) ────────────────────────────────────────────

const IdSchema = z.string().min(1).max(PROVIDER_DISCOVERY_ID_MAX_LENGTH);
const DisplayNameSchema = z.string().min(1).max(PROVIDER_DISCOVERY_DISPLAY_NAME_MAX_LENGTH);
const HeadlineSchema = z.string().min(1).max(PROVIDER_DISCOVERY_HEADLINE_MAX_LENGTH);
const BioSchema = z.string().min(1).max(PROVIDER_DISCOVERY_BIO_MAX_LENGTH);
const TimeZoneSchema = z.string().min(1).max(PROVIDER_DISCOVERY_TIME_ZONE_MAX_LENGTH);
const TagSchema = z
  .string()
  .min(1)
  .max(PROVIDER_DISCOVERY_TAG_MAX_LENGTH)
  .regex(/^[a-z0-9][a-z0-9._-]*$/, 'tag must be lower-case alphanumeric / . _ -');

/**
 * Latitude / longitude in WGS84 decimal degrees. Six fractional digits is
 * ~10 cm at the equator — more than enough for provider geo-discovery.
 */
const LatitudeSchema = z.number().gte(-90).lte(90);
const LongitudeSchema = z.number().gte(-180).lte(180);

const RatingSchema = z
  .number()
  .gte(PROVIDER_DISCOVERY_RATING_MIN)
  .lte(PROVIDER_DISCOVERY_RATING_MAX);

const MediaKeySchema = z.string().min(1).max(PROVIDER_DISCOVERY_MEDIA_KEY_MAX_LENGTH);

const TagArraySchema = z
  .array(TagSchema)
  .max(
    PROVIDER_DISCOVERY_TAGS_PER_FACET_MAX,
    `at most ${PROVIDER_DISCOVERY_TAGS_PER_FACET_MAX} tags`,
  );

const FilterValuesSchema = z
  .array(TagSchema)
  .min(1)
  .max(
    PROVIDER_DISCOVERY_FILTER_VALUES_MAX,
    `at most ${PROVIDER_DISCOVERY_FILTER_VALUES_MAX} filter values`,
  );

// ─── Enums ──────────────────────────────────────────────────────────────

/**
 * Provider tier. Mirrors `provider.provider_tier` in service-provider's
 * Prisma schema. The search-indexer worker (TS-053) projects this value
 * verbatim from the source row.
 *
 * Phase 1 search results filter to `active` providers by default; ranking
 * boosts Elite > Certified > Basic (PDD §14.1 "tier-aware boosting"). The
 * exact boost factor lives in the service-search backend, not the
 * contract.
 */
export const ProviderDiscoveryTierSchema = z.enum(['basic', 'certified', 'elite']);
export type ProviderDiscoveryTier = z.infer<typeof ProviderDiscoveryTierSchema>;

/**
 * Provider lifecycle status — mirrors `provider.provider_status`. Only
 * `active` providers are surfaced in public discovery; the other states
 * exist on the doc for admin / debug reads and for the indexer to deal
 * with re-projection on a status transition.
 */
export const ProviderDiscoveryStatusSchema = z.enum([
  'pending',
  'in_review',
  'active',
  'suspended',
  'archived',
]);
export type ProviderDiscoveryStatus = z.infer<typeof ProviderDiscoveryStatusSchema>;

/**
 * Sort strategies the family-portal can pick at query time. The backend
 * is free to add server-side default boosts on top (tier-aware boosting
 * always applies, irrespective of sort).
 *
 *   - `relevance` — score-based relevance ranking. Default. With no text
 *     query the backend falls back to popularity (booking-count + rating).
 *   - `rating`    — descending by `ratingAverage` (tie-break by
 *     `ratingCount`).
 *   - `distance`  — ascending by distance from `geo.center`. Requires
 *     `geo` to be supplied; rejected otherwise.
 */
export const ProviderDiscoverySortSchema = z.enum(['relevance', 'rating', 'distance']);
export type ProviderDiscoverySort = z.infer<typeof ProviderDiscoverySortSchema>;

// ─── Document shape ─────────────────────────────────────────────────────

const CentroidSchema = z
  .object({
    latitude: LatitudeSchema,
    longitude: LongitudeSchema,
  })
  .strict();

/**
 * The denormalised provider document the search-indexer worker writes
 * into Elasticsearch (or the Phase-1 in-memory stub). One doc per
 * provider; the `providerId` is the index document id.
 *
 * **Soft-FK discipline** (CLAUDE.md §2.3). Every id field on this doc is
 * a plain string — no FK / no referential integrity. The indexer worker
 * is responsible for keeping the doc in sync via domain events
 * (`provider.tier_changed`, `provider.profile_updated`, `booking.completed`
 * for ratings, etc.).
 *
 * **Geo storage**. `centroid` is a pre-computed lat/lng pair derived
 * from the provider's service-area polygon (PDD §8.5 / §14.1). The
 * polygon itself is not on the doc — Phase 1 search uses centroid +
 * radius, not polygon intersection. Polygon-aware search lands in a
 * follow-up alongside the live ES wiring.
 *
 * **Rating fields**. `ratingAverage` is null for providers with no
 * reviews yet; `ratingCount` defaults to 0. The indexer keeps these in
 * sync from `booking.completed` event tallies (TS-053 / TS-061
 * follow-up).
 */
export const ProviderDiscoveryDocumentSchema = z
  .object({
    providerId: IdSchema,
    userId: IdSchema,
    displayName: DisplayNameSchema,
    headline: HeadlineSchema.nullable(),
    bio: BioSchema.nullable(),
    tier: ProviderDiscoveryTierSchema,
    status: ProviderDiscoveryStatusSchema,
    languages: TagArraySchema,
    specialties: TagArraySchema,
    cuisines: TagArraySchema,
    dietaryExpertise: TagArraySchema,
    certifications: TagArraySchema,
    centroid: CentroidSchema.nullable(),
    ratingAverage: RatingSchema.nullable(),
    ratingCount: z.number().int().nonnegative().max(PROVIDER_DISCOVERY_BOOKING_COUNT_MAX),
    completedBookingCount: z.number().int().nonnegative().max(PROVIDER_DISCOVERY_BOOKING_COUNT_MAX),
    profilePhotoKey: MediaKeySchema.nullable(),
    videoIntroKey: MediaKeySchema.nullable(),
    timeZone: TimeZoneSchema,
    /**
     * Resolved next-7-days availability summary (TS-203). Null when
     * the provider has not declared any recurring windows; otherwise
     * the materialised projection that service-provider's
     * discovery-snapshot endpoint produces by applying the recurring
     * windows + date-keyed exclusions starting at the
     * snapshot-evaluation moment. Search backends use the projection
     * to gate "available this week" filters; the booking-svc
     * availability gate (TS-060 / TS-205) remains the authoritative
     * check at booking-create time.
     */
    availabilitySummary: ProviderAvailabilitySummarySchema.nullable(),
    /** Provider's local source-of-truth updatedAt (drives indexer dedup). */
    sourceUpdatedAt: z.string().datetime({ offset: true }),
  })
  .strict();
export type ProviderDiscoveryDocument = z.infer<typeof ProviderDiscoveryDocumentSchema>;

// ─── Search request ─────────────────────────────────────────────────────

const SearchFiltersSchema = z
  .object({
    tiers: z
      .array(ProviderDiscoveryTierSchema)
      .min(1)
      .max(PROVIDER_DISCOVERY_FILTER_VALUES_MAX)
      .optional(),
    statuses: z
      .array(ProviderDiscoveryStatusSchema)
      .min(1)
      .max(PROVIDER_DISCOVERY_FILTER_VALUES_MAX)
      .optional(),
    languages: FilterValuesSchema.optional(),
    specialties: FilterValuesSchema.optional(),
    cuisines: FilterValuesSchema.optional(),
    dietaryExpertise: FilterValuesSchema.optional(),
    certifications: FilterValuesSchema.optional(),
    minRating: RatingSchema.optional(),
    /**
     * Restrict the hit set to providers whose `providerId` is in the
     * supplied list. The family-portal /favorites page uses this
     * filter to hydrate up to `PROVIDER_DISCOVERY_PROVIDER_IDS_FILTER_MAX`
     * = 24 favourite rows with their denormalised discovery docs in a
     * single round-trip (TS-215-followup-2). Backends evaluate the
     * filter as a membership check — there is no implied ordering.
     */
    providerIds: z
      .array(IdSchema)
      .min(1)
      .max(PROVIDER_DISCOVERY_PROVIDER_IDS_FILTER_MAX)
      .optional(),
  })
  .strict();
export type SearchProvidersFilters = z.infer<typeof SearchFiltersSchema>;

const SearchGeoSchema = z
  .object({
    center: CentroidSchema,
    radiusKm: z
      .number()
      .positive()
      .max(PROVIDER_DISCOVERY_RADIUS_KM_MAX)
      .default(PROVIDER_DISCOVERY_RADIUS_KM_DEFAULT),
  })
  .strict();
export type SearchProvidersGeo = z.infer<typeof SearchGeoSchema>;

/**
 * `POST /api/v1/search/providers` request.
 *
 * **No required fields.** Empty body returns the top results sorted by
 * relevance — the public discovery landing page.
 *
 * **Distance sort gate.** `sort: 'distance'` requires `geo` to be
 * supplied; the contract refines it so the client gets a 400 at the
 * gateway rather than a confusing 422 from the backend.
 *
 * **Status filter default.** Omitting `filters.statuses` means the
 * backend serves only `status: 'active'` providers (the family-portal
 * default). Internal / admin callers can pass an explicit array to widen
 * the result set.
 */
export const SearchProvidersRequestSchema = z
  .object({
    query: z.string().min(1).max(PROVIDER_DISCOVERY_QUERY_MAX_LENGTH).optional(),
    filters: SearchFiltersSchema.optional(),
    geo: SearchGeoSchema.optional(),
    sort: ProviderDiscoverySortSchema.default('relevance'),
    limit: z
      .number()
      .int()
      .positive()
      .max(PROVIDER_DISCOVERY_LIMIT_MAX)
      .default(PROVIDER_DISCOVERY_LIMIT_DEFAULT),
    cursor: z.string().min(1).max(PROVIDER_DISCOVERY_CURSOR_MAX_LENGTH).optional(),
  })
  .strict()
  .superRefine((req, ctx) => {
    if (req.sort === 'distance' && req.geo === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['geo'],
        message: 'distance sort requires a geo center to be supplied',
      });
    }
  });
export type SearchProvidersRequest = z.infer<typeof SearchProvidersRequestSchema>;

// ─── Search response ────────────────────────────────────────────────────

/**
 * Max length of a campaign / creative id carried on a sponsored hit — a
 * CUID soft-FK (CLAUDE.md §2.3). Matches the sponsored-listings resolve id
 * bound (TS-218a, `SPONSORED_LISTINGS_ID_MAX_LENGTH`).
 */
export const SPONSORED_HIT_ID_MAX_LENGTH = 128;

/**
 * The campaign + creative that won a reserved sponsored slot for a hit
 * (TS-218b; PRD §10.9, PDD §18.1). Carried so the search-side
 * impression/click capture (TS-275) attributes to the right
 * campaign/creative. The sponsored provider itself is the hit's
 * `document.providerId`, so it is not repeated here.
 */
export const SponsoredHitSchema = z
  .object({
    campaignId: z.string().min(1).max(SPONSORED_HIT_ID_MAX_LENGTH),
    creativeId: z.string().min(1).max(SPONSORED_HIT_ID_MAX_LENGTH),
  })
  .strict();
export type SponsoredHit = z.infer<typeof SponsoredHitSchema>;

const SearchHitSchema = z
  .object({
    document: ProviderDiscoveryDocumentSchema,
    /** Backend-supplied relevance score. Higher is better. */
    score: z.number().nonnegative(),
    /** Distance from the query `geo.center` in kilometres; null when no geo supplied. */
    distanceKm: z.number().nonnegative().nullable(),
    /**
     * True when an active featured placement (TS-207) matched this provider
     * for the current query context (region / tier / wall-clock window) and
     * its boost was applied to `score`. The family-portal renders a
     * "Featured" badge on these hits. Resolved per query in the ranking
     * layer — never baked into the indexed document (see
     * `featured-placement.schema.ts`).
     */
    featured: z.boolean(),
    /**
     * Non-null when this hit occupies a reserved sponsored slot (TS-218b;
     * PRD §10.9, PDD §18.1, §18.3). service-search promotes up to N
     * sponsored providers (resolved from the organic candidate set by the
     * service-ads `sponsored-listings/resolve` surface, TS-218a) to the top
     * slots and flags them here, carrying the winning campaign + creative
     * for downstream impression/click capture (TS-275). The family-portal
     * renders the mandatory "Sponsored" disclosure (PDD §18.3) on these
     * rows.
     *
     * Distinct from `featured` (TS-207, an organic ranking boost): a hit may
     * be BOTH sponsored and featured. Resolved per query in the
     * orchestration layer — never indexed — and only ever set on the first
     * results page (sponsored slots live at the top, never on a paged
     * scroll).
     */
    sponsored: SponsoredHitSchema.nullable(),
  })
  .strict();
export type ProviderDiscoveryHit = z.infer<typeof SearchHitSchema>;

const FacetBucketSchema = z
  .object({
    value: z.string().min(1).max(PROVIDER_DISCOVERY_TAG_MAX_LENGTH),
    count: z.number().int().nonnegative(),
  })
  .strict();
export type ProviderDiscoveryFacetBucket = z.infer<typeof FacetBucketSchema>;

/**
 * Server-side aggregates over the unfiltered result set. The family-portal
 * surfaces these as facet pills next to the result list. Each facet is
 * capped at `PROVIDER_DISCOVERY_TAGS_PER_FACET_MAX` buckets — the rest
 * roll into a synthetic `__other__` bucket the backend may emit.
 */
const SearchFacetsSchema = z
  .object({
    tiers: z.array(FacetBucketSchema).max(PROVIDER_DISCOVERY_TAGS_PER_FACET_MAX),
    languages: z.array(FacetBucketSchema).max(PROVIDER_DISCOVERY_TAGS_PER_FACET_MAX),
    specialties: z.array(FacetBucketSchema).max(PROVIDER_DISCOVERY_TAGS_PER_FACET_MAX),
    cuisines: z.array(FacetBucketSchema).max(PROVIDER_DISCOVERY_TAGS_PER_FACET_MAX),
    certifications: z.array(FacetBucketSchema).max(PROVIDER_DISCOVERY_TAGS_PER_FACET_MAX),
  })
  .strict();
export type ProviderDiscoveryFacets = z.infer<typeof SearchFacetsSchema>;

export const SearchProvidersResponseSchema = z
  .object({
    hits: z.array(SearchHitSchema),
    facets: SearchFacetsSchema,
    /**
     * Backend best-effort estimate. Phase-1 stub returns the exact count;
     * live ES will switch to `track_total_hits=10000` and may return a
     * lower-bound estimate. Always non-negative.
     */
    totalEstimate: z.number().int().nonnegative(),
    /** Opaque next-page cursor. Null when this is the last page. */
    nextCursor: z.string().min(1).max(PROVIDER_DISCOVERY_CURSOR_MAX_LENGTH).nullable(),
    /** Live vs. stub backend marker — admin tooling reads this for ops visibility. */
    liveMode: z.boolean(),
    /**
     * Search-correlation id (TS-217-prep-4a). The `eventId` of the
     * best-effort `search.performed` analytics event this query emitted —
     * `service-search` mints it once, returns it here, AND stamps it as
     * the event's envelope id, so the dashboard can join later signals
     * back to the originating query.
     *
     * The family-portal echoes this token on the downstream events that
     * close the relevance funnel: `search.result_clicked` (TS-217-prep-4b,
     * CTR-by-position) and `booking.created` (TS-217-prep-4c, precise
     * query→booking conversion — replacing the prep-3b approximate
     * household/time-window join). Always present and non-null (the
     * controller mints it unconditionally, even when the best-effort event
     * append drops); a dangling token simply finds no match downstream,
     * which is acceptable for best-effort telemetry. Bounds match the
     * event envelope `eventId` (1–128 chars).
     */
    searchId: z.string().min(1).max(128),
  })
  .strict();
export type SearchProvidersResponse = z.infer<typeof SearchProvidersResponseSchema>;

// ─── Internal upsert / delete ───────────────────────────────────────────

/**
 * `PUT /api/v1/internal/search/providers/:providerId` body. The
 * search-indexer worker (TS-053) calls this with the denormalised doc
 * from the source-of-truth provider row + companion materialisations.
 *
 * The path parameter `:providerId` MUST match `document.providerId`; the
 * service rejects the request with a 422 if they disagree (defence
 * against silent over-write).
 */
export const UpsertProviderDocumentRequestSchema = z
  .object({
    document: ProviderDiscoveryDocumentSchema,
  })
  .strict();
export type UpsertProviderDocumentRequest = z.infer<typeof UpsertProviderDocumentRequestSchema>;

export const UpsertProviderDocumentResponseSchema = z
  .object({
    outcome: z.enum(['created', 'updated', 'unchanged']),
    providerId: IdSchema,
    indexedAt: z.string().datetime({ offset: true }),
    liveMode: z.boolean(),
  })
  .strict();
export type UpsertProviderDocumentResponse = z.infer<typeof UpsertProviderDocumentResponseSchema>;

export const DeleteProviderDocumentResponseSchema = z
  .object({
    outcome: z.enum(['deleted', 'not_found']),
    providerId: IdSchema,
    deletedAt: z.string().datetime({ offset: true }).nullable(),
    liveMode: z.boolean(),
  })
  .strict();
export type DeleteProviderDocumentResponse = z.infer<typeof DeleteProviderDocumentResponseSchema>;

/**
 * `GET /api/v1/internal/providers/:providerId/discovery-snapshot`
 * response (TS-053).
 *
 * service-provider exposes this read-only endpoint so the
 * search-indexer worker can fetch a fully-materialised
 * `ProviderDiscoveryDocument` whenever an upstream domain event
 * (`provider.tier_changed`, `provider.certification_*`) fires. The
 * worker then PUTs the doc verbatim to service-search's internal
 * upsert endpoint.
 *
 * **Why a read endpoint and not the event payload.** The domain
 * event carries the delta (which tier, which cert); the search doc
 * carries the full denormalised state. Coupling the event to the
 * doc would force every doc-shape change to bump every event
 * schema. The endpoint-as-snapshot pattern keeps event payloads
 * minimal and the doc shape free to evolve in service-search +
 * service-provider lockstep.
 *
 * **Outcome shape.** `kind: 'found'` carries the doc;
 * `kind: 'not_found'` covers the case where the providerId no
 * longer exists or has been soft-deleted — the indexer reads it as
 * "issue a delete instead of an upsert".
 */
export const ProviderDiscoverySnapshotResponseSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('found'),
      document: ProviderDiscoveryDocumentSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal('not_found'),
      providerId: IdSchema,
    })
    .strict(),
]);
export type ProviderDiscoverySnapshotResponse = z.infer<
  typeof ProviderDiscoverySnapshotResponseSchema
>;
