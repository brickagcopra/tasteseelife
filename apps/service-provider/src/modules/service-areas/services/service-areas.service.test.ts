import type { GeoPolygon } from '@taste-and-see/contracts';
import type { OutboxService } from '@taste-and-see/nest-outbox';
import { describe, expect, it, vi } from 'vitest';

import type { PrismaService } from '../../../prisma/prisma.service';

import {
  ServiceAreasService,
  computeBoundingBox,
  computeCentroid,
  computePolygonAbsoluteArea,
  resolveRepresentativeCentroid,
  toProviderServiceAreaRecord,
} from './service-areas.service';

/**
 * Unit tests for `ServiceAreasService` (TS-202).
 *
 * Fakes mirror the canonical TS-203 availability shape: an in-memory
 * `FakePrisma` implementing the narrow surface the service consumes
 * (`provider.findUnique`, `providerServiceArea.{findMany, deleteMany,
 * createMany}`, and a `$transaction` callback that runs against the
 * same delegates) + a `FakeOutbox` recording every `append` call.
 */

interface FakeOutboxAppendCall {
  readonly eventName: string;
  readonly eventId: string | undefined;
  readonly payload: unknown;
}
interface FakeOutbox {
  readonly calls: FakeOutboxAppendCall[];
  readonly append: ReturnType<typeof vi.fn>;
  setNextValidationFailure(reason: string): void;
}
function buildFakeOutbox(): FakeOutbox {
  const calls: FakeOutboxAppendCall[] = [];
  let nextFailure: string | null = null;
  const append = vi.fn(
    async (
      _tx: unknown,
      args: { eventName: string; eventId?: string; payload: unknown },
    ): Promise<
      | { kind: 'appended'; eventId: string; eventName: string; occurredAt: Date }
      | {
          kind: 'validation_failed';
          eventName: string;
          issues: ReadonlyArray<{ path: ReadonlyArray<string | number>; message: string }>;
        }
    > => {
      calls.push({ eventName: args.eventName, eventId: args.eventId, payload: args.payload });
      if (nextFailure !== null) {
        const failure = nextFailure;
        nextFailure = null;
        return {
          kind: 'validation_failed',
          eventName: args.eventName,
          issues: [{ path: [], message: failure }],
        };
      }
      return {
        kind: 'appended',
        eventId: args.eventId ?? 'evt_fake',
        eventName: args.eventName,
        occurredAt: new Date('2026-05-25T12:00:00.000Z'),
      };
    },
  );
  return {
    calls,
    append,
    setNextValidationFailure(reason) {
      nextFailure = reason;
    },
  };
}
function asOutboxService(fake: FakeOutbox): OutboxService {
  return { append: fake.append } as unknown as OutboxService;
}

interface ProviderRow {
  readonly id: string;
  readonly userId: string;
  readonly deletedAt: Date | null;
}

interface AreaRow {
  id: string;
  providerId: string;
  label: string | null;
  geoPolygon: unknown;
  centroidLatitude: number;
  centroidLongitude: number;
  bboxMinLatitude: number;
  bboxMinLongitude: number;
  bboxMaxLatitude: number;
  bboxMaxLongitude: number;
  createdAt: Date;
  updatedAt: Date;
}

const NOW = new Date('2026-05-25T12:00:00.000Z');

class FakePrisma {
  public providers: ProviderRow[] = [];
  public areas: AreaRow[] = [];
  private seq = 0;

  provider = {
    findUnique: vi.fn(
      async (args: { where: { id?: string; userId?: string } }): Promise<ProviderRow | null> => {
        if (args.where.id !== undefined) {
          return this.providers.find((p) => p.id === args.where.id) ?? null;
        }
        if (args.where.userId !== undefined) {
          return this.providers.find((p) => p.userId === args.where.userId) ?? null;
        }
        return null;
      },
    ),
  };

