import 'reflect-metadata';

import { Logger } from '@nestjs/common';
import { createLogger } from '@taste-and-see/logger';

import { seedPlanCatalog } from '../modules/plans/seed';
import { loadEnv } from '../config/env';
import { PrismaService } from '../prisma/prisma.service';

/**
 * One-shot CLI entry-point: load the Phase-1 plan catalog (PRD §5) into
 * `subscription.plans`.
 *
 * Usage (locally):
 *
 *   pnpm -F @taste-and-see/service-subscription seed:plans
 *
 * Production / staging: wire this binary into a Kubernetes Job that runs
 * ahead of the release rollout (TS-152 ArgoCD bootstrap). The function
 * is idempotent so repeated runs are safe — second runs only update the
 * mutable columns of existing plans, never re-id them.
 *
 * The script intentionally does NOT instantiate the full Nest app —
 * plan seeding is a database-only operation, no HTTP listener is
 * needed. Booting only the Prisma client keeps the Job pod's startup
 * fast and its surface minimal. Mirrors `seed-rbac.ts` in
 * service-identity exactly.
 */
async function main(): Promise<void> {
  const env = loadEnv();
  const logger = createLogger({
    service: 'service-subscription',
    version: env.SERVICE_VERSION,
  });
  const cliLogger = new Logger('seed-plans');

  const prisma = new PrismaService();
  await prisma.$connect();
  try {
    const report = await seedPlanCatalog(prisma);
    cliLogger.log(
      {
        plansUpserted: report.plansUpserted,
        created: report.created,
        updated: report.updated,
      },
      'plan-catalog seed completed',
    );
    logger.info({ phase: 'plan-seed', report }, 'plan-catalog seed completed');
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err: unknown) => {
  const cliLogger = new Logger('seed-plans');
  cliLogger.error(
    { err: err instanceof Error ? err.message : String(err) },
    'plan-catalog seed failed',
  );
  process.exitCode = 1;
});
