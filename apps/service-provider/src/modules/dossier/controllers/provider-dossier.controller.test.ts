import 'reflect-metadata';

import { NotFoundException } from '@nestjs/common';
import { REQUIRE_PERMISSIONS_METADATA_KEY } from '@taste-and-see/nest-auth';
import { describe, expect, it } from 'vitest';

import type { ProviderProfileSnapshot } from '../../profile/services/provider-profile.service';
import type {
  ProviderDossierService,
  ProviderDossierSnapshot,
} from '../services/provider-dossier.service';

import { ProviderDossierController } from './provider-dossier.controller';

/**
 * Controller tests for the admin provider dossier (TS-305a).
 *
 * The load-bearing assertions:
 *   - the route is gated on `provider:read`, NOT `provider:approve`
 *     (the whole reason the permission was added);
 *   - `userId` and `deletedAt` reach the wire — they are admin-only and
 *     absent from the public profile DTO;
 *   - `generatedAt` matches the clock the certifications were evaluated
 *     against, so "as of …" on a screenshotted deliberation record is
 *     the truth.
 */

const SNAPSHOT: ProviderProfileSnapshot = {
  row: {
    id: 'prov_1',
    userId: 'usr_1',
    status: 'active',
    tier: 'certified',
    displayName: 'Chef Amara',
    headline: 'Slow-cooked comfort food',
    bio: null,
    profilePhotoKey: null,
    videoIntroKey: null,
    timeZone: 'America/New_York',
    dementiaSensitive: true,
    createdAt: new Date('2026-01-04T10:00:00.000Z'),
    updatedAt: new Date('2026-05-19T10:00:00.000Z'),
    deletedAt: null,
  },
  languages: ['english'],
  cuisines: ['west-african'],
  dietaryExpertise: [],
};

const DOSSIER: ProviderDossierSnapshot = {
  profile: SNAPSHOT,
  // TS-305d. `no_activity` rather than a measured section: this fixture
  // exists to exercise the mapping, and a provider with no bookings is
  // the shape every provider starts in.
  metrics: {
    lifetime: { state: 'no_activity' },
    recent: { state: 'no_activity' },
    windowDays: 90,
    firstObservedAt: null,
    lastObservedAt: null,
    computedAt: '2026-05-19T10:00:00.000Z',
  },
  certifications: [
    {
      id: 'pcert_1',
      providerId: 'prov_1',
      certification: { id: 'cert_1', code: 'food-handler', name: 'Food Handler' },
      issuedAt: '2026-01-05T10:00:00.000Z',
      expiresAt: null,
      revokedAt: null,
      revocationReason: null,
      notes: null,
      active: true,
      createdAt: '2026-01-05T10:00:00.000Z',
      updatedAt: '2026-01-05T10:00:00.000Z',
    },
  ],
  tierHistory: [
    {
      id: 'pth_1',
      providerId: 'prov_1',
      fromTier: 'basic',
      toTier: 'certified',
      reason: 'auto_evaluation',
      triggeredByUserId: 'usr_ops',
      notes: null,
      occurredAt: '2026-01-05T10:00:01.000Z',
    },
  ],
  backgroundCheck: {
    id: 'pbc_1',
    status: 'clear',
    completedAt: '2026-01-04T18:00:00.000Z',
    createdAt: '2026-01-04T10:00:00.000Z',
    updatedAt: '2026-01-04T18:00:00.000Z',
  },
};

interface Harness {
  readonly controller: ProviderDossierController;
  readonly capture: { providerId?: string; now?: Date };
}

function makeController(snapshot: ProviderDossierSnapshot | null = DOSSIER): Harness {
  const capture: Harness['capture'] = {};
  const service = {
    getDossier: async (providerId: string, now: Date) => {
      capture.providerId = providerId;
      capture.now = now;
      return snapshot;
    },
  } as unknown as ProviderDossierService;
  return { controller: new ProviderDossierController(service), capture };
}

describe('ProviderDossierController', () => {
  it('returns the composed dossier', async () => {
    const { controller } = makeController();
    const response = await controller.getDossier('prov_1');

    expect(response.provider.id).toBe('prov_1');
    expect(response.certifications).toHaveLength(1);
    expect(response.tierHistory).toHaveLength(1);
    expect(response.backgroundCheck?.status).toBe('clear');
  });

  it('carries the admin-only userId and deletedAt onto the wire', async () => {
    const { controller } = makeController();
    const response = await controller.getDossier('prov_1');

    expect(response.provider.userId).toBe('usr_1');
    expect(response.provider.deletedAt).toBeNull();
  });

  it('renders an archived provider with its deletedAt stamp', async () => {
    const { controller } = makeController({
      ...DOSSIER,
      profile: {
        ...SNAPSHOT,
        row: {
          ...SNAPSHOT.row,
          status: 'archived',
          deletedAt: new Date('2026-03-03T09:00:00.000Z'),
        },
      },
    });

    const response = await controller.getDossier('prov_1');
    expect(response.provider.status).toBe('archived');
    expect(response.provider.deletedAt).toBe('2026-03-03T09:00:00.000Z');
  });

  it('stamps generatedAt with the SAME clock the dossier was assembled against', async () => {
    const { controller, capture } = makeController();
    const response = await controller.getDossier('prov_1');

    expect(capture.now).toBeInstanceOf(Date);
    expect(response.generatedAt).toBe(capture.now?.toISOString());
  });

  it('404s when the provider does not exist', async () => {
    const { controller } = makeController(null);
    await expect(controller.getDossier('prov_missing')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('404s an over-long providerId without calling the service', async () => {
    const { controller, capture } = makeController();
    await expect(controller.getDossier('x'.repeat(65))).rejects.toBeInstanceOf(NotFoundException);
    expect(capture.providerId).toBeUndefined();
  });

  it('truncates the echoed id in the 404 detail', async () => {
    const { controller } = makeController();
    try {
      await controller.getDossier('y'.repeat(200));
      throw new Error('expected a NotFoundException');
    } catch (error) {
      const body = (error as NotFoundException).getResponse() as { detail: string };
      expect(body.detail).toContain('...');
      expect(body.detail.length).toBeLessThan(80);
    }
  });

  it('is gated on provider:read — NOT provider:approve', () => {
    // `@RequirePermissions` writes under the key the PermissionGuard
    // reads, so asserting the metadata IS asserting the gate.
    // `provider:approve` is a write authority; a dossier read behind it
    // would hand credential revocation to every reader.
    const permissions = Reflect.getMetadata(
      REQUIRE_PERMISSIONS_METADATA_KEY,
      ProviderDossierController.prototype.getDossier,
    ) as unknown;

    expect(permissions).toEqual(['provider:read']);
    expect(permissions).not.toContain('provider:approve');
  });
});