  providerServiceArea = {
    findMany: vi.fn(
      async (args: { where: { providerId: string } }): Promise<readonly AreaRow[]> => {
        return this.areas.filter((a) => a.providerId === args.where.providerId);
      },
    ),
    deleteMany: vi.fn(
      async (args: { where: { providerId: string } }): Promise<{ count: number }> => {
        const before = this.areas.length;
        this.areas = this.areas.filter((a) => a.providerId !== args.where.providerId);
        return { count: before - this.areas.length };
      },
    ),
    createMany: vi.fn(
      async (args: {
        data: ReadonlyArray<{
          providerId: string;
          label: string | null;
          geoPolygon: unknown;
          centroidLatitude: number;
          centroidLongitude: number;
          bboxMinLatitude: number;
          bboxMinLongitude: number;
          bboxMaxLatitude: number;
          bboxMaxLongitude: number;
        }>;
      }): Promise<{ count: number }> => {
        for (const row of args.data) {
          this.seq += 1;
          this.areas.push({ ...row, id: `psa_${this.seq}`, createdAt: NOW, updatedAt: NOW });
        }
        return { count: args.data.length };
      },
    ),
  };

  $transaction = vi.fn(
    async <T>(
      fn: (tx: { providerServiceArea: FakePrisma['providerServiceArea'] }) => Promise<T>,
    ): Promise<T> => {
      return fn({ providerServiceArea: this.providerServiceArea });
    },
  );
}

function buildPrisma(): FakePrisma {
  return new FakePrisma();
}

function aProviderRow(overrides: Partial<ProviderRow> = {}): ProviderRow {
  return { id: 'prov_1', userId: 'user_self', deletedAt: null, ...overrides };
}

// A closed square over Manhattan's UES (5 positions). GeoJSON order
// is [longitude, latitude].
const uesPolygon: GeoPolygon = {
  type: 'Polygon',
  coordinates: [
    [
      [-73.96, 40.77],
      [-73.95, 40.77],
      [-73.95, 40.78],
      [-73.96, 40.78],
      [-73.96, 40.77],
    ],
  ],
};

