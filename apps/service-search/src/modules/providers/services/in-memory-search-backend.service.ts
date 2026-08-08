import { Injectable } from '@nestjs/common';
import type {
  ProviderDiscoveryDocument,
  ProviderDiscoveryFacetBucket,
  ProviderDiscoveryFacets,
  ProviderDiscoveryHit,
  ProviderDiscoveryStatus,
  ProviderDiscoveryTier,
  RecommendProvidersRequest,
  RecommendationSeniorProfile,
  RecommendationSignal,
  RecommendedProvider,
  SearchProvidersFilters,
  SearchProvidersGeo,
  SearchProvidersRequest,
} from '@taste-and-see/contracts';

import { SENIOR_CARE_SYNONYM_INDEX } from '../../../common/synonyms/senior-care-dictionary';
import { expandQueryTokens, tokenizeText } from '../../../common/synonyms/synonym-expander';
import {
  type ActiveFeaturedPlacement,
  FeaturedPlacementsService,
} from '../../featured-placements/services/featured-placements.service';
import { RankingConfigService } from '../../ranking-config/services/ranking-config.service';

import {
  type DeleteOutcome,
  type RecommendationOutcome,
  type SearchBackend,
  type SearchOutcome,
  type UpsertOutcome,
} from './search-backend';

/**
 * Pure in-memory `SearchBackend` for Phase 1 (TS-111). Mirrors the
 * `SearchBackend` contract so a TS-111-followup-1 swap to live
 * `@elastic/elasticsearch` is implementation-only.
 *
 * **Storage shape.** `Map<providerId, ProviderDiscoveryDocument>` — one
 * doc per provider, indexed by the doc's `providerId`. Idempotency is
 * keyed off the stored doc's `sourceUpdatedAt`.
 *
 * **Ranking.** Tier-boost multipliers resolve via `RankingConfigService.
 * resolveWeights(...)` at query time (TS-211 — per-region overrides
 * backed by the `search.search_ranking_config` Postgres table; falls
 * back to the seeded `global` row, then to env defaults). Text-query
 * relevance is a Phase-1 token-overlap heuristic (case-insensitive
 * whole-token match against `displayName + headline + bio + specialties
 * + cuisines`). Query tokens are synonym-expanded (TS-216) against the
 * senior-care + culinary dictionary before the overlap match, so
 * "memory care" surfaces `dementia` providers and "religious dietary"
 * surfaces `kosher` — see `matchesQuery` + `common/synonyms`. On top of
 * the tier + featured boosts, an exponential
 * geo-distance decay (TS-210) multiplies the score when the search
 * supplies a geo center — see `geoDecayFactor` + the "Distance math"
 * note below. The live ES wiring will swap in BM25 + an ES `exp`
 * `function_score` geo decay calibrated to the same curve; the contract
 * output stays the same.
 *
 * **Featured placements (TS-207).** On top of the tier boost, the active
 * featured placements (resolved via `FeaturedPlacementsService` at query
 * time) contribute a per-provider score multiplier when the placement's
 * window contains now and its region/tier scope matches. Matching docs are
 * flagged `featured: true` so the family-portal renders a badge. Phase-1
 * region resolution is identity (no region on the request yet) so only
 * `regionCode: null` placements apply — see `resolveFeaturedBoost`.
 *
 * **Region resolution.** Phase 1 uses the `global` row for every
 * request — the `SearchProvidersRequest` does not yet carry a region
 * code, and there is no household → region map. Resolution from
 * `geo.center` / household zip lands as TS-211-followup-3; this
 * backend already routes through the resolver so the change is
 * one-callsite.
 *
 * **Distance math.** Haversine formula against the stored centroid; null
 * centroids fall outside any geo filter (the doc is filtered out when
 * `geo` is supplied). Distances are reported in kilometres with
 * 1-metre granularity. When a geo center is supplied the same distance
 * also drives the TS-210 relevance decay `exp(-distanceKm / scaleKm)`
 * (`scaleKm` from `resolveWeights().geoDecayScaleKm`). The centroid is
 * the area-weighted center of the provider's service-area polygons
 * (TS-053-followup-3); nearest-polygon-edge distance is a follow-up
 * once the doc carries polygon geometry.
 *
 * **Cursor.** `offset:N` — naive but bounded (the contract caps `limit`
 * at 100 and the in-memory cap is implicit at the doc count). Live
 * wiring uses ES `search_after` for stable cursoring under writes.
 *
 * **Reset hook.** `resetForTesting()` is exposed because unit tests
 * share the same module instance. Never called outside tests.
 */
