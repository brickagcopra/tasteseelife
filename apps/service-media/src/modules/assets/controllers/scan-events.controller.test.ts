/**
 * Unit tests for `ScanEventsController` (TS-110 internal scan-event
 * ingest surface) — focused on the controller's narrow responsibilities:
 *
 *   - propagating the `RecordAssetEventResponse` from the service layer
 *     unchanged on the happy path;
 *   - translating `RecordAssetEventFailure` instances to the right
 *     HTTP-status exceptions (404 for `asset_not_found`, 422 for the
 *     other codes);
 *   - re-throwing unexpected errors untouched;
 *   - seeding the `exempt` tenant-scope frame around the full handler
 *     body (TS-020-followup-2b-platform-rollout) so the Prisma extension
 *     gate sees the `internal-media-scan-event-record` reason rather
 *     than firing `MissingRequestContextError` under the `enforce`
 *     posture.
 *
 * The InternalSharedSecretGuard is a separate concern — covered by
 * `internal-shared-secret.guard.test.ts` — so this file does NOT
 * exercise the guard's auth behaviour. Nest wires the guard at the DI
 * layer; constructing the controller directly here lets us test the
 * handler body in isolation.
 */

import { NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import type { RecordAssetEventRequest, RecordAssetEventResponse } from '@taste-and-see/contracts';
import {
  TenantContextStore,
  type TenantContextFrame,
} from '@taste-and-see/nest-prisma-tenant-scope';
import { describe, expect, it } from 'vitest';

import { AssetsService, RecordAssetEventFailure } from '../services/assets.service';

import { ScanEventsController } from './scan-events.controller';

function makeStore(): TenantContextStore {
  return new TenantContextStore();
}

function sampleAssetResponse(): RecordAssetEventResponse['asset'] {
  return {
    id: 'asset_001',
    kind: 'senior_photo',
    ownerUserId: 'user_001',
    ownerScopeKind: 'household',
    ownerScopeId: 'household_001',
    status: 'ready',
    scanStatus: 'clean',
    scanReason: null,
    declaredMime: 'image/jpeg',
    detectedMime: 'image/jpeg',
    declaredFileName: 'grandma.jpg',
    declaredSizeBytes: 12_345,
    actualSizeBytes: 12_300,
    width: 1024,
    height: 768,
    sha256: 'a'.repeat(64),
    storageBucket: 'tastesee-media-test',
    storageKey: 'senior_photo/2026/05/asset_001',
    deliveryKey: 'senior_photo/2026/05/asset_001.webp',
    signedDeliveryUrl: 'https://stub-delivery.tasteandsee.example.com/asset_001?sig=abc',
    signedDeliveryUrlExpiresAt: '2026-05-20T12:05:00.000Z',
    liveMode: false,
    uploadUrlExpiresAt: '2026-05-20T12:15:00.000Z',
    uploadedAt: '2026-05-20T12:00:30.000Z',
    scannedAt: '2026-05-20T12:00:45.000Z',
    processedAt: '2026-05-20T12:01:00.000Z',
    createdAt: '2026-05-20T12:00:00.000Z',
    updatedAt: '2026-05-20T12:01:00.000Z',
  };
}

function sampleRequest(overrides: Partial<RecordAssetEventRequest> = {}): RecordAssetEventRequest {
  return {
    assetId: 'asset_001',
    eventKind: 'process_passed',
    occurredAt: '2026-05-20T12:01:00.000Z',
    detectedMime: 'image/jpeg',
    sha256: 'a'.repeat(64),
    sizeBytes: 12_300,
    width: 1024,
    height: 768,
    deliveryKey: 'senior_photo/2026/05/asset_001.webp',
    ...overrides,
  };
}

class StubAssetsService {
  public recordCalls: RecordAssetEventRequest[] = [];
  public recordReturn: RecordAssetEventResponse = {
    outcome: 'applied',
    asset: sampleAssetResponse(),
  };
  public throwError: unknown = null;

  async recordAssetEvent(input: RecordAssetEventRequest): Promise<RecordAssetEventResponse> {
    this.recordCalls.push(input);
    if (this.throwError !== null) throw this.throwError;
    return this.recordReturn;
  }
}

describe('ScanEventsController.record', () => {
  it('returns the service response unchanged on the applied happy path', async () => {
    const stub = new StubAssetsService();
    const controller = new ScanEventsController(stub as unknown as AssetsService, makeStore());

    const response = await controller.record(sampleRequest());

    expect(response.outcome).toBe('applied');
    expect(response.asset.id).toBe('asset_001');
    expect(stub.recordCalls).toHaveLength(1);
  });

  it('returns the service response unchanged on the replayed path', async () => {
    const stub = new StubAssetsService();
    stub.recordReturn = { outcome: 'replayed', asset: sampleAssetResponse() };
    const controller = new ScanEventsController(stub as unknown as AssetsService, makeStore());

    const response = await controller.record(sampleRequest());

    expect(response.outcome).toBe('replayed');
  });

  it('translates RecordAssetEventFailure asset_not_found to 404', async () => {
    const stub = new StubAssetsService();
    stub.throwError = new RecordAssetEventFailure({
      code: 'asset_not_found',
      detail: 'asset asset_missing not found',
    });
    const controller = new ScanEventsController(stub as unknown as AssetsService, makeStore());

    await expect(
      controller.record(sampleRequest({ assetId: 'asset_missing' })),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('translates RecordAssetEventFailure event_not_applicable to 422', async () => {
    const stub = new StubAssetsService();
    stub.throwError = new RecordAssetEventFailure({
      code: 'event_not_applicable',
      detail: 'event process_passed is not applicable to asset in status awaiting_upload',
    });
    const controller = new ScanEventsController(stub as unknown as AssetsService, makeStore());

    await expect(controller.record(sampleRequest())).rejects.toBeInstanceOf(
      UnprocessableEntityException,
    );
  });

  it('re-throws unexpected errors untouched', async () => {
    const stub = new StubAssetsService();
    const boom = new Error('unexpected database error');
    stub.throwError = boom;
    const controller = new ScanEventsController(stub as unknown as AssetsService, makeStore());

    await expect(controller.record(sampleRequest())).rejects.toBe(boom);
  });
});

describe('ScanEventsController tenant-scope exempt wrap (TS-020-followup-2b-platform-rollout)', () => {
  it('seeds an exempt frame at the assets.recordAssetEvent collaborator callsite', async () => {
    const store = makeStore();
    let observedFrame: TenantContextFrame | null = null;
    const fakeSvc = {
      async recordAssetEvent(_input: RecordAssetEventRequest): Promise<RecordAssetEventResponse> {
        observedFrame = store.current();
        return { outcome: 'applied', asset: sampleAssetResponse() };
      },
    };
    const controller = new ScanEventsController(fakeSvc as unknown as AssetsService, store);

    expect(store.current()).toBeNull();
    await controller.record(sampleRequest());
    expect(observedFrame).toEqual({
      kind: 'exempt',
      reason: 'internal-media-scan-event-record',
    });
    expect(store.current()).toBeNull();
  });

  it('seeds the exempt frame on the 404 short-circuit path (the collaborator throw is inside the wrap)', async () => {
    const store = makeStore();
    let observedFrame: TenantContextFrame | null = null;
    const fakeSvc = {
      async recordAssetEvent(_input: RecordAssetEventRequest): Promise<RecordAssetEventResponse> {
        observedFrame = store.current();
        throw new RecordAssetEventFailure({
          code: 'asset_not_found',
          detail: 'asset not found',
        });
      },
    };
    const controller = new ScanEventsController(fakeSvc as unknown as AssetsService, store);

    expect(store.current()).toBeNull();
    await expect(controller.record(sampleRequest())).rejects.toBeInstanceOf(NotFoundException);
    expect(observedFrame).toEqual({
      kind: 'exempt',
      reason: 'internal-media-scan-event-record',
    });
    expect(store.current()).toBeNull();
  });

  it('seeds the exempt frame on the 422 short-circuit path', async () => {
    const store = makeStore();
    let observedFrame: TenantContextFrame | null = null;
    const fakeSvc = {
      async recordAssetEvent(_input: RecordAssetEventRequest): Promise<RecordAssetEventResponse> {
        observedFrame = store.current();
        throw new RecordAssetEventFailure({
          code: 'event_not_applicable',
          detail: 'event not applicable',
        });
      },
    };
    const controller = new ScanEventsController(fakeSvc as unknown as AssetsService, store);

    await expect(controller.record(sampleRequest())).rejects.toBeInstanceOf(
      UnprocessableEntityException,
    );
    expect(observedFrame).toEqual({
      kind: 'exempt',
      reason: 'internal-media-scan-event-record',
    });
    expect(store.current()).toBeNull();
  });

  it('does not leak a frame outside the wrap on the happy path', async () => {
    const stub = new StubAssetsService();
    const store = makeStore();
    const controller = new ScanEventsController(stub as unknown as AssetsService, store);

    expect(store.current()).toBeNull();
    await controller.record(sampleRequest());
    expect(store.current()).toBeNull();
  });
});
