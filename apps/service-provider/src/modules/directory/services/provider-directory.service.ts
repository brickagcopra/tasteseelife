import { Injectable, Logger } from '@nestjs/common';
import type { ListProvidersQuery, ProviderDirectoryRow } from '@taste-and-see/contracts';

import { PrismaService } from '../../../prisma/prisma.service';

/**
 * Local mirror of the `providers` row shape, narrowed to the ten
 * columns the directory projects.
 *
 * Same TS-021-followup-2 / TS-051-followup-9 rationale documented
 * across this service: `@prisma/client` resolves to the root stub
 * during service-provider's own type-check (the generated client lives
 * in the service's `node_modules/.prisma/client`), so delegate results
 * are untyped and an un-annotated `.map` callback silently becomes
 * `any`. Every read path here declares its row shape by hand.
 */
interface ProviderDirectoryRowRecord {
  readonly id: string;
  readonly userId: string;
  readonly status: ProviderDirectoryRow['status'];
  readonly tier: ProviderDirectoryRow['tier'];
  readonly displayName: string;
  readonly headline: string | null;
  readonly timeZone: string;
  readonly dementiaSensitive: boolean;
  readonly createdAt: Date;
  readonly deletedAt: Date | null;
}

/** One page of the directory plus the unpaged count for the same filters. */
export interface ProviderDirectoryPage {
  readonly rows: readonly ProviderDirectoryRowRecord[];
  readonly total: number;
}

/**
 * Prisma `where` fragment for the directory. Assembled once and used
 * by BOTH the page query and the count, so the two can never drift —
 * a count computed over different predicates than the page is worse
 * than no count at all.
 */
interface DirectoryWhere {
  deletedAt?: null;
  status?: ProviderDirectoryRow['status'];
  tier?: ProviderDirectoryRow['tier'];
  displayName?: { contains: string; mode: 'insensitive' };
}

/**
 * Admin provider directory (TS-305c-followup-1; PRD §10.14, PDD §16.1).
 *
 * Read-only. Answers the one question no surface on this platform
 * could answer before it: **which providers are there.** Every other
 * provider read is self-scoped, keyed on an id the caller must already
 * hold, or family-facing and active-only.
 *
 * **The `q` filter is a substring ILIKE and therefore a sequential
 * scan.** That is a deliberate, bounded choice, not an oversight:
 *
 *   - A prefix match (`display_name LIKE 'x%'`) would ride a
 *     `text_pattern_ops` btree, but operators search by surname at
 *     least as often as by first name, and a prefix-only directory
 *     returns *nothing* for the more common half of those searches.
 *     An empty result reads as "no such provider", which on a review
 *     surface is a worse failure than a slower query.
 *   - The scan is bounded on both ends: `providers` is ~200 rows at
 *     Year-1 (PRD §12.2, and the schema's own `@unique` comment says
 *     so), `limit` is capped at 100 and `offset` at 10,000, and the
 *     route is admin-gated so the call rate is human-paced.
 *   - When the table outgrows that, the fix is a `pg_trgm` GIN index
 *     on `display_name` — an extension-enabling migration, which is an
 *     infrastructure decision rather than a query-shape one. Filed as
 *     TS-305c-followup-1a rather than guessed at here.
 *
 * The `status` and `tier` filters ride the existing
 * `providers_status_idx` / `providers_tier_idx`, and the default
 * archived-exclusion rides `providers_deleted_at_idx`.
 *
 * **The page and the count are issued concurrently.** They are
 * independent reads over the same predicate; `Promise.all` keeps the
 * endpoint at one round-trip's latency. There is no cross-read
 * consistency guarantee and none is needed — a provider created
 * between the two queries can make `total` disagree with the page by
 * one, which for a directory header is noise, not a balance.
 */
@Injectable()
export class ProviderDirectoryService {
  private readonly logger = new Logger(ProviderDirectoryService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * One page of the directory, ordered `displayName ASC, id ASC`.
   *
   * The `id` tiebreak is load-bearing rather than decorative: two
   * providers routinely share a display name ("Maria G."), and without
   * a deterministic second sort key an offset page boundary can drop
   * or repeat one of them between requests.
   */
  async list(query: ListProvidersQuery): Promise<ProviderDirectoryPage> {
    const where = buildWhere(query);

    const [rows, total] = await Promise.all([
      this.prisma.provider.findMany({
        where,
        orderBy: [{ displayName: 'asc' }, { id: 'asc' }],
        skip: query.offset,
        take: query.limit,
        select: {
          id: true,
          userId: true,
          status: true,
          tier: true,
          displayName: true,
          headline: true,
          timeZone: true,
          dementiaSensitive: true,
          createdAt: true,
          deletedAt: true,
        },
      }) as Promise<ProviderDirectoryRowRecord[]>,
      this.prisma.provider.count({ where }) as Promise<number>,
    ]);

    if (query.includeArchived) {
      // Logged because an archived provider appearing in a directory
      // read is the unusual case, and a reviewer who later asks "why
      // was this archived row on screen" should find that the operator
      // asked for it rather than that the filter leaked.
      this.logger.log(
        { returned: rows.length, total },
        'provider-directory: archived providers included by explicit request',
      );
    }

    return { rows, total };
  }
}

/**
 * Build the shared `where` fragment.
 *
 * `includeArchived: false` (the default) pins `deletedAt: null`.
 * `includeArchived: true` omits the predicate entirely rather than
 * writing `deletedAt: { not: null }` — the opt-in widens the set to
 * *all* providers, it does not narrow it to the archived ones. An
 * operator searching for someone they think may have been archived
 * does not yet know which of the two they are.
 */
function buildWhere(query: ListProvidersQuery): DirectoryWhere {
  const where: DirectoryWhere = {};
  if (!query.includeArchived) where.deletedAt = null;
  if (query.status !== undefined) where.status = query.status;
  if (query.tier !== undefined) where.tier = query.tier;
  if (query.q !== undefined) {
    where.displayName = { contains: query.q, mode: 'insensitive' };
  }
  return where;
}
