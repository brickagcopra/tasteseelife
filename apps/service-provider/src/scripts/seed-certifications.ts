import 'reflect-metadata';

import { Logger } from '@nestjs/common';
import { createLogger } from '@taste-and-see/logger';

import { loadEnv } from '../config/env';
import { seedCertificationsCatalog } from '../modules/certifications/seed';
import { PrismaService } from '../prisma/prisma.service';

/**
 * One-shot CLI entry-point: load the Phase-1 certification catalog
 * (PRD §5.2 / §9) into `provider.certifications`.
 *
 * Usage (locally):
 *
 *   pnpm -F @taste-and-see/service-provider seed:certifications
 *
 * Production / staging: wire this binary into a Kubernetes Job that
 * runs ahead of the release rollout (TS-152 ArgoCD bootstrap). The
 * function is idempotent so repeated runs are safe — second runs
 * only refresh the columns the catalog owns, never re-id rows.
 *
 * The script intentionally does NOT instantiate the full Nest app —
 * catalog seeding is a database-only operation, no HTTP listener
 * required. Mirrors `seed-plans.ts` in service-subscription and
 * `seed-rbac.ts` in service-identity exactly.
 */
async function main(): Promise<void> {
  const env = loadEnv();
  const logger = createLogger({
    service: 'service-provider',
    version: env.SERVICE_VERSION,
  });
  const cliLogger = new Logger('seed-certifications');

  const prisma = new PrismaService();
  await prisma.$connect();
  try {
    const report = await seedCertificationsCatalog(prisma);
    cliLogger.log(
      {
        certificationsUpserted: report.certificationsUpserted,
        created: report.created,
        updated: report.updated,
      },
      'certification-catalog seed completed',
    );
    logger.info({ phase: 'certification-seed', report }, 'certification-catalog seed completed');
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err: unknown) => {
  const cliLogger = new Logger('seed-certifications');
  cliLogger.error(
    { err: err instanceof Error ? err.message : String(err) },
    'certification-catalog seed failed',
  );
  process.exitCode = 1;
});
