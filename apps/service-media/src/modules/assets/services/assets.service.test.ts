import type { RecordAssetEventRequest } from '@taste-and-see/contracts';
import { describe, expect, it } from 'vitest';

import { loadEnv, type Env } from '../../../config/env';
import type { PrismaService, PrismaTransactionClient } from '../../../prisma/prisma.service';
import {
  AssetsService,
  IssueUploadUrlFailure,
  RecordAssetEventFailure,
  computeNextState,
} from './assets.service';
import { SignedUrlIssuerService } from './signed-url-issuer.service';

function buildEnv(overrides: Partial<Env> = {}): Env {
  return loadEnv({
    DATABASE_URL: 'postgresql://test:test@localhost:5432/test',
    JWT_ACCESS_SECRET: 'a'.repeat(32),
    INTERNAL_TRUST_SIGNING_SECRET: 't'.repeat(32),
    S3_BUCKET_NAME: 'tastesee-media-test',
    S3_SIGNING_SECRET: 's'.repeat(40),
    MEDIA_SCAN_EVENTS_API_KEY: 'k'.repeat(40),
    ...stringifyOverrides(overrides),
  });
}

function stringifyOverrides(overrides: Partial<Env>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) continue;
    out[key] = typeof value === 'string' ? value : String(value);
  }
  return out;
}

// Minimal in-memory Prisma double — same shape the real client exposes
// for the call sites the service touches. Far cheaper than wiring
// testcontainers in the unit suite (TS-110-followup-7 covers that).
type AssetRow = Record<string, unknown>;

/**
 * Evaluate a row against the (small) subset of Prisma `where` operators
 * the senior-photo gallery read uses: scalar equality, `{ not: null }`,
 * the `{ lt }` comparator (cursor), and a top-level `OR` of `AND` clauses.
 */
function matchesWhere(row: AssetRow, where: AssetRow): boolean {
  for (const [key, condition] of Object.entries(where)) {
    if (key === 'OR') {
      const clauses = condition as AssetRow[];
      if (!clauses.some((clause) => matchesWhere(row, clause))) return false;
      continue;
    }
    if (key === 'AND') {
      const clauses = condition as AssetRow[];
      if (!clauses.every((clause) => matchesWhere(row, clause))) return false;
      continue;
    }
    const value = row[key];
    // A Date-valued condition is scalar equality (the keyset cursor's
    // `{ createdAt: <Date> }` AND-clause), NOT a Prisma operator object —
    // `typeof new Date()` is `'object'`, so it must be handled first.
    if (condition instanceof Date) {
      if (!(value instanceof Date) || value.getTime() !== condition.getTime()) return false;
      continue;
    }
    if (condition !== null && typeof condition === 'object') {
      const op = condition as Record<string, unknown>;
      if ('not' in op) {
        if (op['not'] === null && value === null) return false;
      }
      if ('lt' in op) {
        const bound = op['lt'];
        if (value instanceof Date && bound instanceof Date) {
          if (!(value.getTime() < bound.getTime())) return false;
        } else if (!(String(value) < String(bound))) {
          return false;
        }
      }
      continue;
    }
    if (value !== condition) return false;
  }
  return true;
}

class FakePrisma {
  assets: Map<string, AssetRow> = new Map();
  events: Map<string, AssetRow> = new Map();

