import type { GeoPolygon, ProviderServiceAreaRecord } from '@taste-and-see/contracts';
import { describe, expect, it, vi } from 'vitest';

import type { PrismaService } from '../../../prisma/prisma.service';
import type {
  AvailabilityService,
  ProviderAvailabilitySnapshot,
} from '../../availability/services/availability.service';
import type {
  ProviderCertificationsService,
  ProviderCertificationWithCatalog,
} from '../../certifications/services/provider-certifications.service';
import type { ExternalBusyInterval } from '../../availability/services/availability.service';
import type { CalendarSyncService } from '../../calendar-sync/services/calendar-sync.service';
import type { ServiceAreasService } from '../../service-areas/services/service-areas.service';

import { ProviderMetricsService } from '../../metrics/services/provider-metrics.service';
import { ProviderDiscoveryService } from './provider-discovery.service';

interface FakeProviderRow {
  readonly id: string;
  readonly userId: string;
  readonly status: 'pending' | 'in_review' | 'active' | 'suspended' | 'archived';
  readonly tier: 'basic' | 'certified' | 'elite';
  readonly displayName: string;
  readonly headline: string | null;
  readonly bio: string | null;
  readonly profilePhotoKey: string | null;
  readonly videoIntroKey: string | null;
  readonly timeZone: string;
  readonly updatedAt: Date;
  readonly deletedAt: Date | null;
}

class FakePrisma {
  rows: FakeProviderRow[] = [];

  provider = {
    findUnique: vi.fn(async (args: { where: { id: string } }): Promise<FakeProviderRow | null> => {
      return this.rows.find((r) => r.id === args.where.id) ?? null;
    }),
  };
}

function buildCertifications(
  records: readonly ProviderCertificationWithCatalog[],
): ProviderCertificationsService {
  return {
    listForProvider: vi.fn(async () => records),
  } as unknown as ProviderCertificationsService;
}

function buildAvailability(
  snapshot: ProviderAvailabilitySnapshot | null = null,
): AvailabilityService {
  return {
    getAvailability: vi.fn(async () => snapshot),
  } as unknown as AvailabilityService;
}

/**
 * Fake `ServiceAreasService` for the centroid-projection wiring
 * (TS-053-followup-3). `getServiceAreas` returns the supplied records
 * (default: empty → the discovery service stamps a null centroid).
 */
function buildServiceAreas(
  records: readonly ProviderServiceAreaRecord[] = [],
): ServiceAreasService {
  return {
    getServiceAreas: vi.fn(async () => records),
  } as unknown as ServiceAreasService;
}

/**
 * Fake `CalendarSyncService` for the external-busy union (TS-206).
 * `getExternalBusyIntervals` returns the supplied intervals (default:
 * empty → the availability projection is unchanged).
 */
/**
 * TS-053-followup-4 — the `provider_metrics` rollup read.
 *
 * Defaults to 0, the count for a provider no booking event has ever
 * named. `completedCount` overrides it so a test can assert the value
 * reaches the document rather than merely that the field exists.
 */
function buildMetrics(completedCount = 0): ProviderMetricsService {
  return {
    getCompletedBookingCount: async () => completedCount,
  } as unknown as ProviderMetricsService;
}

function buildCalendarSync(intervals: readonly ExternalBusyInterval[] = []): CalendarSyncService {
  return {
    getExternalBusyIntervals: vi.fn(async () => intervals),
  } as unknown as CalendarSyncService;
}

/** A closed square polygon; only the extent matters for the area weight. */
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

function buildServiceArea(
  centroid: { readonly latitude: number; readonly longitude: number },
  polygon: GeoPolygon = squarePolygon(-73.96, 40.77, 0.01),
): ProviderServiceAreaRecord {
  return {
    id: 'psa_1',
    providerId: 'prov_1',
    label: null,
    polygon,
    centroid,
    boundingBox: { minLatitude: 0, minLongitude: 0, maxLatitude: 0, maxLongitude: 0 },
    createdAt: '2026-05-25T12:00:00.000Z',
    updatedAt: '2026-05-25T12:00:00.000Z',
  };
}