@Injectable()
export class InMemorySearchBackend implements SearchBackend {
  private readonly docs = new Map<string, ProviderDiscoveryDocument>();

  constructor(
    private readonly rankingConfig: RankingConfigService,
    private readonly featuredPlacements: FeaturedPlacementsService,
  ) {}

  isLiveMode(): boolean {
    return false;
  }

  async ping(): Promise<void> {
    // No-op — the in-memory backend is always healthy.
    await Promise.resolve();
  }

  async upsertProvider(input: { document: ProviderDiscoveryDocument }): Promise<UpsertOutcome> {
    const { document } = input;
    const existing = this.docs.get(document.providerId);
    const now = new Date().toISOString();

    if (existing === undefined) {
      this.docs.set(document.providerId, document);
      return {
        outcome: 'created',
        providerId: document.providerId,
        indexedAt: now,
      };
    }

    if (existing.sourceUpdatedAt === document.sourceUpdatedAt) {
      return {
        outcome: 'unchanged',
        providerId: document.providerId,
        indexedAt: existing.sourceUpdatedAt,
      };
    }

    if (existing.sourceUpdatedAt > document.sourceUpdatedAt) {
      // The indexer delivered an older doc after a newer one — refuse
      // to overwrite the fresher state. Outcome is `unchanged` so the
      // caller can record the dedup decision in its own metrics.
      return {
        outcome: 'unchanged',
        providerId: document.providerId,
        indexedAt: existing.sourceUpdatedAt,
      };
    }

    this.docs.set(document.providerId, document);
    return {
      outcome: 'updated',
      providerId: document.providerId,
      indexedAt: now,
    };
  }

  async deleteProvider(input: { providerId: string }): Promise<DeleteOutcome> {
    const existed = this.docs.delete(input.providerId);
    return {
      outcome: existed ? 'deleted' : 'not_found',
      providerId: input.providerId,
      deletedAt: existed ? new Date().toISOString() : null,
    };
  }

