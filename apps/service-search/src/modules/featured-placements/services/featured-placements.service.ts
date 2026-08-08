import { Injectable, Logger } from '@nestjs/common';
import type {
  FeaturedPlacementRecord,
  FeaturedPlacementsListResponse,
  ListFeaturedPlacementsQuery,
  ProviderDiscoveryTier,
  ScheduleFeaturedPlacementRequest,
  ScheduleFeaturedPlacementResponse,
} from '@taste-and-see/contracts';

import { PrismaService } from '../../../prisma/prisma.service';

/**
 * Persistence + lookup layer for TS-207 featured-placement scheduling.
 *
 * Three surfaces:
 *
 *   1. **CRUD** — `list(query)` / `schedule(input)` / `delete(id)`. Used by
 *      the internal shared-secret-pinned admin controller (the api-gateway
 *      BFF forwards super_admin-gated writes from web-admin through it).
 *
 *   2. **Active-placement resolution** — `resolveActivePlacements()` returns
 *      the windows whose `[startsAt, endsAt)` interval contains the current
 *      instant. The in-memory backend reads this at query time and applies
 *      the per-provider boost (the matching against the doc's region/tier
 *      lives in the backend — see `resolveFeaturedBoost`).
 *
 *   3. **Cache** — a 30-second in-memory cache of the resolved active set so
 *      a normal search request does not round-trip Postgres for placements.
 *      Explicitly invalidated on every schedule/delete so an ops mutation
 *      surfaces within one request boundary rather than waiting for the TTL.
 *
 * **No env fallback.** Unlike `RankingConfigService` (whose tier weights
 * have a seeded default), the absence of any placement simply means "nothing
 * is featured" — the resolver returns an empty list and the ranking layer
 * applies no boost. A DB read failure is logged as a warn and degrades to
 * "nothing featured" so the search path never blocks on a placement gap.
 *
 * **Cache scope.** Single-replica today; with multiple replicas the TTL +
 * per-instance cache is still correct (every replica reads the same rows) —
 * the only divergence window is the TTL. Mirrors `RankingConfigService`.
 */
@Injectable()
export class FeaturedPlacementsService {
  private readonly logger = new Logger(FeaturedPlacementsService.name);

  static readonly CACHE_TTL_MS = 30_000;

  /**
   * Cache of the resolved active set. A single entry — the active set is
   * not keyed by region (the backend filters per-doc). Recomputed on a
   * cache miss against the wall clock.
   */
  private cache: { placements: ActiveFeaturedPlacement[]; expiresAt: number } | null = null;

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Resolve the placements whose window contains the current instant.
   * Cache → DB (rows with `endsAt > now`, filtered to `startsAt <= now`).
   * Never throws — a DB error logs a warn + returns an empty set so the
   * search path keeps serving unboosted hits.
   */
  async resolveActivePlacements(): Promise<ActiveFeaturedPlacement[]> {
    const now = Date.now();
    if (this.cache !== null && this.cache.expiresAt > now) {
      return this.cache.placements;
    }

    let placements: ActiveFeaturedPlacement[];
    try {
      const nowDate = new Date(now);
      // The local `FeaturedPlacementRow` annotation mirrors the codebase
      // pattern (TS-021-followup-3) of typing Prisma row results through a
      // local interface rather than the `@prisma/client` namespace export.
      const rows = (await this.prisma.featuredPlacement.findMany({
        where: { endsAt: { gt: nowDate } },
        orderBy: { startsAt: 'desc' },
      })) as FeaturedPlacementRow[];
      placements = rows
        .filter((row) => row.startsAt.getTime() <= now && row.endsAt.getTime() > now)
        .map((row) => ({
          providerId: row.providerId,
          regionCode: row.regionCode,
          tier: row.tier,
          boostMultiplier: row.boostMultiplier,
        }));
    } catch (cause) {
      this.logger.warn(
        `featured-placements DB read failed; treating as no active placements: ${
          cause instanceof Error ? cause.message : 'unknown error'
        }`,
      );
      placements = [];
    }

    this.cache = { placements, expiresAt: now + FeaturedPlacementsService.CACHE_TTL_MS };
    return placements;
  }

  async list(query: ListFeaturedPlacementsQuery): Promise<FeaturedPlacementsListResponse> {
    const now = new Date();
    const rows = await this.prisma.featuredPlacement.findMany({
      where: {
        ...(query.providerId !== undefined && { providerId: query.providerId }),
        ...(query.activeOnly === true && {
          startsAt: { lte: now },
          endsAt: { gt: now },
        }),
      },
      orderBy: { startsAt: 'desc' },
      take: query.limit,
    });
    return { placements: rows.map(toContract) };
  }

  async schedule(
    input: ScheduleFeaturedPlacementRequest,
  ): Promise<ScheduleFeaturedPlacementResponse> {
    const created = await this.prisma.featuredPlacement.create({
      data: {
        providerId: input.providerId,
        regionCode: input.regionCode ?? null,
        tier: input.tier ?? null,
        boostMultiplier: input.boostMultiplier,
        startsAt: new Date(input.startsAt),
        endsAt: new Date(input.endsAt),
        note: input.note ?? null,
        createdByUserId: input.createdByUserId ?? null,
      },
    });
    this.invalidate();
    return { placement: toContract(created) };
  }

  async delete(placementId: string): Promise<DeleteResult> {
    const existing = await this.prisma.featuredPlacement.findUnique({
      where: { id: placementId },
      select: { id: true },
    });
    if (existing === null) {
      return { outcome: 'not_found' };
    }
    await this.prisma.featuredPlacement.delete({ where: { id: placementId } });
    this.invalidate();
    return { outcome: 'deleted' };
  }

  /**
   * Drop the cached active set. Called on every successful mutation so the
   * next search request reads the fresh placements. Exposed (not private)
   * so tests can verify the invalidation flow.
   */
  invalidate(): void {
    this.cache = null;
  }

  /** Test-only — drop the cache so subsequent assertions hit the DB. */
  resetCacheForTesting(): void {
    this.cache = null;
  }
}

/**
 * The shape the ranking layer needs to apply a per-provider boost. Region
 * resolution from the request lands as a follow-up (TS-211-followup-3); the
 * backend only matches `regionCode: null` placements in Phase 1.
 */
export interface ActiveFeaturedPlacement {
  readonly providerId: string;
  readonly regionCode: string | null;
  readonly tier: string | null;
  readonly boostMultiplier: number;
}

export type DeleteResult = { readonly outcome: 'deleted' } | { readonly outcome: 'not_found' };

interface FeaturedPlacementRow {
  readonly id: string;
  readonly providerId: string;
  readonly regionCode: string | null;
  readonly tier: string | null;
  readonly boostMultiplier: number;
  readonly startsAt: Date;
  readonly endsAt: Date;
  readonly note: string | null;
  readonly createdByUserId: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

function toContract(row: FeaturedPlacementRow): FeaturedPlacementRecord {
  return {
    id: row.id,
    providerId: row.providerId,
    regionCode: row.regionCode,
    // The DB only ever holds a contract-valid tier (validated on write);
    // the cast narrows the free-TEXT column to the contract enum.
    tier: row.tier as ProviderDiscoveryTier | null,
    boostMultiplier: row.boostMultiplier,
    startsAt: row.startsAt.toISOString(),
    endsAt: row.endsAt.toISOString(),
    note: row.note,
    createdByUserId: row.createdByUserId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
