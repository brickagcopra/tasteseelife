import { Logger } from '@nestjs/common';

import { PrismaService } from '../../prisma/prisma.service';
import { CERTIFICATION_CATALOG } from './seed-catalog';

/**
 * Surface used by `seedCertificationsCatalog`. Typed against the
 * actual Prisma surface we touch so the function takes a
 * `PrismaService` directly without depending on the
 * `Prisma.TransactionClient` namespace value-side (same workaround
 * as the RBAC + plans seeds — TS-021-followup-2 for the underlying
 * tooling issue).
 */
export interface CertificationSeedClient {
  readonly certification: PrismaService['certification'];
}

export interface CertificationSeedReport {
  readonly certificationsUpserted: number;
  readonly created: readonly string[];
  readonly updated: readonly string[];
}

/**
 * Idempotently load the Phase-1 certification catalog (PRD §5.2 /
 * §9) into `provider.certifications`.
 *
 * Idempotency contract:
 *  - Rows are upserted on `code` (the stable identifier).
 *  - On insert: every column is written from the catalog entry.
 *  - On update: only the columns whose values the catalog owns are
 *    refreshed (`name`, `description`, `issuer`,
 *    `default_validity_months`, `sort_position`, `active`). The
 *    `id` and `created_at` are NOT overwritten so any references
 *    from `provider_certifications` rows stay stable.
 *
 * What this function does NOT do:
 *  - It never deletes catalog entries (a cert removed from the
 *    catalog stays on disk so historical issuance rows remain
 *    readable). Operators retire a cert by flipping `active = false`
 *    via admin tooling — the seed itself doesn't toggle `active` on
 *    a row already at `true` unless the catalog entry changed.
 *  - It never touches `provider_certifications` or
 *    `provider_tier_history`.
 *
 * The function runs inside a single transaction so a partial failure
 * cannot leave the catalog half-applied.
 */
export async function seedCertificationsCatalog(
  prisma: PrismaService,
): Promise<CertificationSeedReport> {
  const logger = new Logger(seedCertificationsCatalog.name);
  return prisma.$transaction(
    async (tx: CertificationSeedClient): Promise<CertificationSeedReport> => {
      const created: string[] = [];
      const updated: string[] = [];

      for (const entry of CERTIFICATION_CATALOG) {
        const existing = await tx.certification.findUnique({
          where: { code: entry.code },
          select: { id: true },
        });

        if (existing === null) {
          await tx.certification.create({
            data: {
              code: entry.code,
              name: entry.name,
              description: entry.description,
              issuer: entry.issuer,
              defaultValidityMonths: entry.defaultValidityMonths,
              sortPosition: entry.sortPosition,
              active: entry.active,
            },
          });
          created.push(entry.code);
          logger.log({ code: entry.code }, 'certification-seed: created');
          continue;
        }

        await tx.certification.update({
          where: { code: entry.code },
          data: {
            name: entry.name,
            description: entry.description,
            issuer: entry.issuer,
            defaultValidityMonths: entry.defaultValidityMonths,
            sortPosition: entry.sortPosition,
            active: entry.active,
          },
        });
        updated.push(entry.code);
        logger.log({ code: entry.code }, 'certification-seed: updated');
      }

      return {
        certificationsUpserted: created.length + updated.length,
        created,
        updated,
      };
    },
  );
}
