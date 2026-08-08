import type {
  DeleteProviderDocumentResponse,
  ProviderDiscoveryDocument,
  UpsertProviderDocumentResponse,
} from '@taste-and-see/contracts';
import { describe, expect, it, vi } from 'vitest';

import { ProjectionOrchestratorService } from './projection-orchestrator.service';
import {
  type ProviderSnapshotClient,
  type ProviderSnapshotResult,
} from './provider-snapshot.client';
import { SearchIndexClientError, type SearchIndexClient } from './search-index.client';

function buildDocument(providerId: string): ProviderDiscoveryDocument {
  return {
    providerId,
    userId: `user_${providerId}`,
    displayName: 'Chef Ada',
    headline: null,
    bio: null,
    tier: 'certified',
    status: 'active',
    languages: [],
    specialties: [],
    cuisines: [],
    dietaryExpertise: [],
    certifications: ['ccc'],
    centroid: null,
    ratingAverage: null,
    ratingCount: 0,
    completedBookingCount: 0,
    profilePhotoKey: null,
    videoIntroKey: null,
    timeZone: 'America/New_York',
    availabilitySummary: null,
    sourceUpdatedAt: '2026-05-16T12:00:00.000Z',
  };
}

function buildFoundSnapshot(providerId: string): ProviderSnapshotResult {
  return {
    kind: 'found',
    response: { kind: 'found', document: buildDocument(providerId) },
  };
}

function buildNotFoundSnapshot(providerId: string): ProviderSnapshotResult {
  return {
    kind: 'found',
    response: { kind: 'not_found', providerId },
  };
}

function buildSnapshotClient(result: ProviderSnapshotResult): ProviderSnapshotClient {
  return {
    fetch: vi.fn(async () => result),
  } as unknown as ProviderSnapshotClient;
}

function buildIndexClient(
  upsertResult?: UpsertProviderDocumentResponse,
  removeResult?: DeleteProviderDocumentResponse,
): SearchIndexClient {
  return {
    upsert: vi.fn(async () => upsertResult ?? defaultUpsertResult()),
    remove: vi.fn(async () => removeResult ?? defaultRemoveResult()),
  } as unknown as SearchIndexClient;
}

function defaultUpsertResult(): UpsertProviderDocumentResponse {
  return {
    outcome: 'updated',
    providerId: 'prov_1',
    indexedAt: '2026-05-16T12:00:00.000Z',
    liveMode: false,
  };
}

function defaultRemoveResult(): DeleteProviderDocumentResponse {
  return {
    outcome: 'deleted',
    providerId: 'prov_1',
    deletedAt: '2026-05-16T12:00:00.000Z',
    liveMode: false,
  };
}

describe('ProjectionOrchestratorService.project', () => {
  it('PUTs the doc when service-provider returns found', async () => {
    const snapshot = buildSnapshotClient(buildFoundSnapshot('prov_1'));
    const index = buildIndexClient();
    const svc = new ProjectionOrchestratorService(snapshot, index);

    const result = await svc.project('prov_1');

    expect(result.kind).toBe('upserted');
    if (result.kind !== 'upserted') return;
    expect(result.providerId).toBe('prov_1');
    expect(result.outcome).toBe('updated');
    expect(snapshot.fetch).toHaveBeenCalledWith('prov_1');
    expect(index.upsert).toHaveBeenCalledTimes(1);
    expect(index.remove).not.toHaveBeenCalled();
  });

  it('DELETEs the doc when service-provider returns not_found', async () => {
    const snapshot = buildSnapshotClient(buildNotFoundSnapshot('prov_1'));
    const index = buildIndexClient();
    const svc = new ProjectionOrchestratorService(snapshot, index);

    const result = await svc.project('prov_1');

    expect(result.kind).toBe('removed');
    if (result.kind !== 'removed') return;
    expect(result.outcome).toBe('deleted');
    expect(index.remove).toHaveBeenCalledWith('prov_1');
    expect(index.upsert).not.toHaveBeenCalled();
  });

  it('skips both downstream calls when the providerId fails contract validation', async () => {
    const snapshot = buildSnapshotClient({
      kind: 'invalid_request',
      message: 'providerId failed validation',
    });
    const index = buildIndexClient();
    const svc = new ProjectionOrchestratorService(snapshot, index);

    const result = await svc.project('bad-id with spaces');

    expect(result.kind).toBe('invalid_provider_id');
    expect(index.upsert).not.toHaveBeenCalled();
    expect(index.remove).not.toHaveBeenCalled();
  });

  it('propagates a SearchIndexClientError so the consumer SDK can retry', async () => {
    const snapshot = buildSnapshotClient(buildFoundSnapshot('prov_1'));
    const index = {
      upsert: vi.fn(async () => {
        throw new SearchIndexClientError('prov_1', 503, 'service-search unavailable');
      }),
      remove: vi.fn(),
    } as unknown as SearchIndexClient;
    const svc = new ProjectionOrchestratorService(snapshot, index);

    await expect(svc.project('prov_1')).rejects.toBeInstanceOf(SearchIndexClientError);
  });

  it('returns the upserted outcome verbatim from service-search', async () => {
    const snapshot = buildSnapshotClient(buildFoundSnapshot('prov_1'));
    const index = buildIndexClient({
      outcome: 'created',
      providerId: 'prov_1',
      indexedAt: '2026-05-16T12:00:00.000Z',
      liveMode: false,
    });
    const svc = new ProjectionOrchestratorService(snapshot, index);

    const result = await svc.project('prov_1');

    expect(result.kind).toBe('upserted');
    if (result.kind !== 'upserted') return;
    expect(result.outcome).toBe('created');
  });

  it('returns the removed outcome verbatim from service-search (including not_found on a double-delete)', async () => {
    const snapshot = buildSnapshotClient(buildNotFoundSnapshot('prov_1'));
    const index = buildIndexClient(undefined, {
      outcome: 'not_found',
      providerId: 'prov_1',
      deletedAt: null,
      liveMode: false,
    });
    const svc = new ProjectionOrchestratorService(snapshot, index);

    const result = await svc.project('prov_1');

    expect(result.kind).toBe('removed');
    if (result.kind !== 'removed') return;
    expect(result.outcome).toBe('not_found');
  });
});
