import { Injectable, Logger } from '@nestjs/common';
import {
  canTransitionAdCampaign,
  canTransitionAdCreative,
  parseAdTargetingPredicate,
  AD_CAMPAIGN_DEFAULT_CURRENCY,
  type AdCampaignDetail,
  type AdCampaignRecord,
  type AdCampaignStatus,
  type AdCreativeRecord,
  type AdCreativeStatus,
  type AdTargetingRuleRecord,
  type AdvertiserKind,
  type CreateAdCampaignRequest,
  type UpdateAdCampaignRequest,
} from '@taste-and-see/contracts';
import type { OutboxRawExecutor } from '@taste-and-see/nest-outbox';

import { AuditEmitter } from '@taste-and-see/nest-audit';
import { ADS_AUDIT_RESOURCE } from '../../audit/audit-resources';
import type { AuditActorContext } from '@taste-and-see/nest-audit';
import {
  CampaignRepository,
  type AdCampaignRow,
  type AdCreativeRow,
  type AdTargetingRuleRow,
  type CampaignPatchData,
  type DecimalLike,
} from '../repositories/campaign.repository';

export interface CreateCampaignInput extends CreateAdCampaignRequest {
  readonly actorUserId: string;
  /** Actor + request metadata for the `audit.action_recorded` event. */
  readonly audit: AuditActorContext;
}

export interface ListCampaignsInput {
  readonly status?: AdCampaignStatus | undefined;
  readonly advertiserKind?: AdvertiserKind | undefined;
  readonly limit: number;
}

export interface UpdateCampaignInput extends UpdateAdCampaignRequest {
  readonly campaignId: string;
  readonly actorUserId: string;
  readonly audit: AuditActorContext;
}

export interface UpdateCreativeStatusInput {
  readonly campaignId: string;
  readonly creativeId: string;
  readonly status: AdCreativeStatus;
  readonly actorUserId: string;
  readonly audit: AuditActorContext;
}

export type CreateCampaignOutcome =
  | { readonly ok: true; readonly campaign: AdCampaignRecord }
  | { readonly ok: false; readonly reason: 'unsupported_currency' };

export type GetCampaignOutcome =
  | { readonly ok: true; readonly campaign: AdCampaignDetail }
  | { readonly ok: false; readonly reason: 'not_found' };

export type UpdateCampaignOutcome =
  | { readonly ok: true; readonly campaign: AdCampaignRecord }
  | { readonly ok: false; readonly reason: 'not_found' }
  | { readonly ok: false; readonly reason: 'unsupported_currency' }
  | { readonly ok: false; readonly reason: 'invalid_window' }
  | { readonly ok: false; readonly reason: 'advertiser_required' }
  | { readonly ok: false; readonly reason: 'advertiser_not_allowed' }
  | {
      readonly ok: false;
      readonly reason: 'invalid_transition';
      readonly from: AdCampaignStatus;
      readonly to: AdCampaignStatus;
    };

export type UpdateCreativeStatusOutcome =
  | { readonly ok: true; readonly creative: AdCreativeRecord }
  | { readonly ok: false; readonly reason: 'not_found' }
  | {
      readonly ok: false;
      readonly reason: 'invalid_transition';
      readonly from: AdCreativeStatus;
      readonly to: AdCreativeStatus;
    };

/**
 * Ad-campaign admin service (TS-271a; PRD §10.9; PDD §18.1, §8.2).
 *
 * Owns the campaign aggregate's domain decisions: status-transition matrices
 * (campaign + creative), delivery-window + advertiser-id integrity on update,
 * the Phase-1 USD-only currency gate, the money ↔ integer-minor-unit boundary
 * crossing (the DB stores `Decimal(12,2)`), and decoding the persisted
 * targeting AST. Persistence is delegated to `CampaignRepository`.
 *
 * Authorisation lives at the controller boundary — every surface sits behind
 * `AccessTokenGuard` + `PermissionGuard` (`ads:read` / `ads:write`). The
 * service trusts the actor id it is handed (resolved from the verified token).
 */
