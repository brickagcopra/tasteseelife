import { NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import {
  SEARCH_RANKING_REGION_CODE_GLOBAL,
  type SearchRankingConfig,
} from '@taste-and-see/contracts';
import {
  TENANT_CONTEXT_STORE_TOKEN,
  type TenantContextStore,
} from '@taste-and-see/nest-prisma-tenant-scope';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  DeleteResult,
  RankingConfigService,
  UpsertResult,
} from '../services/ranking-config.service';

import { RankingConfigController } from './ranking-config.controller';

/**
 * Minimal in-memory `TenantContextStore` honoring the `run(frame, fn)`
 * + `current()` surface that `runWithoutTenantContext` uses. Captures
 * the current frame so each test can assert which `exempt` reason
 * wrapped the call.
 */
function makeStore(): TenantContextStore & { current: () => unknown } {
  let current: unknown = null;
  return {
    run<T>(frame: unknown, fn: () => T): T {
      const prev = current;
      current = frame;
      try {
        return fn();
      } finally {
        current = prev;
      }
    },
    current(): unknown {
      return current;
    },
  } as unknown as TenantContextStore & { current: () => unknown };
}

/** Touchable fake of `RankingConfigService` so the controller wiring is testable. */
class FakeRankingService {
  list = vi.fn();
  get = vi.fn();
  upsert = vi.fn();
  delete = vi.fn();
}

function makeController(
  service: FakeRankingService,
  store: ReturnType<typeof makeStore> = makeStore(),
): RankingConfigController {
  return new RankingConfigController(
    service as unknown as RankingConfigService,
    store as unknown as TenantContextStore,
  );
}

void TENANT_CONTEXT_STORE_TOKEN; // ensure import path is exercised

const sampleConfig: SearchRankingConfig = {
  id: 'rc_seed_global',
  regionCode: SEARCH_RANKING_REGION_CODE_GLOBAL,
  description: 'seeded',
  tierWeightBasic: 1.0,
  tierWeightCertified: 1.2,
  tierWeightElite: 1.5,
  updatedByUserId: null,
  createdAt: '2026-05-21T12:00:00.000Z',
  updatedAt: '2026-05-21T12:00:00.000Z',
};

describe('RankingConfigController.list', () => {
  it('returns the service list response', async () => {
    const svc = new FakeRankingService();
    svc.list.mockResolvedValue({ configs: [sampleConfig] });
    const controller = makeController(svc);
    const response = await controller.list();
    expect(response.configs).toEqual([sampleConfig]);
    expect(svc.list).toHaveBeenCalledOnce();
  });

  it('wraps the call in an exempt tenant frame', async () => {
    const svc = new FakeRankingService();
    const store = makeStore();
    svc.list.mockImplementation(async () => {
      expect(store.current()).toEqual({
        kind: 'exempt',
        reason: 'internal-search-ranking-config-list',
      });
      return { configs: [] };
    });
    const controller = makeController(svc, store);
    await controller.list();
  });
});

describe('RankingConfigController.getByRegion', () => {
  it('returns kind=found when the service yields a row', async () => {
    const svc = new FakeRankingService();
    svc.get.mockResolvedValue(sampleConfig);
    const controller = makeController(svc);
    const response = await controller.getByRegion(SEARCH_RANKING_REGION_CODE_GLOBAL);
    expect(response).toEqual({ kind: 'found', config: sampleConfig });
  });

  it('returns kind=not_found when the service yields null', async () => {
    const svc = new FakeRankingService();
    svc.get.mockResolvedValue(null);
    const controller = makeController(svc);
    const response = await controller.getByRegion('nyc');
    expect(response).toEqual({ kind: 'not_found', regionCode: 'nyc' });
  });

  it('wraps in an exempt tenant frame', async () => {
    const svc = new FakeRankingService();
    const store = makeStore();
    svc.get.mockImplementation(async () => {
      expect(store.current()).toEqual({
        kind: 'exempt',
        reason: 'internal-search-ranking-config-get',
      });
      return null;
    });
    const controller = makeController(svc, store);
    await controller.getByRegion('nyc');
  });
});

describe('RankingConfigController.upsertByRegion', () => {
  let svc: FakeRankingService;
  let controller: RankingConfigController;
  beforeEach(() => {
    svc = new FakeRankingService();
    controller = makeController(svc);
  });

  it('returns the upsert outcome from the service', async () => {
    const result: UpsertResult = { outcome: 'created', config: sampleConfig };
    svc.upsert.mockResolvedValue(result);
    const response = await controller.upsertByRegion('nyc', {
      tierWeightBasic: 1,
      tierWeightCertified: 1.2,
      tierWeightElite: 1.5,
    });
    expect(response).toEqual(result);
    expect(svc.upsert).toHaveBeenCalledWith('nyc', {
      tierWeightBasic: 1,
      tierWeightCertified: 1.2,
      tierWeightElite: 1.5,
    });
  });

  it('wraps in an exempt tenant frame', async () => {
    const store = makeStore();
    const local = makeController(svc, store);
    svc.upsert.mockImplementation(async () => {
      expect(store.current()).toEqual({
        kind: 'exempt',
        reason: 'internal-search-ranking-config-upsert',
      });
      return { outcome: 'unchanged', config: sampleConfig };
    });
    await local.upsertByRegion('nyc', {
      tierWeightBasic: 1,
      tierWeightCertified: 1.2,
      tierWeightElite: 1.5,
    });
  });
});

describe('RankingConfigController.deleteByRegion', () => {
  let svc: FakeRankingService;
  let controller: RankingConfigController;
  beforeEach(() => {
    svc = new FakeRankingService();
    controller = makeController(svc);
  });

  it('returns deleted on success', async () => {
    const del: DeleteResult = { outcome: 'deleted' };
    svc.delete.mockResolvedValue(del);
    const response = await controller.deleteByRegion('nyc');
    expect(response).toEqual({ outcome: 'deleted', regionCode: 'nyc' });
  });

  it('throws NotFound when the row is absent', async () => {
    const del: DeleteResult = { outcome: 'not_found' };
    svc.delete.mockResolvedValue(del);
    await expect(controller.deleteByRegion('ghost')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('throws 422 when the caller targets the global row', async () => {
    const del: DeleteResult = { outcome: 'global_protected' };
    svc.delete.mockResolvedValue(del);
    await expect(
      controller.deleteByRegion(SEARCH_RANKING_REGION_CODE_GLOBAL),
    ).rejects.toBeInstanceOf(UnprocessableEntityException);
  });

  it('wraps in an exempt tenant frame', async () => {
    const store = makeStore();
    const local = makeController(svc, store);
    svc.delete.mockImplementation(async () => {
      expect(store.current()).toEqual({
        kind: 'exempt',
        reason: 'internal-search-ranking-config-delete',
      });
      return { outcome: 'deleted' } as DeleteResult;
    });
    await local.deleteByRegion('nyc');
  });
});