describe('ServiceAreasService.updateServiceAreas', () => {
  it('replaces the area set, computes centroid + bbox, and emits the outbox event', async () => {
    const prisma = buildPrisma();
    prisma.providers = [aProviderRow()];
    prisma.areas = [
      {
        id: 'psa_old',
        providerId: 'prov_1',
        label: 'old',
        geoPolygon: uesPolygon,
        centroidLatitude: 40.775,
        centroidLongitude: -73.955,
        bboxMinLatitude: 40.77,
        bboxMinLongitude: -73.96,
        bboxMaxLatitude: 40.78,
        bboxMaxLongitude: -73.95,
        createdAt: NOW,
        updatedAt: NOW,
      },
    ];
    const outbox = buildFakeOutbox();
    const svc = new ServiceAreasService(
      prisma as unknown as PrismaService,
      asOutboxService(outbox),
    );

    const result = await svc.updateServiceAreas({
      providerId: 'prov_1',
      actorUserId: 'user_self',
      serviceAreas: [{ label: 'Upper East Side', polygon: uesPolygon }],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toHaveLength(1);
    const area = result.value[0];
    expect(area?.label).toBe('Upper East Side');
    expect(area?.centroid.latitude).toBeCloseTo(40.775, 3);
    expect(area?.centroid.longitude).toBeCloseTo(-73.955, 3);
    expect(area?.boundingBox).toEqual({
      minLatitude: 40.77,
      minLongitude: -73.96,
      maxLatitude: 40.78,
      maxLongitude: -73.95,
    });
    // The old row was replaced.
    expect(prisma.areas).toHaveLength(1);
    expect(prisma.areas[0]?.label).toBe('Upper East Side');
    expect(outbox.calls).toHaveLength(1);
    expect(outbox.calls[0]?.eventName).toBe('provider.service_areas_updated');
    expect(outbox.calls[0]?.payload).toMatchObject({
      providerId: 'prov_1',
      areaCount: 1,
      actorUserId: 'user_self',
    });
  });

  it('accepts an empty PUT (clear-all) and emits with areaCount 0', async () => {
    const prisma = buildPrisma();
    prisma.providers = [aProviderRow()];
    prisma.areas = [
      {
        id: 'psa_old',
        providerId: 'prov_1',
        label: null,
        geoPolygon: uesPolygon,
        centroidLatitude: 40.775,
        centroidLongitude: -73.955,
        bboxMinLatitude: 40.77,
        bboxMinLongitude: -73.96,
        bboxMaxLatitude: 40.78,
        bboxMaxLongitude: -73.95,
        createdAt: NOW,
        updatedAt: NOW,
      },
    ];
    const outbox = buildFakeOutbox();
    const svc = new ServiceAreasService(
      prisma as unknown as PrismaService,
      asOutboxService(outbox),
    );

    const result = await svc.updateServiceAreas({
      providerId: 'prov_1',
      actorUserId: 'user_self',
      serviceAreas: [],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual([]);
    expect(prisma.areas).toEqual([]);
    expect(outbox.calls).toHaveLength(1);
    expect(outbox.calls[0]?.payload).toMatchObject({ areaCount: 0 });
  });

  it('rejects an empty providerId at the boundary', async () => {
    const svc = new ServiceAreasService(
      buildPrisma() as unknown as PrismaService,
      asOutboxService(buildFakeOutbox()),
    );
    const result = await svc.updateServiceAreas({
      providerId: '',
      actorUserId: 'user_self',
      serviceAreas: [],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.reason).toBe('invalid_request');
  });

  it('returns not_found when the provider row is missing', async () => {
    const svc = new ServiceAreasService(
      buildPrisma() as unknown as PrismaService,
      asOutboxService(buildFakeOutbox()),
    );
    const result = await svc.updateServiceAreas({
      providerId: 'prov_missing',
      actorUserId: 'user_self',
      serviceAreas: [],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.reason).toBe('not_found');
  });

  it('returns not_found when the provider is soft-deleted', async () => {
    const prisma = buildPrisma();
    prisma.providers = [aProviderRow({ deletedAt: new Date('2026-05-10T00:00:00.000Z') })];
    const svc = new ServiceAreasService(
      prisma as unknown as PrismaService,
      asOutboxService(buildFakeOutbox()),
    );
    const result = await svc.updateServiceAreas({
      providerId: 'prov_1',
      actorUserId: 'user_self',
      serviceAreas: [],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.reason).toBe('not_found');
  });

  it('returns forbidden when the actor does not own the row', async () => {
    const prisma = buildPrisma();
    prisma.providers = [aProviderRow({ userId: 'someone_else' })];
    const outbox = buildFakeOutbox();
    const svc = new ServiceAreasService(
      prisma as unknown as PrismaService,
      asOutboxService(outbox),
    );
    const result = await svc.updateServiceAreas({
      providerId: 'prov_1',
      actorUserId: 'user_self',
      serviceAreas: [{ polygon: uesPolygon }],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.reason).toBe('forbidden');
    expect(outbox.calls).toHaveLength(0);
  });

  it('rolls back when the outbox emit fails validation', async () => {
    const prisma = buildPrisma();
    prisma.providers = [aProviderRow()];
    const outbox = buildFakeOutbox();
    outbox.setNextValidationFailure('payload too small');
    const svc = new ServiceAreasService(
      prisma as unknown as PrismaService,
      asOutboxService(outbox),
    );
    const result = await svc.updateServiceAreas({
      providerId: 'prov_1',
      actorUserId: 'user_self',
      serviceAreas: [{ polygon: uesPolygon }],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.reason).toBe('outbox_validation_failed');
    if (result.error.reason !== 'outbox_validation_failed') return;
    expect(result.error.eventName).toBe('provider.service_areas_updated');
  });

  it('defaults a missing label to null on the persisted row', async () => {
    const prisma = buildPrisma();
    prisma.providers = [aProviderRow()];
    const svc = new ServiceAreasService(
      prisma as unknown as PrismaService,
      asOutboxService(buildFakeOutbox()),
    );
    const result = await svc.updateServiceAreas({
      providerId: 'prov_1',
      actorUserId: 'user_self',
      serviceAreas: [{ polygon: uesPolygon }],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value[0]?.label).toBeNull();
  });
});

describe('ServiceAreasService.deleteServiceAreas', () => {
  it('clears every row + emits the outbox event when something was deleted', async () => {
    const prisma = buildPrisma();
    prisma.providers = [aProviderRow()];
    prisma.areas = [
      {
        id: 'psa_1',
        providerId: 'prov_1',
        label: null,
        geoPolygon: uesPolygon,
        centroidLatitude: 40.775,
        centroidLongitude: -73.955,
        bboxMinLatitude: 40.77,
        bboxMinLongitude: -73.96,
        bboxMaxLatitude: 40.78,
        bboxMaxLongitude: -73.95,
        createdAt: NOW,
        updatedAt: NOW,
      },
    ];
    const outbox = buildFakeOutbox();
    const svc = new ServiceAreasService(
      prisma as unknown as PrismaService,
      asOutboxService(outbox),
    );

    const result = await svc.deleteServiceAreas({
      providerId: 'prov_1',
      actorUserId: 'user_self',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.deletedCount).toBe(1);
    expect(prisma.areas).toEqual([]);
    expect(outbox.calls).toHaveLength(1);
  });

  it('no-op delete on an already-empty set (no outbox emission)', async () => {
    const prisma = buildPrisma();
    prisma.providers = [aProviderRow()];
    const outbox = buildFakeOutbox();
    const svc = new ServiceAreasService(
      prisma as unknown as PrismaService,
      asOutboxService(outbox),
    );

    const result = await svc.deleteServiceAreas({
      providerId: 'prov_1',
      actorUserId: 'user_self',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.deletedCount).toBe(0);
    expect(outbox.calls).toHaveLength(0);
  });

  it('returns forbidden when the actor does not own the row', async () => {
    const prisma = buildPrisma();
    prisma.providers = [aProviderRow({ userId: 'someone_else' })];
    const outbox = buildFakeOutbox();
    const svc = new ServiceAreasService(
      prisma as unknown as PrismaService,
      asOutboxService(outbox),
    );

    const result = await svc.deleteServiceAreas({
      providerId: 'prov_1',
      actorUserId: 'user_self',
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.reason).toBe('forbidden');
    expect(outbox.calls).toHaveLength(0);
  });
});

describe('ServiceAreasService.getServiceAreas', () => {
  it('returns the materialised records', async () => {
    const prisma = buildPrisma();
    prisma.providers = [aProviderRow()];
    prisma.areas = [
      {
        id: 'psa_1',
        providerId: 'prov_1',
        label: 'UES',
        geoPolygon: uesPolygon,
        centroidLatitude: 40.775,
        centroidLongitude: -73.955,
        bboxMinLatitude: 40.77,
        bboxMinLongitude: -73.96,
        bboxMaxLatitude: 40.78,
        bboxMaxLongitude: -73.95,
        createdAt: NOW,
        updatedAt: NOW,
      },
    ];
    const svc = new ServiceAreasService(
      prisma as unknown as PrismaService,
      asOutboxService(buildFakeOutbox()),
    );

    const records = await svc.getServiceAreas('prov_1');
    expect(records).not.toBeNull();
    if (records === null) return;
    expect(records).toHaveLength(1);
    expect(records[0]?.label).toBe('UES');
    expect(records[0]?.polygon).toEqual(uesPolygon);
  });

  it('returns an empty array for a provider with no areas', async () => {
    const prisma = buildPrisma();
    prisma.providers = [aProviderRow()];
    const svc = new ServiceAreasService(
      prisma as unknown as PrismaService,
      asOutboxService(buildFakeOutbox()),
    );
    const records = await svc.getServiceAreas('prov_1');
    expect(records).toEqual([]);
  });

  it('returns null for a soft-deleted provider', async () => {
    const prisma = buildPrisma();
    prisma.providers = [aProviderRow({ deletedAt: new Date('2026-05-10T00:00:00.000Z') })];
    const svc = new ServiceAreasService(
      prisma as unknown as PrismaService,
      asOutboxService(buildFakeOutbox()),
    );
    expect(await svc.getServiceAreas('prov_1')).toBeNull();
  });

  it('returns null for a missing provider', async () => {
    const svc = new ServiceAreasService(
      buildPrisma() as unknown as PrismaService,
      asOutboxService(buildFakeOutbox()),
    );
    expect(await svc.getServiceAreas('prov_missing')).toBeNull();
  });
});

describe('computeBoundingBox', () => {
  it('spans every position across all rings', () => {
    const bbox = computeBoundingBox(uesPolygon);
    expect(bbox).toEqual({
      minLatitude: 40.77,
      minLongitude: -73.96,
      maxLatitude: 40.78,
      maxLongitude: -73.95,
    });
  });

  it('includes hole vertices in the span', () => {
    const withHole: GeoPolygon = {
      type: 'Polygon',
      coordinates: [
        [
          [0, 0],
          [10, 0],
          [10, 10],
          [0, 10],
          [0, 0],
        ],
        [
          [-1, -1],
          [2, -1],
          [2, 2],
          [-1, 2],
          [-1, -1],
        ],
      ],
    };
    const bbox = computeBoundingBox(withHole);
    expect(bbox).toEqual({
      minLatitude: -1,
      minLongitude: -1,
      maxLatitude: 10,
      maxLongitude: 10,
    });
  });
});

describe('computeCentroid', () => {
  it('returns the geometric centre of a square', () => {
    const square: GeoPolygon = {
      type: 'Polygon',
      coordinates: [
        [
          [0, 0],
          [2, 0],
          [2, 2],
          [0, 2],
          [0, 0],
        ],
      ],
    };
    const centroid = computeCentroid(square);
    expect(centroid.longitude).toBeCloseTo(1, 6);
    expect(centroid.latitude).toBeCloseTo(1, 6);
  });

  it('handles a degenerate (zero-area) ring by averaging vertices', () => {
    // A collinear "ring" — all points on the x-axis. Signed area is 0.
    const degenerate: GeoPolygon = {
      type: 'Polygon',
      coordinates: [
        [
          [0, 0],
          [2, 0],
          [4, 0],
          [0, 0],
        ],
      ],
    };
    const centroid = computeCentroid(degenerate);
    // Average of the distinct vertices (0,0),(2,0),(4,0) → (2,0).
    expect(centroid.longitude).toBeCloseTo(2, 6);
    expect(centroid.latitude).toBeCloseTo(0, 6);
  });

  it('stays inside the bounding box (centroid never escapes the extent)', () => {
    const centroid = computeCentroid(uesPolygon);
    const bbox = computeBoundingBox(uesPolygon);
    expect(centroid.longitude).toBeGreaterThanOrEqual(bbox.minLongitude);
    expect(centroid.longitude).toBeLessThanOrEqual(bbox.maxLongitude);
    expect(centroid.latitude).toBeGreaterThanOrEqual(bbox.minLatitude);
    expect(centroid.latitude).toBeLessThanOrEqual(bbox.maxLatitude);
  });
});

describe('toProviderServiceAreaRecord', () => {
  it('projects a persisted row to the contract shape', () => {
    const record = toProviderServiceAreaRecord({
      id: 'psa_1',
      providerId: 'prov_1',
      label: 'UES',
      geoPolygon: uesPolygon,
      centroidLatitude: 40.775,
      centroidLongitude: -73.955,
      bboxMinLatitude: 40.77,
      bboxMinLongitude: -73.96,
      bboxMaxLatitude: 40.78,
      bboxMaxLongitude: -73.95,
      createdAt: NOW,
      updatedAt: NOW,
    });
    expect(record.id).toBe('psa_1');
    expect(record.providerId).toBe('prov_1');
    expect(record.label).toBe('UES');
    expect(record.polygon).toEqual(uesPolygon);
    expect(record.centroid).toEqual({ latitude: 40.775, longitude: -73.955 });
    expect(record.createdAt).toBe(NOW.toISOString());
  });
});

/**
 * A closed axis-aligned square of side `side` with its lower-left corner
 * at (minLng, minLat). GeoJSON position order is [longitude, latitude].
 * Planar area = side². Helper for the centroid-projection tests below.
 */
function squarePolygon(minLng: number, minLat: number, side: number): GeoPolygon {
  return {
    type: 'Polygon',
    coordinates: [
      [
        [minLng, minLat],
        [minLng + side, minLat],
        [minLng + side, minLat + side],
        [minLng, minLat + side],
        [minLng, minLat],
      ],
    ],
  };
}

describe('computePolygonAbsoluteArea (TS-053-followup-3)', () => {
  it('returns the planar area of a unit square regardless of winding', () => {
    expect(computePolygonAbsoluteArea(squarePolygon(0, 0, 1))).toBeCloseTo(1, 9);
    expect(computePolygonAbsoluteArea(squarePolygon(0, 0, 2))).toBeCloseTo(4, 9);
  });

  it('matches the UES fixture extent (0.01° × 0.01°)', () => {
    expect(computePolygonAbsoluteArea(uesPolygon)).toBeCloseTo(0.0001, 9);
  });

  it('returns 0 for a degenerate (collinear) ring', () => {
    const collinear: GeoPolygon = {
      type: 'Polygon',
      coordinates: [
        [
          [0, 0],
          [1, 1],
          [2, 2],
          [0, 0],
        ],
      ],
    };
    expect(computePolygonAbsoluteArea(collinear)).toBe(0);
  });

  it('returns 0 for an under-4-position ring (defensive — contract rejects these)', () => {
    const tooFew: GeoPolygon = {
      type: 'Polygon',
      coordinates: [
        [
          [0, 0],
          [1, 1],
          [0, 0],
        ],
      ],
    };
    expect(computePolygonAbsoluteArea(tooFew)).toBe(0);
  });
});

describe('resolveRepresentativeCentroid (TS-053-followup-3)', () => {
  it('returns null for an empty area set', () => {
    expect(resolveRepresentativeCentroid([])).toBeNull();
  });

  it('returns the single area centroid verbatim', () => {
    const result = resolveRepresentativeCentroid([
      { polygon: squarePolygon(0, 0, 2), centroid: { latitude: 40.775, longitude: -73.955 } },
    ]);
    expect(result).toEqual({ latitude: 40.775, longitude: -73.955 });
  });

  it('returns the arithmetic mean when areas are equal', () => {
    const result = resolveRepresentativeCentroid([
      { polygon: squarePolygon(0, 0, 2), centroid: { latitude: 40, longitude: -73 } },
      { polygon: squarePolygon(10, 10, 2), centroid: { latitude: 42, longitude: -75 } },
    ]);
    expect(result).toEqual({ latitude: 41, longitude: -74 });
  });

  it('weights the centroid toward the larger-area polygon', () => {
    const result = resolveRepresentativeCentroid([
      // Large coverage (4 deg²) — should dominate.
      { polygon: squarePolygon(0, 0, 2), centroid: { latitude: 40, longitude: -73 } },
      // Tiny coverage (0.0001 deg²) — negligible pull.
      { polygon: squarePolygon(50, 50, 0.01), centroid: { latitude: 50, longitude: -80 } },
    ]);
    expect(result).not.toBeNull();
    if (result === null) return;
    expect(result.latitude).toBeCloseTo(40, 2);
    expect(result.longitude).toBeCloseTo(-73, 2);
    // Far closer to the large area's centroid than the tiny one.
    expect(Math.abs(result.latitude - 40)).toBeLessThan(Math.abs(result.latitude - 50));
  });

  it('falls back to the unweighted mean when every area is degenerate (zero total weight)', () => {
    const degenerate: GeoPolygon = {
      type: 'Polygon',
      coordinates: [
        [
          [0, 0],
          [1, 1],
          [2, 2],
          [0, 0],
        ],
      ],
    };
    const result = resolveRepresentativeCentroid([
      { polygon: degenerate, centroid: { latitude: 10, longitude: 10 } },
      { polygon: degenerate, centroid: { latitude: 20, longitude: 20 } },
    ]);
    expect(result).toEqual({ latitude: 15, longitude: 15 });
  });
});
