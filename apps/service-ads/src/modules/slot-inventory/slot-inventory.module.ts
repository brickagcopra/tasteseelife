import { Module } from '@nestjs/common';

import { SlotInventoryController } from './controllers/slot-inventory.controller';
import { SlotInventoryRepository } from './repositories/slot-inventory.repository';
import { SlotInventoryService } from './services/slot-inventory.service';

/**
 * Slot-inventory bounded module (TS-272a; PRD §10.9; PDD §18.1) — the
 * marketing-admin slot-scheduling surface: read the seeded UI placements + book
 * campaigns into them over a delivery window.
 *
 * Composition:
 *   - `SlotInventoryController` — list placements; list / create / detail /
 *     update slot schedules.
 *   - `SlotInventoryService` — the domain decisions (slot + campaign existence
 *     on create, the status-transition matrix + window order on update, the
 *     row → wire mapping).
 *   - `SlotInventoryRepository` — persistence over `ad_placements` (read-only)
 *     + `ad_slot_schedules`.
 *
 * Every endpoint is gated on `ads:read` (reads) / `ads:write` (mutations) via
 * `@RequirePermissions(...)` + `PermissionGuard`; mutations honour
 * `Idempotency-Key` via `@Idempotent()`. The tables are platform-wide
 * marketing-admin inventory (no tenant axis) so the TS-141 gate short-circuits
 * (they sit in service-ads's `unscopedModels`).
 *
 * `SlotInventoryService` is exported so a future delivery path (TS-275+ — read
 * a slot's active schedules to decide what fills it) can compose it.
 */
@Module({
  controllers: [SlotInventoryController],
  providers: [SlotInventoryService, SlotInventoryRepository],
  exports: [SlotInventoryService],
})
export class SlotInventoryModule {}
