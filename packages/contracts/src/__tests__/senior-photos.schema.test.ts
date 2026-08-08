import { describe, expect, it } from 'vitest';

import {
  FamilySeniorPhotoGalleryResponseSchema,
  SENIOR_PHOTO_GALLERY_LIMIT_DEFAULT,
  SENIOR_PHOTO_GALLERY_LIMIT_MAX,
  SeniorPhotoGalleryQuerySchema,
  SeniorPhotoGalleryResponseSchema,
  SeniorPhotoSchema,
} from '../http/senior-photos.schema';

/**
 * Contract tests for the TS-232 consent-gated senior photo-gallery DTOs.
 */
describe('SeniorPhotoSchema', () => {
  const base = {
    id: 'm_abc123',
    signedDeliveryUrl: 'https://stub-delivery.tasteandsee.example.com/senior_photo/m_abc123?sig=x',
    signedDeliveryUrlExpiresAt: '2026-05-27T12:05:00.000Z',
    width: 1600,
    height: 1200,
    declaredFileName: 'grandma-birthday.jpg',
    createdAt: '2026-05-27T12:00:00.000Z',
  };

  it('accepts a fully-populated photo', () => {
    expect(SeniorPhotoSchema.parse(base)).toEqual(base);
  });

  it('accepts null dimensions + null file name (pre-Sharp / no name supplied)', () => {
    const parsed = SeniorPhotoSchema.parse({
      ...base,
      width: null,
      height: null,
      declaredFileName: null,
    });
    expect(parsed.width).toBeNull();
    expect(parsed.height).toBeNull();
    expect(parsed.declaredFileName).toBeNull();
  });

  it('requires a valid URL delivery link', () => {
    expect(SeniorPhotoSchema.safeParse({ ...base, signedDeliveryUrl: 'not-a-url' }).success).toBe(
      false,
    );
  });

  it('rejects a non-datetime createdAt', () => {
    expect(SeniorPhotoSchema.safeParse({ ...base, createdAt: 'today' }).success).toBe(false);
  });

  it('rejects a zero / negative dimension', () => {
    expect(SeniorPhotoSchema.safeParse({ ...base, width: 0 }).success).toBe(false);
    expect(SeniorPhotoSchema.safeParse({ ...base, height: -1 }).success).toBe(false);
  });

  it('does NOT carry the media-asset internal fields', () => {
    const shape = SeniorPhotoSchema.shape;
    for (const internal of ['ownerUserId', 'storageKey', 'storageBucket', 'sha256', 'scanStatus']) {
      expect(internal in shape).toBe(false);
    }
  });

  it('rejects unknown fields (.strict)', () => {
    expect(SeniorPhotoSchema.safeParse({ ...base, storageKey: 'leak' }).success).toBe(false);
  });
});

describe('SeniorPhotoGalleryQuerySchema', () => {
  it('defaults limit when omitted', () => {
    const parsed = SeniorPhotoGalleryQuerySchema.parse({});
    expect(parsed.limit).toBe(SENIOR_PHOTO_GALLERY_LIMIT_DEFAULT);
    expect(parsed.cursor).toBeUndefined();
  });

  it('coerces a string limit from the query string', () => {
    expect(SeniorPhotoGalleryQuerySchema.parse({ limit: '12' }).limit).toBe(12);
  });

  it('rejects a limit over the max', () => {
    expect(
      SeniorPhotoGalleryQuerySchema.safeParse({ limit: SENIOR_PHOTO_GALLERY_LIMIT_MAX + 1 })
        .success,
    ).toBe(false);
  });

  it('rejects a non-positive limit', () => {
    expect(SeniorPhotoGalleryQuerySchema.safeParse({ limit: 0 }).success).toBe(false);
  });

  it('accepts an opaque cursor', () => {
    expect(SeniorPhotoGalleryQuerySchema.parse({ cursor: 'abc' }).cursor).toBe('abc');
  });

  it('rejects unknown fields (.strict)', () => {
    expect(SeniorPhotoGalleryQuerySchema.safeParse({ limit: 10, foo: 1 }).success).toBe(false);
  });
});

describe('SeniorPhotoGalleryResponseSchema (media-svc)', () => {
  const photo = {
    id: 'm_abc123',
    signedDeliveryUrl: 'https://stub-delivery.tasteandsee.example.com/x?sig=y',
    signedDeliveryUrlExpiresAt: '2026-05-27T12:05:00.000Z',
    width: 800,
    height: 600,
    declaredFileName: null,
    createdAt: '2026-05-27T12:00:00.000Z',
  };

  it('accepts a populated page with a next cursor', () => {
    const parsed = SeniorPhotoGalleryResponseSchema.parse({
      seniorId: 'senior_abc',
      photos: [photo],
      nextCursor: 'cursor-1',
    });
    expect(parsed.photos).toHaveLength(1);
    expect(parsed.nextCursor).toBe('cursor-1');
  });

  it('accepts an empty page with a null cursor', () => {
    const parsed = SeniorPhotoGalleryResponseSchema.parse({
      seniorId: 'senior_abc',
      photos: [],
      nextCursor: null,
    });
    expect(parsed.photos).toEqual([]);
    expect(parsed.nextCursor).toBeNull();
  });

  it('has no `shared` flag (that is the gateway-only field)', () => {
    expect('shared' in SeniorPhotoGalleryResponseSchema.shape).toBe(false);
  });

  it('rejects unknown fields (.strict)', () => {
    expect(
      SeniorPhotoGalleryResponseSchema.safeParse({
        seniorId: 'senior_abc',
        photos: [],
        nextCursor: null,
        shared: true,
      }).success,
    ).toBe(false);
  });
});

describe('FamilySeniorPhotoGalleryResponseSchema (gateway)', () => {
  const base = {
    seniorId: 'senior_abc',
    shared: true,
    photos: [],
    nextCursor: null,
  };

  it('accepts the shared shape', () => {
    expect(FamilySeniorPhotoGalleryResponseSchema.parse(base)).toEqual(base);
  });

  it('accepts the not-shared empty shape', () => {
    const parsed = FamilySeniorPhotoGalleryResponseSchema.parse({ ...base, shared: false });
    expect(parsed.shared).toBe(false);
    expect(parsed.photos).toEqual([]);
  });

  it('requires the shared flag', () => {
    const { shared: _omit, ...withoutShared } = base;
    expect(FamilySeniorPhotoGalleryResponseSchema.safeParse(withoutShared).success).toBe(false);
  });

  it('rejects unknown fields (.strict)', () => {
    expect(FamilySeniorPhotoGalleryResponseSchema.safeParse({ ...base, extra: 1 }).success).toBe(
      false,
    );
  });
});
