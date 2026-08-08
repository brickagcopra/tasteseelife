import { Injectable } from '@nestjs/common';

import { PrismaService } from '../../../prisma/prisma.service';

/**
 * An active provider campaign eligible to fill a sponsored slot: the sponsored
 * provider, the campaign, and the single approved `sponsored_listing` creative
 * that would render. `startAt` / `createdAt` are carried so the service can pick
 * a deterministic winner when a provider has more than one active campaign.
 */
export interface ActiveSponsoredCampaign {
  readonly campaignId: string;
  readonly providerId: string;
  readonly creativeId: string;
  readonly startAt: Date | null;
  readonly createdAt: Date;
}

/**
 * Reads the active sponsored-listing inventory from `ad_campaigns` /
 * `ad_creatives` (TS-218a; PDD §8.2, §18.1).
 *
 * `AdCampaign` / `AdCreative` are `unscopedModel`s (platform-wide
 * marketing-admin inventory — see `app.module.ts`), so the tenant-scope gate
 * short-circuits to `proceed_unscoped_model` before any request-context check:
 * this read needs no `RequestContext` frame and no `runWithoutTenantContext`
 * wrapper (the same posture as `AdTargetingRuleRepository`).
 */
@Injectable()
export class SponsoredCampaignRepository {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Active provider campaigns among `providerIds` that carry at least one
   * APPROVED `sponsored_listing` creative and are inside their flight window
   * at `now`.
   *
   * Eligibility (PDD §18.1):
   *   - `advertiserKind = provider` (a sponsored provider listing, not a
   *     partner co-marketing card or internal house ad).
   *   - `status = active`.
   *   - `advertiserId ∈ providerIds` — candidate-scoped (the resolve only
   *     considers providers the search query already surfaced organically).
   *   - flight window: `startAt` null or ≤ now AND `endAt` null or > now.
   *   - has ≥ 1 creative with `status = approved` AND `kind = sponsored_listing`.
   *
   * Budget exhaustion is NOT gated here — spend tracking rides on the
   * TS-275/TS-276 impression → spend aggregation (a carved followup). Today an
   * over-budget campaign is excluded only when ops pauses it.
   *
   * Returns one row per (campaign with a renderable creative); a provider with
   * several active campaigns yields several rows (the service picks the winner).
   * An empty `providerIds` short-circuits to an empty result without a query.
   */
  async findActiveSponsoredCampaigns(params: {
    readonly providerIds: readonly string[];
    readonly now: Date;
  }): Promise<ActiveSponsoredCampaign[]> {
    const { providerIds, now } = params;
    if (providerIds.length === 0) {
      return [];
    }

    // String-literal enum values rather than `@prisma/client`-imported enum
    // members: in this pnpm monorepo `@prisma/client` may resolve to another
    // service's generated client, so importing `AdvertiserKind` & friends is
    // unreliable (the convention `AdTargetingRuleRepository` already follows).
    const rows = await this.prisma.adCampaign.findMany({
      where: {
        advertiserKind: 'provider',
        status: 'active',
        advertiserId: { in: [...providerIds] },
        AND: [
          { OR: [{ startAt: null }, { startAt: { lte: now } }] },
          { OR: [{ endAt: null }, { endAt: { gt: now } }] },
        ],
      },
      select: {
        id: true,
        advertiserId: true,
        startAt: true,
        createdAt: true,
        creatives: {
          where: {
            status: 'approved',
            kind: 'sponsored_listing',
          },
          select: { id: true },
          orderBy: { createdAt: 'asc' },
          take: 1,
        },
      },
    });

    const eligible: ActiveSponsoredCampaign[] = [];
    for (const row of rows) {
      const creative = row.creatives[0];
      // A provider campaign with no approved sponsored_listing creative can't
      // render — drop it (the `take: 1` projection yields an empty array).
      if (row.advertiserId == null || creative === undefined) {
        continue;
      }
      eligible.push({
        campaignId: row.id,
        providerId: row.advertiserId,
        creativeId: creative.id,
        startAt: row.startAt,
        createdAt: row.createdAt,
      });
    }
    return eligible;
  }
}
