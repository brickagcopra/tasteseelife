import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  type AdTargetingAudience,
  ResolveSponsoredListingsResponseSchema,
  SPONSORED_LISTINGS_CANDIDATES_MAX,
  type SponsoredListing,
} from '@taste-and-see/contracts';

import { ENV_TOKEN } from '../../../config/config.module';
import { type Env, isSponsoredListingsEnabled } from '../../../config/env';

/**
 * The ads-inventory slot the provider-search results page fills (PDD §18.1 —
 * the "search top-tile" placement). A stable code so the campaign-admin
 * targeting (TS-271) and the resolve agree on which slot is being served.
 */
export const SEARCH_PROVIDER_SLOT_CODE = 'search_top_tile';

/** Path of the service-ads internal resolve surface (TS-218a). */
const RESOLVE_PATH = '/api/v1/internal/ads/sponsored-listings/resolve';

// Fallbacks for the optional env knobs (kept here, not as Zod defaults, so
// the env fields stay genuinely optional — see env.ts TS-218b note).
const DEFAULT_HEADER_NAME = 'x-internal-api-key';
const DEFAULT_SPONSORED_SLOTS = 2;
const DEFAULT_RESOLVE_TIMEOUT_MS = 750;

/**
 * Outbound client for the service-ads sponsored-listings resolve (TS-218b →
 * TS-218a). Given the ranked organic candidate provider ids + a derived
 * audience, it asks service-ads which of those candidates are sponsored and
 * returns the winning `{ providerId, campaignId, creativeId }` listings for
 * the search layer to seat in the top slots.
 *
 * **Best-effort by construction (fail-open).** Provider search is a pure read
 * on the critical family-portal path; monetisation must never break it. So
 * EVERY non-happy outcome — feature disabled, timeout, network error, non-2xx,
 * non-JSON / malformed body — resolves to `[]` (no sponsored rows) with a
 * `warn` log, never a thrown error. This mirrors the `SearchAnalyticsEmitter`
 * posture: the sponsored overlay is an enhancement, not a correctness-bearing
 * dependency.
 *
 * The call is pinned by a constant shared secret (`ADS_INTERNAL_API_KEY` via
 * `ADS_INTERNAL_HEADER_NAME`) — the same application-layer defence-in-depth
 * the search-indexer uses on service-search's own internal surface; TS-151
 * NetworkPolicy restricts the route to in-cluster callers.
 */
@Injectable()
export class SponsoredListingsClient {
  private readonly log = new Logger(SponsoredListingsClient.name);

  constructor(@Inject(ENV_TOKEN) private readonly env: Env) {}

  /**
   * Resolve the sponsored listings for a results page. Returns `[]` (no
   * sponsored rows) when the feature is disabled, the candidate set is empty,
   * or any failure occurs.
   */
  async resolve(input: {
    readonly audience: AdTargetingAudience;
    readonly candidateProviderIds: readonly string[];
  }): Promise<readonly SponsoredListing[]> {
    if (!isSponsoredListingsEnabled(this.env)) return [];

    const baseUrl = this.env.ADS_SERVICE_BASE_URL;
    const apiKey = this.env.ADS_INTERNAL_API_KEY;
    // `isSponsoredListingsEnabled` + the env `.superRefine` guarantee both are
    // present; the guard keeps the types honest without a non-null assertion.
    if (baseUrl === undefined || apiKey === undefined) return [];
    if (input.candidateProviderIds.length === 0) return [];

    const headerName = (this.env.ADS_INTERNAL_HEADER_NAME ?? DEFAULT_HEADER_NAME).toLowerCase();
    const limit = this.env.SEARCH_SPONSORED_SLOTS ?? DEFAULT_SPONSORED_SLOTS;
    const timeoutMs = this.env.ADS_RESOLVE_TIMEOUT_MS ?? DEFAULT_RESOLVE_TIMEOUT_MS;

    const body = {
      slotCode: SEARCH_PROVIDER_SLOT_CODE,
      audience: input.audience,
      candidateProviderIds: input.candidateProviderIds.slice(0, SPONSORED_LISTINGS_CANDIDATES_MAX),
      limit,
    };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    let response: Response;
    try {
      response = await fetch(`${baseUrl}${RESOLVE_PATH}`, {
        method: 'POST',
        headers: {
          accept: 'application/json',
          'content-type': 'application/json',
          [headerName]: apiKey,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (cause) {
      const reason = controller.signal.aborted ? 'timed out' : 'failed at the network layer';
      this.log.warn(
        `sponsored-listings resolve ${reason} (best-effort, no sponsored slots): ${
          cause instanceof Error ? cause.message : String(cause)
        }`,
      );
      return [];
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      this.log.warn(
        `sponsored-listings resolve returned HTTP ${response.status} (best-effort, no sponsored slots)`,
      );
      return [];
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      this.log.warn(
        'sponsored-listings resolve returned a non-JSON body (best-effort, no sponsored slots)',
      );
      return [];
    }

    const parsed = ResolveSponsoredListingsResponseSchema.safeParse(payload);
    if (!parsed.success) {
      this.log.warn(
        `sponsored-listings resolve returned a malformed body (best-effort, no sponsored slots): ${parsed.error.message}`,
      );
      return [];
    }

    return parsed.data.listings;
  }
}
