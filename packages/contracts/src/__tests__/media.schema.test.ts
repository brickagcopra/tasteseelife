import { describe, expect, it } from 'vitest';

import {
  IssueUploadUrlRequestSchema,
  IssueUploadUrlResponseSchema,
  ListMediaAssetsQuerySchema,
  MEDIA_LIST_LIMIT_DEFAULT,
  MEDIA_LIST_LIMIT_MAX,
  MEDIA_MAX_SIZE_BYTES,
  MEDIA_REQUIRED_HEADERS_MAX,
  MEDIA_ID_MAX_LENGTH,
  MediaAssetEventKindSchema,
  MediaAssetKeySchema,
  MediaAssetKindSchema,
  StoredMediaAssetKeySchema,
  MediaAssetResponseSchema,
  MediaAssetStatusSchema,
  MediaAssetsListResponseSchema,
  MediaOwnerScopeKindSchema,
  MediaScanStatusSchema,
  RecordAssetEventRequestSchema,
  RecordAssetEventResponseSchema,
  ADMIN_MEDIA_RESOLVE_MAX,
  ResolveMediaAssetsQuerySchema,
  ResolveMediaAssetsResponseSchema,
  ResolvedMediaAssetSchema,
  isAdminPreviewableMediaKind,
} from '../http/media.schema';

const ISO_NOW = '2026-05-16T12:00:00.000Z';
const SHA256_HEX = 'a'.repeat(64);

function buildAsset(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'asset_abc',
    kind: 'senior_photo',
    ownerUserId: 'user_abc',
    ownerScopeKind: 'household',
    ownerScopeId: 'hh_abc',
    status: 'awaiting_upload',
    scanStatus: 'pending',
    scanReason: null,
    declaredMime: 'image/jpeg',
    detectedMime: null,
    declaredFileName: 'grandma.jpg',
    declaredSizeBytes: 1024,
    actualSizeBytes: null,
    width: null,
    height: null,
    sha256: null,
    storageBucket: 'tastesee-media-dev',
    storageKey: 'dev/senior_photo/2026/05/asset_abc',
    deliveryKey: null,
    signedDeliveryUrl: null,
    signedDeliveryUrlExpiresAt: null,
    liveMode: false,
    uploadUrlExpiresAt: ISO_NOW,
    uploadedAt: null,
    scannedAt: null,
    processedAt: null,
    createdAt: ISO_NOW,
    updatedAt: ISO_NOW,
    ...overrides,
  };
}

describe('MediaAssetKindSchema', () => {
  it.each([
    'senior_photo',
    'provider_profile_photo',
    'provider_video_intro',
    'memory_recipe_image',
    'provider_document',
    'certification_evidence',
    'academy_lesson_attachment',
  ] as const)('accepts %s', (value) => {
    expect(MediaAssetKindSchema.parse(value)).toBe(value);
  });

  it('rejects an unknown kind', () => {
    expect(() => MediaAssetKindSchema.parse('billboard_ad')).toThrow();
  });
});

describe('MediaAssetStatusSchema', () => {
  it.each([
    'awaiting_upload',
    'uploaded',
    'scanning',
    'ready',
    'rejected',
    'failed',
    'expired',
  ] as const)('accepts %s', (value) => {
    expect(MediaAssetStatusSchema.parse(value)).toBe(value);
  });

  it('rejects an unknown status', () => {
    expect(() => MediaAssetStatusSchema.parse('lost')).toThrow();
  });
});

describe('MediaScanStatusSchema', () => {
  it.each(['pending', 'clean', 'infected', 'failed'] as const)('accepts %s', (value) => {
    expect(MediaScanStatusSchema.parse(value)).toBe(value);
  });
});

describe('MediaOwnerScopeKindSchema', () => {
  it.each(['user', 'household', 'senior', 'provider', 'course'] as const)('accepts %s', (value) => {
    expect(MediaOwnerScopeKindSchema.parse(value)).toBe(value);
  });

  it('rejects an unknown scope kind', () => {
    expect(() => MediaOwnerScopeKindSchema.parse('partner')).toThrow();
  });
});

describe('MediaAssetEventKindSchema', () => {
  it.each([
    'upload_completed',
    'magic_byte_passed',
    'magic_byte_failed',
    'scan_passed',
    'scan_failed',
    'process_passed',
    'process_failed',
    'expired',
  ] as const)('accepts %s', (value) => {
    expect(MediaAssetEventKindSchema.parse(value)).toBe(value);
  });
});