  async searchProviders(input: { request: SearchProvidersRequest }): Promise<SearchOutcome> {
    const { request } = input;

    const statusFilter = request.filters?.statuses ?? (['active'] as const);
    // TS-211 — resolve tier weights from `RankingConfigService`, which
    // reads the per-region row from `search.search_ranking_config`
    // with `global` fallback + env-default fallback. Phase 1 uses the
    // `global` row for every request (no region in the request yet);
    // TS-211-followup-3 wires region resolution from `geo.center` /
    // household zip.
    const resolved = await this.rankingConfig.resolveWeights();
    const tierBoost: Record<ProviderDiscoveryTier, number> = {
      basic: resolved.basic,
      certified: resolved.certified,
      elite: resolved.elite,
    };

    // TS-207 — resolve the active featured placements (window contains now)
    // so a matching provider gets an extra score multiplier + a `featured`
    // flag on its hit. Empty in the common case; the resolver caches.
    const activeFeatured = await this.featuredPlacements.resolveActivePlacements();

    // 1. Filter
    const filtered = [...this.docs.values()].filter((doc) =>
      passesFilters(doc, statusFilter, request.filters, request.geo, request.query),
    );

    // 2. Score + decorate with distance + featured boost + geo decay
    const scored: ScoredHit[] = filtered.map((doc) => {
      const featuredBoost = resolveFeaturedBoost(doc, activeFeatured);
      const distanceKm =
        request.geo === undefined ? null : computeDistanceKm(doc, request.geo.center);
      // TS-210 — fold an exponential distance decay into the relevance
      // score when the search supplies a geo center: closer providers
      // rank higher. No-op (factor 1) when geo is absent. The explicit
      // `distance` sort still orders by raw `distanceKm`, so decay only
      // shapes relevance/rating ordering — never the distance sort.
      const geoDecay = geoDecayFactor(distanceKm, resolved.geoDecayScaleKm);
      return {
        doc,
        score: computeScore(doc, request.query, tierBoost[doc.tier]) * featuredBoost * geoDecay,
        distanceKm,
        featured: featuredBoost > 1,
      };
    });

    // 3. Sort
    const sorted = sortHits(scored, request.sort);

    // 4. Paginate (cursor = "offset:N")
    const offset = parseOffsetCursor(request.cursor);
    const limit = request.limit;
    const pageHits = sorted.slice(offset, offset + limit);
    const nextOffset = offset + pageHits.length;
    const nextCursor = nextOffset < sorted.length ? `offset:${nextOffset}` : null;

    // 5. Build response hits. `sponsored` is always null here — sponsorship
    // is a monetisation overlay resolved against service-ads in the
    // orchestration layer (TS-218b), never an organic-ranking concern, so
    // the backend has no knowledge of it.
    const hits: ProviderDiscoveryHit[] = pageHits.map(({ doc, score, distanceKm, featured }) => ({
      document: doc,
      score,
      distanceKm,
      featured,
      sponsored: null,
    }));

    return {
      hits,
      facets: computeFacets(filtered),
      totalEstimate: filtered.length,
      nextCursor,
    };
  }

  /**
   * TS-213 — match recommendations. Scores every `active` provider doc
   * against the de-identified senior signal profile (see
   * `scoreRecommendation`), orders by total score descending (tie-broken
   * by rating then providerId), and returns the top `limit`.
   *
   * **Always returns up to `limit` providers** — the quality baselines
   * (rating / popularity / tier) give every active provider a non-zero
   * score even with no preference match, so the family-portal always
   * has something to show. The explainability signal trail makes the
   * "why" honest: an unmatched provider surfaces only quality signals.
   *
   * Tier weights resolve through `RankingConfigService` exactly like the
   * search path (Phase-1 `global`). No DB write; the resolve is the
   * 30s-cached read.
   */
  async recommendProviders(input: {
    request: RecommendProvidersRequest;
  }): Promise<RecommendationOutcome> {
    const { request } = input;
    const resolved = await this.rankingConfig.resolveWeights();
    const tierBoost: Record<ProviderDiscoveryTier, number> = {
      basic: resolved.basic,
      certified: resolved.certified,
      elite: resolved.elite,
    };

    const scored: RecommendedProvider[] = [...this.docs.values()]
      .filter((doc) => doc.status === 'active')
      .map((doc) => scoreRecommendation(doc, request.profile, tierBoost[doc.tier]));

    const sorted = [...scored].sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      const ar = a.document.ratingAverage ?? -1;
      const br = b.document.ratingAverage ?? -1;
      if (br !== ar) return br - ar;
      return a.document.providerId.localeCompare(b.document.providerId);
    });

    return { recommendations: sorted.slice(0, request.limit) };
  }

  /**
   * TS-111-followup-4 — O(1) indexed-document count for the
   * `search_index_size_docs` gauge. The stub's whole index is the in-memory
   * `Map`, so its `size` is the exact count.
   */
  documentCount(): number {
    return this.docs.size;
  }

  resetForTesting(): void {
    this.docs.clear();
  }
}

// ─── Helpers (exported for unit tests) ──────────────────────────────────

/** A scored document carrying its distance + featured flag through sort. */
interface ScoredHit {
  doc: ProviderDiscoveryDocument;
  score: number;
  distanceKm: number | null;
  featured: boolean;
}

