import { Logger } from '@nestjs/common';

import { minorToDecimalString } from '../../common/money';
import { PrismaService } from '../../prisma/prisma.service';
import { SERVICE_CATALOG_SEED } from './seed-catalog';

/**
 * Surface used by `seedServiceCatalog`. Typed against the actual Prisma
 * surface we touch so the function takes a `PrismaService` directly
 * without depending on the `Prisma.TransactionClient` namespace
 * value-side (same workaround as the plan + RBAC seeds —
 * TS-021-followup-2 for the underlying tooling issue).
 */
export interface CatalogSeedClient {
  readonly serviceCatalogEntry: PrismaService['serviceCatalogEntry'];
}

export interface CatalogSeedReport {
  readonly entriesUpserted: number;
  readonly created: readonly string[];
  readonly updated: readonly string[];
}

/**
 * Idempotently load the Phase-1 service catalog (PRD §5.4 / §6.3) into
 * `booking.service_catalog`.
 *
 * Idempotency contract:
 *  - Entries are upserted on `kind` (the stable unique identifier).
 *  - On insert: every column is written from the catalog entry.
 *  - On update: only the operator-editable columns are refreshed —
 *    `name`, `description`, `base_rate_min`, `base_rate_max`,
 *    `duration_minutes`, `currency`, `active`, `required_provider_tier`,
 *    `sort_position`. The `id` and `created_at` are NOT overwritten,
 *    preserving the row's identity across reseeds (so a hand-edited row
 *    keeps its id).
 *
 * What this function does NOT do:
 *  - It never deletes entries. A kind removed from the seed stays on
 *    disk; operators retire a kind by flipping `active = false` via
 *    admin tooling (TS-128-followup-6).
 *
 * Money crosses the wire/persistence boundary here exactly once: the
 * seed carries integer minor units, the column is `Decimal(12,2)`, and
 * `minorToDecimalString` produces the fixed-2 string Postgres expects
 * (CLAUDE.md §6 — no floats for money).
 *
 * The function runs inside a single transaction so a partial failure
 * cannot leave the catalog half-applied.
 */
export async function seedServiceCatalog(prisma: PrismaService): Promise<CatalogSeedReport> {
  const logger = new Logger(seedServiceCatalog.name);
  return prisma.$transaction(async (tx: CatalogSeedClient): Promise<CatalogSeedReport> => {
    const created: string[] = [];
    const updated: string[] = [];

    for (const entry of SERVICE_CATALOG_SEED) {
      const mutableColumns = {
        name: entry.name,
        description: entry.description,
        baseRateMin: minorToDecimalString(entry.baseRateMinMinor),
        baseRateMax: minorToDecimalString(entry.baseRateMaxMinor),
        durationMinutes: entry.durationMinutes,
        currency: entry.currency,
        active: entry.active,
        requiredProviderTier: entry.requiredProviderTier,
        sortPosition: entry.sortPosition,
      };

      const existing = await tx.serviceCatalogEntry.findUnique({
        where: { kind: entry.kind },
        select: { id: true },
      });

      if (existing === null) {
        await tx.serviceCatalogEntry.create({
          data: { kind: entry.kind, ...mutableColumns },
        });
        created.push(entry.kind);
        logger.log({ kind: entry.kind }, 'service-catalog-seed: created');
        continue;
      }

      await tx.serviceCatalogEntry.update({
        where: { kind: entry.kind },
        data: mutableColumns,
      });
      updated.push(entry.kind);
      logger.log({ kind: entry.kind }, 'service-catalog-seed: updated');
    }

    return {
      entriesUpserted: created.length + updated.length,
      created,
      updated,
    };
  });
}
