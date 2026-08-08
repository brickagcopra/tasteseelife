import 'reflect-metadata';

import { Logger } from '@nestjs/common';
import { createLogger } from '@taste-and-see/logger';

import { loadEnv } from '../config/env';
import { seedServiceCatalog } from '../modules/catalog/seed';
import { PrismaService } from '../prisma/prisma.service';

/**
 * One-shot CLI entry-point: load the Phase-1 service catalog
 * (PRD §5.4 / §6.3) into `booking.service_catalog`.
 *
 * Usage (locally):
 *
 *   pnpm -F @taste-and-see/service-booking seed:catalog
 *
 * Production / staging: wire this binary into a Kubernetes Job that runs
 * ahead of the release rollout (TS-152 ArgoCD bootstrap; TS-040-followup-3
 * tracks the plan-seed twin). The function is idempotent so repeated
 * runs are safe — second runs only refresh the mutable columns of
 * existing entries, never re-id them.
 *
 * The script intentionally does NOT instantiate the full Nest app —
 * catalog seeding is a database-only operation, no HTTP listener is
 * needed. Booting only the Prisma client keeps the Job pod's startup
 * fast and its surface minimal. Mirrors `seed-plans.ts` in
 * service-subscription exactly.
 *
 * NOTE: this script constructs a bare `PrismaService` (no tenant-scope
 * wrapper). `service_catalog` is platform-wide config (it carries no
 * tenant column and is registered in `unscopedModels`), so the
 * unwrapped client is correct here — the seed does not run inside a
 * tenant-scoped request frame.
 */
async function main(): Promise<void> {
  const env = loadEnv();
  const logger = createLogger({
    service: 'service-booking',
    version: env.SERVICE_VERSION,
  });
  const cliLogger = new Logger('seed-catalog');

  const prisma = new PrismaService();
  await prisma.$connect();
  try {
    const report = await seedServiceCatalog(prisma);
    cliLogger.log(
      {
        entriesUpserted: report.entriesUpserted,
        created: report.created,
        updated: report.updated,
      },
      'service-catalog seed completed',
    );
    logger.info({ phase: 'catalog-seed', report }, 'service-catalog seed completed');
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err: unknown) => {
  const cliLogger = new Logger('seed-catalog');
  cliLogger.error(
    { err: err instanceof Error ? err.message : String(err) },
    'service-catalog seed failed',
  );
  process.exitCode = 1;
});
