import { Injectable } from '@nestjs/common';
import type {
  AdAccessibilityReport,
  AdCreativeKind,
  AdCreativeReviewDecision,
  AdCreativeStatus,
  AdvertiserKind,
} from '@taste-and-see/contracts';

import { PrismaService, type PrismaTransactionClient } from '../../../prisma/prisma.service';

/**
 * Local mirrors of the Prisma-generated `ad_creatives` (with its TS-277
 * accessibility columns) / `ad_campaigns` (context projection) /
 * `ad_creative_reviews` rows, narrowed to the columns this module reads/writes.
 * Same TS-021-followup-3 rationale documented across the codebase (Prisma row
 * types resolve inconsistently under our tsconfig, so we project shapes by hand;
 * dropped on the next Prisma bump — TS-277a-followup).
 */
export interface AdCreativeWithAccessibilityRow {
  readonly id: string;
  readonly campaignId: string;
  readonly kind: AdCreativeKind;
  readonly assetKeys: readonly string[];
  readonly headline: string;
  readonly body: string | null;
  readonly ctaUrl: string | null;
  readonly status: AdCreativeStatus;
  readonly altText: string | null;
  readonly textColor: string | null;
  readonly backgroundColor: string | null;
  readonly motionSafe: boolean;
  readonly disclosureAcknowledged: boolean;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface AdCampaignContextRow {
  readonly id: string;
  readonly name: string;
  readonly advertiserKind: AdvertiserKind;
}

export interface AdCreativeReviewRow {
  readonly id: string;
  readonly creativeId: string;
  readonly decision: AdCreativeReviewDecision;
  readonly reviewerUserId: string;
  readonly notes: string | null;
  readonly accessibilityPassed: boolean;
  /** The persisted JSONB report snapshot; validated on read by the service. */
  readonly accessibilityReport: unknown;
  readonly overrodeAccessibility: boolean;
  readonly createdAt: Date;
}

/** A partial accessibility-metadata update (only present keys are written). */
export interface CreativeAccessibilityPatchData {
  altText?: string | null;
  textColor?: string | null;
  backgroundColor?: string | null;
  motionSafe?: boolean;
  disclosureAcknowledged?: boolean;
}

/** A review-decision row to append (the report is pre-snapshotted by the service). */
export interface ReviewWriteData {
  readonly creativeId: string;
  readonly decision: AdCreativeReviewDecision;
  readonly reviewerUserId: string;
  readonly notes: string | null;
  readonly accessibilityPassed: boolean;
  readonly accessibilityReport: AdAccessibilityReport;
  readonly overrodeAccessibility: boolean;
}

/** Explicit column projections — never `SELECT *` (CLAUDE.md §4.1). */
const CREATIVE_SELECT = {
  id: true,
  campaignId: true,
  kind: true,
  assetKeys: true,
  headline: true,
  body: true,
  ctaUrl: true,
  status: true,
  altText: true,
  textColor: true,
  backgroundColor: true,
  motionSafe: true,
  disclosureAcknowledged: true,
  createdAt: true,
  updatedAt: true,
} as const;

const CAMPAIGN_CONTEXT_SELECT = {
  id: true,
  name: true,
  advertiserKind: true,
} as const;

const REVIEW_SELECT = {
  id: true,
  creativeId: true,
  decision: true,
  reviewerUserId: true,
  notes: true,
  accessibilityPassed: true,
  accessibilityReport: true,
  overrodeAccessibility: true,
  createdAt: true,
} as const;

/**
 * Persistence for the creative approval-workflow surface (TS-277; PDD §18.3) —
 * `ad_creatives` (with its accessibility columns), the `ad_campaigns` context
 * projection, and the append-only `ad_creative_reviews` log.
 *
 * `AdCreative` / `AdCampaign` / `AdCreativeReview` are `unscopedModel`s
 * (platform-wide marketing-admin inventory — see `app.module.ts`), so the
 * tenant-scope gate short-circuits to `proceed_unscoped_model` before any
 * request-context check: these reads/writes need no `RequestContext` frame and
 * no `runWithoutTenantContext` wrapper (the same posture as `CampaignRepository`
 * / `SlotInventoryRepository`).
 */
@Injectable()
export class CreativeReviewRepository {
  constructor(private readonly prisma: PrismaService) {}

