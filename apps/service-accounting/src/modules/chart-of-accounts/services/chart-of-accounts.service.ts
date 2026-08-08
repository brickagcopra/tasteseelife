import { Injectable, Logger } from '@nestjs/common';
import type {
  Account as AccountDto,
  AccountCurrency,
  AccountNormalBalance,
  AccountType,
} from '@taste-and-see/contracts';

import { PrismaService } from '../../../prisma/prisma.service';

/**
 * The single source of truth for the columns the public chart-of-
 * accounts endpoint reads. Hoisted to module scope (rather than a class
 * field) so Prisma's `findMany({ select })` can structurally narrow the
 * row type at the call site — a class-field `select` collapses to
 * `any` because `this.<field>` loses the literal-object type Prisma's
 * generics depend on. The mirrored `AccountProjection` interface below
 * shadows this shape one-to-one; a future column addition has to be
 * touched in both places, which is the deliberate cost of explicit
 * projection.
 */
const ACCOUNT_PUBLIC_SELECT = {
  id: true,
  code: true,
  name: true,
  description: true,
  type: true,
  parentId: true,
  normalBalance: true,
  currency: true,
  active: true,
  createdAt: true,
  updatedAt: true,
} as const;

/**
 * Slim Prisma projection of the columns needed to render an
 * `AccountDto`. Keeping the projection narrow defends against a future
 * schema column landing in the response (CLAUDE.md §3.3 — no raw
 * Prisma objects to clients) and makes the SQL `SELECT` cost stable.
 */
interface AccountProjection {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly description: string | null;
  readonly type: AccountType;
  readonly parentId: string | null;
  readonly normalBalance: AccountNormalBalance;
  readonly currency: string;
  readonly active: boolean;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/**
 * Filter shape mirroring `ListAccountsQuerySchema`. `parentId`
 * accepts the literal string `'null'` (case-insensitive) to mean
 * "top-level accounts only" — the alternative would be a separate
 * `topLevelOnly` flag, but the convention here matches how the contract
 * surfaces it.
 */
export interface ListAccountsFilter {
  readonly type?: AccountType;
  readonly parentId?: string;
  readonly activeOnly: boolean;
}

/**
 * `ChartOfAccountsService` — read-side facade for the accounting chart
 * of accounts.
 *
 * TS-080 ships only the public list endpoint (`list`); future tasks
 * extend the surface — admin-side mutations land with TS-127 (admin
 * subscriptions / accounting management), the per-id / per-code
 * lookup with TS-081 (journal-posting service needs to resolve a
 * code → id at post time).
 *
 * **DTO mapping rationale.** The Prisma row carries Date columns and
 * the row-level `currency` column. The service converts:
 *   - `Date` → ISO-8601 string via `.toISOString()`.
 *   - `currency` is narrowed to the contract enum (USD only in Phase 1);
 *     a row carrying a future currency surfaces a clean 500 here rather
 *     than silently passing through unsupported wire shape.
 *
 * The mapping lives inside the service rather than a separate mapper
 * module because TS-080 has only the one read endpoint; if a second
 * consumer needs the same shape (admin tooling, future BI), the
 * mapper is extracted then.
 */
@Injectable()
export class ChartOfAccountsService {
  private readonly logger = new Logger(ChartOfAccountsService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * List the chart of accounts in canonical order.
   *
   * Ordering: `(code ASC)`. The catalog codes are designed so a
   * lexicographic sort yields the canonical accounting display order
   * (1xxx → 2xxx → 3xxx → 4xxx → 4500/4510/4520 → 5xxx), and the
   * `chart_of_accounts_active_code_idx` covering index lets Postgres
   * satisfy the active-only listing as a single index-only scan.
   *
   * Filters:
   *   - `type` (optional) narrows to a single category.
   *   - `parentId` (optional) narrows to a sub-tree. The literal
   *     `'null'` (case-insensitive) means "top-level only".
   *   - `activeOnly` (default true) excludes retired accounts.
   */
  async list(filter: ListAccountsFilter): Promise<readonly AccountDto[]> {
    const where = this.buildWhere(filter);

    const rows = await this.prisma.chartOfAccount.findMany({
      where,
      select: ACCOUNT_PUBLIC_SELECT,
      orderBy: [{ code: 'asc' }],
    });

    this.logger.log(
      {
        count: rows.length,
        filter: {
          type: filter.type ?? null,
          parentId: filter.parentId ?? null,
          activeOnly: filter.activeOnly,
        },
      },
      'chart-of-accounts.list',
    );
    return rows.map((row: AccountProjection) => this.toDto(row));
  }

  private buildWhere(filter: ListAccountsFilter): {
    active?: boolean;
    type?: AccountType;
    parentId?: string | null;
  } {
    const where: {
      active?: boolean;
      type?: AccountType;
      parentId?: string | null;
    } = {};
    if (filter.activeOnly) where.active = true;
    if (filter.type !== undefined) where.type = filter.type;
    if (filter.parentId !== undefined) {
      where.parentId = isNullLiteral(filter.parentId) ? null : filter.parentId;
    }
    return where;
  }

  private toDto(row: AccountProjection): AccountDto {
    return {
      id: row.id,
      code: row.code,
      name: row.name,
      ...(row.description !== null && { description: row.description }),
      type: row.type,
      parentId: row.parentId,
      normalBalance: row.normalBalance,
      currency: this.narrowCurrency(row.currency),
      active: row.active,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  /**
   * Narrow the DB-side `currency CHAR(3)` to the contract enum (USD
   * only in Phase 1). A row carrying a future currency surfaces a
   * clean 500 here rather than silently passing through unsupported
   * wire shape; the contract layer's downstream `.parse()` would
   * reject anyway, so this is defence-in-depth.
   */
  private narrowCurrency(value: string): AccountCurrency {
    if (value !== 'USD') {
      throw new Error(`unsupported currency in account row: ${value}`);
    }
    return 'USD';
  }
}

function isNullLiteral(value: string): boolean {
  return value.toLowerCase() === 'null';
}
