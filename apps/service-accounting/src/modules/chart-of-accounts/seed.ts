import { Logger } from '@nestjs/common';

import { PrismaService } from '../../prisma/prisma.service';
import { CHART_OF_ACCOUNTS_CATALOG, type SeedAccountEntry } from './seed-catalog';

/**
 * Surface used by `seedChartOfAccounts`. Typed against the actual
 * Prisma surface we touch so the function takes a `PrismaService`
 * directly without depending on the `Prisma.TransactionClient`
 * namespace value-side (same workaround as the plans + RBAC seeds —
 * TS-021-followup-2 for the underlying tooling issue).
 */
export interface ChartOfAccountsSeedClient {
  readonly chartOfAccount: PrismaService['chartOfAccount'];
}

export interface ChartOfAccountsSeedReport {
  readonly accountsUpserted: number;
  readonly created: readonly string[];
  readonly updated: readonly string[];
}

/**
 * Idempotently load the Phase-1 chart of accounts (PDD §11.2 +
 * Appendix A) into `accounting.chart_of_accounts`.
 *
 * Idempotency contract:
 *   - Accounts are upserted on `code` (the stable accounting identifier).
 *   - On insert: every column is written from the catalog entry. The
 *     `parent_id` is resolved by looking up the previously-inserted
 *     parent (catalog order guarantees the parent exists by the time
 *     a child is inserted, enforced at module load by the compile-time
 *     guard in `seed-catalog.ts`).
 *   - On update: only the columns whose values the catalog owns are
 *     refreshed — `name`, `description`, `type`, `normal_balance`,
 *     `parent_id`, `currency`, `active`. The `id` and `created_at` are
 *     NOT overwritten so any journal_lines referencing the account by
 *     id stay valid.
 *
 * What this function does NOT do:
 *   - It never deletes accounts (an account removed from the catalog
 *     stays on disk so historical journal_lines remain readable).
 *     Operators retire an account via admin tooling (`active = false`).
 *   - It never touches `journals`, `journal_lines`, or `accounting_periods`.
 *
 * The function runs inside a single transaction so a partial failure
 * cannot leave the catalog half-applied.
 *
 * **Why a parent-resolution lookup at insert time instead of a second
 * pass.** The catalog enforces parent-before-child ordering at module
 * load. Resolving parent_id inline (querying the just-inserted parent
 * by its code) keeps the seed single-pass — no parent-id back-patching
 * step, and an interrupted seed run picks up cleanly from the partial
 * state on the next run because `findUnique({ where: { code } })`
 * returns the same row whether it was inserted earlier in the same
 * run or in a prior run.
 */
export async function seedChartOfAccounts(
  prisma: PrismaService,
): Promise<ChartOfAccountsSeedReport> {
  const logger = new Logger(seedChartOfAccounts.name);
  return prisma.$transaction(
    async (tx: ChartOfAccountsSeedClient): Promise<ChartOfAccountsSeedReport> => {
      const created: string[] = [];
      const updated: string[] = [];

      for (const entry of CHART_OF_ACCOUNTS_CATALOG) {
        const parentId = await resolveParentId(tx, entry);

        const existing = await tx.chartOfAccount.findUnique({
          where: { code: entry.code },
          select: { id: true },
        });

        if (existing === null) {
          await tx.chartOfAccount.create({
            data: {
              code: entry.code,
              name: entry.name,
              description: entry.description,
              type: entry.type,
              normalBalance: entry.normalBalance,
              parentId,
              currency: entry.currency,
              active: entry.active,
            },
          });
          created.push(entry.code);
          logger.log({ code: entry.code }, 'chart-of-accounts-seed: created');
          continue;
        }

        await tx.chartOfAccount.update({
          where: { code: entry.code },
          data: {
            name: entry.name,
            description: entry.description,
            type: entry.type,
            normalBalance: entry.normalBalance,
            parentId,
            currency: entry.currency,
            active: entry.active,
          },
        });
        updated.push(entry.code);
        logger.log({ code: entry.code }, 'chart-of-accounts-seed: updated');
      }

      return {
        accountsUpserted: created.length + updated.length,
        created,
        updated,
      };
    },
  );
}

/**
 * Look up the parent account's id by its code. Returns `null` for
 * top-level entries (no parent). Throws if `parentCode` is non-null
 * but the parent row is missing — the compile-time catalog guard
 * makes this impossible in practice; the runtime throw is a defence-
 * in-depth against future catalog edits that accidentally reorder
 * entries past the load-time check.
 */
async function resolveParentId(
  tx: ChartOfAccountsSeedClient,
  entry: SeedAccountEntry,
): Promise<string | null> {
  if (entry.parentCode === null) return null;
  const parent = await tx.chartOfAccount.findUnique({
    where: { code: entry.parentCode },
    select: { id: true },
  });
  if (parent === null) {
    throw new Error(
      `chart-of-accounts-seed: parent ${entry.parentCode} missing when seeding ${entry.code} — catalog order broken`,
    );
  }
  return parent.id;
}
