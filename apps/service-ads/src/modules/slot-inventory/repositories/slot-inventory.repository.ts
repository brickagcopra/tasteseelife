import { Injectable } from '@nestjs/common';
import type { AdCreativeKind, AdSlotScheduleStatus } from '@taste-and-see/contracts';

import { PrismaService, type PrismaTransactionClient } from '../../../prisma/prisma.service';

/**
 * Local mirrors of the Prisma-generated `ad_placements` / `ad_slot_schedules`
 * rows, narrowed to the columns this module reads/writes. Same
 * TS-021-followup-3 rationale documented across the codebase (Prisma row types
 * resolve inconsistently under our tsconfig, so we project shapes by hand;
 * dropped on the next Prisma bump — TS-272a-followup).
 */
export interface AdPlacementRow {
  readonly id: string;
  readonly slotCode: string;
  readonly supportedCreativeKinds: readonly AdCreativeKind[];
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface AdSlotScheduleRow {
  readonly id: string;
  readonly placementId: string;
  readonly campaignId: string;
  readonly status: AdSlotScheduleStatus;
  readonly priority: number;
  readonly startAt: Date;
  readonly endAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/** Explicit column projections — never `SELECT *` (CLAUDE.md §4.1). */
const PLACEMENT_SELECT = {
  id: true,
  slotCode: true,
  supportedCreativeKinds: true,
  createdAt: true,
  updatedAt: true,
} as const;

const SCHEDULE_SELECT = {
  id: true,
  placementId: true,
  campaignId: true,
  status: true,
  priority: true,
  startAt: true,
  endAt: true,
  createdAt: true,
  updatedAt: true,
} as const;

/** Columns to persist on slot-schedule create (already date-converted). */
export interface SlotScheduleWriteData {
  readonly placementId: string;
  readonly campaignId: string;
  readonly status: AdSlotScheduleStatus;
  readonly priority: number;
  readonly startAt: Date;
  readonly endAt: Date | null;
}

/** A partial scalar update on a slot schedule (only present keys are written). */
export interface SlotSchedulePatchData {
  status?: AdSlotScheduleStatus;
  priority?: number;
  startAt?: Date;
  endAt?: Date | null;
}

/**
 * Persistence for the slot-inventory surface (TS-272a; PDD §8.2, §18.1) — the
 * seeded `ad_placements` (read-only here) + the `ad_slot_schedules` bindings.
 *
 * `AdPlacement` / `AdSlotSchedule` / `AdCampaign` are `unscopedModel`s
 * (platform-wide marketing-admin inventory — see `app.module.ts`), so the
 * tenant-scope gate short-circuits to `proceed_unscoped_model` before any
 * request-context check: these reads/writes need no `RequestContext` frame and
 * no `runWithoutTenantContext` wrapper (the same posture as `CampaignRepository`
 * / `SponsoredCampaignRepository`).
 */
@Injectable()
export class SlotInventoryRepository {
  constructor(private readonly prisma: PrismaService) {}

  /** All seeded placements ordered by `slotCode` ascending (stable display order). */
  async listPlacements(): Promise<readonly AdPlacementRow[]> {
    return (await this.prisma.adPlacement.findMany({
      orderBy: [{ slotCode: 'asc' }],
      select: PLACEMENT_SELECT,
    })) as AdPlacementRow[];
  }

  /**
   * The placement row (incl. `supportedCreativeKinds`), or null when it does
   * not resolve. Used at create time for both the existence check and the
   * creative-kind compatibility rule (TS-272a-followup-3) — one read serves both.
   */
  async findPlacement(id: string): Promise<AdPlacementRow | null> {
    return (await this.prisma.adPlacement.findUnique({
      where: { id },
      select: PLACEMENT_SELECT,
    })) as AdPlacementRow | null;
  }

  /** `true` when a campaign with this id exists (the create-time campaign check). */
  async campaignExists(id: string): Promise<boolean> {
    const row = await this.prisma.adCampaign.findUnique({
      where: { id },
      select: { id: true },
    });
    return row !== null;
  }

  /**
   * The distinct `kind`s of a campaign's `approved` creatives (TS-272a-followup-3).
   * Drives the creative-kind ↔ placement compatibility rule: a campaign may only
   * be booked into a placement when one of these kinds is in the placement's
   * `supportedCreativeKinds`. A campaign with no approved creative yields `[]`
   * (so it cannot be scheduled anywhere). Only `approved` creatives count —
   * draft / pending_review / rejected / archived creatives never deliver.
   */
  async findApprovedCreativeKinds(campaignId: string): Promise<readonly AdCreativeKind[]> {
    const rows = (await this.prisma.adCreative.findMany({
      // String-literal enum value per the `@prisma/client` pnpm-hoist convention.
      where: { campaignId, status: 'approved' },
      select: { kind: true },
    })) as ReadonlyArray<{ readonly kind: AdCreativeKind }>;
    return [...new Set(rows.map((r) => r.kind))];
  }

  /**
   * Persist a new slot schedule. `onPersist` runs inside the same transaction
   * as the insert (the audit-outbox append, so the audit row commits atomically
   * with the schedule — CLAUDE.md §3.6, §5.3).
   */
  async createSchedule(
    data: SlotScheduleWriteData,
    onPersist?: (tx: PrismaTransactionClient, created: AdSlotScheduleRow) => Promise<void>,
  ): Promise<AdSlotScheduleRow> {
    return this.prisma.$transaction(async (tx: PrismaTransactionClient) => {
      const created = (await tx.adSlotSchedule.create({
        data: {
          placementId: data.placementId,
          campaignId: data.campaignId,
          status: data.status,
          priority: data.priority,
          startAt: data.startAt,
          endAt: data.endAt,
        },
        select: SCHEDULE_SELECT,
      })) as AdSlotScheduleRow;
      if (onPersist !== undefined) await onPersist(tx, created);
      return created;
    });
  }

  /** A single schedule row, or null when it does not resolve. */
  async findSchedule(id: string): Promise<AdSlotScheduleRow | null> {
    return (await this.prisma.adSlotSchedule.findUnique({
      where: { id },
      select: SCHEDULE_SELECT,
    })) as AdSlotScheduleRow | null;
  }

  /** Matching schedules ordered by `createdAt` descending (newest first). */
  async listSchedules(filter: {
    readonly placementId?: string | undefined;
    readonly campaignId?: string | undefined;
    readonly status?: AdSlotScheduleStatus | undefined;
    readonly limit: number;
  }): Promise<readonly AdSlotScheduleRow[]> {
    const where: Record<string, unknown> = {};
    if (filter.placementId !== undefined) where['placementId'] = filter.placementId;
    if (filter.campaignId !== undefined) where['campaignId'] = filter.campaignId;
    if (filter.status !== undefined) where['status'] = filter.status;

    return (await this.prisma.adSlotSchedule.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: filter.limit,
      select: SCHEDULE_SELECT,
    })) as AdSlotScheduleRow[];
  }

  /**
   * Apply a partial scalar update to a slot schedule. `onPersist` runs inside
   * the same transaction as the update (the audit-outbox append).
   */
  async updateSchedule(
    id: string,
    data: SlotSchedulePatchData,
    onPersist?: (tx: PrismaTransactionClient, updated: AdSlotScheduleRow) => Promise<void>,
  ): Promise<AdSlotScheduleRow> {
    return this.prisma.$transaction(async (tx: PrismaTransactionClient) => {
      const updated = (await tx.adSlotSchedule.update({
        where: { id },
        data,
        select: SCHEDULE_SELECT,
      })) as AdSlotScheduleRow;
      if (onPersist !== undefined) await onPersist(tx, updated);
      return updated;
    });
  }
}
