import { Injectable } from '@nestjs/common';
import type {
  AdCampaignStatus,
  AdCreativeKind,
  AdCreativeStatus,
  AdTargetingRuleKind,
  AdvertiserKind,
} from '@taste-and-see/contracts';

import { PrismaService, type PrismaTransactionClient } from '../../../prisma/prisma.service';

/**
 * A persisted-Decimal value as Prisma returns it for a `Decimal?` column — a
 * `decimal.js`-backed object exposing `toFixed`. Typed structurally so the
 * repository never imports the `Prisma.Decimal` value-side (the
 * `@prisma/client` pnpm-hoist convention this service already follows —
 * `SponsoredCampaignRepository` / `AdTargetingRuleRepository`).
 */
export interface DecimalLike {
  toFixed(places: number): string;
}

/**
 * Local mirrors of the Prisma-generated `ad_campaigns` / `ad_creatives` /
 * `ad_targeting_rules` rows, narrowed to the columns this module reads/writes.
 * Same TS-021-followup-3 rationale documented across the codebase — Prisma's
 * row types resolve inconsistently under our tsconfig so we project shapes by
 * hand (dropped on the next Prisma bump — TS-271a-followup).
 *
 * `budget` is the raw persisted `Decimal(12,2)` (or null); the service crosses
 * the money boundary to integer minor units exactly once. `value` is the raw
 * targeting-rule AST TEXT; the service decodes it via `parseAdTargetingPredicate`.
 */