  mediaAsset = {
    create: async ({
      data,
      select: _select,
    }: {
      data: AssetRow;
      select: unknown;
    }): Promise<AssetRow> => {
      const id = (data['id'] as string | undefined) ?? `m_${Math.random().toString(36).slice(2)}`;
      const now = new Date();
      const row: AssetRow = {
        ...data,
        id,
        status: data['status'] ?? 'awaiting_upload',
        scanStatus: data['scanStatus'] ?? 'pending',
        scanReason: null,
        detectedMime: null,
        declaredFileName: data['declaredFileName'] ?? null,
        actualSizeBytes: null,
        width: null,
        height: null,
        sha256: null,
        deliveryKey: null,
        uploadedAt: null,
        scannedAt: null,
        processedAt: null,
        createdAt: now,
        updatedAt: now,
      };
      this.assets.set(id, row);
      return row;
    },
    findUnique: async ({ where }: { where: { id: string } }): Promise<AssetRow | null> => {
      return this.assets.get(where.id) ?? null;
    },
    findMany: async ({
      where,
      take,
    }: {
      where: AssetRow;
      take: number;
      orderBy: unknown;
      select: unknown;
    }): Promise<AssetRow[]> => {
      // Faithful enough for the senior-photo gallery read: honour the
      // equality filters + `deliveryKey: { not: null }` + the keyset
      // cursor OR, sort newest-first ((createdAt, id) desc), then take.
      const matches = Array.from(this.assets.values()).filter((row) => matchesWhere(row, where));
      matches.sort((a, b) => {
        const at = (a['createdAt'] as Date).getTime();
        const bt = (b['createdAt'] as Date).getTime();
        if (at !== bt) return bt - at;
        return String(b['id']).localeCompare(String(a['id']));
      });
      return matches.slice(0, take);
    },
    update: async ({
      where,
      data,
    }: {
      where: { id: string };
      data: AssetRow;
      select: unknown;
    }): Promise<AssetRow> => {
      const existing = this.assets.get(where.id);
      if (existing === undefined) throw new Error('not found');
      const merged: AssetRow = { ...existing, ...data, updatedAt: new Date() };
      this.assets.set(where.id, merged);
      return merged;
    },
  };

  mediaAssetEvent = {
    findUnique: async ({
      where,
    }: {
      where: { assetId_eventKind: { assetId: string; eventKind: string } };
      select: unknown;
    }): Promise<AssetRow | null> => {
      const key = `${where.assetId_eventKind.assetId}|${where.assetId_eventKind.eventKind}`;
      return this.events.get(key) ?? null;
    },
    create: async ({ data }: { data: AssetRow }): Promise<AssetRow> => {
      const key = `${data['assetId'] as string}|${data['eventKind'] as string}`;
      this.events.set(key, data);
      return data;
    },
  };

  $transaction = async <T>(fn: (tx: PrismaTransactionClient) => Promise<T>): Promise<T> => {
    return fn(this as unknown as PrismaTransactionClient);
  };
}

function buildService(): { service: AssetsService; prisma: FakePrisma } {
  const env = buildEnv();
  const prisma = new FakePrisma();
  const urls = new SignedUrlIssuerService(env);
  const service = new AssetsService(prisma as unknown as PrismaService, urls);
  return { service, prisma };
}

// ─── issueUploadUrl ──────────────────────────────────────────────────

describe('AssetsService.issueUploadUrl', () => {
  it('mints a stub URL + persists an awaiting_upload row for a valid request', async () => {
    const { service, prisma } = buildService();
    const result = await service.issueUploadUrl(
      'user_abc',
      {
        kind: 'senior_photo',
        declaredMime: 'image/jpeg',
        declaredSizeBytes: 1024,
        declaredFileName: 'grandma.jpg',
        ownerScope: { kind: 'household', id: 'hh_abc' },
      },
      new Date('2026-05-16T12:00:00.000Z'),
    );
    expect(result.asset.status).toBe('awaiting_upload');
    expect(result.asset.kind).toBe('senior_photo');
    expect(result.uploadMethod).toBe('PUT');
    expect(result.requiredHeaders['content-type']).toBe('image/jpeg');
    expect(result.liveMode).toBe(false);
    expect(prisma.assets.size).toBe(1);
  });

  it('rejects a MIME outside the per-kind allow-list', async () => {
    const { service } = buildService();
    await expect(
      service.issueUploadUrl('user_abc', {
        kind: 'provider_document',
        declaredMime: 'image/jpeg',
        declaredSizeBytes: 1024,
        ownerScope: { kind: 'provider', id: 'pr_abc' },
      }),
    ).rejects.toBeInstanceOf(IssueUploadUrlFailure);
  });

  it('rejects when declared size exceeds the per-kind cap', async () => {
    const { service } = buildService();
    await expect(
      service.issueUploadUrl('user_abc', {
        kind: 'senior_photo',
        declaredMime: 'image/jpeg',
        declaredSizeBytes: 50 * 1024 * 1024, // 50 MiB exceeds 20 MiB image cap
        ownerScope: { kind: 'household', id: 'hh_abc' },
      }),
    ).rejects.toBeInstanceOf(IssueUploadUrlFailure);
  });

  it('binds the storage key to the asset id (audit trail discipline)', async () => {
    const { service, prisma } = buildService();
    const result = await service.issueUploadUrl(
      'user_abc',
      {
        kind: 'memory_recipe_image',
        declaredMime: 'image/webp',
        declaredSizeBytes: 4096,
        ownerScope: { kind: 'senior', id: 's_abc' },
      },
      new Date('2026-05-16T12:00:00.000Z'),
    );
    const row = prisma.assets.get(result.asset.id);
    expect(row).toBeDefined();
    expect(result.asset.storageKey).toContain(result.asset.id);
    expect(result.asset.storageKey).toContain('memory_recipe_image');
    expect(result.asset.storageKey).toContain('2026/05');
  });
});

