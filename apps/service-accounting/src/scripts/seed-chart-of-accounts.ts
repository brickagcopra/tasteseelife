import 'reflect-metadata';

import { Logger } from '@nestjs/common';
import { createLogger } from '@taste-and-see/logger';

import { loadEnv } from '../config/env';
import { seedChartOfAccounts } from '../modules/chart-of-accounts/seed';
import { PrismaService } from '../prisma/prisma.service';

/**
 * One-shot CLI entry-point: load the Phase-1 chart of accounts
 * (PDD §11.2 + Appendix A) into `accounting.chart_of_accounts`.
 *
 * Usage (locally):
 *
 *   pnpm -F @taste-and-see/service-accounting seed:chart-of-accounts
 *
 * Production / staging: wire this binary into a Kubernetes Job that
 * runs ahead of the release rollout (TS-152 ArgoCD bootstrap). The
 * function is idempotent so repeated runs are safe — second runs
 * only update the mutable columns of existing accounts, never re-id
 * them (critical because `journal_lines.account_id` references the id).
 *
 * The script intentionally does NOT instantiate the full Nest app —
 * chart-of-accounts seeding is a database-only operation, no HTTP
 * listener is needed. Booting only the Prisma client keeps the Job
 * pod's startup fast and its surface minimal. Mirrors `seed-rbac.ts`
 * in service-identity and `seed-plans.ts` in service-subscription
 * exactly.
 */
async function main(): Promise<void> {
  const env = loadEnv();
  const logger = createLogger({
    service: 'service-accounting',
    version: env.SERVICE_VERSION,
  });
  const cliLogger = new Logger('seed-chart-of-accounts');

  const prisma = new PrismaService();
  await prisma.$connect();
  try {
    const report = await seedChartOfAccounts(prisma);
    cliLogger.log(
      {
        accountsUpserted: report.accountsUpserted,
        created: report.created,
        updated: report.updated,
      },
      'chart-of-accounts seed completed',
    );
    logger.info({ phase: 'chart-of-accounts-seed', report }, 'chart-of-accounts seed completed');
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err: unknown) => {
  const cliLogger = new Logger('seed-chart-of-accounts');
  cliLogger.error(
    { err: err instanceof Error ? err.message : String(err) },
    'chart-of-accounts seed failed',
  );
  process.exitCode = 1;
});
