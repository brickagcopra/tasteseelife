import { UnprocessableEntityException } from '@nestjs/common';
import type {
  DeleteProviderDocumentResponse,
  ProviderDiscoveryDocument,
  UpsertProviderDocumentRequest,
  UpsertProviderDocumentResponse,
} from '@taste-and-see/contracts';
import {
  TenantContextStore,
  type TenantContextFrame,
} from '@taste-and-see/nest-prisma-tenant-scope';
import { describe, expect, it } from 'vitest';

import {
  ProviderSearchService,
  type UpsertProviderResult,
} from '../services/provider-search.service';

import { ProviderIndexController } from './provider-index.controller';

/**
 * Controller-level tests for `ProviderIndexController` introduced under
 * TS-020-followup-2b-platform-rollout. Two describe blocks:
 *
 *   - Base behaviour: happy-path upsert/delete + the 422-from-mismatch
 *     branch. These cover the wire-shape compatibility of the new
 *     tenant-scope wrap (the response and exception types must be
 *     unchanged after the `runWithoutTenantContext` wrap landed).
 *
 *   - Tenant-scope exempt wrap: each wrapped handler is exercised
 *     against a real `TenantContextStore`; the stub `ProviderSearchService`
 *     captures `store.current()` at the collaborator callsite and the
 *     test asserts the frame equals `{ kind: 'exempt', reason: '...' }`
 *     with the expected reason string. The no-frame-leak invariant
 *     (store.current() === null BEFORE and AFTER the handler) is
 *     pinned for both happy and short-circuit paths.
 *
 * The structural difference from the eleven prior rollouts is that
 * service-search has NO Prisma; the wrap is defence-in-depth + parity
 * scaffolding, not an enforcement-critical body. The tests still pin
 * the wire-shape invariant so a future maintainer adding Prisma here
 * cannot accidentally hoist a Prisma call OUTSIDE the wrap by adding
 * "just one tiny read" between the existing collaborator return and
 * post-processing.
 */
function makeStore(): TenantContextStore {
  return new TenantContextStore();
}

const ISO_NOW = '2026-05-20T12:00:00.000Z';

function sampleDoc(overrides: Partial<ProviderDiscoveryDocument> = {}): ProviderDiscoveryDocument {
  return {
    providerId: 'prov_abc',
    userId: 'user_abc',
    displayName: 'Chef Alice',
    headline: null,
    bio: null,
    tier: 'certified',
    status: 'active',
    languages: ['en'],
    specialties: [],
    cuisines: [],
    dietaryExpertise: [],
    certifications: [],
    centroid: null,
    ratingAverage: null,
    ratingCount: 0,
    completedBookingCount: 0,
    profilePhotoKey: null,
    videoIntroKey: null,
    timeZone: 'America/New_York',
    availabilitySummary: null,
    sourceUpdatedAt: ISO_NOW,
    ...overrides,
  };
}

function sampleUpsertResponse(
  overrides: Partial<UpsertProviderDocumentResponse> = {},
): UpsertProviderDocumentResponse {
  return {
    outcome: 'created',
    providerId: 'prov_abc',
    indexedAt: ISO_NOW,
    liveMode: false,
    ...overrides,
  };
}

function sampleDeleteResponse(
  overrides: Partial<DeleteProviderDocumentResponse> = {},
): DeleteProviderDocumentResponse {
  return {
    outcome: 'deleted',
    providerId: 'prov_abc',
    deletedAt: ISO_NOW,
    liveMode: false,
    ...overrides,
  };
}

interface StubInput {
  upsertCalls: Array<{ providerIdPath: string; document: ProviderDiscoveryDocument }>;
  upsertReturn: UpsertProviderResult;
  deleteCalls: Array<{ providerId: string }>;
  deleteReturn: DeleteProviderDocumentResponse;
  onUpsert?: () => void;
  onDelete?: () => void;
}

function makeStubService(overrides: Partial<StubInput> = {}): {
  service: ProviderSearchService;
  state: StubInput;
} {
  const state: StubInput = {
    upsertCalls: [],
    upsertReturn: {
      kind: 'success',
      response: sampleUpsertResponse(),
    },
    deleteCalls: [],
    deleteReturn: sampleDeleteResponse(),
    ...overrides,
  };

  const service = {
    async upsertProvider(input: {
      providerIdPath: string;
      document: ProviderDiscoveryDocument;
    }): Promise<UpsertProviderResult> {
      state.upsertCalls.push(input);
      state.onUpsert?.();
      return state.upsertReturn;
    },
    async deleteProvider(input: { providerId: string }): Promise<DeleteProviderDocumentResponse> {
      state.deleteCalls.push(input);
      state.onDelete?.();
      return state.deleteReturn;
    },
  } as unknown as ProviderSearchService;

  return { service, state };
}

