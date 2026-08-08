import { Injectable, Logger } from '@nestjs/common';
import {
  AdAccessibilityReportSchema,
  canTransitionAdCreative,
  creativeStatusForReviewAction,
  evaluateCreativeAccessibility,
  reviewDecisionForAction,
  type AdAccessibilityReport,
  type AdCreativeAccessibilityMetadata,
  type AdCreativeRecord,
  type AdCreativeReviewAction,
  type AdCreativeReviewItem,
  type AdCreativeReviewRecord,
  type UpdateAdCreativeAccessibilityRequest,
} from '@taste-and-see/contracts';
import type { OutboxRawExecutor } from '@taste-and-see/nest-outbox';

import { AuditEmitter } from '@taste-and-see/nest-audit';
import { ADS_AUDIT_RESOURCE } from '../../audit/audit-resources';
import type { AuditActorContext } from '@taste-and-see/nest-audit';
import {
  CreativeReviewRepository,
  type AdCampaignContextRow,
  type AdCreativeReviewRow,
  type AdCreativeWithAccessibilityRow,
  type CreativeAccessibilityPatchData,
} from '../repositories/creative-review.repository';

export interface UpdateAccessibilityInput extends UpdateAdCreativeAccessibilityRequest {
  readonly creativeId: string;
  readonly actorUserId: string;
  /** Actor + request metadata for the `audit.action_recorded` event. */
  readonly audit: AuditActorContext;
}

export interface ReviewCreativeInput {
  readonly creativeId: string;
  readonly action: AdCreativeReviewAction;
  readonly notes: string | undefined;
  readonly acknowledgeAccessibilityFailures: boolean;
  readonly reviewerUserId: string;
  readonly audit: AuditActorContext;
}

export type GetReviewDetailOutcome =
  | {
      readonly ok: true;
      readonly item: AdCreativeReviewItem;
      readonly reviews: readonly AdCreativeReviewRecord[];
    }
  | { readonly ok: false; readonly reason: 'not_found' };

export type UpdateAccessibilityOutcome =
  | { readonly ok: true; readonly item: AdCreativeReviewItem }
  | { readonly ok: false; readonly reason: 'not_found' };

export type ReviewCreativeOutcome =
  | {
      readonly ok: true;
      readonly item: AdCreativeReviewItem;
      readonly review: AdCreativeReviewRecord;
    }
  | { readonly ok: false; readonly reason: 'not_found' }
  | { readonly ok: false; readonly reason: 'not_in_review'; readonly status: string }
  | {
      readonly ok: false;
      readonly reason: 'accessibility_failed';
      readonly report: AdAccessibilityReport;
    }
  | { readonly ok: false; readonly reason: 'override_reason_required' };

/**
 * Creative approval-workflow service (TS-277; PRD §10.9; PDD §18.3).
 *
 * Owns the review domain decisions: the FIFO review queue, the live
 * accessibility evaluation (`evaluateCreativeAccessibility`), the
 * accessibility-metadata edit, and the approve / reject / request-changes
 * decision — including the audited override path when a reviewer approves a
 * creative whose accessibility report fails. Persistence (the creative status
 * flip + the append-only review row) is delegated to `CreativeReviewRepository`.
 *
 * Authorisation lives at the controller boundary: the review surface is gated on
 * `marketing:approve_creative` (a higher-trust gate than `ads:write` so the
 * campaign author cannot self-approve); the accessibility-metadata edit is the
 * author's `ads:write`. The service trusts the actor id it is handed (resolved
 * from the verified token).
 */
@Injectable()
export class CreativeReviewService {
  private readonly logger = new Logger(CreativeReviewService.name);

  constructor(
    private readonly repo: CreativeReviewRepository,
    private readonly audit: AuditEmitter,
  ) {}

  /** The `pending_review` creatives with their live accessibility reports (FIFO). */
  async getReviewQueue(limit: number): Promise<readonly AdCreativeReviewItem[]> {
    const creatives = await this.repo.listPendingReview(limit);
    if (creatives.length === 0) return [];

    const campaignIds = [...new Set(creatives.map((c) => c.campaignId))];
    const contexts = await this.repo.listCampaignContexts(campaignIds);
    const byId = new Map(contexts.map((c) => [c.id, c] as const));

    const items: AdCreativeReviewItem[] = [];
    for (const creative of creatives) {
      const campaign = byId.get(creative.campaignId);
      // A creative whose campaign vanished mid-read (FK cascade would normally
      // have removed the creative too) is skipped rather than surfaced half-built.
      if (campaign === undefined) continue;
      items.push(buildItem(creative, campaign));
    }
    return items;
  }

