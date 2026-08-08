import { Inject, Injectable, Logger } from '@nestjs/common';
import type {
  AdTargetingAudience,
  ResolveSponsoredListingsResponse,
  SponsoredListing,
} from '@taste-and-see/contracts';
import { withSpan } from '@taste-and-see/tracing';

import { TargetingService } from '../../targeting/services/targeting.service';
import { SPONSORED_LISTINGS_CLOCK_TOKEN, type Clock } from '../sponsored-listings.clock';
import {
  SponsoredCampaignRepository,
  type ActiveSponsoredCampaign,
} from '../repositories/sponsored-campaign.repository';
import { SponsoredListingsMetrics } from './sponsored-listings-metrics';

/**
 * Input to a resolve — the search-supplied slot + audience + organic candidate
 * order + the number of slots to fill.
 */
export interface ResolveSponsoredListingsInput {
  readonly slotCode: string;
  readonly audience: AdTargetingAudience;
  readonly candidateProviderIds: readonly string[];
  readonly limit: number;
}

/**
 * Resolves which of `service-search`'s organic candidates are sponsored for a
 * slot (TS-218a; PRD §10.9; PDD §18.1, §18.3).
 *
 * The monetisation decision lives here; the relevance decision stays in
 * `service-search` (see the `sponsored-listings.schema` doc-block). The result
 * is ordered by `service-search` relevance among the sponsored subset and
 * deduplicated by provider — a provider never occupies two slots.
 *
 * Algorithm:
 *   1. Load the active sponsored inventory for the candidate set.
 *   2. Group eligible campaigns by provider; within a provider, order by a
 *      deterministic winner rule (most-recently-started, then newest, then id).
 *   3. Walk the candidates in relevance order; for each, take the first of its
 *      campaigns whose targeting rules match the audience (fail-closed on a
 *      malformed rule, per `TargetingService`). Stop once `limit` slots fill.
 */
@Injectable()
export class SponsoredListingsService {
  private readonly logger = new Logger(SponsoredListingsService.name);

  constructor(
    private readonly campaigns: SponsoredCampaignRepository,
    private readonly targeting: TargetingService,
    @Inject(SPONSORED_LISTINGS_CLOCK_TOKEN) private readonly clock: Clock,
    private readonly metrics: SponsoredListingsMetrics,
  ) {}

  async resolve(input: ResolveSponsoredListingsInput): Promise<ResolveSponsoredListingsResponse> {
    // Wrap the resolve in a domain span so the monetisation decision is visible
    // as its own boundary under the auto-instrumented HTTP span. The free-form
    // `slotCode` rides the span (high-cardinality-tolerant), never a metric
    // label (TS-218a-followup-3; CLAUDE.md §10).
    return withSpan('ads.sponsored_listings.resolve', async (span) => {
      const { slotCode, audience, candidateProviderIds, limit } = input;
      const now = this.clock.now();
      span.setAttributes({
        'ads.slot_code': slotCode,
        'ads.candidate_count': candidateProviderIds.length,
        'ads.limit': limit,
      });

      if (candidateProviderIds.length === 0) {
        span.setAttributes({ 'ads.eligible_campaign_count': 0, 'ads.filled_count': 0 });
        this.metrics.recordResolve({ candidateCount: 0, filledCount: 0, limit });
        return { slotCode, listings: [], resolvedAt: now.toISOString() };
      }

      const active = await this.campaigns.findActiveSponsoredCampaigns({
        providerIds: candidateProviderIds,
        now,
      });

      // Group eligible campaigns by provider, each group winner-ordered so the
      // first targeting match per provider is the deterministic winner.
      const byProvider = new Map<string, ActiveSponsoredCampaign[]>();
      for (const campaign of active) {
        const group = byProvider.get(campaign.providerId);
        if (group === undefined) {
          byProvider.set(campaign.providerId, [campaign]);
        } else {
          group.push(campaign);
        }
      }
      for (const group of byProvider.values()) {
        group.sort(compareCampaignWinner);
      }

      const listings: SponsoredListing[] = [];
      // Walk candidates in relevance order so sponsored slot order mirrors the
      // organic ranking among the sponsored subset.
      for (const providerId of candidateProviderIds) {
        if (listings.length >= limit) {
          break;
        }
        const group = byProvider.get(providerId);
        if (group === undefined) {
          continue;
        }
        const winner = await this.firstTargetingMatch(group, audience);
        if (winner !== undefined) {
          listings.push({
            providerId,
            campaignId: winner.campaignId,
            creativeId: winner.creativeId,
          });
        }
      }

      span.setAttributes({
        'ads.eligible_campaign_count': active.length,
        'ads.filled_count': listings.length,
      });
      this.metrics.recordResolve({
        candidateCount: candidateProviderIds.length,
        filledCount: listings.length,
        limit,
      });

      this.logger.log(
        `sponsored-listings resolved slot=${slotCode} candidates=${candidateProviderIds.length} ` +
          `eligibleCampaigns=${active.length} filled=${listings.length}/${limit}`,
      );

      return { slotCode, listings, resolvedAt: now.toISOString() };
    });
  }

  /**
   * The first campaign in winner-order whose targeting matches the audience, or
   * `undefined` if none match. Evaluation stops at the first match so a provider
   * with several campaigns costs at most one targeting load per losing campaign.
   */
  private async firstTargetingMatch(
    group: readonly ActiveSponsoredCampaign[],
    audience: AdTargetingAudience,
  ): Promise<ActiveSponsoredCampaign | undefined> {
    for (const campaign of group) {
      const decision = await this.targeting.evaluateCampaignTargeting(
        campaign.campaignId,
        audience,
      );
      if (decision.match) {
        return campaign;
      }
    }
    return undefined;
  }
}

/**
 * Deterministic winner ordering for two active campaigns of the same provider:
 * most-recently-started first (a null `startAt` — "started whenever created" —
 * sorts after a concrete start), then newest-created, then campaign id as the
 * final stable tiebreak.
 */
function compareCampaignWinner(a: ActiveSponsoredCampaign, b: ActiveSponsoredCampaign): number {
  const aStart = a.startAt?.getTime() ?? Number.NEGATIVE_INFINITY;
  const bStart = b.startAt?.getTime() ?? Number.NEGATIVE_INFINITY;
  if (aStart !== bStart) {
    return bStart - aStart;
  }
  const createdDelta = b.createdAt.getTime() - a.createdAt.getTime();
  if (createdDelta !== 0) {
    return createdDelta;
  }
  return a.campaignId < b.campaignId ? -1 : a.campaignId > b.campaignId ? 1 : 0;
}