  /** `pending_review` creatives ordered by `createdAt` ascending (FIFO queue). */
  async listPendingReview(limit: number): Promise<readonly AdCreativeWithAccessibilityRow[]> {
    return (await this.prisma.adCreative.findMany({
      where: { status: 'pending_review' },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: limit,
      select: CREATIVE_SELECT,
    })) as AdCreativeWithAccessibilityRow[];
  }

  /** A single creative (with its accessibility columns), or null. */
  async findCreative(creativeId: string): Promise<AdCreativeWithAccessibilityRow | null> {
    return (await this.prisma.adCreative.findUnique({
      where: { id: creativeId },
      select: CREATIVE_SELECT,
    })) as AdCreativeWithAccessibilityRow | null;
  }

  /** The campaign context for a single campaign, or null. */
  async findCampaignContext(campaignId: string): Promise<AdCampaignContextRow | null> {
    return (await this.prisma.adCampaign.findUnique({
      where: { id: campaignId },
      select: CAMPAIGN_CONTEXT_SELECT,
    })) as AdCampaignContextRow | null;
  }

  /** Batch-load campaign context for a set of ids (the review-queue join). */
  async listCampaignContexts(
    campaignIds: readonly string[],
  ): Promise<readonly AdCampaignContextRow[]> {
    if (campaignIds.length === 0) return [];
    return (await this.prisma.adCampaign.findMany({
      where: { id: { in: [...campaignIds] } },
      select: CAMPAIGN_CONTEXT_SELECT,
    })) as AdCampaignContextRow[];
  }

  /** A creative's review history, newest first. */
  async listReviews(creativeId: string): Promise<readonly AdCreativeReviewRow[]> {
    return (await this.prisma.adCreativeReview.findMany({
      where: { creativeId },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      select: REVIEW_SELECT,
    })) as AdCreativeReviewRow[];
  }

  /**
   * Apply a partial accessibility-metadata update to a creative. `onPersist`
   * runs inside the same transaction as the update (the audit-outbox append, so
   * the audit row commits atomically with the edit — CLAUDE.md §3.6, §5.3).
   */
  async updateAccessibility(
    creativeId: string,
    data: CreativeAccessibilityPatchData,
    onPersist?: (
      tx: PrismaTransactionClient,
      updated: AdCreativeWithAccessibilityRow,
    ) => Promise<void>,
  ): Promise<AdCreativeWithAccessibilityRow> {
    return this.prisma.$transaction(async (tx: PrismaTransactionClient) => {
      const updated = (await tx.adCreative.update({
        where: { id: creativeId },
        data,
        select: CREATIVE_SELECT,
      })) as AdCreativeWithAccessibilityRow;
      if (onPersist !== undefined) await onPersist(tx, updated);
      return updated;
    });
  }

  /**
   * Apply a review decision: set the creative's new status AND append the
   * immutable review row in one transaction (the status flip + the audit record
   * must land together — CLAUDE.md §3.6).
   */
  async applyReview(
    params: {
      readonly creativeId: string;
      readonly newStatus: AdCreativeStatus;
      readonly review: ReviewWriteData;
    },
    onPersist?: (
      tx: PrismaTransactionClient,
      result: { creative: AdCreativeWithAccessibilityRow; review: AdCreativeReviewRow },
    ) => Promise<void>,
  ): Promise<{ creative: AdCreativeWithAccessibilityRow; review: AdCreativeReviewRow }> {
    const { creativeId, newStatus, review } = params;
    return this.prisma.$transaction(async (tx: PrismaTransactionClient) => {
      const creative = (await tx.adCreative.update({
        where: { id: creativeId },
        data: { status: newStatus },
        select: CREATIVE_SELECT,
      })) as AdCreativeWithAccessibilityRow;

      const created = (await tx.adCreativeReview.create({
        data: {
          creativeId: review.creativeId,
          decision: review.decision,
          reviewerUserId: review.reviewerUserId,
          notes: review.notes,
          accessibilityPassed: review.accessibilityPassed,
          accessibilityReport: review.accessibilityReport,
          overrodeAccessibility: review.overrodeAccessibility,
        },
        select: REVIEW_SELECT,
      })) as AdCreativeReviewRow;

      const result = { creative, review: created };
      if (onPersist !== undefined) await onPersist(tx, result);
      return result;
    });
  }
}
