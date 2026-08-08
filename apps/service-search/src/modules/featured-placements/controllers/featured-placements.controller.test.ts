import {
  TENANT_CONTEXT_STORE_TOKEN,
  type TenantContextStore,
} from '@taste-and-see/nest-prisma-tenant-scope';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  DeleteResult,
  FeaturedPlacementsService,
} from '../services/featured-placements.service';

import { FeaturedPlacementsController } from './featured-placements.controller';

/**
 * Minimal in-memory `TenantContextStore` honoring the `run(frame, fn)` +
 * `current()` surface that `runWithoutTenantContext` uses. Captures the
 * current frame so each test can assert which `exempt` reason wrapped the
 * call. Mirrors the ranking-config controller test.
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

class FakeService {
  list = vi.fn();
  schedule = vi.fn();
  delete = vi.fn();
}

function makeController(
  service: FakeService,
  store: ReturnType<typeof makeStore> = makeStore(),
): FeaturedPlacementsController {
  return new FeaturedPlacementsController(
    service as unknown as FeaturedPlacementsService,
    store as unknown as TenantContextStore,
  );
}

void TENANT_CONTEXT_STORE_TOKEN;

const sampleRecord = {
  id: 'fp_abc',
  providerId: 'prov_abc',
  regionCode: null,
  tier: null,
  boostMultiplier: 2,
  startsAt: '2026-06-01T09:00:00.000Z',
  endsAt: '2026-06-08T09:00:00.000Z',
  note: null,
  createdByUserId: null,
  createdAt: '2026-06-01T09:00:00.000Z',
  updatedAt: '2026-06-01T09:00:00.000Z',
} as const;

describe('FeaturedPlacementsController.list', () => {
  it('returns the service list response', async () => {
    const svc = new FakeService();
    svc.list.mockResolvedValue({ placements: [sampleRecord] });
    const controller = makeController(svc);
    const response = await controller.list({ limit: 50 });
    expect(response.placements).toEqual([sampleRecord]);
    expect(svc.list).toHaveBeenCalledWith({ limit: 50 });
  });

  it('wraps the call in an exempt tenant frame', async () => {
    const svc = new FakeService();
    const store = makeStore();
    svc.list.mockImplementation(async () => {
      expect(store.current()).toEqual({
        kind: 'exempt',
        reason: 'internal-search-featured-placements-list',
      });
      return { placements: [] };
    });
    await makeController(svc, store).list({ limit: 50 });
  });
});

describe('FeaturedPlacementsController.schedule', () => {
  it('returns the created placement from the service', async () => {
    const svc = new FakeService();
    svc.schedule.mockResolvedValue({ placement: sampleRecord });
    const controller = makeController(svc);
    const body = {
      providerId: 'prov_abc',
      boostMultiplier: 2,
      startsAt: '2026-06-01T09:00:00.000Z',
      endsAt: '2026-06-08T09:00:00.000Z',
    };
    const response = await controller.schedule(body);
    expect(response).toEqual({ placement: sampleRecord });
    expect(svc.schedule).toHaveBeenCalledWith(body);
  });

  it('wraps in an exempt tenant frame', async () => {
    const svc = new FakeService();
    const store = makeStore();
    svc.schedule.mockImplementation(async () => {
      expect(store.current()).toEqual({
        kind: 'exempt',
        reason: 'internal-search-featured-placements-schedule',
      });
      return { placement: sampleRecord };
    });
    await makeController(svc, store).schedule({
      providerId: 'prov_abc',
      boostMultiplier: 2,
      startsAt: '2026-06-01T09:00:00.000Z',
      endsAt: '2026-06-08T09:00:00.000Z',
    });
  });
});

describe('FeaturedPlacementsController.cancel', () => {
  let svc: FakeService;
  let controller: FeaturedPlacementsController;
  beforeEach(() => {
    svc = new FakeService();
    controller = makeController(svc);
  });

  it('echoes the placementId with a deleted outcome', async () => {
    const del: DeleteResult = { outcome: 'deleted' };
    svc.delete.mockResolvedValue(del);
    const response = await controller.cancel('fp_abc');
    expect(response).toEqual({ outcome: 'deleted', placementId: 'fp_abc' });
  });

  it('returns not_found (idempotent) rather than throwing', async () => {
    const del: DeleteResult = { outcome: 'not_found' };
    svc.delete.mockResolvedValue(del);
    const response = await controller.cancel('fp_ghost');
    expect(response).toEqual({ outcome: 'not_found', placementId: 'fp_ghost' });
  });

  it('wraps in an exempt tenant frame', async () => {
    const store = makeStore();
    const local = makeController(svc, store);
    svc.delete.mockImplementation(async () => {
      expect(store.current()).toEqual({
        kind: 'exempt',
        reason: 'internal-search-featured-placements-delete',
      });
      return { outcome: 'deleted' } as DeleteResult;
    });
    await local.cancel('fp_abc');
  });
});