  /** A single creative under review with its decision history (newest first). */
  async getReviewDetail(creativeId: string): Promise<GetReviewDetailOutcome> {
    const creative = await this.repo.findCreative(creativeId);
    if (creative === null) return { ok: false, reason: 'not_found' };

    const campaign = await this.repo.findCampaignContext(creative.campaignId);
    if (campaign === null) return { ok: false, reason: 'not_found' };

    const reviewRows = await this.repo.listReviews(creativeId);
    return {
      ok: true,
      item: buildItem(creative, campaign),
      reviews: reviewRows.map(toReviewRecord),
    };
  }

  /** Set / edit a creative's accessibility metadata (the author's `ads:write`). */
  async updateAccessibility(input: UpdateAccessibilityInput): Promise<UpdateAccessibilityOutcome> {
    const creative = await this.repo.findCreative(input.creativeId);
    if (creative === null) return { ok: false, reason: 'not_found' };

    const campaign = await this.repo.findCampaignContext(creative.campaignId);
    if (campaign === null) return { ok: false, reason: 'not_found' };

    const data: CreativeAccessibilityPatchData = {};
    if (input.altText !== undefined) data.altText = input.altText;
    if (input.textColor !== undefined) data.textColor = input.textColor;
    if (input.backgroundColor !== undefined) data.backgroundColor = input.backgroundColor;
    if (input.motionSafe !== undefined) data.motionSafe = input.motionSafe;
    if (input.disclosureAcknowledged !== undefined) {
      data.disclosureAcknowledged = input.disclosureAcknowledged;
    }

    // Snapshot the before-state up front — the write must not have mutated it
    // by the time the audit hook runs.
    const beforeMetadata = toAccessibilityMetadata(creative);
    const updated = await this.repo.updateAccessibility(input.creativeId, data, async (tx, row) => {
      await this.audit.emit(tx as unknown as OutboxRawExecutor, input.audit, {
        action: 'ad_creative:accessibility_updated',
        resourceKind: ADS_AUDIT_RESOURCE.creative,
        resourceId: row.id,
        before: beforeMetadata,
        after: toAccessibilityMetadata(row),
      });
    });

    this.logger.log(
      {
        creativeId: input.creativeId,
        campaignId: updated.campaignId,
        actorUserId: input.actorUserId,
        fields: Object.keys(data),
      },
      'ad creative accessibility metadata updated',
    );
    return { ok: true, item: buildItem(updated, campaign) };
  }

  /**
   * Apply a review decision. Resolution order:
   *   1. `not_found` — the creative does not resolve.
   *   2. `not_in_review` — the creative is not in `pending_review`.
   *   3. `accessibility_failed` — `approve` with a failing report and no
   *      acknowledgement (a 422 carrying the report).
   *   4. `override_reason_required` — `approve` overriding a failing report
   *      without `notes` (the justification).
   * Only then does the status flip + review-row append fire (one transaction).
   */
  async reviewCreative(input: ReviewCreativeInput): Promise<ReviewCreativeOutcome> {
    const creative = await this.repo.findCreative(input.creativeId);
    if (creative === null) return { ok: false, reason: 'not_found' };

    const campaign = await this.repo.findCampaignContext(creative.campaignId);
    if (campaign === null) return { ok: false, reason: 'not_found' };

    if (creative.status !== 'pending_review') {
      return { ok: false, reason: 'not_in_review', status: creative.status };
    }

    const report = evaluateCreativeAccessibility(toAccessibilityInput(creative));

    let overrodeAccessibility = false;
    if (input.action === 'approve' && !report.passed) {
      if (!input.acknowledgeAccessibilityFailures) {
        return { ok: false, reason: 'accessibility_failed', report };
      }
      if (input.notes === undefined) {
        return { ok: false, reason: 'override_reason_required' };
      }
      overrodeAccessibility = true;
    }

    const newStatus = creativeStatusForReviewAction(input.action);
    // Defensive: pending_review → approved / rejected / draft are all allowed by
    // the matrix; this guards against a future matrix change silently breaking.
    if (!canTransitionAdCreative(creative.status, newStatus)) {
      return { ok: false, reason: 'not_in_review', status: creative.status };
    }

    const { creative: updated, review } = await this.repo.applyReview(
      {
        creativeId: input.creativeId,
        newStatus,
        review: {
          creativeId: input.creativeId,
          decision: reviewDecisionForAction(input.action),
          reviewerUserId: input.reviewerUserId,
          notes: input.notes ?? null,
          accessibilityPassed: report.passed,
          accessibilityReport: report,
          overrodeAccessibility,
        },
      },
      async (tx, result) => {
        await this.audit.emit(tx as unknown as OutboxRawExecutor, input.audit, {
          action: 'ad_creative:reviewed',
          resourceKind: ADS_AUDIT_RESOURCE.creative,
          resourceId: result.creative.id,
          before: { status: 'pending_review' },
          after: {
            status: result.creative.status,
            decision: result.review.decision,
            accessibilityPassed: result.review.accessibilityPassed,
            overrodeAccessibility: result.review.overrodeAccessibility,
          },
        });
      },
    );

    this.logger.log(
      {
        creativeId: input.creativeId,
        campaignId: updated.campaignId,
        reviewerUserId: input.reviewerUserId,
        action: input.action,
        decision: review.decision,
        accessibilityPassed: report.passed,
        overrodeAccessibility,
        from: 'pending_review',
        to: updated.status,
      },
      'ad creative reviewed',
    );
    return { ok: true, item: buildItem(updated, campaign), review: toReviewRecord(review) };
  }
}

