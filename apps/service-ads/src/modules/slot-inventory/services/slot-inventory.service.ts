import { Injectable, Logger } from '@nestjs/common';
import {
  canTransitionAdSlotSchedule,
  type AdCreativeKind,
  type AdPlacementRecord,
  type AdSlotScheduleRecord,
  type AdSlotScheduleStatus,
  type CreateAdSlotScheduleRequest,
  type UpdateAdSlotScheduleRequest,
} from '@taste-and-see/contracts';
import type { OutboxRawExecutor } from '@taste-and-see/nest-outbox';

import { AuditEmitter } from '@taste-and-see/nest-audit';
import { ADS_AUDIT_RESOURCE } from '../../audit/audit-resources';
import type { AuditActorContext } from '@taste-and-see/nest-audit';
import {
  SlotInventoryRepository,
  type AdPlacementRow,
  type AdSlotScheduleRow,
  type SlotSchedulePatchData,
} from '../repositories/slot-inventory.repository';

export interface CreateSlotScheduleInput extends CreateAdSlotScheduleRequest {
  readonly actorUserId: string;
  /** Actor + request metadata for the `audit.action_recorded` event. */
  readonly audit: AuditActorContext;
}

export interface ListSlotSchedulesInput {
  readonly placementId?: string | undefined;
  readonly campaignId?: string | undefined;
  readonly status?: AdSlotScheduleStatus | undefined;
  readonly limit: number;
}

export interface UpdateSlotScheduleInput extends UpdateAdSlotScheduleRequest {
  readonly scheduleId: string;
  readonly actorUserId: string;
  readonly audit: AuditActorContext;
}

export type CreateSlotScheduleOutcome =
  | { readonly ok: true; readonly schedule: AdSlotScheduleRecord }
  | { readonly ok: false; readonly reason: 'placement_not_found' }
  | { readonly ok: false; readonly reason: 'campaign_not_found' }
  | {
      readonly ok: false;
      readonly reason: 'incompatible_creative_kind';
      /** The kinds the placement accepts. */
      readonly supportedKinds: readonly AdCreativeKind[];
      /** The kinds of the campaign's approved creatives (may be empty). */
      readonly approvedKinds: readonly AdCreativeKind[];
    };

export type GetSlotScheduleOutcome =
  | { readonly ok: true; readonly schedule: AdSlotScheduleRecord }
  | { readonly ok: false; readonly reason: 'not_found' };

export type UpdateSlotScheduleOutcome =
  | { readonly ok: true; readonly schedule: AdSlotScheduleRecord }
  | { readonly ok: false; readonly reason: 'not_found' }
  | { readonly ok: false; readonly reason: 'invalid_window' }
  | {
      readonly ok: false;
      readonly reason: 'invalid_transition';
      readonly from: AdSlotScheduleStatus;
      readonly to: AdSlotScheduleStatus;
    };

/**
 * Slot-inventory admin service (TS-272a; PRD §10.9; PDD §18.1).
 *
 * Owns the domain decisions for slot scheduling: the slot + campaign existence
 * checks on create, the status-transition matrix + delivery-window order on
 * update, and the row → wire-record mapping. Persistence is delegated to
 * `SlotInventoryRepository`.
 *
 * Authorisation lives at the controller boundary — every surface sits behind
 * `AccessTokenGuard` + `PermissionGuard` (`ads:read` / `ads:write`). The
 * service trusts the actor id it is handed (resolved from the verified token).
 */
@Injectable()
export class SlotInventoryService {
  private readonly logger = new Logger(SlotInventoryService.name);

  constructor(
    private readonly repo: SlotInventoryRepository,
    private readonly audit: AuditEmitter,
  ) {}

  /** The seeded placements ordered by `slotCode`. */
  async listPlacements(): Promise<readonly AdPlacementRecord[]> {
    const rows = await this.repo.listPlacements();
    return rows.map(toPlacementRecord);
  }

  /**
   * Book a campaign into a placement. The window order (`endAt` > `startAt`) is
   * enforced by the contract `superRefine`; this layer enforces:
   *   1. Referential integrity — both the placement and the campaign must resolve.
   *   2. Creative-kind compatibility (TS-272a-followup-3) — the campaign must
   *      carry at least one `approved` creative whose `kind` is in the
   *      placement's `supportedCreativeKinds` (e.g. a banner-only campaign cannot
   *      be booked into `search_top_tile`, which serves only `sponsored_listing`).
   *      A campaign with no approved creative can be scheduled nowhere.
   */
  async createSchedule(input: CreateSlotScheduleInput): Promise<CreateSlotScheduleOutcome> {
    const placement = await this.repo.findPlacement(input.placementId);
    if (placement === null) {
      return { ok: false, reason: 'placement_not_found' };
    }
    if (!(await this.repo.campaignExists(input.campaignId))) {
      return { ok: false, reason: 'campaign_not_found' };
    }

    const approvedKinds = await this.repo.findApprovedCreativeKinds(input.campaignId);
    const supportedKinds = placement.supportedCreativeKinds;
    if (!approvedKinds.some((kind) => supportedKinds.includes(kind))) {
      return { ok: false, reason: 'incompatible_creative_kind', supportedKinds, approvedKinds };
    }

    const row = await this.repo.createSchedule(
      {
        placementId: input.placementId,
        campaignId: input.campaignId,
        status: input.status,
        priority: input.priority,
        startAt: new Date(input.startAt),
        endAt: input.endAt === undefined ? null : new Date(input.endAt),
      },
      async (tx, created) => {
        await this.audit.emit(tx as unknown as OutboxRawExecutor, input.audit, {
          action: 'ad_slot_schedule:create',
          resourceKind: ADS_AUDIT_RESOURCE.slotSchedule,
          resourceId: created.id,
          before: null,
          after: toScheduleRecord(created),
        });
      },
    );

    this.logger.log(
      {
        scheduleId: row.id,
        placementId: row.placementId,
        campaignId: row.campaignId,
        status: row.status,
        actorUserId: input.actorUserId,
      },
      'ad slot schedule created',
    );
    return { ok: true, schedule: toScheduleRecord(row) };
  }

