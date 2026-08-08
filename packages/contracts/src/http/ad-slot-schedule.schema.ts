import { z } from 'zod';

import { AdCreativeKindSchema } from './ads-campaign.schema';

/**
 * Slot-inventory admin HTTP DTOs (TS-272a; PRD §10.9 "Inventory management
 * (slot scheduling)"; PDD §18.1).
 *
 * Two related surfaces on `service-ads`:
 *   1. **Placements** — the predefined UI slots (`ad_placements`, seeded by the
 *      `seed:placements` CLI: home banner, search top-tile, dashboard sidebar,
 *      blog footer, partner co-marketing card). Read-only over the wire (the
 *      slot catalog is seeded, not authored in the admin UI).
 *   2. **Slot schedules** — the bookings that bind a campaign into a placement
 *      over a delivery window (`ad_slot_schedules`). Full admin CRUD.
 *
 * Every endpoint consuming these DTOs is gated on `ads:read` / `ads:write` via
 * `@RequirePermissions(...)` + `PermissionGuard` (CLAUDE.md §3.2); the gateway
 * BFF (TS-272b) enforces the same gate at the edge (defence-in-depth).
 *
 * **Platform-wide inventory.** Neither a placement nor a schedule carries a
 * per-household tenant axis — both are marketing-admin-managed inventory (the
 * `AdPlacement` / `AdSlotSchedule` Prisma models are in service-ads's
 * `unscopedModels`). A schedule's `campaignId` / `placementId` are in-schema
 * soft references surfaced by id; the UI cross-references the placements list.
 *
 * **No money here.** A schedule is the inventory binding only — budget +
 * targeting live on `ad_campaigns` (the campaign aggregate, TS-271a). So these
 * DTOs carry no money field at all.
 *
 * **`.strict()` everywhere** — an unknown field is a 400 (CLAUDE.md §3.3).
 */

// ─── Bounded length / numeric constants ─────────────────────────────────

/** CUID-shaped placement / schedule / campaign row id cap. */
export const AD_SLOT_SCHEDULE_ID_MAX_LENGTH = 36;

/** Stable UI-position slot code (e.g. `home_banner`). */
export const AD_PLACEMENT_SLOT_CODE_MAX_LENGTH = 64;

/** Supported-creative-kinds list cap (the slot catalog has a handful each). */
export const AD_PLACEMENT_SUPPORTED_KINDS_MAX = 8;

/**
 * Schedule priority — orders overlapping schedules on the same slot (higher
 * served first). A bounded non-negative integer; `0` is the default tie-break.
 */
export const AD_SLOT_SCHEDULE_PRIORITY_MIN = 0;
export const AD_SLOT_SCHEDULE_PRIORITY_MAX = 1_000;

/** Admin slot-schedules-list caps. Bounded, no cursor at Phase-1 volume. */
export const AD_SLOT_SCHEDULES_LIST_LIMIT_DEFAULT = 50;
export const AD_SLOT_SCHEDULES_LIST_LIMIT_MAX = 200;

// ─── Enums ──────────────────────────────────────────────────────────────

/**
 * Slot-schedule lifecycle — mirrors the `AdSlotScheduleStatus` Prisma enum
 * (PDD §18.1). `scheduled` (booked, awaiting `startAt`) · `active` (delivering)
 * · `paused` (manual hold) · `completed` (ran to `endAt`) · `archived`
 * (retired). Additive only.
 */
export const AdSlotScheduleStatusSchema = z.enum([
  'scheduled',
  'active',
  'paused',
  'completed',
  'archived',
]);
export type AdSlotScheduleStatus = z.infer<typeof AdSlotScheduleStatusSchema>;

/**
 * The status a schedule may be CREATED in. `scheduled` (default — booked,
 * awaiting its window) or `active` (book-and-go-live). A schedule cannot be
 * created straight into `paused` / `completed` / `archived` (those are
 * transitions off a live schedule).
 */