export interface AdCampaignRow {
  readonly id: string;
  readonly name: string;
  readonly advertiserKind: AdvertiserKind;
  readonly advertiserId: string | null;
  readonly status: AdCampaignStatus;
  readonly budget: DecimalLike | string | number | null;
  readonly currency: string;
  readonly startAt: Date | null;
  readonly endAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface AdCreativeRow {
  readonly id: string;
  readonly campaignId: string;
  readonly kind: AdCreativeKind;
  readonly assetKeys: readonly string[];
  readonly headline: string;
  readonly body: string | null;
  readonly ctaUrl: string | null;
  readonly status: AdCreativeStatus;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface AdTargetingRuleRow {
  readonly id: string;
  readonly campaignId: string;
  readonly kind: AdTargetingRuleKind;
  readonly value: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/** Explicit column projections — never `SELECT *` (CLAUDE.md §4.1). */
const CAMPAIGN_SELECT = {
  id: true,
  name: true,
  advertiserKind: true,
  advertiserId: true,
  status: true,
  budget: true,
  currency: true,
  startAt: true,
  endAt: true,
  createdAt: true,
  updatedAt: true,
} as const;

const CREATIVE_SELECT = {
  id: true,
  campaignId: true,
  kind: true,
  assetKeys: true,
  headline: true,
  body: true,
  ctaUrl: true,
  status: true,
  createdAt: true,
  updatedAt: true,
} as const;

const RULE_SELECT = {
  id: true,
  campaignId: true,
  kind: true,
  value: true,
  createdAt: true,
  updatedAt: true,
} as const;

/** Campaign scalar columns to persist on create (already money/date-converted). */
export interface CampaignWriteData {
  readonly name: string;
  readonly advertiserKind: AdvertiserKind;
  readonly advertiserId: string | null;
  readonly status: AdCampaignStatus;
  /** Decimal(12,2) dollars as a string (e.g. "5000.00"), or null = uncapped. */
  readonly budget: string | null;
  readonly currency: string;
  readonly startAt: Date | null;
  readonly endAt: Date | null;
}

/** A creative to persist nested under its campaign. */
export interface CreativeWriteData {
  readonly kind: AdCreativeKind;
  readonly assetKeys: readonly string[];
  readonly headline: string;
  readonly body: string | null;
  readonly ctaUrl: string | null;
  readonly status: AdCreativeStatus;
}

/** A targeting rule to persist nested under its campaign (predicate pre-encoded). */
export interface TargetingRuleWriteData {
  readonly kind: AdTargetingRuleKind;
  /** `JSON.stringify(predicate)` — the AST TEXT (TS-273). */
  readonly value: string;
}

/** A partial scalar update on a campaign (only present keys are written). */
export interface CampaignPatchData {
  name?: string;
  advertiserId?: string | null;
  budget?: string | null;
  currency?: string;
  startAt?: Date | null;
  endAt?: Date | null;
  status?: AdCampaignStatus;
}

export interface CampaignAggregateRows {
  readonly campaign: AdCampaignRow;
  readonly creatives: readonly AdCreativeRow[];
  readonly targetingRules: readonly AdTargetingRuleRow[];
}

/**
 * Persistence for the ad-campaign aggregate (TS-271a; PDD §8.2, §18.1).
 *
 * `AdCampaign` / `AdCreative` / `AdTargetingRule` are `unscopedModel`s
 * (platform-wide marketing-admin inventory — see `app.module.ts`), so the
 * tenant-scope gate short-circuits to `proceed_unscoped_model` before any
 * request-context check: these reads/writes need no `RequestContext` frame and
 * no `runWithoutTenantContext` wrapper (the same posture as
 * `SponsoredCampaignRepository` / `AdTargetingRuleRepository`).
 *
 * The repository deals in RAW persisted shapes (budget as a `Decimal`, the
 * targeting predicate as TEXT). Money ↔ minor-unit conversion and AST
 * encode/decode live in `CampaignsService`.
 */
@Injectable()
export class CampaignRepository {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Create a campaign with its initial creatives + targeting rules in one
   * transaction, then read the three result sets back ordered by creation.
   *
   * `onPersist` (when supplied) runs INSIDE the same transaction after the
   * aggregate is read back — the audit-outbox append, so the audit row commits
   * atomically with the campaign (CLAUDE.md §3.6, §5.3). It throwing rolls the
   * whole create back.
   */
  async createAggregate(
    params: {
      readonly campaign: CampaignWriteData;
      readonly creatives: readonly CreativeWriteData[];
      readonly targetingRules: readonly TargetingRuleWriteData[];
    },
    onPersist?: (tx: PrismaTransactionClient, aggregate: CampaignAggregateRows) => Promise<void>,
  ): Promise<CampaignAggregateRows> {
    const { campaign, creatives, targetingRules } = params;
    return this.prisma.$transaction(async (tx: PrismaTransactionClient) => {
      const created = (await tx.adCampaign.create({
        data: {
          name: campaign.name,
          advertiserKind: campaign.advertiserKind,
          advertiserId: campaign.advertiserId,
          status: campaign.status,
          budget: campaign.budget,
          currency: campaign.currency,
          startAt: campaign.startAt,
          endAt: campaign.endAt,
          // Conditional spreads rather than an explicit `undefined` value:
          // an empty child collection must leave the nested-write key ABSENT,
          // and `exactOptionalPropertyTypes` rejects a present-but-`undefined`
          // property against the generated create input (TS-501).
          ...(creatives.length > 0 && {
            creatives: { create: creatives.map((c) => ({ ...c, assetKeys: [...c.assetKeys] })) },
          }),
          ...(targetingRules.length > 0 && {
            targetingRules: { create: targetingRules.map((r) => ({ ...r })) },
          }),
        },
        select: CAMPAIGN_SELECT,
      })) as AdCampaignRow;

      const creativeRows = (await tx.adCreative.findMany({
        where: { campaignId: created.id },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        select: CREATIVE_SELECT,
      })) as AdCreativeRow[];

      const ruleRows = (await tx.adTargetingRule.findMany({
        where: { campaignId: created.id },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        select: RULE_SELECT,
      })) as AdTargetingRuleRow[];

      const aggregate = { campaign: created, creatives: creativeRows, targetingRules: ruleRows };
      if (onPersist !== undefined) await onPersist(tx, aggregate);
      return aggregate;
    });
  }

  /** Shallow campaign row, or null when no campaign resolves. */
  async findCampaign(id: string): Promise<AdCampaignRow | null> {
    return (await this.prisma.adCampaign.findUnique({
      where: { id },
      select: CAMPAIGN_SELECT,
    })) as AdCampaignRow | null;
  }

  /** Campaign + its ordered creatives + rules, or null when no campaign resolves. */
  async findDetail(id: string): Promise<CampaignAggregateRows | null> {
    const campaign = await this.findCampaign(id);
    if (campaign === null) return null;

    const creatives = (await this.prisma.adCreative.findMany({
      where: { campaignId: id },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      select: CREATIVE_SELECT,
    })) as AdCreativeRow[];

    const targetingRules = (await this.prisma.adTargetingRule.findMany({
      where: { campaignId: id },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      select: RULE_SELECT,
    })) as AdTargetingRuleRow[];

    return { campaign, creatives, targetingRules };
  }

  /** Matching campaigns ordered by `createdAt` descending (newest first). */
  async listCampaigns(filter: {
    readonly status?: AdCampaignStatus | undefined;
    readonly advertiserKind?: AdvertiserKind | undefined;
    readonly limit: number;
  }): Promise<readonly AdCampaignRow[]> {
    const where: Record<string, unknown> = {};
    if (filter.status !== undefined) where['status'] = filter.status;
    if (filter.advertiserKind !== undefined) where['advertiserKind'] = filter.advertiserKind;

    return (await this.prisma.adCampaign.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: filter.limit,
      select: CAMPAIGN_SELECT,
    })) as AdCampaignRow[];
  }

  /**
   * Apply a partial scalar update to a campaign. `onPersist` runs inside the
   * same transaction as the update (the audit-outbox append — see
   * `createAggregate`).
   */
  async updateCampaign(
    id: string,
    data: CampaignPatchData,
    onPersist?: (tx: PrismaTransactionClient, updated: AdCampaignRow) => Promise<void>,
  ): Promise<AdCampaignRow> {
    return this.prisma.$transaction(async (tx: PrismaTransactionClient) => {
      const updated = (await tx.adCampaign.update({
        where: { id },
        data,
        select: CAMPAIGN_SELECT,
      })) as AdCampaignRow;
      if (onPersist !== undefined) await onPersist(tx, updated);
      return updated;
    });
  }

  /** A creative scoped to its campaign, or null when it does not resolve. */
  async findCreative(campaignId: string, creativeId: string): Promise<AdCreativeRow | null> {
    return (await this.prisma.adCreative.findFirst({
      where: { id: creativeId, campaignId },
      select: CREATIVE_SELECT,
    })) as AdCreativeRow | null;
  }

  /**
   * Set a creative's review status. `onPersist` runs inside the same
   * transaction as the update (the audit-outbox append — see `createAggregate`).
   */
  async updateCreativeStatus(
    creativeId: string,
    status: AdCreativeStatus,
    onPersist?: (tx: PrismaTransactionClient, updated: AdCreativeRow) => Promise<void>,
  ): Promise<AdCreativeRow> {
    return this.prisma.$transaction(async (tx: PrismaTransactionClient) => {
      const updated = (await tx.adCreative.update({
        where: { id: creativeId },
        data: { status },
        select: CREATIVE_SELECT,
      })) as AdCreativeRow;
      if (onPersist !== undefined) await onPersist(tx, updated);
      return updated;
    });
  }
}
