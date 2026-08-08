import { Logger } from '@nestjs/common';

import { PrismaService } from '../../prisma/prisma.service';
import { AD_PLACEMENT_SEED } from './placement-seed-data';

/**
 * Surface used by `seedAdPlacements`. Typed against the actual Prisma surface
 * we touch so the function takes a `PrismaService` directly without depending
 * on the `Prisma.TransactionClient` namespace value-side (the same workaround
 * the service-booking catalog seed + the campaign repository use —
 * TS-021-followup-3).
 */
export interface PlacementSeedClient {
  readonly adPlacement: PrismaService['adPlacement'];
}

export interface PlacementSeedReport {
  readonly entriesUpserted: number;
  readonly created: readonly string[];
  readonly updated: readonly string[];
}

/**
 * Idempotently load the five predefined placements (PRD §10.9; PDD §18.1) into
 * `ads.ad_placements`.
 *
 * Idempotency contract:
 *  - Entries are upserted on `slotCode` (the stable unique identifier).
 *  - On insert: `slotCode` + `supportedCreativeKinds` are written.
 *  - On update: only `supportedCreativeKinds` is refreshed (a slot's supported
 *    kinds may evolve). The `id` + `createdAt` are NOT overwritten, preserving
 *    the row's identity across reseeds so any `ad_slot_schedules` FK stays valid.
 *
 * What this function does NOT do: it never deletes a slot. A `slotCode` removed
 * from the seed list stays on disk (and any schedules bound to it stay valid)
 * — retiring a slot is a deliberate, separate operation.
 *
 * Runs inside a single transaction so a partial failure cannot leave the slot
 * catalog half-applied. The seed carries no money or tenant data — placements
 * are platform-wide inventory (the `AdPlacement` model is unscoped), so the
 * unwrapped client (the bare `PrismaService` the CLI constructs) is correct.
 */
export async function seedAdPlacements(prisma: PrismaService): Promise<PlacementSeedReport> {
  const logger = new Logger(seedAdPlacements.name);
  return prisma.$transaction(async (tx: PlacementSeedClient): Promise<PlacementSeedReport> => {
    const created: string[] = [];
    const updated: string[] = [];

    for (const entry of AD_PLACEMENT_SEED) {
      const supportedCreativeKinds = [...entry.supportedCreativeKinds];

      const existing = await tx.adPlacement.findUnique({
        where: { slotCode: entry.slotCode },
        select: { id: true },
      });

      if (existing === null) {
        await tx.adPlacement.create({
          data: { slotCode: entry.slotCode, supportedCreativeKinds },
        });
        created.push(entry.slotCode);
        logger.log({ slotCode: entry.slotCode }, 'ad-placement-seed: created');
        continue;
      }

      await tx.adPlacement.update({
        where: { slotCode: entry.slotCode },
        data: { supportedCreativeKinds },
      });
      updated.push(entry.slotCode);
      logger.log({ slotCode: entry.slotCode }, 'ad-placement-seed: updated');
    }

    return { entriesUpserted: created.length + updated.length, created, updated };
  });
}
