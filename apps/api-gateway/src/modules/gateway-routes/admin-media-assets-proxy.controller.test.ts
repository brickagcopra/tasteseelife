import { HttpException, HttpStatus } from '@nestjs/common';
import { describe, expect, it } from 'vitest';

import {
  AccessTokenGuard,
  PermissionGuard,
  REQUIRE_PERMISSIONS_METADATA_KEY,
} from '@taste-and-see/nest-auth';
import type { RequestWithContext } from '@taste-and-see/nest-auth';
import { RateLimitGuard } from '../rate-limit/guards/rate-limit.guard';
import type {
  DownstreamCallOptions,
  DownstreamHttpClient,
  DownstreamResult,
} from '../service-registry/services/downstream-http-client';

import { AdminMediaAssetsProxyController } from './admin-media-assets-proxy.controller';

/**
 * Proxy tests for admin media preview resolution (TS-282-followup-5b).
 *
 * The load-bearing assertions:
 *   - a restricted KIND never yields a URL, whatever its status;
 *   - the storage layout and the owner never cross the wire;
 *   - one bad key out of many degrades that key alone, never the page;
 *   - `unavailable` and `not_found` stay distinct — an outage must not read
 *     as "this asset does not exist".
 */

class StubDownstreamClient {
  public readonly calls: DownstreamCallOptions[] = [];
  constructor(private readonly byId: Readonly<Record<string, DownstreamResult>>) {}
  async call<TBody = unknown>(options: DownstreamCallOptions): Promise<DownstreamResult<TBody>> {
    this.calls.push(options);
    const id = decodeURIComponent(options.path.split('/').pop() ?? '');
    const result = this.byId[id] ?? { kind: 'client_error', status: 404, body: {}, setCookies: [] };
    return result as DownstreamResult<TBody>;
  }
}

const REQUEST: RequestWithContext = {
  requestContext: {
    userId: 'usr_marketing',
    mfaVerified: true,
    roles: [
      {
        name: 'marketing',
        permissions: ['ads:read', 'marketing:approve_creative', 'media:read'],
        scope: { type: 'global' },
      },
    ],
    tenantScope: { type: 'global' },
  },
  headers: { 'x-trace-id': 'tr_media' },
} as unknown as RequestWithContext;

function buildAsset(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'asset_ok',
    kind: 'provider_profile_photo',
    ownerUserId: 'usr_provider',
    ownerScopeKind: 'provider',
    ownerScopeId: 'prov_1',
    status: 'ready',
    scanStatus: 'clean',
    scanReason: null,
    declaredMime: 'image/png',
    detectedMime: 'image/webp',
    declaredFileName: 'headshot.png',
    declaredSizeBytes: 51_200,
    actualSizeBytes: 48_000,
    width: 1200,
    height: 628,
    sha256: 'a'.repeat(64),
    storageBucket: 'media-bucket',
    storageKey: 'uploads/2026/07/asset_ok.png',
    deliveryKey: 'delivery/asset_ok.webp',
    signedDeliveryUrl: 'https://stub-delivery.tasteandsee.example.com/asset_ok?sig=abc',
    signedDeliveryUrlExpiresAt: '2026-07-28T12:05:00.000Z',
    liveMode: false,
    uploadUrlExpiresAt: null,
    uploadedAt: '2026-07-28T11:00:00.000Z',
    scannedAt: '2026-07-28T11:01:00.000Z',
    processedAt: '2026-07-28T11:02:00.000Z',
    createdAt: '2026-07-28T10:59:00.000Z',
    updatedAt: '2026-07-28T11:02:00.000Z',
    ...overrides,
  };
}

function ok(body: unknown): DownstreamResult {
  return { kind: 'ok', status: 200, body, setCookies: [] };
}

function build(byId: Readonly<Record<string, DownstreamResult>>): {
  controller: AdminMediaAssetsProxyController;
  client: StubDownstreamClient;
} {
  const client = new StubDownstreamClient(byId);
  return {
    controller: new AdminMediaAssetsProxyController(client as unknown as DownstreamHttpClient),
    client,
  };
}