@Injectable()
export class CampaignsService {
  private readonly logger = new Logger(CampaignsService.name);

  constructor(
    private readonly repo: CampaignRepository,
    private readonly audit: AuditEmitter,
  ) {}

  /**
   * Create a campaign, optionally with nested creatives + targeting rules
   * (one transaction). The advertiser-id ↔ kind integrity + the window order
   * are enforced by the contract's `superRefine`; this layer enforces the
   * Phase-1 USD-only currency gate.
   */
  async createCampaign(input: CreateCampaignInput): Promise<CreateCampaignOutcome> {
    if (!isSupportedCurrency(input.currency)) {
      return { ok: false, reason: 'unsupported_currency' };
    }

    const aggregate = await this.repo.createAggregate(
      {
        campaign: {
          name: input.name,
          advertiserKind: input.advertiserKind,
          advertiserId: input.advertiserId,
          status: input.status,
          budget: input.budgetMinor === undefined ? null : minorToDecimalString(input.budgetMinor),
          currency: input.currency,
          startAt: input.startAt === undefined ? null : new Date(input.startAt),
          endAt: input.endAt === undefined ? null : new Date(input.endAt),
        },
        creatives: (input.creatives ?? []).map((c) => ({
          kind: c.kind,
          assetKeys: c.assetKeys,
          headline: c.headline,
          body: c.body ?? null,
          ctaUrl: c.ctaUrl ?? null,
          status: c.status,
        })),
        targetingRules: (input.targetingRules ?? []).map((r) => ({
          kind: r.kind,
          value: JSON.stringify(r.predicate),
        })),
      },
      // Audit the create atomically with the insert (CLAUDE.md §3.6, §5.3).
      async (tx, created) => {
        await this.audit.emit(tx as unknown as OutboxRawExecutor, input.audit, {
          action: 'ad_campaign:create',
          resourceKind: ADS_AUDIT_RESOURCE.campaign,
          resourceId: created.campaign.id,
          before: null,
          after: toCampaignRecord(created.campaign),
        });
      },
    );

    this.logger.log(
      {
        campaignId: aggregate.campaign.id,
        advertiserKind: aggregate.campaign.advertiserKind,
        status: aggregate.campaign.status,
        creativeCount: aggregate.creatives.length,
        ruleCount: aggregate.targetingRules.length,
        actorUserId: input.actorUserId,
      },
      'ad campaign created',
    );
    return { ok: true, campaign: toCampaignRecord(aggregate.campaign) };
  }

  /** Matching campaigns ordered by `createdAt` descending (newest first). */
  async listCampaigns(input: ListCampaignsInput): Promise<readonly AdCampaignRecord[]> {
    const rows = await this.repo.listCampaigns({
      status: input.status,
      advertiserKind: input.advertiserKind,
      limit: input.limit,
    });
    return rows.map(toCampaignRecord);
  }

  /** Campaign detail with its creatives + decoded targeting rules. */
  async getCampaignDetail(campaignId: string): Promise<GetCampaignOutcome> {
    const aggregate = await this.repo.findDetail(campaignId);
    if (aggregate === null) return { ok: false, reason: 'not_found' };

    const detail: AdCampaignDetail = {
      ...toCampaignRecord(aggregate.campaign),
      creatives: aggregate.creatives.map(toCreativeRecord),
      // A rule whose persisted AST fails to decode is omitted — the same
      // fail-closed posture the delivery evaluator takes (TS-273). The admin
      // never sees a half-parsed rule.
      targetingRules: aggregate.targetingRules
        .map(toTargetingRuleRecord)
        .filter((r): r is AdTargetingRuleRecord => r !== null),
    };
    return { ok: true, campaign: detail };
  }