  /** Matching schedules ordered by `createdAt` descending (newest first). */
  async listSchedules(input: ListSlotSchedulesInput): Promise<readonly AdSlotScheduleRecord[]> {
    const rows = await this.repo.listSchedules({
      placementId: input.placementId,
      campaignId: input.campaignId,
      status: input.status,
      limit: input.limit,
    });
    return rows.map(toScheduleRecord);
  }

  /** A single schedule, or `not_found`. */
  async getSchedule(scheduleId: string): Promise<GetSlotScheduleOutcome> {
    const row = await this.repo.findSchedule(scheduleId);
    if (row === null) return { ok: false, reason: 'not_found' };
    return { ok: true, schedule: toScheduleRecord(row) };
  }

  /**
   * Apply a partial update. Resolution order:
   *   1. `not_found` — the schedule does not resolve.
   *   2. `invalid_transition` — a `status` change disallowed by the matrix.
   *   3. `invalid_window` — the merged `startAt` / `endAt` are out of order.
   * Only then does the write fire.
   */
  async updateSchedule(input: UpdateSlotScheduleInput): Promise<UpdateSlotScheduleOutcome> {
    const current = await this.repo.findSchedule(input.scheduleId);
    if (current === null) return { ok: false, reason: 'not_found' };

    if (input.status !== undefined && input.status !== current.status) {
      if (!canTransitionAdSlotSchedule(current.status, input.status)) {
        return { ok: false, reason: 'invalid_transition', from: current.status, to: input.status };
      }
    }

    // Merge the delivery window and re-check ordering.
    const mergedStart = input.startAt !== undefined ? new Date(input.startAt) : current.startAt;
    const mergedEnd = input.endAt !== undefined ? toDateOrNull(input.endAt) : current.endAt;
    if (mergedEnd !== null && mergedEnd.getTime() <= mergedStart.getTime()) {
      return { ok: false, reason: 'invalid_window' };
    }

    const data: SlotSchedulePatchData = {};
    if (input.priority !== undefined) data.priority = input.priority;
    if (input.startAt !== undefined) data.startAt = new Date(input.startAt);
    if (input.endAt !== undefined) data.endAt = toDateOrNull(input.endAt);
    if (input.status !== undefined && input.status !== current.status) data.status = input.status;

    // Snapshot the before-state up front — the write must not have mutated it
    // by the time the audit hook runs.
    const before = toScheduleRecord(current);
    const updated = await this.repo.updateSchedule(input.scheduleId, data, async (tx, row) => {
      await this.audit.emit(tx as unknown as OutboxRawExecutor, input.audit, {
        action: 'ad_slot_schedule:update',
        resourceKind: ADS_AUDIT_RESOURCE.slotSchedule,
        resourceId: row.id,
        before,
        after: toScheduleRecord(row),
      });
    });

    this.logger.log(
      {
        scheduleId: input.scheduleId,
        actorUserId: input.actorUserId,
        from: current.status,
        to: updated.status,
        fields: Object.keys(data),
      },
      'ad slot schedule updated',
    );
    return { ok: true, schedule: toScheduleRecord(updated) };
  }
}

function toDateOrNull(iso: string | null): Date | null {
  return iso === null ? null : new Date(iso);
}

// ─── Row → wire-record mappers ──────────────────────────────────────────

/** Project a persisted placement row into the wire `AdPlacementRecord`. */
export function toPlacementRecord(row: AdPlacementRow): AdPlacementRecord {
  return {
    id: row.id,
    slotCode: row.slotCode,
    supportedCreativeKinds: [...row.supportedCreativeKinds],
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** Project a persisted schedule row into the wire `AdSlotScheduleRecord`. */
export function toScheduleRecord(row: AdSlotScheduleRow): AdSlotScheduleRecord {
  return {
    id: row.id,
    placementId: row.placementId,
    campaignId: row.campaignId,
    status: row.status,
    priority: row.priority,
    startAt: row.startAt.toISOString(),
    endAt: row.endAt === null ? null : row.endAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
