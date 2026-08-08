import { Inject, Injectable, Logger } from '@nestjs/common';
import type {
  ListSearchRankingConfigResponse,
  SearchRankingConfig,
  UpsertSearchRankingConfigRequest,
} from '@taste-and-see/contracts';
import { SEARCH_RANKING_REGION_CODE_GLOBAL } from '@taste-and-see/contracts';

import { ENV_TOKEN } from '../../../config/config.module';
import type { Env } from '../../../config/env';
import { PrismaService } from '../../../prisma/prisma.service';

/**
 * Persistence + lookup layer for TS-211 search ranking config.
 *
 * Three surfaces:
 *
 *   1. **CRUD** — `list()` / `get(regionCode)` / `upsert(regionCode, input)` /
 *      `delete(regionCode)`. Used by the internal shared-secret-pinned
 *      admin controller. Upsert is idempotent: re-applying the same
 *      weights returns `{ outcome: 'unchanged', config }` without
 *      mutating `updatedAt`.
 *
 *   2. **Weight resolution** — `resolveWeights(regionCode?)` returns the
 *      `{ basic, certified, elite, geoDecayScaleKm }` config the backend reads
 *      at query time. The resolver:
 *        a) Returns the per-region row's weights if present.
 *        b) Falls back to the `global` row's weights.
 *        c) Falls back to the env defaults if both rows are absent or
 *           the DB read fails (logged as a warn; the search path
 *           continues to serve hits — never blocks on a config gap).
 *
 *   3. **Cache** — a 30-second in-memory cache keyed by region code so
 *      a normal search request does not round-trip Postgres for the
 *      config. Reads are explicitly invalidated on every upsert/delete
 *      so an ops mutation surfaces within one request boundary instead
 *      of waiting for the TTL.
 *
 * **Phase 1 region resolution is identity.** The backend always passes
 * the request's region code through; for Phase 1 the only region in use
 * is `global`. TS-211-followup-3 wires actual region resolution from
 * `geo.center` / household zip / etc.
 *
 * **Cache scope.** Single-replica today. With multiple replicas a TTL
 * + per-instance cache is still correct (every replica reads the same
 * Postgres row); the only divergence window is the TTL. Captured as
 * TS-211-followup-4 if the multi-replica drift becomes operationally
 * material.
 */
@Injectable()
export class RankingConfigService {
  private readonly logger = new Logger(RankingConfigService.name);

  /**
   * In-memory cache of resolved weights by region code. The key is the
   * region the resolver was called with — the cached value may have
   * come from the `global` fallback row or the env default; the
   * resolver records the actual source on the cache miss so a future
   * `get`/`list` reads the same answer the backend uses.
   *
   * 30-second TTL keeps the search hot path off Postgres while ensuring
   * an ops mutation propagates predictably (the invalidate-on-write
   * path makes the wait shorter still).
   */
  private readonly cache = new Map<string, { weights: ResolvedRankingConfig; expiresAt: number }>();

  static readonly CACHE_TTL_MS = 30_000;

  constructor(
    private readonly prisma: PrismaService,
    @Inject(ENV_TOKEN) private readonly env: Env,
  ) {}

  /**
   * Resolve the per-region ranking config — tier weights plus the
   * TS-210 `geoDecayScaleKm`. Tier weights resolve cache → per-region
   * row → `global` row → env fallback; never throws (a DB error logs a
   * warn + falls back to env defaults so the search path keeps serving).
   * `geoDecayScaleKm` is env-sourced on every path today (the table has
   * no decay column yet — per-region decay is TS-211-followup-3).
   */
  async resolveWeights(
    regionCode: string = SEARCH_RANKING_REGION_CODE_GLOBAL,
  ): Promise<ResolvedRankingConfig> {
    const cached = this.cache.get(regionCode);
    const now = Date.now();
    if (cached !== undefined && cached.expiresAt > now) {
      return cached.weights;
    }

    let weights: ResolvedRankingConfig;
    try {
      const row = await this.findFirstAvailable(regionCode);
      if (row !== null) {
        weights = {
          basic: row.tierWeightBasic,
          certified: row.tierWeightCertified,
          elite: row.tierWeightElite,
          geoDecayScaleKm: this.env.SEARCH_GEO_DECAY_SCALE_KM,
          source: row.regionCode === regionCode ? 'region' : 'global',
          regionCode: row.regionCode,
        };
      } else {
        weights = this.envFallback();
      }
    } catch (cause) {
      this.logger.warn(
        `ranking-config DB read failed; falling back to env defaults: ${
          cause instanceof Error ? cause.message : 'unknown error'
        }`,
      );
      weights = this.envFallback();
    }

    this.cache.set(regionCode, { weights, expiresAt: now + RankingConfigService.CACHE_TTL_MS });
    return weights;
  }

  async list(): Promise<ListSearchRankingConfigResponse> {
    const rows = await this.prisma.searchRankingConfig.findMany({
      orderBy: { regionCode: 'asc' },
    });
    return {
      configs: rows.map(toContract),
    };
  }

  async get(regionCode: string): Promise<SearchRankingConfig | null> {
    const row = await this.prisma.searchRankingConfig.findUnique({
      where: { regionCode },
    });
    return row === null ? null : toContract(row);
  }

