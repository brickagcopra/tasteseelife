import { z } from 'zod';

/**
 * Search domain event constants + Zod schemas (TS-217-prep-1, prep-4b).
 *
 * Two events today:
 *
 *   - `search.performed` — emitted by `service-search` after every
 *     `POST /api/v1/search/providers` query resolves. Consumers:
 *     `service-analytics` (TS-217 search-relevance dashboard — top
 *     queries, zero-result queries, query-to-booking conversion anchor).
 *   - `search.result_clicked` (TS-217-prep-4b) — emitted by
 *     `service-search` when the family-portal reports a click on a search
 *     result (`POST /api/v1/search/clicks`). Carries the `searchId`
 *     correlation token (= the originating `search.performed` event's
 *     `eventId`, minted in prep-4a) plus the clicked `providerId` and the
 *     zero-based result `position`, so `service-analytics` can compute
 *     click-through-rate by position. Consumer: `service-analytics`.
 *
 * **Why this event is best-effort, not transactional.** Every other
 * outbox producer in the platform appends inside the same Prisma
 * transaction as a state change, so the event commits atomically with
 * the business write (PDD §7.3 / CLAUDE.md §5.3). Provider search is a
 * pure READ — there is no state change to be atomic with. `service-search`
 * therefore appends `search.performed` on a best-effort path: a failed
 * append logs a warning and the search response is still returned. The
 * event is analytics telemetry; losing one on a transient DB blip must
 * never fail a family-portal search. (See the producer's emitter for the
 * swallow-and-log wrapping.)
 *
 * Event names are dot-notation, past tense (CLAUDE.md §2.2). The
 * constant below is the single source of truth — services import the
 * literal rather than typing the string, so a rename is a TS error at
 * every call site.
 */
export const SEARCH_PERFORMED = 'search.performed' as const;

/**
 * Common event envelope — every event carries `eventId` (consumer dedup
 * key per CLAUDE.md §5.3) and `occurredAt` (producer wall-clock
 * timestamp). Same shape as the booking + subscription events.
 */
const SearchEventEnvelopeSchema = z.object({
  eventId: z.string().min(1).max(128),
  occurredAt: z.string().datetime(),
});

/**
 * Provider tier — mirrors service-provider's `ProviderTier` enum and the
 * http `ProviderDiscoveryTierSchema`. Re-declared here (rather than
 * imported from the http schema) so the events module has no intra-
 * package dependency on the http module — the same discipline the
 * booking events follow.
 */
const SearchProviderTierSchema = z.enum(['basic', 'certified', 'elite']);

/**
 * Sort strategy the family-portal picked — mirrors the http
 * `ProviderDiscoverySortSchema`. Carried so the analytics consumer can
 * segment relevance metrics by the sort the user actually chose.
 */
const SearchSortSchema = z.enum(['relevance', 'rating', 'distance']);

/**
 * Filter-facet keys — mirrors the keys of the http `SearchFiltersSchema`.
 * The event carries the set of ACTIVE facets (not their values) so
 * zero-result analysis can correlate over-constrained queries
 * ("language + cuisine + min-rating all set → no hits") without echoing
 * the potentially high-cardinality filter values onto the bus.
 *
 * `tiers` is the one exception where the values themselves are also
 * carried (`filterTiers` below) — tier is the PRD §5 ranking axis,
 * low-cardinality (3 values), and "zero results filtered to Elite" is a
 * first-class diagnostic for the search-relevance dashboard.
 */
export const SearchFilterFacetSchema = z.enum([
  'tiers',
  'statuses',
  'languages',
  'specialties',
  'cuisines',
  'dietaryExpertise',
  'certifications',
  'minRating',
  'providerIds',
]);
export type SearchFilterFacet = z.infer<typeof SearchFilterFacetSchema>;

/**
 * Page position — distinguishes a fresh query (`first`) from a
 * pagination follow-up (`paged`, i.e. the request carried a cursor).
 * "Top queries" + "zero-result queries" aggregate over `first` pages so
 * a deep scroll isn't double-counted as a new query.
 */
export const SearchPagePositionSchema = z.enum(['first', 'paged']);
export type SearchPagePosition = z.infer<typeof SearchPagePositionSchema>;

/** Free-text query cap — matches `PROVIDER_DISCOVERY_QUERY_MAX_LENGTH`. */
export const SEARCH_PERFORMED_QUERY_TEXT_MAX_LENGTH = 256;
/** Number of distinct filter-facet keys (the `appliedFilters` cap). */
export const SEARCH_PERFORMED_FILTER_FACETS_MAX = 9;
/** Number of provider tiers (the `filterTiers` cap). */
export const SEARCH_PERFORMED_FILTER_TIERS_MAX = 3;