  /**
   * Apply a partial update. Resolution order:
   *   1. `not_found` — the campaign does not resolve.
   *   2. `unsupported_currency` — a non-USD currency (Phase-1 gate).
   *   3. `invalid_transition` — a `status` change disallowed by the matrix.
   *   4. `advertiser_required` / `advertiser_not_allowed` — the merged
   *      advertiser-id violates the kind's integrity rule.
   *   5. `invalid_window` — the merged `startAt` / `endAt` are out of order.
   * Only then does the write fire.
   */
  async updateCampaign(input: UpdateCampaignInput): Promise<UpdateCampaignOutcome> {
    const current = await this.repo.findCampaign(input.campaignId);
    if (current === null) return { ok: false, reason: 'not_found' };

    if (input.currency !== undefined && !isSupportedCurrency(input.currency)) {
      return { ok: false, reason: 'unsupported_currency' };
    }

    if (input.status !== undefined && input.status !== current.status) {
      if (!canTransitionAdCampaign(current.status, input.status)) {
        return { ok: false, reason: 'invalid_transition', from: current.status, to: input.status };
      }
    }

    // Merge the advertiser id against the campaign's (immutable) kind.
    const mergedAdvertiserId =
      input.advertiserId !== undefined ? input.advertiserId : current.advertiserId;
    if (current.advertiserKind === 'internal') {
      if (mergedAdvertiserId !== null) return { ok: false, reason: 'advertiser_not_allowed' };
    } else if (mergedAdvertiserId === null) {
      return { ok: false, reason: 'advertiser_required' };
    }

    // Merge the delivery window and re-check ordering.
    const mergedStart = input.startAt !== undefined ? toDateOrNull(input.startAt) : current.startAt;
    const mergedEnd = input.endAt !== undefined ? toDateOrNull(input.endAt) : current.endAt;
    if (
      mergedStart !== null &&
      mergedEnd !== null &&
      mergedEnd.getTime() <= mergedStart.getTime()
    ) {
      return { ok: false, reason: 'invalid_window' };
    }

    const data: CampaignPatchData = {};
    if (input.name !== undefined) data.name = input.name;
    if (input.advertiserId !== undefined) data.advertiserId = input.advertiserId;
    if (input.budgetMinor !== undefined) {
      data.budget = input.budgetMinor === null ? null : minorToDecimalString(input.budgetMinor);
    }
    if (input.currency !== undefined) data.currency = input.currency;
    if (input.startAt !== undefined) data.startAt = toDateOrNull(input.startAt);
    if (input.endAt !== undefined) data.endAt = toDateOrNull(input.endAt);
    if (input.status !== undefined && input.status !== current.status) data.status = input.status;

    // Snapshot the before-state up front — the write must not have mutated it
    // by the time the audit hook runs.
    const before = toCampaignRecord(current);
    const updated = await this.repo.updateCampaign(input.campaignId, data, async (tx, row) => {
      await this.audit.emit(tx as unknown as OutboxRawExecutor, input.audit, {
        action: 'ad_campaign:update',
        resourceKind: ADS_AUDIT_RESOURCE.campaign,
        resourceId: row.id,
        before,
        after: toCampaignRecord(row),
      });
    });

    this.logger.log(
      {
        campaignId: input.campaignId,
        actorUserId: input.actorUserId,
        from: current.status,
        to: updated.status,
        fields: Object.keys(data),
      },
      'ad campaign updated',
    );
    return { ok: true, campaign: toCampaignRecord(updated) };
  }

