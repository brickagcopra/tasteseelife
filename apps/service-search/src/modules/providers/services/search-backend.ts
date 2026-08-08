import type {
  ProviderDiscoveryDocument,
  ProviderDiscoveryFacets,
  ProviderDiscoveryHit,
  RecommendProvidersRequest,
  RecommendedProvider,
  SearchProvidersRequest,
} from '@taste-and-see/contracts';

/**
 * DI token for the active `SearchBackend` implementation. The
 * `ProvidersModule` resolves either `InMemorySearchBackend` (Phase 1
 * stub, TS-111) or the live `@elastic/elasticsearch`-backed implementation
 * (TS-111-followup-1) based on the validated env's
 * `isSearchBackendStubMode` predicate.
 */
export const SEARCH_BACKEND_TOKEN = Symbol.for('@taste-and-see/service-search:backend');

/**
 * Shape every search backend must satisfy. The contract is deliberately
 * minimal — both the stub and the live Elasticsearch client surface the
 * same five operations, so a TS-111-followup-1 swap requires no
 * controller / service changes.
 *
 * **Invariants every implementation must hold.**
 *
 *   - `upsert` is idempotent on `(providerId, sourceUpdatedAt)`. A retry
 *     with the same `sourceUpdatedAt` returns `outcome: 'unchanged'`
 *     without overwriting the stored doc; a strictly-newer
 *     `sourceUpdatedAt` returns `outcome: 'updated'`; a previously-unseen
 *     `providerId` returns `outcome: 'created'`. The dedup contract
 *     prevents out-of-order TS-053 indexer event delivery from
 *     overwriting a fresher doc with stale data.
 *
 *   - `search` MUST apply the family-portal status default (only
 *     `active` providers surface unless the caller explicitly widens the
 *     filter via `request.filters.statuses`). Phase-1 ranking applies
 *     the tier-boost multiplier from env (basic / certified / elite).
 *
 *   - `search` MUST return `distanceKm: null` on every hit when the
 *     caller did NOT supply a geo center, and a non-null km value on
 *     every hit when a geo center IS supplied. Distance-sort is
 *     contract-gated to require geo, so the backend never needs to
 *     sort by `null`.
 *
 *   - `delete` returns `'deleted'` on the first call, `'not_found'`
 *     thereafter — idempotent for the indexer.
 *
 *   - `ping` must complete in < 250 ms (PDD §7.1 readiness budget).
 *     The stub satisfies trivially; live wiring sends a lightweight
 *     `cluster.health` call.
 */
export interface SearchBackend {
  /** Returns true when the backend is wired against a live Elasticsearch cluster. */
  isLiveMode(): boolean;

  /** Cheap liveness probe used by `/readyz`. */
  ping(): Promise<void>;

  /**
   * Idempotent upsert. The backend's stored `sourceUpdatedAt` is the
   * dedup axis — see the invariant above.
   */
  upsertProvider(input: { document: ProviderDiscoveryDocument }): Promise<UpsertOutcome>;

  /**
   * Hard delete. The Phase-1 stub removes the in-memory entry; live
   * wiring issues an ES `delete` and treats a 404 as `'not_found'`.
   */
  deleteProvider(input: { providerId: string }): Promise<DeleteOutcome>;

  /**
   * Provider-discovery query — applies filters + geo + sort + paginate.
   * The cursor implementation is backend-specific (the stub returns a
   * `offset:N` string; live wiring uses `search_after`).
   */
  searchProviders(input: { request: SearchProvidersRequest }): Promise<SearchOutcome>;

  /**
   * Match-recommendation query (TS-213). Scores the active provider set
   * against a **de-identified senior signal profile** (languages /
   * dietary tags / cuisine cues / dementia-sensitive flag) and returns
   * the top-N with explainability metadata. Only `active` providers are
   * recommended (family-facing). Ordered by score descending, tie-broken
   * by rating then providerId for stability. The live ES wiring maps the
   * same signal weights onto a `function_score` query.
   */
  recommendProviders(input: { request: RecommendProvidersRequest }): Promise<RecommendationOutcome>;

  /**
   * Current indexed-document count, surfaced for the
   * `search_index_size_docs` Prometheus gauge (TS-111-followup-4). Optional
   * + synchronous: the in-memory stub returns its `Map` size in O(1); a live
   * `@elastic/elasticsearch` backend (TS-111-followup-1) can return a cached
   * count refreshed off the index stats, or omit the method entirely — the
   * gauge callback then records nothing rather than blocking the scrape on an
   * async ES `count` call.
   */
  documentCount?(): number | undefined;

  /** Pure in-memory utility for tests + admin tooling — never call in production. */
  resetForTesting?(): void;
}

export interface UpsertOutcome {
  readonly outcome: 'created' | 'updated' | 'unchanged';
  readonly providerId: string;
  readonly indexedAt: string;
}

export interface DeleteOutcome {
  readonly outcome: 'deleted' | 'not_found';
  readonly providerId: string;
  readonly deletedAt: string | null;
}

export interface SearchOutcome {
  readonly hits: readonly ProviderDiscoveryHit[];
  readonly facets: ProviderDiscoveryFacets;
  readonly totalEstimate: number;
  readonly nextCursor: string | null;
}

export interface RecommendationOutcome {
  readonly recommendations: readonly RecommendedProvider[];
}
