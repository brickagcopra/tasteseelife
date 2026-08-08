import { Injectable, Logger } from '@nestjs/common';
import {
  SERVICE_CATALOG_DEFAULT_CURRENCY,
  type BookingServiceKind,
  type ProviderTier,
  type ServiceCatalogRecord,
  type UpsertServiceCatalogEntryRequest,
} from '@taste-and-see/contracts';

import { decimalStringToMinor, minorToDecimalString } from '../../../common/money';
import { err, ok, type Result } from '../../../common/result';
import { PrismaService } from '../../../prisma/prisma.service';

/**
 * Columns projected for every catalog read/write. Explicit `select` —
 * never `SELECT *` in a production path (CLAUDE.md §4.1).
 */
const CATALOG_SELECT = {
  kind: true,
  name: true,
  description: true,
  baseRateMin: true,
  baseRateMax: true,
  durationMinutes: true,
  currency: true,
  active: true,
  requiredProviderTier: true,
  sortPosition: true,
  updatedAt: true,
} as const;

/**
 * Structural shape of a selected catalog row. Typed structurally (not
 * via the `@prisma/client` `ServiceCatalogEntry` model type) for the
 * same reason the sibling services keep local row mirrors — the Prisma
 * namespace value-side doesn't resolve cleanly today (TS-021-followup-3).
 * The Prisma-selected row is assignable to this shape (`Decimal` →
 * `{ toString }`, the Prisma `ServiceKind` enum → `BookingServiceKind`).
 */
interface ServiceCatalogRow {
  readonly kind: BookingServiceKind;
  readonly name: string;
  readonly description: string;
  readonly baseRateMin: { toString(): string };
  readonly baseRateMax: { toString(): string };
  readonly durationMinutes: number;
  readonly currency: string;
  readonly active: boolean;
  readonly requiredProviderTier: ProviderTier | null;
  readonly sortPosition: number;
  readonly updatedAt: Date;
}

/**
 * Failure modes for the admin upsert. The contract layer already
 * rejects an inverted band (`min > max`) and a malformed currency
 * length at the controller boundary (400 via `ZodValidationPipe`); the
 * service re-checks both as defence-in-depth and adds the Phase-1
 * USD-only policy (which is intentionally NOT baked into the contract
 * so the wire shape survives the multi-currency rollout).
 */
export type CatalogServiceFailure =
  | { readonly reason: 'unsupported_currency'; readonly currency: string }
  | {
      readonly reason: 'invalid_band';
      readonly baseRateMinMinor: number;
      readonly baseRateMaxMinor: number;
    };

/** Map a persisted row to the public `ServiceCatalogRecord` wire shape. */
function toServiceCatalogRecord(row: ServiceCatalogRow): ServiceCatalogRecord {
  return {
    kind: row.kind,
    name: row.name,
    description: row.description,
    baseRateMinMinor: decimalStringToMinor(row.baseRateMin.toString()),
    baseRateMaxMinor: decimalStringToMinor(row.baseRateMax.toString()),
    durationMinutes: row.durationMinutes,
    currency: row.currency,
    active: row.active,
    requiredProviderTier: row.requiredProviderTier,
    sortPosition: row.sortPosition,
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * Service-catalog read + admin-edit logic (TS-060-followup-2).
 *
 * Owns the `booking.service_catalog` table — the admin-editable pricing
 * / duration metadata layer beside the `service_kind` enum (PRD §5.4 /
 * §6.3, PDD §8.2). Consumed by:
 *
 *   - `GET /api/v1/service-catalog` (authenticated read) — `list`.
 *   - `PUT /api/v1/admin/service-catalog/:kind` (super-admin) — `upsert`.
 *   - The booking-create quote path will read `getByKind` once
 *     TS-060-followup-2a wires it (today `service-kind-defaults.ts` is
 *     the constant substitute).
 *
 * `service_catalog` is platform-wide config (no tenant column) and is
 * registered in `unscopedModels`, so the tenant-scope Prisma extension
 * does not filter these queries.
 */
@Injectable()
export class CatalogService {
  private readonly logger = new Logger(CatalogService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Every catalog entry, ordered by `sortPosition`. Returns both active
   * and inactive rows so the admin editor sees retired kinds; consumers
   * (e.g. the family-portal picker) filter on `active` client-side.
   */
  async list(): Promise<readonly ServiceCatalogRecord[]> {
    const rows = await this.prisma.serviceCatalogEntry.findMany({
      select: CATALOG_SELECT,
      orderBy: { sortPosition: 'asc' },
    });
    return rows.map(toServiceCatalogRecord);
  }

  /** One entry by kind, or null when no row exists for the kind. */
  async getByKind(kind: BookingServiceKind): Promise<ServiceCatalogRecord | null> {
    const row = await this.prisma.serviceCatalogEntry.findUnique({
      where: { kind },
      select: CATALOG_SELECT,
    });
    return row === null ? null : toServiceCatalogRecord(row);
  }

  /**
   * Create-or-update the catalog row for `kind`. Full-replace on the
   * editable columns; `kind` is the upsert key, never client-mutable.
   *
   * Rejects (without a write):
   *   - a non-USD currency until multi-currency lands (Phase 3).
   *   - an inverted band (defence-in-depth; the contract catches it
   *     first at the controller boundary).
   */
  async upsert(
    kind: BookingServiceKind,
    body: UpsertServiceCatalogEntryRequest,
  ): Promise<Result<ServiceCatalogRecord, CatalogServiceFailure>> {
    if (body.currency !== SERVICE_CATALOG_DEFAULT_CURRENCY) {
      return err({ reason: 'unsupported_currency', currency: body.currency });
    }
    if (body.baseRateMinMinor > body.baseRateMaxMinor) {
      return err({
        reason: 'invalid_band',
        baseRateMinMinor: body.baseRateMinMinor,
        baseRateMaxMinor: body.baseRateMaxMinor,
      });
    }

    const mutableColumns = {
      name: body.name,
      description: body.description,
      baseRateMin: minorToDecimalString(body.baseRateMinMinor),
      baseRateMax: minorToDecimalString(body.baseRateMaxMinor),
      durationMinutes: body.durationMinutes,
      currency: body.currency,
      active: body.active,
      requiredProviderTier: body.requiredProviderTier,
      sortPosition: body.sortPosition,
    };

    const row = await this.prisma.serviceCatalogEntry.upsert({
      where: { kind },
      create: { kind, ...mutableColumns },
      update: mutableColumns,
      select: CATALOG_SELECT,
    });

    this.logger.log({ kind, active: body.active }, 'service-catalog.upsert');
    return ok(toServiceCatalogRecord(row));
  }
}