describe('IssueUploadUrlRequestSchema', () => {
  const valid = {
    kind: 'senior_photo' as const,
    declaredMime: 'image/jpeg',
    declaredSizeBytes: 1024,
    declaredFileName: 'grandma.jpg',
    ownerScope: { kind: 'household' as const, id: 'hh_abc' },
  };

  it('accepts a valid body', () => {
    const parsed = IssueUploadUrlRequestSchema.parse(valid);
    expect(parsed.kind).toBe('senior_photo');
    expect(parsed.ownerScope.id).toBe('hh_abc');
  });

  it('accepts a body without declaredFileName (optional)', () => {
    const parsed = IssueUploadUrlRequestSchema.parse({
      ...valid,
      declaredFileName: undefined,
    });
    expect(parsed.declaredFileName).toBeUndefined();
  });

  it('rejects an unknown extra field', () => {
    expect(() => IssueUploadUrlRequestSchema.parse({ ...valid, extra: 'no' })).toThrow();
  });

  it('rejects a non-IANA MIME shape', () => {
    expect(() => IssueUploadUrlRequestSchema.parse({ ...valid, declaredMime: 'jpeg' })).toThrow();
  });

  it('rejects a zero declared size', () => {
    expect(() => IssueUploadUrlRequestSchema.parse({ ...valid, declaredSizeBytes: 0 })).toThrow();
  });

  it('rejects a declared size above the cap', () => {
    expect(() =>
      IssueUploadUrlRequestSchema.parse({
        ...valid,
        declaredSizeBytes: MEDIA_MAX_SIZE_BYTES + 1,
      }),
    ).toThrow();
  });

  it('rejects a non-integer declared size', () => {
    expect(() =>
      IssueUploadUrlRequestSchema.parse({ ...valid, declaredSizeBytes: 12.5 }),
    ).toThrow();
  });

  it('rejects a missing owner scope', () => {
    const { ownerScope: _scope, ...rest } = valid;
    expect(() => IssueUploadUrlRequestSchema.parse(rest)).toThrow();
  });
});

describe('IssueUploadUrlResponseSchema', () => {
  const valid = {
    asset: buildAsset(),
    uploadUrl: 'https://stub-uploads.tasteandsee.example.com/asset_abc?sig=x',
    uploadMethod: 'PUT' as const,
    requiredHeaders: { 'content-type': 'image/jpeg' },
    expiresAt: ISO_NOW,
    liveMode: false,
  };

  it('accepts a valid body', () => {
    expect(IssueUploadUrlResponseSchema.parse(valid)).toMatchObject({
      uploadMethod: 'PUT',
      liveMode: false,
    });
  });

  it('rejects a missing required headers map', () => {
    const { requiredHeaders: _rh, ...rest } = valid;
    expect(() => IssueUploadUrlResponseSchema.parse(rest)).toThrow();
  });

  it('rejects a non-https-shaped upload URL', () => {
    expect(() =>
      IssueUploadUrlResponseSchema.parse({ ...valid, uploadUrl: 'not-a-url' }),
    ).toThrow();
  });

  it('rejects when required headers exceed the cap', () => {
    const tooMany: Record<string, string> = {};
    for (let i = 0; i <= MEDIA_REQUIRED_HEADERS_MAX; i++) tooMany[`h${i}`] = 'v';
    expect(() =>
      IssueUploadUrlResponseSchema.parse({ ...valid, requiredHeaders: tooMany }),
    ).toThrow();
  });
});

describe('MediaAssetResponseSchema', () => {
  it('accepts a default-shaped asset', () => {
    expect(MediaAssetResponseSchema.parse(buildAsset())).toMatchObject({
      status: 'awaiting_upload',
      scanStatus: 'pending',
    });
  });

  it('accepts a ready-shaped asset (delivery URL non-null)', () => {
    expect(
      MediaAssetResponseSchema.parse(
        buildAsset({
          status: 'ready',
          scanStatus: 'clean',
          detectedMime: 'image/jpeg',
          actualSizeBytes: 1024,
          width: 800,
          height: 600,
          sha256: SHA256_HEX,
          deliveryKey: 'dev/senior_photo/2026/05/asset_abc.webp',
          signedDeliveryUrl: 'https://stub-delivery.tasteandsee.example.com/asset_abc',
          signedDeliveryUrlExpiresAt: ISO_NOW,
          uploadedAt: ISO_NOW,
          scannedAt: ISO_NOW,
          processedAt: ISO_NOW,
        }),
      ).status,
    ).toBe('ready');
  });

  it('rejects a non-hex sha256', () => {
    expect(() => MediaAssetResponseSchema.parse(buildAsset({ sha256: 'NOT-HEX' }))).toThrow();
  });

  it('rejects a uppercase mime type', () => {
    expect(() =>
      MediaAssetResponseSchema.parse(buildAsset({ declaredMime: 'IMAGE-NO-SLASH' })),
    ).toThrow();
  });

  it('rejects an unknown extra field', () => {
    expect(() => MediaAssetResponseSchema.parse(buildAsset({ secret: 'no' }))).toThrow();
  });
});

