import { z } from 'zod';

import { AdTargetingAudienceSchema } from './ad-targeting.schema';

/**
 * Sponsored-listings resolve contract (TS-218a; PRD §10.9, PDD §18.1, §18.3).
 *
 * The internal service-to-service surface `service-search` calls at query time
 * to fill the reserved sponsored slot(s) on a provider-search results page.
 * `service-ads` owns the inventory + targeting decision (PDD §18 — "inventory +
 * targeting served by ads-svc"); `service-search` owns slot reservation +
 * organic ranking and renders the mandatory "Sponsored" disclosure (PDD §18.3,
 * landed search-side in TS-218b).
 *
 * ── Flow ────────────────────────────────────────────────────────────────
 *
 *   1. `service-search` ranks the organic provider candidates for a query and
 *      derives an `AdTargetingAudience` for the requesting viewer.
 *   2. It POSTs `{ slotCode, audience, candidateProviderIds, limit }` to
 *      `service-ads` (`POST /api/v1/internal/ads/sponsored-listings/resolve`,
 *      pinned by a shared-secret guard — cluster-internal, never client-facing).
 *   3. `service-ads` returns up to `limit` `{ providerId, campaignId,
 *      creativeId }` listings: providers among `candidateProviderIds` that have
 *      an ACTIVE provider campaign (advertiserKind=`provider`, status=`active`,
 *      inside its `[startAt, endAt)` flight window) carrying an APPROVED
 *      `sponsored_listing` creative, whose targeting rules match the audience.
 *
 * ── Why candidate-scoped ────────────────────────────────────────────────
 *
 * `service-ads` does not hold the provider-discovery index, so it cannot decide
 * *which* providers are relevant to a query — only which of the
 * search-supplied candidates are sponsored. Scoping the resolve to the organic
 * candidate set keeps the relevance decision in `service-search` while the
 * monetisation decision stays in `service-ads`, and guarantees a sponsored row
 * is always a provider the query would surface organically (no off-topic ads).
 *
 * ── Deferred to followups ───────────────────────────────────────────────
 *
 *   - Budget pacing / spend-exhaustion: a campaign with a non-null `budget`
 *     is eligible while `status=active`; spend tracking + exhaustion gating
 *     rides on the TS-275/TS-276 impression → spend aggregation (TS-218a
 *     followup). Today an over-budget campaign must be paused by ops.
 *   - Frequency capping (TS-274) is applied search-side / at capture time, not
 *     in this read.
 *
 * `.strict()` everywhere — an unknown field is a parse failure, not a silently
 * dropped knob (CLAUDE.md §3.3). NOT registered in the public OpenAPI document
 * (an internal service-to-service surface, like the TS-273 targeting grammar).
 */

// ─── Bounded length / count constants ───────────────────────────────────

/** A placement slot code (e.g. `search_top_tile`). Slug/code token. */
export const SPONSORED_LISTINGS_SLOT_CODE_MAX_LENGTH = 64;

/**
 * A provider / campaign / creative identifier (a CUID soft-FK; CLAUDE.md §2.3).
 * Bounded so a malformed id can't bloat the request or response payload.
 */
export const SPONSORED_LISTINGS_ID_MAX_LENGTH = 128;

/**
 * Max organic candidates `service-search` may submit in one resolve. Bounded
 * so the targeting evaluator's per-candidate rule load can't be turned into an
 * unbounded fan-out by a pathological request. Comfortably above a single
 * results page.
 */
export const SPONSORED_LISTINGS_CANDIDATES_MAX = 200;

/** Default number of sponsored slots to fill when the caller omits `limit`. */
export const SPONSORED_LISTINGS_LIMIT_DEFAULT = 3;

/** Hard ceiling on sponsored slots one resolve will return. */
export const SPONSORED_LISTINGS_LIMIT_MAX = 10;

// ─── Field schemas ──────────────────────────────────────────────────────

/**
 * A placement slot code — non-empty, length-bounded, slug/code alphabet so it
 * can never carry whitespace, control characters, or structural JSON.
 */
export const SponsoredListingSlotCodeSchema = z
  .string()
  .min(1)
  .max(SPONSORED_LISTINGS_SLOT_CODE_MAX_LENGTH)
  .regex(/^[A-Za-z0-9_.:-]+$/, 'slotCode must be a slug/code token');

/**
 * A provider / campaign / creative id token — non-empty, length-bounded, and
 * restricted to the CUID alphabet (`A-Za-z0-9_-`).
 */
export const SponsoredListingIdSchema = z
  .string()
  .min(1)
  .max(SPONSORED_LISTINGS_ID_MAX_LENGTH)
  .regex(/^[A-Za-z0-9_-]+$/, 'id must be alphanumeric / _ / -');

/** Request body for `POST /api/v1/internal/ads/sponsored-listings/resolve`. */
export const ResolveSponsoredListingsRequestSchema = z
  .object({
    /** The placement slot being filled (e.g. `search_top_tile`). */
    slotCode: SponsoredListingSlotCodeSchema,
    /**
     * The viewer the delivery decision is evaluated against. The same audience
     * grammar the campaign-admin targeting rules are written in (TS-273); an
     * untargeted campaign matches any audience.
     */
    audience: AdTargetingAudienceSchema,
    /**
     * The organic provider candidates, in `service-search` relevance order.
     * Only providers in this set can be returned as sponsored — see the module
     * doc-block for why the resolve is candidate-scoped. May be empty (the
     * resolve then returns no listings).
     */
    candidateProviderIds: z.array(SponsoredListingIdSchema).max(SPONSORED_LISTINGS_CANDIDATES_MAX),
    /** Max sponsored slots to fill. */
    limit: z
      .number()
      .int()
      .min(1)
      .max(SPONSORED_LISTINGS_LIMIT_MAX)
      .default(SPONSORED_LISTINGS_LIMIT_DEFAULT),
  })
  .strict();
export type ResolveSponsoredListingsRequest = z.infer<typeof ResolveSponsoredListingsRequestSchema>;

/**
 * One resolved sponsored listing: the sponsored provider plus the campaign +
 * creative that won the slot (carried so the search-side impression/click
 * capture — TS-275 — can attribute to the right campaign/creative).
 */
export const SponsoredListingSchema = z
  .object({
    providerId: SponsoredListingIdSchema,
    campaignId: SponsoredListingIdSchema,
    creativeId: SponsoredListingIdSchema,
  })
  .strict();
export type SponsoredListing = z.infer<typeof SponsoredListingSchema>;

/**
 * Response body for the resolve. `listings` is ordered (sponsored slot order,
 * which preserves `service-search` relevance order among the sponsored subset)
 * and deduplicated by `providerId` — one provider never occupies two slots.
 */
export const ResolveSponsoredListingsResponseSchema = z
  .object({
    slotCode: SponsoredListingSlotCodeSchema,
    listings: z.array(SponsoredListingSchema).max(SPONSORED_LISTINGS_LIMIT_MAX),
    /** Server timestamp the resolve was computed (ISO-8601). */
    resolvedAt: z.string().datetime(),
  })
  .strict();
export type ResolveSponsoredListingsResponse = z.infer<
  typeof ResolveSponsoredListingsResponseSchema
>;