  async upsert(regionCode: string, input: UpsertSearchRankingConfigRequest): Promise<UpsertResult> {
    const existing = await this.prisma.searchRankingConfig.findUnique({
      where: { regionCode },
    });

    if (existing === null) {
      const created = await this.prisma.searchRankingConfig.create({
        data: {
          regionCode,
          description: input.description ?? null,
          tierWeightBasic: input.tierWeightBasic,
          tierWeightCertified: input.tierWeightCertified,
          tierWeightElite: input.tierWeightElite,
          updatedByUserId: input.updatedByUserId ?? null,
        },
      });
      this.invalidate(regionCode);
      return { outcome: 'created', config: toContract(created) };
    }

    const unchanged =
      existing.tierWeightBasic === input.tierWeightBasic &&
      existing.tierWeightCertified === input.tierWeightCertified &&
      existing.tierWeightElite === input.tierWeightElite &&
      (existing.description ?? null) === (input.description ?? null);

    if (unchanged) {
      return { outcome: 'unchanged', config: toContract(existing) };
    }

    const updated = await this.prisma.searchRankingConfig.update({
      where: { regionCode },
      data: {
        description: input.description ?? null,
        tierWeightBasic: input.tierWeightBasic,
        tierWeightCertified: input.tierWeightCertified,
        tierWeightElite: input.tierWeightElite,
        updatedByUserId: input.updatedByUserId ?? null,
      },
    });
    this.invalidate(regionCode);
    return { outcome: 'updated', config: toContract(updated) };
  }

  async delete(regionCode: string): Promise<DeleteResult> {
    if (regionCode === SEARCH_RANKING_REGION_CODE_GLOBAL) {
      return { outcome: 'global_protected' };
    }

    const existing = await this.prisma.searchRankingConfig.findUnique({
      where: { regionCode },
    });
    if (existing === null) {
      return { outcome: 'not_found' };
    }

    await this.prisma.searchRankingConfig.delete({ where: { regionCode } });
    this.invalidate(regionCode);
    return { outcome: 'deleted' };
  }

  /**
   * Drop the cache entry for a region code. Called on every successful
   * mutation so the next search request reads the fresh row.
   *
   * Exposed (not private) so tests can verify the invalidation flow.
   */
  invalidate(regionCode: string): void {
    this.cache.delete(regionCode);
    // The `global` row is also the implicit fallback for every region;
    // invalidating it propagates by-region reads on their next miss.
    if (regionCode === SEARCH_RANKING_REGION_CODE_GLOBAL) {
      this.cache.clear();
    }
  }

  /**
   * Test-only — drop the entire cache so subsequent assertions hit
   * the persistence layer.
   */
  resetCacheForTesting(): void {
    this.cache.clear();
  }

  private async findFirstAvailable(regionCode: string): Promise<{
    readonly tierWeightBasic: number;
    readonly tierWeightCertified: number;
    readonly tierWeightElite: number;
    readonly regionCode: string;
  } | null> {
    if (regionCode !== SEARCH_RANKING_REGION_CODE_GLOBAL) {
      const exact = await this.prisma.searchRankingConfig.findUnique({
        where: { regionCode },
        select: {
          tierWeightBasic: true,
          tierWeightCertified: true,
          tierWeightElite: true,
          regionCode: true,
        },
      });
      if (exact !== null) return exact;
    }

    const fallback = await this.prisma.searchRankingConfig.findUnique({
      where: { regionCode: SEARCH_RANKING_REGION_CODE_GLOBAL },
      select: {
        tierWeightBasic: true,
        tierWeightCertified: true,
        tierWeightElite: true,
        regionCode: true,
      },
    });
    return fallback;
  }

  private envFallback(): ResolvedRankingConfig {
    return {
      basic: this.env.SEARCH_TIER_BOOST_BASIC,
      certified: this.env.SEARCH_TIER_BOOST_CERTIFIED,
      elite: this.env.SEARCH_TIER_BOOST_ELITE,
      geoDecayScaleKm: this.env.SEARCH_GEO_DECAY_SCALE_KM,
      source: 'env',
      regionCode: SEARCH_RANKING_REGION_CODE_GLOBAL,
    };
  }
}

/**
 * Resolved ranking config the search backend reads at query time: the
 * tier-boost multipliers (table-sourced with `global` + env fallback)
 * plus the TS-210 geo-distance decay scale (env-sourced today). `source`
 * describes the tier-weight provenance only.
 */
export interface ResolvedRankingConfig {
  readonly basic: number;
  readonly certified: number;
  readonly elite: number;
  /** TS-210 — exponential geo-decay e-folding length in km (env-sourced). */
  readonly geoDecayScaleKm: number;
  readonly source: 'region' | 'global' | 'env';
  readonly regionCode: string;
}

export type UpsertResult =
  | { readonly outcome: 'created'; readonly config: SearchRankingConfig }
  | { readonly outcome: 'updated'; readonly config: SearchRankingConfig }
  | { readonly outcome: 'unchanged'; readonly config: SearchRankingConfig };

export type DeleteResult =
  | { readonly outcome: 'deleted' }
  | { readonly outcome: 'not_found' }
  | { readonly outcome: 'global_protected' };

interface SearchRankingConfigRow {
  readonly id: string;
  readonly regionCode: string;
  readonly description: string | null;
  readonly tierWeightBasic: number;
  readonly tierWeightCertified: number;
  readonly tierWeightElite: number;
  readonly updatedByUserId: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

function toContract(row: SearchRankingConfigRow): SearchRankingConfig {
  return {
    id: row.id,
    regionCode: row.regionCode,
    description: row.description,
    tierWeightBasic: row.tierWeightBasic,
    tierWeightCertified: row.tierWeightCertified,
    tierWeightElite: row.tierWeightElite,
    updatedByUserId: row.updatedByUserId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
