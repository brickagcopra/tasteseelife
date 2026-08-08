import { Injectable } from '@nestjs/common';

import { PrismaService } from '../../../prisma/prisma.service';

/**
 * Catalog row shape — projection of a `certifications` row.
 *
 * Local mirror of the Prisma-generated row (see TS-051-followup-9 /
 * TS-021-followup-2 for the underlying tsc-namespace-value issue
 * that forces local mirrors today).
 */
export interface CertificationCatalogRecord {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly description: string;
  readonly issuer: string;
  readonly defaultValidityMonths: number | null;
  readonly sortPosition: number;
  readonly active: boolean;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/**
 * Read-only catalog access (TS-052).
 *
 * Two surfaces:
 *  - `listActive()` — every `active = true` row, ordered by
 *    `sortPosition` then `code`. Powers the public
 *    `GET /api/v1/certifications` endpoint.
 *  - `findByCode(code)` — single-row lookup. Used by the
 *    provider-certifications grant flow to resolve a request's
 *    `certificationCode` to an internal id + validity hint, and by
 *    the tier-promotion service to look up the gate certs.
 *
 * **Why a separate service from `ProviderCertificationsService`**. The
 * catalog is platform metadata; an issuance is per-provider state.
 * Keeping the two services apart keeps the surface boundaries tight
 * — admin tooling that mutates the catalog (TS-127 / TS-290) won't
 * touch issuance rows, and the grant flow doesn't accidentally write
 * to the catalog.
 *
 * **Caching**. None today — the catalog is small (4 rows in Phase 1)
 * and the read frequency is bounded by the family-portal pricing
 * page. A Redis cache lands as a follow-up if the read path becomes
 * hot.
 */
@Injectable()
export class CertificationsCatalogService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Return every active catalog row, ordered by `sortPosition` then
   * `code`. The `sortPosition` tie-break on `code` keeps the order
   * deterministic when two rows share a position.
   */
  async listActive(): Promise<readonly CertificationCatalogRecord[]> {
    const rows = await this.prisma.certification.findMany({
      where: { active: true },
      orderBy: [{ sortPosition: 'asc' }, { code: 'asc' }],
    });
    return rows as CertificationCatalogRecord[];
  }

  /**
   * Look up a single catalog row by its stable `code`. Returns `null`
   * when no row exists OR the row exists but is inactive — callers
   * who specifically want the inactive row use the admin tooling
   * surface (TS-127), not this method.
   */
  async findByCode(code: string): Promise<CertificationCatalogRecord | null> {
    if (code.length === 0) return null;
    const row = await this.prisma.certification.findUnique({
      where: { code },
    });
    if (row === null) return null;
    if (!row.active) return null;
    return row as CertificationCatalogRecord;
  }

  /**
   * Look up a single catalog row by id. Used by
   * `ProviderCertificationsService` when projecting an issuance row
   * for the response DTO. Includes inactive catalog rows — historical
   * issuances continue to reference their catalog row even after
   * retirement.
   */
  async findById(id: string): Promise<CertificationCatalogRecord | null> {
    if (id.length === 0) return null;
    const row = await this.prisma.certification.findUnique({
      where: { id },
    });
    return row as CertificationCatalogRecord | null;
  }

  /**
   * Bulk lookup by id set — used by `listForProvider` to denormalise
   * the cert name + code onto each issuance row in a single round-
   * trip rather than N+1 fetching.
   */
  async findManyByIds(
    ids: readonly string[],
  ): Promise<ReadonlyMap<string, CertificationCatalogRecord>> {
    if (ids.length === 0) return new Map();
    const rows = await this.prisma.certification.findMany({
      where: { id: { in: [...ids] } },
    });
    const map = new Map<string, CertificationCatalogRecord>();
    for (const row of rows as CertificationCatalogRecord[]) {
      map.set(row.id, row);
    }
    return map;
  }
}