// ─── Row → wire-record mappers ──────────────────────────────────────────

/** The accessibility-engine input projection of a persisted creative row. */
function toAccessibilityInput(row: AdCreativeWithAccessibilityRow): {
  kind: AdCreativeWithAccessibilityRow['kind'];
  assetKeys: readonly string[];
  altText: string | null;
  textColor: string | null;
  backgroundColor: string | null;
  motionSafe: boolean;
  disclosureAcknowledged: boolean;
} {
  return {
    kind: row.kind,
    assetKeys: row.assetKeys,
    altText: row.altText,
    textColor: row.textColor,
    backgroundColor: row.backgroundColor,
    motionSafe: row.motionSafe,
    disclosureAcknowledged: row.disclosureAcknowledged,
  };
}

/** Project a persisted creative row into the base wire `AdCreativeRecord`. */
function toCreativeRecord(row: AdCreativeWithAccessibilityRow): AdCreativeRecord {
  return {
    id: row.id,
    campaignId: row.campaignId,
    kind: row.kind,
    assetKeys: [...row.assetKeys],
    headline: row.headline,
    body: row.body,
    ctaUrl: row.ctaUrl,
    status: row.status,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** Project the creative's declared accessibility metadata. */
function toAccessibilityMetadata(
  row: AdCreativeWithAccessibilityRow,
): AdCreativeAccessibilityMetadata {
  return {
    altText: row.altText,
    textColor: row.textColor,
    backgroundColor: row.backgroundColor,
    motionSafe: row.motionSafe,
    disclosureAcknowledged: row.disclosureAcknowledged,
  };
}

/** Assemble a review-queue / detail item (creative + metadata + live report + campaign). */
function buildItem(
  creative: AdCreativeWithAccessibilityRow,
  campaign: AdCampaignContextRow,
): AdCreativeReviewItem {
  return {
    creative: toCreativeRecord(creative),
    accessibilityMetadata: toAccessibilityMetadata(creative),
    accessibility: evaluateCreativeAccessibility(toAccessibilityInput(creative)),
    campaign: {
      id: campaign.id,
      name: campaign.name,
      advertiserKind: campaign.advertiserKind,
    },
  };
}

/** Project a persisted review row into the wire record (validating the snapshot). */
function toReviewRecord(row: AdCreativeReviewRow): AdCreativeReviewRecord {
  return {
    id: row.id,
    creativeId: row.creativeId,
    decision: row.decision,
    reviewerUserId: row.reviewerUserId,
    notes: row.notes,
    accessibilityPassed: row.accessibilityPassed,
    overrodeAccessibility: row.overrodeAccessibility,
    accessibility: AdAccessibilityReportSchema.parse(row.accessibilityReport),
    createdAt: row.createdAt.toISOString(),
  };
}