export const InitialAdSlotScheduleStatusSchema = z.enum(['scheduled', 'active']);
export type InitialAdSlotScheduleStatus = z.infer<typeof InitialAdSlotScheduleStatusSchema>;

// ─── Status-transition policy ───────────────────────────────────────────

/**
 * Allowed slot-schedule status transitions, keyed by the current status. Shared
 * between the service (which enforces the matrix) and the web-admin UI (which
 * renders only the valid actions) so the two never drift. A no-op same-status
 * PATCH is allowed (handled before the matrix is consulted).
 *
 *   - `scheduled` → active / paused / archived
 *   - `active`    → paused / completed / archived
 *   - `paused`    → active / completed / archived
 *   - `completed` → archived (retire to reporting)
 *   - `archived`  → ∅ (terminal)
 */
export const AD_SLOT_SCHEDULE_STATUS_TRANSITIONS = {
  scheduled: ['active', 'paused', 'archived'],
  active: ['paused', 'completed', 'archived'],
  paused: ['active', 'completed', 'archived'],
  completed: ['archived'],
  archived: [],
} as const satisfies Record<AdSlotScheduleStatus, readonly AdSlotScheduleStatus[]>;

/** `true` when `from → to` is an allowed slot-schedule status transition. */
export function canTransitionAdSlotSchedule(
  from: AdSlotScheduleStatus,
  to: AdSlotScheduleStatus,
): boolean {
  return (AD_SLOT_SCHEDULE_STATUS_TRANSITIONS[from] as readonly AdSlotScheduleStatus[]).includes(
    to,
  );
}

/** `true` when `status` is a terminal slot-schedule status (no outgoing transitions). */
export function isAdSlotScheduleTerminal(status: AdSlotScheduleStatus): boolean {
  return AD_SLOT_SCHEDULE_STATUS_TRANSITIONS[status].length === 0;
}

// ─── Field schemas ──────────────────────────────────────────────────────

const IdSchema = z.string().min(1).max(AD_SLOT_SCHEDULE_ID_MAX_LENGTH);
const SlotCodeSchema = z.string().trim().min(1).max(AD_PLACEMENT_SLOT_CODE_MAX_LENGTH);
const PrioritySchema = z
  .number()
  .int()
  .min(AD_SLOT_SCHEDULE_PRIORITY_MIN)
  .max(AD_SLOT_SCHEDULE_PRIORITY_MAX);
const TimestampSchema = z.string().datetime({ offset: true });

// ─── Record shapes ──────────────────────────────────────────────────────

/**
 * A predefined UI slot. Read-only over the wire — the slot catalog is seeded
 * (`seed:placements`), not authored in the admin UI. `supportedCreativeKinds`
 * constrains which creative kinds may fill the slot.
 */
export const AdPlacementRecordSchema = z
  .object({
    id: IdSchema,
    slotCode: SlotCodeSchema,
    supportedCreativeKinds: z.array(AdCreativeKindSchema).max(AD_PLACEMENT_SUPPORTED_KINDS_MAX),
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema,
  })
  .strict();
export type AdPlacementRecord = z.infer<typeof AdPlacementRecordSchema>;

/**
 * A scheduled booking of a campaign into a placement over a delivery window.
 * `priority` orders overlapping schedules on the same slot (higher first);
 * `startAt` is always present, `endAt` is null for an open-ended schedule.
 */
export const AdSlotScheduleRecordSchema = z
  .object({
    id: IdSchema,
    placementId: IdSchema,
    campaignId: IdSchema,
    status: AdSlotScheduleStatusSchema,
    priority: PrioritySchema,
    startAt: TimestampSchema,
    endAt: TimestampSchema.nullable(),
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema,
  })
  .strict();
export type AdSlotScheduleRecord = z.infer<typeof AdSlotScheduleRecordSchema>;

// ─── Create ─────────────────────────────────────────────────────────────