describe('RecordAssetEventRequestSchema', () => {
  const valid = {
    assetId: 'asset_abc',
    eventKind: 'upload_completed' as const,
    occurredAt: ISO_NOW,
  };

  it('accepts a minimal upload_completed event', () => {
    expect(RecordAssetEventRequestSchema.parse(valid)).toMatchObject({
      assetId: 'asset_abc',
      eventKind: 'upload_completed',
    });
  });

  it('accepts a magic_byte_passed with detected MIME + sha256 + size', () => {
    const parsed = RecordAssetEventRequestSchema.parse({
      ...valid,
      eventKind: 'magic_byte_passed',
      detectedMime: 'image/jpeg',
      sha256: SHA256_HEX,
      sizeBytes: 1024,
    });
    expect(parsed.detectedMime).toBe('image/jpeg');
    expect(parsed.sha256).toBe(SHA256_HEX);
  });

  it('accepts a scan_failed with reason', () => {
    expect(
      RecordAssetEventRequestSchema.parse({
        ...valid,
        eventKind: 'scan_failed',
        reason: 'Eicar.Test.File',
      }).reason,
    ).toBe('Eicar.Test.File');
  });

  it('rejects an unknown extra field', () => {
    expect(() => RecordAssetEventRequestSchema.parse({ ...valid, extra: 'no' })).toThrow();
  });
});

describe('RecordAssetEventResponseSchema', () => {
  it('accepts applied | replayed', () => {
    expect(
      RecordAssetEventResponseSchema.parse({
        outcome: 'applied',
        asset: buildAsset(),
      }).outcome,
    ).toBe('applied');
    expect(
      RecordAssetEventResponseSchema.parse({
        outcome: 'replayed',
        asset: buildAsset(),
      }).outcome,
    ).toBe('replayed');
  });

  it('rejects an unknown outcome', () => {
    expect(() =>
      RecordAssetEventResponseSchema.parse({
        outcome: 'pending',
        asset: buildAsset(),
      }),
    ).toThrow();
  });
});

describe('ListMediaAssetsQuerySchema', () => {
  it('applies the default limit', () => {
    expect(ListMediaAssetsQuerySchema.parse({}).limit).toBe(MEDIA_LIST_LIMIT_DEFAULT);
  });

  it('clamps via the max', () => {
    expect(() => ListMediaAssetsQuerySchema.parse({ limit: MEDIA_LIST_LIMIT_MAX + 1 })).toThrow();
  });

  it('coerces a string limit', () => {
    expect(ListMediaAssetsQuerySchema.parse({ limit: '25' }).limit).toBe(25);
  });

  it('accepts kind + status + owner filters', () => {
    const parsed = ListMediaAssetsQuerySchema.parse({
      kind: 'memory_recipe_image',
      status: 'ready',
      ownerScopeKind: 'household',
      ownerScopeId: 'hh_abc',
    });
    expect(parsed.kind).toBe('memory_recipe_image');
    expect(parsed.ownerScopeId).toBe('hh_abc');
  });
});

describe('MediaAssetsListResponseSchema', () => {
  it('accepts an empty list', () => {
    expect(MediaAssetsListResponseSchema.parse({ rows: [], nextCursor: null }).rows).toEqual([]);
  });

  it('accepts a single-row list', () => {
    expect(
      MediaAssetsListResponseSchema.parse({
        rows: [buildAsset()],
        nextCursor: null,
      }).rows,
    ).toHaveLength(1);
  });
});