// ─── getAssetById ────────────────────────────────────────────────────

describe('AssetsService.getAssetById', () => {
  it('returns null for a missing asset', async () => {
    const { service } = buildService();
    expect(await service.getAssetById('m_missing')).toBeNull();
  });

  it('returns the asset metadata with a null delivery URL when status != ready', async () => {
    const { service } = buildService();
    const created = await service.issueUploadUrl('user_abc', {
      kind: 'senior_photo',
      declaredMime: 'image/jpeg',
      declaredSizeBytes: 1024,
      ownerScope: { kind: 'household', id: 'hh_abc' },
    });
    const fetched = await service.getAssetById(created.asset.id);
    expect(fetched).not.toBeNull();
    expect(fetched!.signedDeliveryUrl).toBeNull();
    expect(fetched!.signedDeliveryUrlExpiresAt).toBeNull();
  });
});

// ─── listSeniorPhotos ────────────────────────────────────────────────

describe('AssetsService.listSeniorPhotos', () => {
  /** Seed a `ready` row directly (bypassing the upload→ready pipeline). */
  function seedReadyPhoto(
    prisma: FakePrisma,
    overrides: {
      id: string;
      ownerScopeKind?: string;
      ownerScopeId?: string;
      kind?: string;
      status?: string;
      deliveryKey?: string | null;
      width?: number | null;
      height?: number | null;
      declaredFileName?: string | null;
      createdAt: Date;
    },
  ): void {
    prisma.assets.set(overrides.id, {
      id: overrides.id,
      ownerScopeKind: overrides.ownerScopeKind ?? 'senior',
      ownerScopeId: overrides.ownerScopeId ?? 's_1',
      kind: overrides.kind ?? 'senior_photo',
      status: overrides.status ?? 'ready',
      // `'deliveryKey' in overrides` so an explicit `null` is preserved
      // (a `??` here would collapse the intentional null to the default).
      deliveryKey:
        'deliveryKey' in overrides ? overrides.deliveryKey : `delivered/${overrides.id}.webp`,
      storageBucket: 'tastesee-media-test',
      storageKey: `staged/${overrides.id}.jpg`,
      width: overrides.width ?? 1600,
      height: overrides.height ?? 1200,
      declaredFileName: overrides.declaredFileName ?? `${overrides.id}.jpg`,
      createdAt: overrides.createdAt,
    });
  }

  it('returns only ready senior_photo rows owner-scoped to the senior', async () => {
    const { service, prisma } = buildService();
    seedReadyPhoto(prisma, { id: 'm_match', createdAt: new Date('2026-05-20T10:00:00Z') });
    // Wrong owner scope:
    seedReadyPhoto(prisma, {
      id: 'm_other_senior',
      ownerScopeId: 's_2',
      createdAt: new Date('2026-05-20T10:00:00Z'),
    });
    // Wrong kind:
    seedReadyPhoto(prisma, {
      id: 'm_recipe',
      kind: 'memory_recipe_image',
      createdAt: new Date('2026-05-20T10:00:00Z'),
    });
    // Not ready:
    seedReadyPhoto(prisma, {
      id: 'm_scanning',
      status: 'scanning',
      createdAt: new Date('2026-05-20T10:00:00Z'),
    });
    // Ready but no delivery key (defensive filter):
    seedReadyPhoto(prisma, {
      id: 'm_no_delivery',
      deliveryKey: null,
      createdAt: new Date('2026-05-20T10:00:00Z'),
    });

    const result = await service.listSeniorPhotos('s_1', { limit: 24 });
    expect(result.seniorId).toBe('s_1');
    expect(result.photos.map((p) => p.id)).toEqual(['m_match']);
    expect(result.nextCursor).toBeNull();
  });

  it('projects the trimmed gallery shape with a minted delivery URL', async () => {
    const { service, prisma } = buildService();
    seedReadyPhoto(prisma, {
      id: 'm_one',
      width: 800,
      height: 600,
      declaredFileName: 'grandma.jpg',
      createdAt: new Date('2026-05-20T10:00:00Z'),
    });
    const result = await service.listSeniorPhotos('s_1', { limit: 24 });
    const photo = result.photos[0]!;
    expect(photo.id).toBe('m_one');
    expect(photo.width).toBe(800);
    expect(photo.height).toBe(600);
    expect(photo.declaredFileName).toBe('grandma.jpg');
    expect(typeof photo.signedDeliveryUrl).toBe('string');
    expect(photo.signedDeliveryUrl.length).toBeGreaterThan(0);
    expect(photo.signedDeliveryUrlExpiresAt).not.toBe('');
    // The trimmed item must not leak internal asset fields.
    expect(photo as Record<string, unknown>).not.toHaveProperty('storageKey');
    expect(photo as Record<string, unknown>).not.toHaveProperty('ownerUserId');
    expect(photo as Record<string, unknown>).not.toHaveProperty('sha256');
  });

  it('orders newest-first', async () => {
    const { service, prisma } = buildService();
    seedReadyPhoto(prisma, { id: 'm_old', createdAt: new Date('2026-05-18T10:00:00Z') });
    seedReadyPhoto(prisma, { id: 'm_new', createdAt: new Date('2026-05-20T10:00:00Z') });
    seedReadyPhoto(prisma, { id: 'm_mid', createdAt: new Date('2026-05-19T10:00:00Z') });
    const result = await service.listSeniorPhotos('s_1', { limit: 24 });
    expect(result.photos.map((p) => p.id)).toEqual(['m_new', 'm_mid', 'm_old']);
  });

  it('paginates with a cursor when the page is full', async () => {
    const { service, prisma } = buildService();
    seedReadyPhoto(prisma, { id: 'm_a', createdAt: new Date('2026-05-20T10:00:00Z') });
    seedReadyPhoto(prisma, { id: 'm_b', createdAt: new Date('2026-05-19T10:00:00Z') });
    seedReadyPhoto(prisma, { id: 'm_c', createdAt: new Date('2026-05-18T10:00:00Z') });

    const page1 = await service.listSeniorPhotos('s_1', { limit: 2 });
    expect(page1.photos.map((p) => p.id)).toEqual(['m_a', 'm_b']);
    expect(page1.nextCursor).not.toBeNull();

    const page2 = await service.listSeniorPhotos('s_1', {
      limit: 2,
      cursor: page1.nextCursor!,
    });
    expect(page2.photos.map((p) => p.id)).toEqual(['m_c']);
    expect(page2.nextCursor).toBeNull();
  });

  it('returns an empty page (null cursor) for a senior with no photos', async () => {
    const { service } = buildService();
    const result = await service.listSeniorPhotos('s_empty', { limit: 24 });
    expect(result.photos).toEqual([]);
    expect(result.nextCursor).toBeNull();
  });
});

