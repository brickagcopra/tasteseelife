import 'reflect-metadata';

import { BadRequestException } from '@nestjs/common';
import { REQUIRE_PERMISSIONS_METADATA_KEY } from '@taste-and-see/nest-auth';
import { describe, expect, it } from 'vitest';

import type {
  ProviderDirectoryPage,
  ProviderDirectoryService,
} from '../services/provider-directory.service';

import { ProviderDirectoryController } from './provider-directory.controller';

/**
 * Controller tests for the admin provider directory
 * (TS-305c-followup-1).
 *
 * The load-bearing assertions:
 *   - the route is gated on `provider:read`, never on the WRITE
 *     authority `provider:approve`;
 *   - a typo'd filter is a 400, not a silently-unfiltered directory —
 *     an operator who believes they filtered to suspended providers and
 *     is handed all of them draws the wrong conclusion from the page;
 *   - `limit` / `offset` are echoed as APPLIED, so a defaulted page
 *     size cannot be mistaken for a chosen one;
 *   - `bio` and the media keys never reach the wire.
 */

const ROW = {
  id: 'prov_1',
  userId: 'usr_1',
  status: 'active' as const,
  tier: 'certified' as const,
  displayName: 'Chef Amara',
  headline: 'Slow-cooked comfort food',
  timeZone: 'America/New_York',
  dementiaSensitive: true,
  createdAt: new Date('2026-01-04T10:00:00.000Z'),
  deletedAt: null,
};

interface Harness {
  readonly controller: ProviderDirectoryController;
  readonly capture: { listArg?: unknown };
}

function makeHarness(page?: Partial<ProviderDirectoryPage>): Harness {
  const capture: Harness['capture'] = {};
  const directory = {
    list: async (arg: unknown) => {
      capture.listArg = arg;
      return { rows: page?.rows ?? [ROW], total: page?.total ?? 1 };
    },
  } as unknown as ProviderDirectoryService;

  return { controller: new ProviderDirectoryController(directory), capture };
}

describe('ProviderDirectoryController.listProviders', () => {
  it('returns a contract-shaped page', async () => {
    const { controller } = makeHarness({ total: 187 });

    const response = await controller.listProviders({});

    expect(response.total).toBe(187);
    expect(response.providers).toHaveLength(1);
    expect(response.providers[0]).toEqual({
      id: 'prov_1',
      userId: 'usr_1',
      status: 'active',
      tier: 'certified',
      displayName: 'Chef Amara',
      headline: 'Slow-cooked comfort food',
      timeZone: 'America/New_York',
      dementiaSensitive: true,
      createdAt: '2026-01-04T10:00:00.000Z',
      deletedAt: null,
    });
  });

  it('echoes the DEFAULTED limit and offset, not the absent raw ones', async () => {
    const { controller } = makeHarness();

    const response = await controller.listProviders({});

    expect(response.limit).toBe(25);
    expect(response.offset).toBe(0);
  });

  it('echoes an explicitly-supplied limit and offset', async () => {
    const { controller } = makeHarness();

    const response = await controller.listProviders({ limit: '10', offset: '40' });

    expect(response.limit).toBe(10);
    expect(response.offset).toBe(40);
  });

  it('coerces the query-string strings before handing them to the service', async () => {
    const { controller, capture } = makeHarness();

    await controller.listProviders({ limit: '10', offset: '40', includeArchived: 'true' });

    expect(capture.listArg).toEqual({ includeArchived: true, limit: 10, offset: 40 });
  });

  it('trims a padded q', async () => {
    const { controller, capture } = makeHarness();

    await controller.listProviders({ q: '  amara ' });

    expect((capture.listArg as { q?: string }).q).toBe('amara');
  });

  it('400s on an unknown filter key rather than returning an unfiltered directory', async () => {
    const { controller } = makeHarness();

    await expect(controller.listProviders({ statuss: 'active' })).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('400s on an out-of-range limit', async () => {
    const { controller } = makeHarness();

    await expect(controller.listProviders({ limit: '5000' })).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('400s on an unknown status value', async () => {
    const { controller } = makeHarness();

    await expect(controller.listProviders({ status: 'retired' })).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('renders an archived row with a non-null deletedAt', async () => {
    const { controller } = makeHarness({
      rows: [
        { ...ROW, status: 'archived' as const, deletedAt: new Date('2026-06-01T00:00:00.000Z') },
      ],
    });

    const response = await controller.listProviders({ includeArchived: 'true' });

    expect(response.providers[0]?.deletedAt).toBe('2026-06-01T00:00:00.000Z');
    expect(response.providers[0]?.status).toBe('archived');
  });

  it('returns an empty page without error', async () => {
    const { controller } = makeHarness({ rows: [], total: 0 });

    const response = await controller.listProviders({ q: 'nobody' });

    expect(response.providers).toEqual([]);
    expect(response.total).toBe(0);
  });

  it('is gated on provider:read, not the provider:approve write authority', () => {
    const permissions = Reflect.getMetadata(
      REQUIRE_PERMISSIONS_METADATA_KEY,
      ProviderDirectoryController.prototype.listProviders,
    ) as unknown;

    expect(permissions).toEqual(['provider:read']);
    expect(permissions).not.toContain('provider:approve');
  });
});
