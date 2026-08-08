import 'reflect-metadata';

import { Logger } from '@nestjs/common';
import { createLogger } from '@taste-and-see/logger';

import { loadEnv } from '../config/env';
import { seedAdPlacements } from '../modules/slot-inventory/placement-seed';
import { PrismaService } from '../prisma/prisma.service';

/**
 * One-shot CLI entry-point: load the five predefined ad placements (PRD §10.9;
 * PDD §18.1) into `ads.ad_placements`.
 *
 * Usage (locally):
 *
 *   pnpm -F @taste-and-see/service-ads seed:placements
 *
 * Production / staging: wire this binary into a Kubernetes Job that runs ahead
 * of the release rollout (the same shape as service-booking `seed:catalog` /
 * service-subscription `seed:plans`). The function is idempotent so repeated
 * runs are safe — second runs only refresh the mutable `supportedCreativeKinds`
 * column of existing slots, never re-id them.
 *
 * The script intentionally does NOT instantiate the full Nest app — placement
 * seeding is a database-only operation, no HTTP listener is needed. Booting
 * only the Prisma client keeps the Job pod's startup fast and its surface
 * minimal.
 *
 * NOTE: this constructs a bare `PrismaService` (no tenant-scope wrapper).
 * `ad_placements` is platform-wide inventory (no tenant column; registered in
 * `unscopedModels`), so the unwrapped client is correct — the seed does not run
 * inside a tenant-scoped request frame.
 */
async function main(): Promise<void> {
  const env = loadEnv();
  const logger = createLogger({ service: 'service-ads', version: env.SERVICE_VERSION });
  const cliLogger = new Logger('seed-placements');

  const prisma = new PrismaService();
  await prisma.$connect();
  try {
    const report = await seedAdPlacements(prisma);
    cliLogger.log(
      {
        entriesUpserted: report.entriesUpserted,
        created: report.created,
        updated: report.updated,
      },
      'ad-placements seed completed',
    );
    logger.info({ phase: 'placement-seed', report }, 'ad-placements seed completed');
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err: unknown) => {
  const cliLogger = new Logger('seed-placements');
  cliLogger.error(
    { err: err instanceof Error ? err.message : String(err) },
    'ad-placements seed failed',
  );
  process.exitCode = 1;
});
