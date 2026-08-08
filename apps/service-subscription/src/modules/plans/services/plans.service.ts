import { Injectable, Logger } from '@nestjs/common';
import type { Plan as PlanDto, PlanCustomerGroup } from '@taste-and-see/contracts';
import Decimal from 'decimal.js';

import { PrismaService } from '../../../prisma/prisma.service';

/**
 * The single source of truth for the columns the public plan-catalog
 * endpoint reads. Hoisted to module scope (rather than a class field) so
 * Prisma's `findMany({ select })` can structurally narrow the row type at
 * the call site — a class-field `select` collapses to `any` because
 * `this.<field>` loses the literal-object type Prisma's generics depend
 * on. The mirrored `PlanProjection` interface below shadows this shape
 * one-to-one; a future column addition has to be touched in both places,
 * which is the deliberate cost of explicit projection.
 */
const PLAN_PUBLIC_SELECT = {
  id: true,
  code: true,
  name: true,
  description: true,
  customerGroup: true,
  monthlyPrice: true,
  annualPrice: true,
  currency: true,
  features: true,
  active: true,
  sortPosition: true,
  createdAt: true,
  updatedAt: true,
} as const;

/**
 * Slim Prisma projection of the columns needed to render a `PlanDto`. Keeping
 * the projection narrow defends against a future schema column landing in
 * the response (CLAUDE.md §3.3 — no raw Prisma objects to clients) and
 * makes the SQL `SELECT` cost stable.
 */
interface PlanProjection {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly description: string | null;
  readonly customerGroup: PlanCustomerGroup;
  readonly monthlyPrice: Decimal;
  readonly annualPrice: Decimal;
  readonly currency: string;
  readonly features: unknown;
  readonly active: boolean;
  readonly sortPosition: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/**
 * `PlansService` — read-side facade for the subscription plan catalog.
 *
 * TS-040 ships only the public list endpoint (`listActive`); future tasks
 * extend the surface — admin-side mutations land with TS-127 (admin
 * subscriptions management), the per-id lookup with TS-041 (subscription
 * checkout flow needs to verify a plan reference), and pricing-page
 * filter facets with TS-124 (family-portal checkout UX).
 *
 * **DTO mapping rationale.** The Prisma row carries `Decimal` price
 * columns + `jsonb` features, which neither the contract nor the wire
 * accept directly. The service owns the conversion so:
 *   - `Decimal.toFixed(2)` → integer USD minor units (no float math
 *     touches the price; CLAUDE.md §17.6).
 *   - The `jsonb` features blob is narrowed to `string[]` with a guard
 *     that filters non-string entries (defence-in-depth — admin tooling
 *     could in theory write a malformed array, the API surface stays
 *     well-shaped).
 *   - `Date` columns become ISO-8601 strings via `.toISOString()`.
 *
 * The mapping lives inside the service rather than a separate mapper
 * module because TS-040 has only the one endpoint; if a second consumer
 * needs the same shape (admin tooling), the mapper is extracted then.
 */
@Injectable()
export class PlansService {
  private readonly logger = new Logger(PlansService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * List every active plan, ordered for the public pricing page.
   *
   * Ordering: `(customer_group ASC, sort_position ASC, code ASC)`.
   * `customer_group` is the outer band (family / provider / academy);
   * `sort_position` is the admin-controllable order within a band; `code`
   * is the deterministic tie-breaker so identical sort_positions don't
   * yield jittery results between deploys.
   *
   * The composite covering index `plans_active_customer_group_sort_idx`
   * (`active`, `customer_group`, `sort_position`, `code`) lets Postgres
   * satisfy this query as a single index-only scan.
   */
  async listActive(): Promise<readonly PlanDto[]> {
    // The `select` is inlined (rather than hoisted to a class field) so
    // Prisma's type inference can structurally narrow the row type at
    // the call site. A class-field `select` collapses to `any` because
    // `this.<field>` loses the literal-object type Prisma needs.
    const rows = await this.prisma.plan.findMany({
      where: { active: true },
      select: PLAN_PUBLIC_SELECT,
      orderBy: [{ customerGroup: 'asc' }, { sortPosition: 'asc' }, { code: 'asc' }],
    });

    this.logger.log({ count: rows.length }, 'plans.listActive');
    return rows.map((row: PlanProjection) => this.toDto(row));
  }

  private toDto(row: PlanProjection): PlanDto {
    return {
      id: row.id,
      code: row.code,
      name: row.name,
      ...(row.description !== null && { description: row.description }),
      customerGroup: row.customerGroup,
      monthlyPriceUsdMinor: this.decimalToUsdMinor(row.monthlyPrice),
      annualPriceUsdMinor: this.decimalToUsdMinor(row.annualPrice),
      currency: this.narrowCurrency(row.currency),
      features: this.narrowFeatures(row.features),
      active: row.active,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  /**
   * Convert a `Decimal` price (e.g. `199.00`) to integer USD minor units
   * (e.g. `19900`) WITHOUT going through `Number` (CLAUDE.md §17.6).
   *
   * The two-step is: round to 2 decimal places (defence-in-depth — the
   * column is `Decimal(12,2)` so this should be a no-op) then multiply
   * by 100 and convert to a JS integer. The result is bounded by the
   * column type to ≤ 9_999_999_999.99 → ≤ 999_999_999_999 minor units,
   * comfortably inside `Number.MAX_SAFE_INTEGER` (~9.0e15).
   */
  private decimalToUsdMinor(value: Decimal): number {
    return value.mul(100).toDecimalPlaces(0, Decimal.ROUND_HALF_EVEN).toNumber();
  }

  /**
   * Narrow the DB-side `currency CHAR(3)` to the contract enum (USD only
   * in Phase 1). A row carrying a future currency would surface a clean
   * 500 here rather than silently passing through unsupported wire shape;
   * the contract layer's downstream `.parse()` would reject anyway, so
   * this is defence-in-depth.
   */
  private narrowCurrency(value: string): 'USD' {
    if (value !== 'USD') {
      throw new Error(`unsupported currency in plan row: ${value}`);
    }
    return 'USD';
  }

  /**
   * Narrow the `jsonb` features blob to `string[]`. Filters any
   * non-string entries (defence-in-depth against admin-tool drift) and
   * coerces a non-array shape to `[]` (rather than throwing — a missing
   * features list is recoverable in render).
   */
  private narrowFeatures(value: unknown): string[] {
    if (!Array.isArray(value)) return [];
    return value.filter((entry): entry is string => typeof entry === 'string');
  }
}