describe('AdminMediaAssetsProxyController — guards', () => {
  it('sits behind access-token, permission, and rate-limit guards', () => {
    const guards: unknown[] =
      Reflect.getMetadata('__guards__', AdminMediaAssetsProxyController) ?? [];
    expect(guards).toEqual([AccessTokenGuard, PermissionGuard, RateLimitGuard]);
  });

  it('is gated on media:read', () => {
    // Not `marketing:approve_creative`: the content author editor resolves a
    // byline photo through the same endpoint and its persona is a content
    // editor, who has no business approving ad creatives.
    const required: unknown = Reflect.getMetadata(
      REQUIRE_PERMISSIONS_METADATA_KEY,
      AdminMediaAssetsProxyController.prototype.resolve,
    );
    expect(required).toEqual(['media:read']);
  });
});

describe('AdminMediaAssetsProxyController — resolution', () => {
  it('returns a signed URL for a ready, previewable asset', async () => {
    const { controller } = build({ asset_ok: ok(buildAsset()) });
    const response = await controller.resolve({ id: 'asset_ok' }, REQUEST);

    expect(response.assets).toHaveLength(1);
    const [asset] = response.assets;
    expect(asset).toEqual({
      outcome: 'ready',
      assetKey: 'asset_ok',
      signedUrl: 'https://stub-delivery.tasteandsee.example.com/asset_ok?sig=abc',
      expiresAt: '2026-07-28T12:05:00.000Z',
      mime: 'image/webp',
      width: 1200,
      height: 628,
      fileName: 'headshot.png',
      sizeBytes: 48_000,
    });
  });

  it('never puts the storage layout, the digest, or the owner on the wire', () => {
    // TS-282-followup-5a refused to export media-svc's filesystem into three
    // other services' contracts. Exporting it into a browser to draw a picture
    // is the same mistake with a nicer excuse.
    const serialised = JSON.stringify(buildAsset());
    expect(serialised).toContain('media-bucket');

    return build({ asset_ok: ok(buildAsset()) })
      .controller.resolve({ id: 'asset_ok' }, REQUEST)
      .then((response) => {
        const out = JSON.stringify(response);
        for (const secret of [
          'media-bucket',
          'uploads/2026/07/asset_ok.png',
          'delivery/asset_ok.webp',
          'a'.repeat(64),
          'usr_provider',
          'prov_1',
        ]) {
          expect(out).not.toContain(secret);
        }
      });
  });

  it('prefers the magic-byte-detected mime over the declared one', async () => {
    // CLAUDE.md §17.16 — the client's declared Content-Type is a claim, not a
    // fact. A console that renders on the declared mime is trusting it again.
    const { controller } = build({ asset_ok: ok(buildAsset({ detectedMime: null })) });
    const response = await controller.resolve({ id: 'asset_ok' }, REQUEST);
    expect(response.assets[0]).toMatchObject({ outcome: 'ready', mime: 'image/png' });
  });

  it('refuses a restricted kind, without naming it', async () => {
    const { controller } = build({ asset_senior: ok(buildAsset({ kind: 'senior_photo' })) });
    const response = await controller.resolve({ id: 'asset_senior' }, REQUEST);
    expect(response.assets[0]).toEqual({ outcome: 'restricted', assetKey: 'asset_senior' });
    expect(JSON.stringify(response)).not.toContain('senior_photo');
  });

  it('refuses a restricted kind even when the row is ready and has a URL', async () => {
    // The kind check runs before the status check on purpose. `media:read` is
    // held by marketing; media-svc's own GET has no row-level gate yet
    // (TS-110-followup-9), so this is the only thing standing between an ads
    // permission and a provider's government ID.
    const { controller } = build({
      asset_doc: ok(buildAsset({ kind: 'provider_document', status: 'ready' })),
    });
    const response = await controller.resolve({ id: 'asset_doc' }, REQUEST);
    expect(response.assets[0]).toEqual({ outcome: 'restricted', assetKey: 'asset_doc' });
    expect(JSON.stringify(response)).not.toContain('stub-delivery');
  });

  it('reports the lifecycle status when an asset is not renderable', async () => {
    const { controller } = build({
      asset_rej: ok(buildAsset({ status: 'rejected', signedDeliveryUrl: null })),
    });
    const response = await controller.resolve({ id: 'asset_rej' }, REQUEST);
    expect(response.assets[0]).toEqual({
      outcome: 'not_ready',
      assetKey: 'asset_rej',
      status: 'rejected',
    });
  });

  it('treats a ready row with no signed URL as not_ready rather than crashing', async () => {
    const { controller } = build({ asset_ok: ok(buildAsset({ signedDeliveryUrl: null })) });
    const response = await controller.resolve({ id: 'asset_ok' }, REQUEST);
    expect(response.assets[0]).toMatchObject({ outcome: 'not_ready', status: 'ready' });
  });

  it('reports a missing asset as not_found — the common case for a legacy key', async () => {
    const { controller } = build({});
    const response = await controller.resolve({ id: 'uploads/legacy.png' }, REQUEST);
    expect(response.assets[0]).toEqual({ outcome: 'not_found', assetKey: 'uploads/legacy.png' });
  });

  it('keeps an outage distinct from a missing asset', async () => {
    // Conflating them tells a reviewer "that image does not exist" when what
    // actually happened is that we could not ask.
    const cases: ReadonlyArray<readonly [string, DownstreamResult]> = [
      ['a_timeout', { kind: 'timeout' }],
      ['a_network', { kind: 'network_error', detail: 'ECONNREFUSED' }],
      ['a_5xx', { kind: 'server_error', status: 503, body: {}, setCookies: [] }],
      ['a_unconfigured', { kind: 'not_configured', service: 'media' }],
      ['a_403', { kind: 'client_error', status: 403, body: {}, setCookies: [] }],
      ['a_drift', ok({ id: 'a_drift', unexpected: true })],
    ];
    const { controller } = build(Object.fromEntries(cases));
    for (const [id] of cases) {
      const response = await controller.resolve({ id }, REQUEST);
      expect(response.assets[0]).toEqual({ outcome: 'unavailable', assetKey: id });
    }
  });

  it('degrades one bad key without failing the page', async () => {
    // A console that 502s because one of ten keys is junk is a console that
    // cannot review the other nine — which is the defect, restated.
    const { controller } = build({ asset_ok: ok(buildAsset()) });
    const response = await controller.resolve({ id: ['asset_ok', 'garbage', 'asset_ok'] }, REQUEST);
    expect(response.assets.map((a) => a.outcome)).toEqual(['ready', 'not_found']);
  });

  it('de-duplicates ids so a repeated key costs one downstream call', async () => {
    const { controller, client } = build({ asset_ok: ok(buildAsset()) });
    await controller.resolve({ id: ['asset_ok', 'asset_ok', 'asset_ok'] }, REQUEST);
    expect(client.calls).toHaveLength(1);
  });

  it('propagates the actor and the trace id to media-svc', async () => {
    const { controller, client } = build({ asset_ok: ok(buildAsset()) });
    await controller.resolve({ id: 'asset_ok' }, REQUEST);
    expect(client.calls[0]).toMatchObject({
      service: 'media',
      method: 'GET',
      traceId: 'tr_media',
    });
    expect(client.calls[0]?.actor?.userId).toBe('usr_marketing');
  });

  it('encodes a legacy key that would otherwise escape the path', async () => {
    const { controller, client } = build({});
    await controller.resolve({ id: '../admin/media/assets' }, REQUEST);
    expect(client.calls[0]?.path).toBe('/api/v1/media/assets/..%2Fadmin%2Fmedia%2Fassets');
  });

  it('rejects an over-large fan-out at the edge, before any downstream call', async () => {
    const { controller, client } = build({});
    const ids = Array.from({ length: 11 }, (_, i) => `asset_${i}`);
    await expect(controller.resolve({ id: ids }, REQUEST)).rejects.toBeInstanceOf(HttpException);
    expect(client.calls).toHaveLength(0);
  });

  it('rejects a request with no ids', async () => {
    const { controller } = build({});
    await expect(controller.resolve({}, REQUEST)).rejects.toMatchObject({
      status: HttpStatus.BAD_REQUEST,
    });
  });
});