/**
 * `POST /api/v1/admin/ads/slot-schedules` body — book a campaign into a
 * placement over a window. `placementId` + `campaignId` must resolve (validated
 * server-side → 422 when either is missing). `priority` defaults to `0`;
 * `status` defaults to `scheduled`. `endAt` is optional (open-ended); when
 * present it must be strictly after `startAt`.
 */
export const CreateAdSlotScheduleRequestSchema = z
  .object({
    placementId: IdSchema,
    campaignId: IdSchema,
    startAt: TimestampSchema,
    endAt: TimestampSchema.optional(),
    priority: PrioritySchema.default(AD_SLOT_SCHEDULE_PRIORITY_MIN),
    status: InitialAdSlotScheduleStatusSchema.default('scheduled'),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.endAt !== undefined && Date.parse(value.endAt) <= Date.parse(value.startAt)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'endAt must be after startAt',
        path: ['endAt'],
      });
    }
  });
export type CreateAdSlotScheduleRequest = z.infer<typeof CreateAdSlotScheduleRequestSchema>;

// ─── Update ─────────────────────────────────────────────────────────────

/**
 * `PATCH /api/v1/admin/ads/slot-schedules/:scheduleId` body — a partial update.
 * At least one field must be present. `endAt` accepts `null` to clear (make the
 * schedule open-ended). A `status` change must be an allowed transition
 * (validated server-side; a disallowed move is a 409). `placementId` /
 * `campaignId` are NOT editable — rebinding a slot to a different campaign is a
 * new schedule. The merged window (`endAt` > `startAt`) is re-validated
 * server-side.
 */
export const UpdateAdSlotScheduleRequestSchema = z
  .object({
    startAt: TimestampSchema.optional(),
    endAt: TimestampSchema.nullable().optional(),
    priority: PrioritySchema.optional(),
    status: AdSlotScheduleStatusSchema.optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (Object.keys(value).length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'at least one field must be supplied',
      });
    }
  });
export type UpdateAdSlotScheduleRequest = z.infer<typeof UpdateAdSlotScheduleRequestSchema>;

// ─── List ───────────────────────────────────────────────────────────────

/**
 * `GET /api/v1/admin/ads/slot-schedules` query. With no filters the list
 * returns all schedules ordered by `createdAt` descending. `placementId` /
 * `campaignId` / `status` narrow the result.
 */
export const ListAdSlotSchedulesQuerySchema = z
  .object({
    placementId: IdSchema.optional(),
    campaignId: IdSchema.optional(),
    status: AdSlotScheduleStatusSchema.optional(),
    limit: z.coerce
      .number()
      .int()
      .positive()
      .max(AD_SLOT_SCHEDULES_LIST_LIMIT_MAX)
      .default(AD_SLOT_SCHEDULES_LIST_LIMIT_DEFAULT),
  })
  .strict();
export type ListAdSlotSchedulesQuery = z.infer<typeof ListAdSlotSchedulesQuerySchema>;

// ─── Response envelopes ─────────────────────────────────────────────────

/** `GET /api/v1/admin/ads/placements` response — the seeded slots. */
export const AdPlacementsListResponseSchema = z
  .object({ placements: z.array(AdPlacementRecordSchema) })
  .strict();
export type AdPlacementsListResponse = z.infer<typeof AdPlacementsListResponseSchema>;

/** Single-schedule envelope returned by create / detail / update. */
export const AdSlotScheduleResponseSchema = z
  .object({ schedule: AdSlotScheduleRecordSchema })
  .strict();
export type AdSlotScheduleResponse = z.infer<typeof AdSlotScheduleResponseSchema>;

/** `GET /api/v1/admin/ads/slot-schedules` response — the matching schedules. */
export const AdSlotSchedulesListResponseSchema = z
  .object({ schedules: z.array(AdSlotScheduleRecordSchema) })
  .strict();
export type AdSlotSchedulesListResponse = z.infer<typeof AdSlotSchedulesListResponseSchema>;