  /**
   * Advance a creative through its review lifecycle. A same-status set is a
   * no-op success. The full TS-277 approval + accessibility workflow gates the
   * move to `approved`; this is the raw status lever.
   */
  async updateCreativeStatus(
    input: UpdateCreativeStatusInput,
  ): Promise<UpdateCreativeStatusOutcome> {
    const creative = await this.repo.findCreative(input.campaignId, input.creativeId);
    if (creative === null) return { ok: false, reason: 'not_found' };

    if (
      input.status !== creative.status &&
      !canTransitionAdCreative(creative.status, input.status)
    ) {
      return { ok: false, reason: 'invalid_transition', from: creative.status, to: input.status };
    }

    const updated =
      input.status === creative.status
        ? creative
        : await this.repo.updateCreativeStatus(input.creativeId, input.status, async (tx, row) => {
            // Audit only on an actual status write — a same-status PATCH is a
            // no-op and leaves no trail.
            await this.audit.emit(tx as unknown as OutboxRawExecutor, input.audit, {
              action: 'ad_creative:status_changed',
              resourceKind: ADS_AUDIT_RESOURCE.creative,
              resourceId: row.id,
              before: toCreativeRecord(creative),
              after: toCreativeRecord(row),
            });
          });

    this.logger.log(
      {
        campaignId: input.campaignId,
        creativeId: input.creativeId,
        actorUserId: input.actorUserId,
        from: creative.status,
        to: updated.status,
      },
      'ad creative status updated',
    );
    return { ok: true, creative: toCreativeRecord(updated) };
  }
}

// ─── Currency gate ──────────────────────────────────────────────────────

/** Phase-1 is USD-only (PRD §11.4 / PDD §11.2); other codes are a 422. */
function isSupportedCurrency(currency: string): boolean {
  return currency === AD_CAMPAIGN_DEFAULT_CURRENCY;
}

// ─── Money boundary (Decimal(12,2) ↔ integer minor units) ───────────────

/** Integer minor units (cents) → a `Decimal(12,2)` dollars string, no float. */
export function minorToDecimalString(minor: number): string {
  const negative = minor < 0;
  const abs = Math.abs(minor);
  const dollars = Math.floor(abs / 100);
  const cents = abs % 100;
  return `${negative ? '-' : ''}${dollars}.${cents.toString().padStart(2, '0')}`;
}

/**
 * A persisted `Decimal(12,2)` (or its `toFixed`-bearing object / string /
 * number form) → integer minor units, or null. No float arithmetic: we read
 * the fixed-2 string and recombine the whole + fractional parts as integers.
 */
export function decimalToMinor(value: DecimalLike | string | number | null): number | null {
  if (value === null || value === undefined) return null;
  const fixed =
    typeof value === 'object' && value !== null && typeof value.toFixed === 'function'
      ? value.toFixed(2)
      : Number(value).toFixed(2);
  const negative = fixed.startsWith('-');
  const unsigned = negative ? fixed.slice(1) : fixed;
  const [whole, frac = '00'] = unsigned.split('.');
  const minor = Number(whole) * 100 + Number(frac.padEnd(2, '0').slice(0, 2));
  return negative ? -minor : minor;
}

function toDateOrNull(iso: string | null): Date | null {
  return iso === null ? null : new Date(iso);
}

// ─── Row → wire-record mappers ──────────────────────────────────────────

/** Project a persisted campaign row into the wire `AdCampaignRecord`. */
export function toCampaignRecord(row: AdCampaignRow): AdCampaignRecord {
  return {
    id: row.id,
    name: row.name,
    advertiserKind: row.advertiserKind,
    advertiserId: row.advertiserId,
    status: row.status,
    budgetMinor: decimalToMinor(row.budget),
    currency: row.currency,
    startAt: row.startAt === null ? null : row.startAt.toISOString(),
    endAt: row.endAt === null ? null : row.endAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** Project a persisted creative row into the wire `AdCreativeRecord`. */
export function toCreativeRecord(row: AdCreativeRow): AdCreativeRecord {
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

/**
 * Project a persisted targeting-rule row into the wire record, decoding the
 * AST TEXT. Returns null when the persisted `value` fails to decode (the rule
 * is then omitted from the detail read — fail-closed, TS-273).
 */
export function toTargetingRuleRecord(row: AdTargetingRuleRow): AdTargetingRuleRecord | null {
  const decoded = parseAdTargetingPredicate(row.value);
  if (!decoded.ok) return null;
  return {
    id: row.id,
    campaignId: row.campaignId,
    kind: row.kind,
    predicate: decoded.predicate,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