/**
 * `search.performed` — emitted from `POST /api/v1/search/providers` after
 * the query resolves. Carries enough for the search-relevance dashboard
 * (TS-217) to compute top queries, zero-result queries, and per-sort /
 * per-filter relevance signals without joining back to anything.
 *
 *   - `actorUserId` — who searched. Server-stamped from the access-token
 *     request context, never client-supplied (CLAUDE.md §3.2). The join
 *     anchor for query-to-booking conversion once the booking flow echoes
 *     a search correlation id (TS-217-prep-3 follow-up).
 *   - `queryText` — the verbatim free-text query (provider-discovery
 *     text: cuisine / dish / language / chef name — NOT senior PII;
 *     CLAUDE.md §3.9). Null when the search carried no text query (the
 *     discovery landing page). Bounded at 256 chars by the request
 *     contract.
 *   - `sort` / `hasGeo` — the sort the user chose + whether a geo center
 *     was supplied.
 *   - `appliedFilters` — which filter facets were active (see
 *     `SearchFilterFacetSchema`). Stable order; may be empty.
 *   - `filterTiers` — the tier VALUES requested (empty when the tier
 *     filter was not set). See the facet-schema note above.
 *   - `resultCount` — hits returned on this page.
 *   - `totalEstimate` — total matches (backend best-effort estimate).
 *   - `zeroResults` — `totalEstimate === 0`. Carried explicitly (and
 *     invariant-checked below) so the consumer's hottest query — "how
 *     many searches returned nothing" — is an indexed boolean, not a
 *     derived predicate over a count column.
 *   - `page` — first vs. paginated (see `SearchPagePositionSchema`).
 *   - `liveMode` — stub vs. live Elasticsearch backend, so the analytics
 *     consumer can segment Phase-1 stub data from live-ES data once
 *     TS-111-followup-1 lands.
 */
export const SearchPerformedSchema = SearchEventEnvelopeSchema.extend({
  actorUserId: z.string().min(1).max(64),
  queryText: z.string().max(SEARCH_PERFORMED_QUERY_TEXT_MAX_LENGTH).nullable(),
  sort: SearchSortSchema,
  hasGeo: z.boolean(),
  appliedFilters: z.array(SearchFilterFacetSchema).max(SEARCH_PERFORMED_FILTER_FACETS_MAX),
  filterTiers: z.array(SearchProviderTierSchema).max(SEARCH_PERFORMED_FILTER_TIERS_MAX),
  resultCount: z.number().int().min(0),
  totalEstimate: z.number().int().min(0),
  zeroResults: z.boolean(),
  page: SearchPagePositionSchema,
  liveMode: z.boolean(),
})
  .strict()
  .superRefine((body, ctx) => {
    if (body.zeroResults !== (body.totalEstimate === 0)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['zeroResults'],
        message: 'zeroResults must equal (totalEstimate === 0)',
      });
    }
    if (body.resultCount > body.totalEstimate) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['resultCount'],
        message: 'resultCount (hits on this page) cannot exceed totalEstimate',
      });
    }
  });
export type SearchPerformed = z.infer<typeof SearchPerformedSchema>;

/**
 * `search.result_clicked` — emitted when the family-portal reports that a
 * user opened a provider from a search-results list (TS-217-prep-4b). A
 * click is telemetry, never a correctness-bearing write, so the producer
 * appends it on the same best-effort path as `search.performed` (see the
 * file header's best-effort note + the producer's emitter).
 *
 * Each click carries its OWN `eventId` (one row per click), distinct from
 * the `searchId` correlation token it points at. The CTR funnel is the
 * join `search.result_clicked.searchId === search.performed.eventId`.
 */
export const SEARCH_RESULT_CLICKED = 'search.result_clicked' as const;

/**
 * Zero-based result position cap. The family-portal page size is bounded
 * (`PROVIDER_DISCOVERY_LIMIT_MAX` = 100) and deep pagination is rare, so a
 * generous absolute cap rejects a corrupt / hand-crafted position without
 * constraining the legitimate range. CTR-by-position aggregation buckets
 * by this value.
 */
export const SEARCH_RESULT_CLICKED_POSITION_MAX = 9_999;

/** Soft-FK id length cap for the clicked provider + the correlation token. */
export const SEARCH_RESULT_CLICKED_ID_MAX_LENGTH = 128;

/**
 * `search.result_clicked` payload (TS-217-prep-4b).
 *
 *   - `searchId` — the correlation token the client received on the
 *     `SearchProvidersResponse` (= the originating `search.performed`
 *     event's `eventId`; TS-217-prep-4a). The CTR join key.
 *   - `actorUserId` — who clicked. Server-stamped from the access-token
 *     request context, never client-supplied (CLAUDE.md §3.2). Matches the
 *     `search.performed` actor stamping so a future per-user CTR cut is
 *     possible.
 *   - `providerId` — the clicked provider (the index doc id). Soft-FK
 *     into service-provider (CLAUDE.md §2.3 — id only, never a real FK).
 *   - `position` — the zero-based rank of the clicked result within the
 *     results page the user saw. Bounded by
 *     `SEARCH_RESULT_CLICKED_POSITION_MAX`.
 */
export const SearchResultClickedSchema = SearchEventEnvelopeSchema.extend({
  searchId: z.string().min(1).max(SEARCH_RESULT_CLICKED_ID_MAX_LENGTH),
  actorUserId: z.string().min(1).max(64),
  providerId: z.string().min(1).max(SEARCH_RESULT_CLICKED_ID_MAX_LENGTH),
  position: z.number().int().min(0).max(SEARCH_RESULT_CLICKED_POSITION_MAX),
}).strict();
export type SearchResultClicked = z.infer<typeof SearchResultClickedSchema>;