/**
 * Resolve the featured score multiplier for a doc against the active
 * placement set (TS-207). Returns the MAX `boostMultiplier` among the
 * placements that match — providerId, the doc's tier (or a tier-agnostic
 * placement), and (Phase 1) a region-agnostic placement — or `1` when none
 * match (no boost).
 *
 * **Phase-1 region resolution is identity.** The `SearchProvidersRequest`
 * does not yet carry a resolved region, so a placement scoped to a specific
 * `regionCode` cannot be matched and is skipped. Only `regionCode: null`
 * ("every region") placements apply. Per-region matching lands alongside
 * TS-211-followup-3's region resolution.
 */
export function resolveFeaturedBoost(
  doc: ProviderDiscoveryDocument,
  activePlacements: readonly ActiveFeaturedPlacement[],
): number {
  let boost = 1;
  for (const placement of activePlacements) {
    if (placement.providerId !== doc.providerId) continue;
    // Phase 1: region-scoped placements can't be matched (no request region).
    if (placement.regionCode !== null) continue;
    if (placement.tier !== null && placement.tier !== doc.tier) continue;
    if (placement.boostMultiplier > boost) boost = placement.boostMultiplier;
  }
  return boost;
}

export function passesFilters(
  doc: ProviderDiscoveryDocument,
  statusFilter: readonly ProviderDiscoveryStatus[],
  filters: SearchProvidersFilters | undefined,
  geo: SearchProvidersGeo | undefined,
  query: string | undefined,
): boolean {
  if (!statusFilter.includes(doc.status)) return false;
  if (filters?.tiers !== undefined && !filters.tiers.includes(doc.tier)) return false;
  if (filters?.providerIds !== undefined && !filters.providerIds.includes(doc.providerId))
    return false;

  if (filters?.languages !== undefined && !hasAnyOverlap(doc.languages, filters.languages))
    return false;
  if (filters?.specialties !== undefined && !hasAnyOverlap(doc.specialties, filters.specialties))
    return false;
  if (filters?.cuisines !== undefined && !hasAnyOverlap(doc.cuisines, filters.cuisines))
    return false;
  if (
    filters?.dietaryExpertise !== undefined &&
    !hasAnyOverlap(doc.dietaryExpertise, filters.dietaryExpertise)
  )
    return false;
  if (
    filters?.certifications !== undefined &&
    !hasAnyOverlap(doc.certifications, filters.certifications)
  )
    return false;
  if (filters?.minRating !== undefined) {
    if (doc.ratingAverage === null || doc.ratingAverage < filters.minRating) return false;
  }

  if (geo !== undefined) {
    if (doc.centroid === null) return false;
    const km = computeDistanceKm(doc, geo.center);
    if (km > geo.radiusKm) return false;
  }

  if (query !== undefined && query.length > 0) {
    if (!matchesQuery(doc, query)) return false;
  }

  return true;
}

function hasAnyOverlap(docValues: readonly string[], filterValues: readonly string[]): boolean {
  for (const v of filterValues) {
    if (docValues.includes(v)) return true;
  }
  return false;
}

export function matchesQuery(doc: ProviderDiscoveryDocument, query: string): boolean {
  // TS-216 — expand the query tokens with the senior-care + culinary
  // synonym dictionary so a search for "memory care" also matches a
  // provider tagged `dementia`, "religious dietary" surfaces `kosher`,
  // etc. Expansion is query-side only (the doc haystack stays literal),
  // mirroring an ES `synonym_graph` filter on the search analyzer; the
  // live ES wiring (TS-216-followup-1) loads the same dictionary.
  const tokens = expandQueryTokens(tokenizeText(query), SENIOR_CARE_SYNONYM_INDEX);
  if (tokens.length === 0) return true;
  const haystack = tokenizeText(
    `${doc.displayName} ${doc.headline ?? ''} ${doc.bio ?? ''} ${doc.specialties.join(' ')} ${doc.cuisines.join(' ')} ${doc.languages.join(' ')} ${doc.dietaryExpertise.join(' ')}`,
  );
  const set = new Set(haystack);
  // Match when at least one query token overlaps. Phase-1 OR-search;
  // the live ES wiring will swap in BM25 ANY-token relevance.
  for (const token of tokens) {
    if (set.has(token)) return true;
  }
  return false;
}