describe('the assetKey seam (TS-282-followup-5a)', () => {
  const LEGACY_KEY = `s3://media-bucket/${'a'.repeat(120)}/original.jpg`;

  it('accepts a media asset id', () => {
    expect(MediaAssetKeySchema.safeParse('clx0k9f3a0000abcdefghijkl').success).toBe(true);
  });

  it('REJECTS a storage key on the write path', () => {
    // The storage key is an internal detail of the bucket layout: it changes
    // when the layout changes, it is meaningless without the bucket, and
    // `GET /api/v1/media/assets/{id}` cannot look one up. Three services used
    // to accept one here.
    expect(MediaAssetKeySchema.safeParse(LEGACY_KEY).success).toBe(false);
  });

  it('is bounded by the media id length, not by three different local caps', () => {
    // The three consumers declared 512 / 256 / 256 against a real media id's
    // 64. That disagreement is what proved nobody was validating anything.
    expect(MediaAssetKeySchema.safeParse('a'.repeat(MEDIA_ID_MAX_LENGTH)).success).toBe(true);
    expect(MediaAssetKeySchema.safeParse('a'.repeat(MEDIA_ID_MAX_LENGTH + 1)).success).toBe(false);
  });

  it('rejects an empty or whitespace-only key rather than storing a blank reference', () => {
    expect(MediaAssetKeySchema.safeParse('').success).toBe(false);
    expect(MediaAssetKeySchema.safeParse('   ').success).toBe(false);
  });

  it('READ shapes stay permissive, and that asymmetry is the migration', () => {
    // A row written before the convention landed may carry free text that was
    // never an id. Tightening the READ path would turn such a row into a
    // gateway 502 on a page that renders fine today — a stricter schema
    // breaking production. Expand → migrate → contract (CLAUDE.md §4.1).
    expect(StoredMediaAssetKeySchema.safeParse(LEGACY_KEY).success).toBe(true);
    expect(MediaAssetKeySchema.safeParse(LEGACY_KEY).success).toBe(false);
  });
});

// ─── Admin preview resolution (TS-282-followup-5b) ──────────────────────────────

describe('isAdminPreviewableMediaKind', () => {
  it('refuses household-private imagery', () => {
    // A senior's photograph is consent-gated (CLAUDE.md §12) and a memory
    // recipe card is a family's own artwork. `media:read` is held by marketing
    // and content editors; the permission alone is not the control.
    expect(isAdminPreviewableMediaKind('senior_photo')).toBe(false);
    expect(isAdminPreviewableMediaKind('memory_recipe_image')).toBe(false);
  });

  it('refuses statutory and identity evidence', () => {
    // TS-305a deliberately keeps the Checkr handles and the AES-GCM payload in
    // the database on the dossier read path. A resolution endpoint that minted
    // a signed URL for a government ID by id would undo that.
    expect(isAdminPreviewableMediaKind('provider_document')).toBe(false);
    expect(isAdminPreviewableMediaKind('certification_evidence')).toBe(false);
  });

  it('allows collateral the customer surface already shows', () => {
    expect(isAdminPreviewableMediaKind('provider_profile_photo')).toBe(true);
    expect(isAdminPreviewableMediaKind('provider_video_intro')).toBe(true);
    expect(isAdminPreviewableMediaKind('academy_lesson_attachment')).toBe(true);
  });

  it('has an answer for every kind the enum declares', () => {
    // The switch is exhaustive, so this passing today is not the interesting
    // part — the interesting part is that adding a kind without deciding its
    // side of the line does not compile. TS-282-followup-5d adds the editorial
    // kinds; this is the assertion that makes that decision unavoidable.
    for (const kind of MediaAssetKindSchema.options) {
      expect(typeof isAdminPreviewableMediaKind(kind)).toBe('boolean');
    }
  });
});

describe('ResolveMediaAssetsQuerySchema', () => {
  it('accepts a single id as a bare string (Express gives one param unwrapped)', () => {
    const parsed = ResolveMediaAssetsQuerySchema.safeParse({ id: 'asset_abc' });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.id).toEqual(['asset_abc']);
  });

  it('accepts repeated ids as an array', () => {
    const parsed = ResolveMediaAssetsQuerySchema.safeParse({ id: ['a', 'b'] });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.id).toEqual(['a', 'b']);
  });

  it('keeps a comma-bearing legacy key intact rather than splitting it', () => {
    // Repeated params exist precisely so a delimiter cannot mangle one bad
    // key into two bogus ones and lose the value the response echoes back.
    // A legacy assetKey is unvalidated free text and may contain anything.
    const legacy = 'uploads/2026/05, final.png';
    const parsed = ResolveMediaAssetsQuerySchema.safeParse({ id: legacy });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.id).toEqual([legacy]);
  });

  it('rejects an empty request and one over the fan-out ceiling', () => {
    expect(ResolveMediaAssetsQuerySchema.safeParse({ id: [] }).success).toBe(false);
    expect(ResolveMediaAssetsQuerySchema.safeParse({}).success).toBe(false);
    const tooMany = Array.from({ length: ADMIN_MEDIA_RESOLVE_MAX + 1 }, (_, i) => `a${i}`);
    expect(ResolveMediaAssetsQuerySchema.safeParse({ id: tooMany }).success).toBe(false);
  });

  it('rejects an unknown query parameter', () => {
    expect(
      ResolveMediaAssetsQuerySchema.safeParse({ id: 'a', includeStorageKey: 'true' }).success,
    ).toBe(false);
  });
});