// ─── recordAssetEvent ────────────────────────────────────────────────

describe('AssetsService.recordAssetEvent', () => {
  it('applies upload_completed and transitions awaiting_upload → uploaded', async () => {
    const { service } = buildService();
    const created = await service.issueUploadUrl('user_abc', {
      kind: 'senior_photo',
      declaredMime: 'image/jpeg',
      declaredSizeBytes: 1024,
      ownerScope: { kind: 'household', id: 'hh_abc' },
    });
    const event: RecordAssetEventRequest = {
      assetId: created.asset.id,
      eventKind: 'upload_completed',
      occurredAt: '2026-05-16T12:01:00.000Z',
      sizeBytes: 1024,
    };
    const result = await service.recordAssetEvent(event);
    expect(result.outcome).toBe('applied');
    expect(result.asset.status).toBe('uploaded');
    expect(result.asset.uploadedAt).not.toBeNull();
  });

  it('replays an already-applied event idempotently', async () => {
    const { service } = buildService();
    const created = await service.issueUploadUrl('user_abc', {
      kind: 'senior_photo',
      declaredMime: 'image/jpeg',
      declaredSizeBytes: 1024,
      ownerScope: { kind: 'household', id: 'hh_abc' },
    });
    const event: RecordAssetEventRequest = {
      assetId: created.asset.id,
      eventKind: 'upload_completed',
      occurredAt: '2026-05-16T12:01:00.000Z',
    };
    await service.recordAssetEvent(event);
    const result = await service.recordAssetEvent(event);
    expect(result.outcome).toBe('replayed');
  });

  it('rejects a magic_byte_passed against a not-yet-uploaded asset', async () => {
    const { service } = buildService();
    const created = await service.issueUploadUrl('user_abc', {
      kind: 'senior_photo',
      declaredMime: 'image/jpeg',
      declaredSizeBytes: 1024,
      ownerScope: { kind: 'household', id: 'hh_abc' },
    });
    await expect(
      service.recordAssetEvent({
        assetId: created.asset.id,
        eventKind: 'magic_byte_passed',
        occurredAt: '2026-05-16T12:01:00.000Z',
      }),
    ).rejects.toBeInstanceOf(RecordAssetEventFailure);
  });

  it('rejects an event for an unknown asset', async () => {
    const { service } = buildService();
    await expect(
      service.recordAssetEvent({
        assetId: 'm_missing',
        eventKind: 'upload_completed',
        occurredAt: '2026-05-16T12:01:00.000Z',
      }),
    ).rejects.toBeInstanceOf(RecordAssetEventFailure);
  });

  it('full pipeline: awaiting_upload → uploaded → scanning → ready', async () => {
    const { service } = buildService();
    const created = await service.issueUploadUrl('user_abc', {
      kind: 'senior_photo',
      declaredMime: 'image/jpeg',
      declaredSizeBytes: 1024,
      ownerScope: { kind: 'household', id: 'hh_abc' },
    });
    await service.recordAssetEvent({
      assetId: created.asset.id,
      eventKind: 'upload_completed',
      occurredAt: '2026-05-16T12:01:00.000Z',
    });
    await service.recordAssetEvent({
      assetId: created.asset.id,
      eventKind: 'magic_byte_passed',
      occurredAt: '2026-05-16T12:02:00.000Z',
      detectedMime: 'image/jpeg',
      sha256: 'a'.repeat(64),
      sizeBytes: 1024,
    });
    await service.recordAssetEvent({
      assetId: created.asset.id,
      eventKind: 'scan_passed',
      occurredAt: '2026-05-16T12:03:00.000Z',
    });
    const result = await service.recordAssetEvent({
      assetId: created.asset.id,
      eventKind: 'process_passed',
      occurredAt: '2026-05-16T12:04:00.000Z',
      deliveryKey: 'development/senior_photo/2026/05/derived.webp',
      width: 800,
      height: 600,
    });
    expect(result.asset.status).toBe('ready');
    expect(result.asset.scanStatus).toBe('clean');
    expect(result.asset.deliveryKey).toBe('development/senior_photo/2026/05/derived.webp');
    expect(result.asset.signedDeliveryUrl).not.toBeNull();
  });

  it('magic_byte_failed transitions uploaded → rejected', async () => {
    const { service } = buildService();
    const created = await service.issueUploadUrl('user_abc', {
      kind: 'senior_photo',
      declaredMime: 'image/jpeg',
      declaredSizeBytes: 1024,
      ownerScope: { kind: 'household', id: 'hh_abc' },
    });
    await service.recordAssetEvent({
      assetId: created.asset.id,
      eventKind: 'upload_completed',
      occurredAt: '2026-05-16T12:01:00.000Z',
    });
    const result = await service.recordAssetEvent({
      assetId: created.asset.id,
      eventKind: 'magic_byte_failed',
      occurredAt: '2026-05-16T12:02:00.000Z',
      reason: 'declared image/jpeg but bytes are %PDF-',
    });
    expect(result.asset.status).toBe('rejected');
    expect(result.asset.scanReason).toContain('declared image/jpeg');
  });

  it('scan_failed transitions scanning → rejected with scanStatus=infected', async () => {
    const { service } = buildService();
    const created = await service.issueUploadUrl('user_abc', {
      kind: 'senior_photo',
      declaredMime: 'image/jpeg',
      declaredSizeBytes: 1024,
      ownerScope: { kind: 'household', id: 'hh_abc' },
    });
    await service.recordAssetEvent({
      assetId: created.asset.id,
      eventKind: 'upload_completed',
      occurredAt: '2026-05-16T12:01:00.000Z',
    });
    await service.recordAssetEvent({
      assetId: created.asset.id,
      eventKind: 'magic_byte_passed',
      occurredAt: '2026-05-16T12:02:00.000Z',
      detectedMime: 'image/jpeg',
    });
    const result = await service.recordAssetEvent({
      assetId: created.asset.id,
      eventKind: 'scan_failed',
      occurredAt: '2026-05-16T12:03:00.000Z',
      reason: 'Eicar.Test.File',
    });
    expect(result.asset.status).toBe('rejected');
    expect(result.asset.scanStatus).toBe('infected');
    expect(result.asset.scanReason).toBe('Eicar.Test.File');
  });

  it('expired transitions awaiting_upload → expired', async () => {
    const { service } = buildService();
    const created = await service.issueUploadUrl('user_abc', {
      kind: 'senior_photo',
      declaredMime: 'image/jpeg',
      declaredSizeBytes: 1024,
      ownerScope: { kind: 'household', id: 'hh_abc' },
    });
    const result = await service.recordAssetEvent({
      assetId: created.asset.id,
      eventKind: 'expired',
      occurredAt: '2026-05-16T13:00:00.000Z',
    });
    expect(result.asset.status).toBe('expired');
  });
});