export function computeScore(
  doc: ProviderDiscoveryDocument,
  query: string | undefined,
  tierMultiplier: number,
): number {
  let base = 1;

  if (query !== undefined && query.length > 0) {
    // TS-216 — synonym-expanded query tokens (see `matchesQuery`). A
    // synonym hit counts toward the overlap score, so a "memory care"
    // search both surfaces and ranks `dementia`-tagged providers.
    const tokens = expandQueryTokens(tokenizeText(query), SENIOR_CARE_SYNONYM_INDEX);
    const haystack = tokenizeText(
      `${doc.displayName} ${doc.headline ?? ''} ${doc.bio ?? ''} ${doc.specialties.join(' ')} ${doc.cuisines.join(' ')}`,
    );
    const set = new Set(haystack);
    let overlaps = 0;
    for (const token of tokens) {
      if (set.has(token)) overlaps += 1;
    }
    base = 1 + overlaps;
  }

  const ratingContribution = (doc.ratingAverage ?? 3) / 5;
  const popularityContribution = Math.min(doc.completedBookingCount / 100, 1);
  return base * tierMultiplier * (1 + 0.5 * ratingContribution + 0.25 * popularityContribution);
}

export function computeDistanceKm(
  doc: ProviderDiscoveryDocument,
  center: { latitude: number; longitude: number },
): number {
  if (doc.centroid === null) return Number.POSITIVE_INFINITY;
  return haversineKm(doc.centroid, center);
}

/**
 * Earth radius in kilometres. WGS84 mean radius; sufficient accuracy
 * for the family-portal radius-search use case (~50 km typical).
 */
const EARTH_RADIUS_KM = 6371.0088;

export function haversineKm(
  a: { latitude: number; longitude: number },
  b: { latitude: number; longitude: number },
): number {
  const dLat = toRadians(b.latitude - a.latitude);
  const dLon = toRadians(b.longitude - a.longitude);
  const lat1 = toRadians(a.latitude);
  const lat2 = toRadians(b.latitude);
  const h = Math.sin(dLat / 2) ** 2 + Math.sin(dLon / 2) ** 2 * Math.cos(lat1) * Math.cos(lat2);
  const c = 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
  return EARTH_RADIUS_KM * c;
}

function toRadians(degrees: number): number {
  return (degrees * Math.PI) / 180;
}

/**
 * TS-210 — exponential geo-distance decay multiplier applied to a hit's
 * relevance score. `factor = exp(-distanceKm / scaleKm)`: 1.0 at the
 * search center, decaying to `1/e` (~0.368) at one scale length and
 * monotonically toward 0 beyond. A smaller `scaleKm` penalizes distance
 * more aggressively.
 *
 * Returns `1` (no decay) when distance is unavailable or nonsensical —
 * `null` distance (no geo center supplied), a non-finite distance
 * (a null-centroid doc reports `Infinity`, though `passesFilters`
 * already removes those when geo is present), or a non-positive scale
 * (defensive — the env schema enforces `positive()`).
 *
 * The live ES wiring (TS-111-followup-1) maps this onto an ES `exp`
 * `function_score` decay with `scale` / `decay` calibrated to the same
 * curve, so the Phase-1 and live rankings stay aligned.
 */
export function geoDecayFactor(distanceKm: number | null, scaleKm: number): number {
  if (distanceKm === null || !Number.isFinite(distanceKm) || distanceKm <= 0) return 1;
  if (!Number.isFinite(scaleKm) || scaleKm <= 0) return 1;
  return Math.exp(-distanceKm / scaleKm);
}

// ─── TS-213 match-recommendation scoring ────────────────────────────────

/**
 * Per-matched-value weights for the four preference-match signals + the
 * three quality baselines. Match signals are weighted to dominate over
 * the quality baselines so a well-matched Basic provider can outrank a
 * poorly-matched Elite — recommendations are about fit first, prestige
 * second. Tuned constants live here (not the contract); the live ES
 * `function_score` wiring (TS-111-followup-1) maps onto the same curve.
 */