describe('ResolvedMediaAssetSchema', () => {
  const READY = {
    outcome: 'ready',
    assetKey: 'asset_abc',
    signedUrl: 'https://stub-delivery.tasteandsee.example.com/x?sig=y',
    expiresAt: ISO_NOW,
    mime: 'image/webp',
    width: 1200,
    height: 628,
    fileName: 'banner.webp',
    sizeBytes: 48_000,
  } as const;

  it('accepts a ready asset', () => {
    expect(ResolvedMediaAssetSchema.safeParse(READY).success).toBe(true);
  });

  it('never carries the storage layout or the owner', () => {
    // TS-282-followup-5a refused to put media-svc's storage key into three
    // other services' contracts because it exports one service's filesystem to
    // the platform. Handing bucket / key / owner ids to a browser-facing app to
    // draw a picture is the same mistake.
    for (const leak of [
      { storageBucket: 'media-bucket' },
      { storageKey: 'uploads/2026/05/asset_abc.webp' },
      { deliveryKey: 'delivery/asset_abc.webp' },
      { sha256: SHA256_HEX },
      { ownerUserId: 'user_1' },
      { ownerScopeId: 'household_1' },
    ]) {
      expect(ResolvedMediaAssetSchema.safeParse({ ...READY, ...leak }).success).toBe(false);
    }
  });

  it('distinguishes the four non-renderable outcomes', () => {
    // Rendering nothing, for any reason, without saying which reason is the
    // defect this endpoint exists to fix, in a nicer typeface.
    expect(
      ResolvedMediaAssetSchema.safeParse({
        outcome: 'not_ready',
        assetKey: 'asset_abc',
        status: 'rejected',
      }).success,
    ).toBe(true);
    expect(
      ResolvedMediaAssetSchema.safeParse({ outcome: 'not_found', assetKey: 'asset_abc' }).success,
    ).toBe(true);
    expect(
      ResolvedMediaAssetSchema.safeParse({ outcome: 'restricted', assetKey: 'asset_abc' }).success,
    ).toBe(true);
    expect(
      ResolvedMediaAssetSchema.safeParse({ outcome: 'unavailable', assetKey: 'asset_abc' }).success,
    ).toBe(true);
  });

  it('does not name the kind on a restricted asset', () => {
    // The operator needs to know it is a policy refusal rather than a broken
    // link. They do not need to learn that a given id is a senior's photograph.
    expect(
      ResolvedMediaAssetSchema.safeParse({
        outcome: 'restricted',
        assetKey: 'asset_abc',
        kind: 'senior_photo',
      }).success,
    ).toBe(false);
  });

  it('carries the lifecycle status on not_ready, because the statuses differ', () => {
    // "We rejected these bytes" and "we have not looked at them yet" are
    // different answers to a reviewer deciding whether to bounce a creative.
    expect(
      ResolvedMediaAssetSchema.safeParse({
        outcome: 'not_ready',
        assetKey: 'asset_abc',
        status: 'scanning',
      }).success,
    ).toBe(true);
    expect(
      ResolvedMediaAssetSchema.safeParse({ outcome: 'not_ready', assetKey: 'asset_abc' }).success,
    ).toBe(false);
  });

  it('accepts a legacy free-text key on every outcome', () => {
    // The keys stored today predate the TS-282-followup-5a convention. If the
    // resolution response could not echo one back, the not_found answer this
    // surface most needs to give would be a 502 instead.
    const legacy = 'a'.repeat(300);
    expect(
      ResolvedMediaAssetSchema.safeParse({ outcome: 'not_found', assetKey: legacy }).success,
    ).toBe(true);
  });
});

describe('ResolveMediaAssetsResponseSchema', () => {
  it('is bounded by the same ceiling as the query', () => {
    const rows = Array.from({ length: ADMIN_MEDIA_RESOLVE_MAX }, (_, i) => ({
      outcome: 'not_found' as const,
      assetKey: `asset_${i}`,
    }));
    expect(ResolveMediaAssetsResponseSchema.safeParse({ assets: rows }).success).toBe(true);
    expect(
      ResolveMediaAssetsResponseSchema.safeParse({
        assets: [...rows, { outcome: 'not_found', assetKey: 'overflow' }],
      }).success,
    ).toBe(false);
  });

  it('rejects an unknown envelope field', () => {
    expect(
      ResolveMediaAssetsResponseSchema.safeParse({ assets: [], nextCursor: null }).success,
    ).toBe(false);
  });
});