describe('ProviderIndexController.upsert', () => {
  it('returns the success response on a matching path + body', async () => {
    const { service, state } = makeStubService();
    const controller = new ProviderIndexController(service, makeStore());

    const body: UpsertProviderDocumentRequest = { document: sampleDoc() };
    const response = await controller.upsert('prov_abc', body);

    expect(response.outcome).toBe('created');
    expect(response.providerId).toBe('prov_abc');
    expect(response.liveMode).toBe(false);
    expect(state.upsertCalls).toHaveLength(1);
    expect(state.upsertCalls[0]?.providerIdPath).toBe('prov_abc');
    expect(state.upsertCalls[0]?.document.providerId).toBe('prov_abc');
  });

  it('translates a provider_id_mismatch failure into a 422 UnprocessableEntityException', async () => {
    const { service, state } = makeStubService({
      upsertReturn: {
        kind: 'failure',
        failure: 'provider_id_mismatch',
        detail: 'path :providerId must match document.providerId',
      },
    });
    const controller = new ProviderIndexController(service, makeStore());

    const body: UpsertProviderDocumentRequest = {
      document: sampleDoc({ providerId: 'prov_other' }),
    };
    await expect(controller.upsert('prov_abc', body)).rejects.toBeInstanceOf(
      UnprocessableEntityException,
    );
    expect(state.upsertCalls).toHaveLength(1);
  });

  it('forwards the outcome of an updated upsert', async () => {
    const { service } = makeStubService({
      upsertReturn: {
        kind: 'success',
        response: sampleUpsertResponse({ outcome: 'updated' }),
      },
    });
    const controller = new ProviderIndexController(service, makeStore());

    const response = await controller.upsert('prov_abc', { document: sampleDoc() });
    expect(response.outcome).toBe('updated');
  });
});

describe('ProviderIndexController.delete', () => {
  it('returns the deleted outcome on the happy path', async () => {
    const { service, state } = makeStubService();
    const controller = new ProviderIndexController(service, makeStore());

    const response = await controller.delete('prov_abc');

    expect(response.outcome).toBe('deleted');
    expect(response.providerId).toBe('prov_abc');
    expect(state.deleteCalls).toHaveLength(1);
    expect(state.deleteCalls[0]?.providerId).toBe('prov_abc');
  });

  it('forwards a not_found outcome unchanged', async () => {
    const { service } = makeStubService({
      deleteReturn: sampleDeleteResponse({ outcome: 'not_found', deletedAt: null }),
    });
    const controller = new ProviderIndexController(service, makeStore());

    const response = await controller.delete('prov_missing');
    expect(response.outcome).toBe('not_found');
    expect(response.deletedAt).toBeNull();
  });
});

describe('ProviderIndexController tenant-scope exempt wrap (TS-020-followup-2b-platform-rollout)', () => {
  it('seeds an exempt frame at the upsertProvider collaborator callsite', async () => {
    const store = makeStore();
    let observedFrame: TenantContextFrame | null = null;
    const { service } = makeStubService({
      onUpsert: () => {
        observedFrame = store.current();
      },
    });
    const controller = new ProviderIndexController(service, store);

    expect(store.current()).toBeNull();
    await controller.upsert('prov_abc', { document: sampleDoc() });
    expect(observedFrame).toEqual({
      kind: 'exempt',
      reason: 'internal-search-provider-upsert',
    });
    expect(store.current()).toBeNull();
  });

  it('seeds an exempt frame at the deleteProvider collaborator callsite', async () => {
    const store = makeStore();
    let observedFrame: TenantContextFrame | null = null;
    const { service } = makeStubService({
      onDelete: () => {
        observedFrame = store.current();
      },
    });
    const controller = new ProviderIndexController(service, store);

    expect(store.current()).toBeNull();
    await controller.delete('prov_abc');
    expect(observedFrame).toEqual({
      kind: 'exempt',
      reason: 'internal-search-provider-delete',
    });
    expect(store.current()).toBeNull();
  });

  it('seeds the exempt frame on the 422 upsert short-circuit path (provider_id_mismatch)', async () => {
    const store = makeStore();
    let observedFrame: TenantContextFrame | null = null;
    const { service } = makeStubService({
      upsertReturn: {
        kind: 'failure',
        failure: 'provider_id_mismatch',
        detail: 'path :providerId must match document.providerId',
      },
      onUpsert: () => {
        observedFrame = store.current();
      },
    });
    const controller = new ProviderIndexController(service, store);

    expect(store.current()).toBeNull();
    await expect(
      controller.upsert('prov_abc', { document: sampleDoc({ providerId: 'prov_other' }) }),
    ).rejects.toBeInstanceOf(UnprocessableEntityException);
    expect(observedFrame).toEqual({
      kind: 'exempt',
      reason: 'internal-search-provider-upsert',
    });
    expect(store.current()).toBeNull();
  });

  it('does not leak a frame outside the wrap on the happy upsert path', async () => {
    const store = makeStore();
    const { service } = makeStubService();
    const controller = new ProviderIndexController(service, store);

    expect(store.current()).toBeNull();
    await controller.upsert('prov_abc', { document: sampleDoc() });
    expect(store.current()).toBeNull();
  });

  it('does not leak a frame outside the wrap on the happy delete path', async () => {
    const store = makeStore();
    const { service } = makeStubService();
    const controller = new ProviderIndexController(service, store);

    expect(store.current()).toBeNull();
    await controller.delete('prov_abc');
    expect(store.current()).toBeNull();
  });
});