export const RECOMMENDATION_WEIGHT_LANGUAGE = 3;
export const RECOMMENDATION_WEIGHT_DIETARY = 2.5;
export const RECOMMENDATION_WEIGHT_CUISINE = 2;
/** Dementia experience is a binary, high-weight gate — cognitive needs are a strong fit signal. */
export const RECOMMENDATION_WEIGHT_DEMENTIA = 4;
export const RECOMMENDATION_WEIGHT_RATING = 1;
export const RECOMMENDATION_WEIGHT_POPULARITY = 0.5;
export const RECOMMENDATION_WEIGHT_TIER = 1;

/**
 * Cap on the number of matched values that count toward a single match
 * signal's contribution. A provider listing many languages shouldn't
 * dominate purely on count; senior signal arrays are small in practice,
 * so this is defensive.
 */
export const RECOMMENDATION_MATCH_VALUES_CAP = 3;

/**
 * Provider specialty / dietary-expertise tags that mark dementia-sensitive
 * / memory-care experience. A senior with cognitive needs (intake
 * `dementiaStatus !== 'none'`) boosts providers carrying any of these.
 * Open-vocab tags drift across providers, so we match a small synonym
 * set rather than a single canonical tag. Extending this set is the
 * cheap lever before a proper taxonomy (TS-216 synonym dictionary).
 */
export const DEMENTIA_SPECIALTY_TAGS: readonly string[] = [
  'dementia',
  'dementia_sensitive',
  'dementia-sensitive',
  'dementia_care',
  'dementia-care',
  'memory_care',
  'memory-care',
  'alzheimers',
  'cognitive_care',
  'cognitive-care',
];

/** Set intersection preserving the order of `a`, deduped. */
function intersectOrdered(a: readonly string[], b: readonly string[]): string[] {
  const bSet = new Set(b);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of a) {
    if (bSet.has(value) && !seen.has(value)) {
      seen.add(value);
      out.push(value);
    }
  }
  return out;
}

/**
 * Score a single provider document against a de-identified senior
 * signal profile (TS-213). Returns the scored recommendation carrying
 * an explainability signal trail whose `contribution`s sum to `score`.
 *
 * Signals, in trail order:
 *   1. match signals (language / dietary / cuisine / dementia) — emitted
 *      only when the provider matches the senior on that facet;
 *   2. quality baselines (rating / popularity / tier) — always emitted,
 *      so even an unmatched provider has a non-zero, explainable score.
 *
 * Match contribution = weight × min(matchCount, RECOMMENDATION_MATCH_VALUES_CAP)
 * for the per-value facets; the dementia signal is binary (weight when
 * any synonym matches, 0 otherwise).
 */