// ─── computeNextState (pure helper) ──────────────────────────────────

describe('computeNextState', () => {
  const baseEvent = {
    assetId: 'a',
    occurredAt: '2026-05-16T12:00:00.000Z',
  } as const;

  it('upload_completed only applicable from awaiting_upload', () => {
    expect(
      computeNextState('uploaded', 'pending', {
        ...baseEvent,
        eventKind: 'upload_completed',
      }),
    ).toBeNull();
  });

  it('process_passed applicable from scanning OR ready (idempotent re-run)', () => {
    expect(
      computeNextState('scanning', 'clean', {
        ...baseEvent,
        eventKind: 'process_passed',
      }),
    ).not.toBeNull();
    expect(
      computeNextState('ready', 'clean', {
        ...baseEvent,
        eventKind: 'process_passed',
      }),
    ).not.toBeNull();
  });

  it('process_failed not applicable from awaiting_upload or uploaded', () => {
    expect(
      computeNextState('awaiting_upload', 'pending', {
        ...baseEvent,
        eventKind: 'process_failed',
      }),
    ).toBeNull();
    expect(
      computeNextState('uploaded', 'pending', {
        ...baseEvent,
        eventKind: 'process_failed',
      }),
    ).toBeNull();
  });

  it('expired only applicable from awaiting_upload', () => {
    expect(
      computeNextState('uploaded', 'pending', {
        ...baseEvent,
        eventKind: 'expired',
      }),
    ).toBeNull();
  });
});
