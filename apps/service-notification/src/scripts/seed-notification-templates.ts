import 'reflect-metadata';

import { Logger } from '@nestjs/common';
import { createLogger } from '@taste-and-see/logger';
import {
  TenantContextStore,
  runWithoutTenantContext,
} from '@taste-and-see/nest-prisma-tenant-scope';

import { loadEnv } from '../config/env';
import { MjmlCompilerService } from '../modules/templates/services/mjml-compiler.service';
import { seedAccountEmailVerificationTemplate } from '../modules/templates/seed/account-verification-template';
import { seedAcademyCertificationRenewalTemplate } from '../modules/templates/seed/academy-certification-renewal-template';
import { seedBillingDunningTemplates } from '../modules/templates/seed/billing-dunning-templates';
import { seedWellnessSummaryTemplate } from '../modules/templates/seed/wellness-summary-template';
import { PrismaService } from '../prisma/prisma.service';

/**
 * One-shot CLI entry-point: seed the system notification templates (the
 * TS-235 monthly wellness-summary email, the TS-256 certification-renewal
 * reminder, and the four TS-042-followup-3a3 billing / dunning rungs) into
 * `notification.notification_templates` + `_versions`.
 *
 * Usage (locally):
 *
 *   pnpm -F @taste-and-see/service-notification seed:templates
 *
 * Production / staging: wire into a Kubernetes Job that runs ahead of the
 * release rollout (TS-235-followup, mirroring seed-rbac / seed-catalog).
 * The function is idempotent so repeated runs are safe.
 *
 * Like seed-rbac, this does NOT boot the full Nest app — template seeding
 * is a DB-only operation. `MjmlCompilerService` is dependency-free so it
 * is instantiated directly; `PrismaService` is too. The work is wrapped in
 * `runWithoutTenantContext` so the intent is explicit + future-proof if it
 * ever moves into a Nest application context (the template models are
 * `unscopedModels`, so the gate would short-circuit regardless).
 */
async function main(): Promise<void> {
  const env = loadEnv();
  const logger = createLogger({ service: 'service-notification', version: env.SERVICE_VERSION });
  const cliLogger = new Logger('seed-notification-templates');

  const prisma = new PrismaService();
  const mjml = new MjmlCompilerService();
  const tenantStore = new TenantContextStore();
  await prisma.$connect();
  try {
    const reports = await runWithoutTenantContext(
      tenantStore,
      'notification-template-seed',
      async () => ({
        wellnessSummary: await seedWellnessSummaryTemplate(prisma, mjml),
        academyCertificationRenewal: await seedAcademyCertificationRenewalTemplate(prisma, mjml),
        billingDunning: await seedBillingDunningTemplates(prisma, mjml),
        accountEmailVerification: await seedAccountEmailVerificationTemplate(prisma, mjml),
      }),
    );
    cliLogger.log(reports, 'notification template seed completed');
    logger.info(
      { phase: 'notification-template-seed', reports },
      'notification template seed completed',
    );
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err: unknown) => {
  const cliLogger = new Logger('seed-notification-templates');
  cliLogger.error(
    { err: err instanceof Error ? err.message : String(err) },
    'notification template seed failed',
  );
  process.exitCode = 1;
});