export function scoreRecommendation(
  doc: ProviderDiscoveryDocument,
  profile: RecommendationSeniorProfile,
  tierMultiplier: number,
): RecommendedProvider {
  const signals: RecommendationSignal[] = [];

  const languageMatched = intersectOrdered(profile.languages, doc.languages);
  if (languageMatched.length > 0) {
    signals.push({
      kind: 'language',
      matchedValues: languageMatched,
      contribution:
        RECOMMENDATION_WEIGHT_LANGUAGE *
        Math.min(languageMatched.length, RECOMMENDATION_MATCH_VALUES_CAP),
    });
  }

  const dietaryMatched = intersectOrdered(profile.dietaryTags, doc.dietaryExpertise);
  if (dietaryMatched.length > 0) {
    signals.push({
      kind: 'dietary',
      matchedValues: dietaryMatched,
      contribution:
        RECOMMENDATION_WEIGHT_DIETARY *
        Math.min(dietaryMatched.length, RECOMMENDATION_MATCH_VALUES_CAP),
    });
  }

  const cuisineMatched = intersectOrdered(profile.cuisinePreferences, doc.cuisines);
  if (cuisineMatched.length > 0) {
    signals.push({
      kind: 'cuisine',
      matchedValues: cuisineMatched,
      contribution:
        RECOMMENDATION_WEIGHT_CUISINE *
        Math.min(cuisineMatched.length, RECOMMENDATION_MATCH_VALUES_CAP),
    });
  }

  if (profile.dementiaSensitive) {
    const dementiaMatched = intersectOrdered(doc.specialties, DEMENTIA_SPECIALTY_TAGS);
    if (dementiaMatched.length > 0) {
      signals.push({
        kind: 'dementia_experience',
        matchedValues: dementiaMatched,
        contribution: RECOMMENDATION_WEIGHT_DEMENTIA,
      });
    }
  }

  // Quality baselines — always present so every active provider has a
  // non-zero, explainable score.
  const ratingContribution = (RECOMMENDATION_WEIGHT_RATING * (doc.ratingAverage ?? 3)) / 5;
  signals.push({ kind: 'rating', matchedValues: [], contribution: ratingContribution });

  const popularityContribution =
    RECOMMENDATION_WEIGHT_POPULARITY * Math.min(doc.completedBookingCount / 100, 1);
  signals.push({ kind: 'popularity', matchedValues: [], contribution: popularityContribution });

  signals.push({
    kind: 'tier',
    matchedValues: [],
    contribution: RECOMMENDATION_WEIGHT_TIER * tierMultiplier,
  });

  const score = signals.reduce((sum, signal) => sum + signal.contribution, 0);
  return { document: doc, score, signals };
}

function sortHits(hits: ScoredHit[], sort: SearchProvidersRequest['sort']): ScoredHit[] {
  return [...hits].sort((a, b) => {
    switch (sort) {
      case 'rating': {
        const ar = a.doc.ratingAverage ?? -1;
        const br = b.doc.ratingAverage ?? -1;
        if (br !== ar) return br - ar;
        // Tie-break by ratingCount, then by score
        if (b.doc.ratingCount !== a.doc.ratingCount) return b.doc.ratingCount - a.doc.ratingCount;
        return b.score - a.score;
      }
      case 'distance': {
        const ad = a.distanceKm ?? Number.POSITIVE_INFINITY;
        const bd = b.distanceKm ?? Number.POSITIVE_INFINITY;
        if (ad !== bd) return ad - bd;
        return b.score - a.score;
      }
      case 'relevance':
      default:
        // Score descending, then by providerId for stability
        if (b.score !== a.score) return b.score - a.score;
        return a.doc.providerId.localeCompare(b.doc.providerId);
    }
  });
}

const CURSOR_OFFSET_PREFIX = 'offset:';

export function parseOffsetCursor(cursor: string | undefined): number {
  if (cursor === undefined) return 0;
  if (!cursor.startsWith(CURSOR_OFFSET_PREFIX)) return 0;
  const n = Number.parseInt(cursor.slice(CURSOR_OFFSET_PREFIX.length), 10);
  if (!Number.isFinite(n) || n < 0) return 0;
  return n;
}

export function computeFacets(docs: readonly ProviderDiscoveryDocument[]): ProviderDiscoveryFacets {
  return {
    tiers: aggregate(docs, (d) => [d.tier]),
    languages: aggregate(docs, (d) => d.languages),
    specialties: aggregate(docs, (d) => d.specialties),
    cuisines: aggregate(docs, (d) => d.cuisines),
    certifications: aggregate(docs, (d) => d.certifications),
  };
}

const FACET_BUCKET_LIMIT = 32;

function aggregate(
  docs: readonly ProviderDiscoveryDocument[],
  extractor: (doc: ProviderDiscoveryDocument) => readonly string[],
): ProviderDiscoveryFacetBucket[] {
  const counts = new Map<string, number>();
  for (const doc of docs) {
    for (const value of extractor(doc)) {
      counts.set(value, (counts.get(value) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .sort((a, b) => {
      if (b[1] !== a[1]) return b[1] - a[1];
      return a[0].localeCompare(b[0]);
    })
    .slice(0, FACET_BUCKET_LIMIT)
    .map(([value, count]) => ({ value, count }));
}
