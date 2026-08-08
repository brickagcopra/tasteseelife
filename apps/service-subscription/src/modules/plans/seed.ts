import { Logger } from '@nestjs/common';

import { PrismaService } from '../../prisma/prisma.service';
import { PLAN_CATALOG } from './seed-catalog';

/**
 * Surface used by `seedPlanCatalog`. Typed against the actual Prisma
 * surface we touch so the function takes a `PrismaService` directly
 * without depending on the `Prisma.TransactionClient` namespace
 * value-side (same workaround as the RBAC seed — TS-021-followup-2 for
 * the underlying tooling issue).
 */
export interface PlanSeedClient {
  readonly plan: PrismaService['plan'];
}

export interface PlanSeedReport {
  readonly plansUpserted: number;
  readonly created: readonly string[];
  readonly updated: readonly string[];
}

/**
 * Idempotently load the Phase-1 plan catalog (PRD §5) into
 * `subscription.plans`.
 *
 * Idempotency contract:
 *  - Plans are upserted on `code` (the stable identifier).
 *  - On insert: every column is written from the catalog entry.
 *  - On update: only the columns whose values the catalog owns are
 *    refreshed — `name`, `description`, `customer_group`,
 *    `monthly_price`, `annual_price`, `currency`, `features`, `active`,
 *    `sort_position`. The `id` and `created_at` are NOT overwritten;
 *    that preserves any references in subscription rows that will
 *    point at `plans.id` once TS-041 ships.
 *
 * What this function does NOT do:
 *  - It never deletes plans (a plan removed from the catalog stays on
 *    disk so historical subscriptions remain readable). Operators who
 *    want to retire a plan flip `active = false` via admin tooling.
 *  - It never touches `subscriptions`, `coupons`, or any of the other
 *    tables that will land in TS-041+.
 *
 * The function runs inside a single transaction so a partial failure
 * cannot leave the catalog half-applied.
 */
export async function seedPlanCatalog(prisma: PrismaService): Promise<PlanSeedReport> {
  const logger = new Logger(seedPlanCatalog.name);
  return prisma.$transaction(async (tx: PlanSeedClient): Promise<PlanSeedReport> => {
    const created: string[] = [];
    const updated: string[] = [];

    for (const entry of PLAN_CATALOG) {
      const existing = await tx.plan.findUnique({
        where: { code: entry.code },
        select: { id: true },
      });

      if (existing === null) {
        await tx.plan.create({
          data: {
            code: entry.code,
            name: entry.name,
            description: entry.description,
            customerGroup: entry.customerGroup,
            monthlyPrice: entry.monthlyPrice.toFixed(2),
            annualPrice: entry.annualPrice.toFixed(2),
            currency: entry.currency,
            features: [...entry.features],
            active: entry.active,
            sortPosition: entry.sortPosition,
          },
        });
        created.push(entry.code);
        logger.log({ code: entry.code }, 'plan-seed: created');
        continue;
      }

      await tx.plan.update({
        where: { code: entry.code },
        data: {
          name: entry.name,
          description: entry.description,
          customerGroup: entry.customerGroup,
          monthlyPrice: entry.monthlyPrice.toFixed(2),
          annualPrice: entry.annualPrice.toFixed(2),
          currency: entry.currency,
          features: [...entry.features],
          active: entry.active,
          sortPosition: entry.sortPosition,
        },
      });
      updated.push(entry.code);
      logger.log({ code: entry.code }, 'plan-seed: updated');
    }

    return {
      plansUpserted: created.length + updated.length,
      created,
      updated,
    };
  });
}
