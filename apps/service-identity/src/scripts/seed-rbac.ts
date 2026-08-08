import 'reflect-metadata';

import { Logger } from '@nestjs/common';
import { createLogger } from '@taste-and-see/logger';
import {
  TenantContextStore,
  runWithoutTenantContext,
} from '@taste-and-see/nest-prisma-tenant-scope';

import { loadEnv } from '../config/env';
import { seedRbacCatalog } from '../modules/rbac/seed';
import { PrismaService } from '../prisma/prisma.service';

/**
 * One-shot CLI entry-point: load the system RBAC catalog into
 * `identity.permissions` / `identity.roles` / `identity.role_permissions`.
 *
 * Usage (locally):
 *
 *   pnpm -F @taste-and-see/service-identity seed:rbac
 *
 * Production / staging: wire this binary into a Kubernetes Job that
 * runs ahead of the release rollout (TS-152 ArgoCD bootstrap). The
 * function is idempotent so repeated runs are safe.
 *
 * The script intentionally does NOT instantiate the full Nest app —
 * RBAC seeding is a database-only operation, no HTTP listener or
 * Auth/MFA/Token services are needed. Booting only the Prisma client
 * keeps the Job pod's startup fast and its surface minimal.
 *
 * Tenant-scoping (TS-020-followup-2). The script instantiates
 * `PrismaService` directly — not through the Nest DI graph — so the
 * `wrapWithTenantScope` factory in `PrismaModule` does NOT apply,
 * and the tenant-scope extension does NOT fire on these queries. The
 * script still wraps its work in `runWithoutTenantContext('rbac-seed',
 * ...)` so the intent is explicit + future-proof: should the seed move
 * to a Nest application context (Kubernetes Job built on the AppModule),
 * the explicit exempt frame keeps it working without an enforcement-
 * mode regression.
 */
async function main(): Promise<void> {
  const env = loadEnv();
  const logger = createLogger({
    service: 'service-identity',
    version: env.SERVICE_VERSION,
  });
  const cliLogger = new Logger('seed-rbac');

  const prisma = new PrismaService();
  const tenantStore = new TenantContextStore();
  await prisma.$connect();
  try {
    const report = await runWithoutTenantContext(tenantStore, 'rbac-seed', () =>
      seedRbacCatalog(prisma),
    );
    cliLogger.log(
      {
        permissionsUpserted: report.permissionsUpserted,
        rolesUpserted: report.rolesUpserted,
        rolePermissionsAttached: report.rolePermissionsAttached,
        rolePermissionsDetached: report.rolePermissionsDetached,
        skippedUnknownPermissions: report.skippedUnknownPermissions,
      },
      'rbac seed completed',
    );
    logger.info({ phase: 'rbac-seed', report }, 'rbac seed completed');
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err: unknown) => {
  const cliLogger = new Logger('seed-rbac');
  cliLogger.error({ err: err instanceof Error ? err.message : String(err) }, 'rbac seed failed');
  process.exitCode = 1;
});
