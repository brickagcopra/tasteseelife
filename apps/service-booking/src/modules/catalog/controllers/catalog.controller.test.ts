import 'reflect-metadata';

import { PATH_METADATA, METHOD_METADATA } from '@nestjs/common/constants';
import { BadRequestException, RequestMethod, UnprocessableEntityException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';

import type {
  ServiceCatalogRecord,
  UpsertServiceCatalogEntryRequest,
} from '@taste-and-see/contracts';

import { err, ok } from '../../../common/result';
import type { CatalogService } from '../services/catalog.service';
import { CatalogController } from './catalog.controller';

/**
 * Controller-level wiring + failure-mapping assertions for
 * `CatalogController` (TS-060-followup-2). Service-layer behavioural
 * coverage lives in `services/catalog.service.test.ts`. This file pins
 * the metadata wiring (so a refactor that drops `@Idempotent()` from the
 * PUT fails here before production), the route shapes, the path-param
 * validation, and the discriminated-union failure → HTTP mapping.
 */

const IDEMPOTENT_METADATA = Symbol.for('@taste-and-see/nest-idempotency:idempotent');

const validUpsert: UpsertServiceCatalogEntryRequest = {
  name: 'Companion dining',
  description: 'A chef prepares and shares a meal with your loved one.',
  baseRateMinMinor: 15_000,
  baseRateMaxMinor: 25_000,
  durationMinutes: 120,
  currency: 'USD',
  active: true,
  requiredProviderTier: null,
  sortPosition: 0,
};

function makeRecord(over: Partial<ServiceCatalogRecord> = {}): ServiceCatalogRecord {
  return {
    kind: 'companion_dining',
    name: 'Companion dining',
    description: 'A chef prepares and shares a meal with your loved one.',
    baseRateMinMinor: 15_000,
    baseRateMaxMinor: 25_000,
    durationMinutes: 120,
    currency: 'USD',
    active: true,
    requiredProviderTier: null,
    sortPosition: 0,
    updatedAt: '2026-05-25T00:00:00.000Z',
    ...over,
  };
}

describe('CatalogController route + idempotency wiring', () => {
  it('marks the PUT handler with @Idempotent()', () => {
    const handler = CatalogController.prototype.upsert as unknown as object;
    const flag = Reflect.getMetadata(IDEMPOTENT_METADATA, handler) as unknown;
    expect(flag).toBe(true);
  });

  it('does NOT mark the GET handler with @Idempotent()', () => {
    const handler = CatalogController.prototype.list as unknown as object;
    const flag = Reflect.getMetadata(IDEMPOTENT_METADATA, handler) as unknown;
    expect(flag).toBeUndefined();
  });

  it('routes list at GET api/v1/service-catalog', () => {
    const handler = CatalogController.prototype.list as unknown as object;
    expect(Reflect.getMetadata(PATH_METADATA, handler)).toBe('api/v1/service-catalog');
    expect(Reflect.getMetadata(METHOD_METADATA, handler)).toBe(RequestMethod.GET);
  });

  it('routes upsert at PUT api/v1/admin/service-catalog/:kind', () => {
    const handler = CatalogController.prototype.upsert as unknown as object;
    expect(Reflect.getMetadata(PATH_METADATA, handler)).toBe('api/v1/admin/service-catalog/:kind');
    expect(Reflect.getMetadata(METHOD_METADATA, handler)).toBe(RequestMethod.PUT);
  });
});

describe('CatalogController.list', () => {
  it('wraps the service entries under { entries }', async () => {
    const catalog = {
      list: vi.fn().mockResolvedValueOnce([makeRecord(), makeRecord({ kind: 'transportation' })]),
    } as unknown as CatalogService;
    const controller = new CatalogController(catalog);

    const response = await controller.list();

    expect(response.entries).toHaveLength(2);
    expect(response.entries[0]?.kind).toBe('companion_dining');
  });

  it('returns { entries: [] } when the catalog is empty', async () => {
    const catalog = { list: vi.fn().mockResolvedValueOnce([]) } as unknown as CatalogService;
    const controller = new CatalogController(catalog);
    expect(await controller.list()).toEqual({ entries: [] });
  });
});

describe('CatalogController.upsert', () => {
  it('returns the upserted entry wrapped under { entry } on success', async () => {
    const catalog = {
      upsert: vi.fn().mockResolvedValueOnce(ok(makeRecord())),
    } as unknown as CatalogService;
    const controller = new CatalogController(catalog);

    const response = await controller.upsert('companion_dining', validUpsert);

    expect(response.entry.kind).toBe('companion_dining');
    expect(response.entry.baseRateMinMinor).toBe(15_000);
  });

  it('forwards the narrowed kind to the service', async () => {
    const upsert = vi.fn().mockResolvedValueOnce(ok(makeRecord({ kind: 'event_dining' })));
    const catalog = { upsert } as unknown as CatalogService;
    const controller = new CatalogController(catalog);

    await controller.upsert('event_dining', validUpsert);

    expect(upsert).toHaveBeenCalledWith('event_dining', validUpsert);
  });

  it('rejects an unknown :kind path param with 400 (no service call)', async () => {
    const upsert = vi.fn();
    const catalog = { upsert } as unknown as CatalogService;
    const controller = new CatalogController(catalog);

    await expect(controller.upsert('spa_day', validUpsert)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(upsert).not.toHaveBeenCalled();
  });

  it('maps unsupported_currency to 422', async () => {
    const catalog = {
      upsert: vi
        .fn()
        .mockResolvedValueOnce(err({ reason: 'unsupported_currency', currency: 'EUR' })),
    } as unknown as CatalogService;
    const controller = new CatalogController(catalog);

    await expect(
      controller.upsert('companion_dining', { ...validUpsert, currency: 'EUR' }),
    ).rejects.toBeInstanceOf(UnprocessableEntityException);
  });

  it('maps invalid_band to 422', async () => {
    const catalog = {
      upsert: vi
        .fn()
        .mockResolvedValueOnce(
          err({ reason: 'invalid_band', baseRateMinMinor: 30_000, baseRateMaxMinor: 10_000 }),
        ),
    } as unknown as CatalogService;
    const controller = new CatalogController(catalog);

    await expect(
      controller.upsert('companion_dining', {
        ...validUpsert,
        baseRateMinMinor: 30_000,
        baseRateMaxMinor: 10_000,
      }),
    ).rejects.toMatchObject({ status: 422 });
  });
});