function buildCertRecord(code: string): ProviderCertificationWithCatalog {
  return {
    row: {
      id: `pc_${code}`,
      providerId: 'prov_1',
      certificationId: `cert_${code}`,
      issuedAt: new Date('2026-01-01T00:00:00.000Z'),
      expiresAt: null,
      revokedAt: null,
      revocationReason: null,
      issuerUserId: null,
      revokerUserId: null,
      notes: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    },
    catalog: {
      id: `cert_${code}`,
      code,
      name: code,
      description: '',
      issuer: 'Taste & See Cooking Academy',
      defaultValidityMonths: null,
      sortPosition: 0,
      active: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    },
  };
}

const BASE_ROW: FakeProviderRow = {
  id: 'prov_1',
  userId: 'user_1',
  status: 'active',
  tier: 'certified',
  displayName: 'Chef Ada',
  headline: 'French-Mediterranean comfort food, dementia-sensitive plating',
  bio: 'Twenty years of fine-dining experience.',
  profilePhotoKey: 'media/profile.jpg',
  videoIntroKey: 'media/intro.mp4',
  timeZone: 'America/New_York',
  updatedAt: new Date('2026-05-16T12:00:00.000Z'),
  deletedAt: null,
};

describe('ProviderDiscoveryService.getSnapshot', () => {
  it('returns the full document for an active provider with certifications', async () => {
    const prisma = new FakePrisma();
    prisma.rows = [BASE_ROW];
    const certs = buildCertifications([
      buildCertRecord('ccc'),
      buildCertRecord('dementia_sensitive'),
    ]);
    const svc = new ProviderDiscoveryService(
      prisma as unknown as PrismaService,
      certs,
      buildAvailability(),
      buildServiceAreas(),
      buildCalendarSync(),
      buildMetrics(),
    );

    const result = await svc.getSnapshot('prov_1');

    expect(result.kind).toBe('found');
    if (result.kind !== 'found') return;
    expect(result.document.providerId).toBe('prov_1');
    expect(result.document.userId).toBe('user_1');
    expect(result.document.tier).toBe('certified');
    expect(result.document.status).toBe('active');
    expect(result.document.displayName).toBe('Chef Ada');
    expect(result.document.certifications).toEqual(['ccc', 'dementia_sensitive']);
    expect(result.document.languages).toEqual([]);
    expect(result.document.specialties).toEqual([]);
    expect(result.document.cuisines).toEqual([]);
    expect(result.document.dietaryExpertise).toEqual([]);
    expect(result.document.centroid).toBeNull();
    expect(result.document.ratingAverage).toBeNull();
    expect(result.document.ratingCount).toBe(0);
    expect(result.document.completedBookingCount).toBe(0);
    expect(result.document.availabilitySummary).toBeNull();
    expect(result.document.sourceUpdatedAt).toBe('2026-05-16T12:00:00.000Z');
  });

  it('projects the completed-visit count from the provider_metrics rollup (TS-053-followup-4)', async () => {
    const prisma = new FakePrisma();
    prisma.rows = [BASE_ROW];
    const svc = new ProviderDiscoveryService(
      prisma as unknown as PrismaService,
      buildCertifications([]),
      buildAvailability(),
      buildServiceAreas(),
      buildCalendarSync(),
      buildMetrics(37),
    );

    const result = await svc.getSnapshot('prov_1');
    if (result.kind !== 'found') throw new Error('expected found');

    expect(result.document.completedBookingCount).toBe(37);
  });

  it('keeps the rating fields null and zero — TS-305e, and they are not "no reviews yet"', async () => {
    const prisma = new FakePrisma();
    prisma.rows = [BASE_ROW];
    const svc = new ProviderDiscoveryService(
      prisma as unknown as PrismaService,
      buildCertifications([]),
      buildAvailability(),
      buildServiceAreas(),
      buildCalendarSync(),
      buildMetrics(37),
    );

    const result = await svc.getSnapshot('prov_1');
    if (result.kind !== 'found') throw new Error('expected found');

    // A completed-visit count does NOT imply a rating. The two travel
    // together on the document and it would be easy to start deriving
    // one from the other; nothing on this platform captures a rating.
    expect(result.document.ratingAverage).toBeNull();
    expect(result.document.ratingCount).toBe(0);
  });

  it('projects the next-7-days availability when the provider has declared windows (TS-203)', async () => {
    const prisma = new FakePrisma();
    prisma.rows = [BASE_ROW];
    const certs = buildCertifications([]);
    const availability = buildAvailability({
      providerId: 'prov_1',
      timeZone: 'America/New_York',
      windows: [
        { weekday: 'monday', startTime: '09:00', endTime: '13:00' },
        { weekday: 'wednesday', startTime: '18:00', endTime: '21:00' },
      ],
      exceptions: [],
      updatedAt: new Date('2026-05-16T12:00:00.000Z'),
    });
    const svc = new ProviderDiscoveryService(
      prisma as unknown as PrismaService,
      certs,
      availability,
      buildServiceAreas(),
      buildCalendarSync(),
      buildMetrics(),
    );

    const result = await svc.getSnapshot('prov_1');
    expect(result.kind).toBe('found');
    if (result.kind !== 'found') return;
    expect(result.document.availabilitySummary).not.toBeNull();
    expect(result.document.availabilitySummary?.timeZone).toBe('America/New_York');
    // The projection runs over the next 7 days — exactly one monday +
    // one wednesday land in any 7-day window. Two entries total.
    expect(result.document.availabilitySummary?.entries).toHaveLength(2);
  });

  it('returns null availabilitySummary when both windows + exceptions are empty (TS-203)', async () => {
    const prisma = new FakePrisma();
    prisma.rows = [BASE_ROW];
    const certs = buildCertifications([]);
    const availability = buildAvailability({
      providerId: 'prov_1',
      timeZone: 'America/New_York',
      windows: [],
      exceptions: [],
      updatedAt: new Date('2026-05-16T12:00:00.000Z'),
    });
    const svc = new ProviderDiscoveryService(
      prisma as unknown as PrismaService,
      certs,
      availability,
      buildServiceAreas(),
      buildCalendarSync(),
      buildMetrics(),
    );

    const result = await svc.getSnapshot('prov_1');
    expect(result.kind).toBe('found');
    if (result.kind !== 'found') return;
    expect(result.document.availabilitySummary).toBeNull();
  });

  it('projects a representative centroid from the provider service areas (TS-053-followup-3)', async () => {
    const prisma = new FakePrisma();
    prisma.rows = [BASE_ROW];
    const certs = buildCertifications([]);
    const svc = new ProviderDiscoveryService(
      prisma as unknown as PrismaService,
      certs,
      buildAvailability(),
      buildServiceAreas([buildServiceArea({ latitude: 40.775, longitude: -73.955 })]),
      buildCalendarSync(),
      buildMetrics(),
    );

    const result = await svc.getSnapshot('prov_1');

    expect(result.kind).toBe('found');
    if (result.kind !== 'found') return;
    // Single area → its centroid flows through verbatim. The weighting
    // math itself is covered by the resolveRepresentativeCentroid unit
    // tests; here we only assert the wiring stamps the doc.
    expect(result.document.centroid).toEqual({ latitude: 40.775, longitude: -73.955 });
  });

  it('leaves centroid null when the provider has declared no service areas (TS-053-followup-3)', async () => {
    const prisma = new FakePrisma();
    prisma.rows = [BASE_ROW];
    const certs = buildCertifications([]);
    const svc = new ProviderDiscoveryService(
      prisma as unknown as PrismaService,
      certs,
      buildAvailability(),
      buildServiceAreas([]),
      buildCalendarSync(),
      buildMetrics(),
    );

    const result = await svc.getSnapshot('prov_1');

    expect(result.kind).toBe('found');
    if (result.kind !== 'found') return;
    expect(result.document.centroid).toBeNull();
  });

  it('returns not_found when the providerId does not exist', async () => {
    const prisma = new FakePrisma();
    const certs = buildCertifications([]);
    const svc = new ProviderDiscoveryService(
      prisma as unknown as PrismaService,
      certs,
      buildAvailability(),
      buildServiceAreas(),
      buildCalendarSync(),
      buildMetrics(),
    );

    const result = await svc.getSnapshot('prov_missing');

    expect(result.kind).toBe('not_found');
    if (result.kind !== 'not_found') return;
    expect(result.providerId).toBe('prov_missing');
  });

  it('returns not_found when the provider row is soft-deleted', async () => {
    const prisma = new FakePrisma();
    prisma.rows = [{ ...BASE_ROW, deletedAt: new Date('2026-05-10T00:00:00.000Z') }];
    const certs = buildCertifications([buildCertRecord('ccc')]);
    const svc = new ProviderDiscoveryService(
      prisma as unknown as PrismaService,
      certs,
      buildAvailability(),
      buildServiceAreas(),
      buildCalendarSync(),
      buildMetrics(),
    );

    const result = await svc.getSnapshot('prov_1');

    expect(result.kind).toBe('not_found');
  });

  it('returns an empty certifications array when the provider has none', async () => {
    const prisma = new FakePrisma();
    prisma.rows = [{ ...BASE_ROW, tier: 'basic' }];
    const certs = buildCertifications([]);
    const svc = new ProviderDiscoveryService(
      prisma as unknown as PrismaService,
      certs,
      buildAvailability(),
      buildServiceAreas(),
      buildCalendarSync(),
      buildMetrics(),
    );

    const result = await svc.getSnapshot('prov_1');

    expect(result.kind).toBe('found');
    if (result.kind !== 'found') return;
    expect(result.document.certifications).toEqual([]);
    expect(result.document.tier).toBe('basic');
  });

  it('preserves null `headline` / `bio` / media keys on a minimal profile', async () => {
    const prisma = new FakePrisma();
    prisma.rows = [
      {
        ...BASE_ROW,
        headline: null,
        bio: null,
        profilePhotoKey: null,
        videoIntroKey: null,
      },
    ];
    const certs = buildCertifications([]);
    const svc = new ProviderDiscoveryService(
      prisma as unknown as PrismaService,
      certs,
      buildAvailability(),
      buildServiceAreas(),
      buildCalendarSync(),
      buildMetrics(),
    );

    const result = await svc.getSnapshot('prov_1');

    expect(result.kind).toBe('found');
    if (result.kind !== 'found') return;
    expect(result.document.headline).toBeNull();
    expect(result.document.bio).toBeNull();
    expect(result.document.profilePhotoKey).toBeNull();
    expect(result.document.videoIntroKey).toBeNull();
  });

  it('surfaces a suspended provider as `found` (the indexer decides what to do with status)', async () => {
    const prisma = new FakePrisma();
    prisma.rows = [{ ...BASE_ROW, status: 'suspended' }];
    const certs = buildCertifications([]);
    const svc = new ProviderDiscoveryService(
      prisma as unknown as PrismaService,
      certs,
      buildAvailability(),
      buildServiceAreas(),
      buildCalendarSync(),
      buildMetrics(),
    );

    const result = await svc.getSnapshot('prov_1');

    expect(result.kind).toBe('found');
    if (result.kind !== 'found') return;
    expect(result.document.status).toBe('suspended');
  });
});
