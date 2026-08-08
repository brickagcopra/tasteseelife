import { describe, expect, it } from 'vitest';

import type { CreateFavoriteProviderRequest, FavoriteProvider } from '../http';
import {
  CreateFavoriteProviderRequestSchema,
  CreateFavoriteProviderResponseSchema,
  DeleteFavoriteProviderResponseSchema,
  FAVORITE_PROVIDER_ID_MAX_LENGTH,
  FAVORITE_PROVIDER_NOTES_MAX_LENGTH,
  FAVORITE_PROVIDER_PROVIDER_ID_MAX_LENGTH,
  FAVORITE_PROVIDER_SENIOR_ID_MAX_LENGTH,
  FAVORITE_PROVIDERS_MAX_PER_OWNER,
  FavoriteProviderSchema,
  FavoriteProvidersListResponseSchema,
} from '../http';

const sampleFavorite: FavoriteProvider = {
  id: 'fp_abc',
  ownerUserId: 'user_payer',
  providerId: 'provider_chef',
  seniorId: 'senior_mom',
  notes: 'Loved the carbonara at the trial visit.',
  createdAt: '2026-05-21T12:00:00.000Z',
};

describe('FAVORITE_PROVIDER constants', () => {
  it('exports sensible caps', () => {
    expect(FAVORITE_PROVIDER_ID_MAX_LENGTH).toBeGreaterThanOrEqual(24);
    expect(FAVORITE_PROVIDER_PROVIDER_ID_MAX_LENGTH).toBeGreaterThanOrEqual(24);
    expect(FAVORITE_PROVIDER_SENIOR_ID_MAX_LENGTH).toBeGreaterThanOrEqual(24);
    expect(FAVORITE_PROVIDER_NOTES_MAX_LENGTH).toBeGreaterThanOrEqual(100);
    expect(FAVORITE_PROVIDERS_MAX_PER_OWNER).toBeGreaterThanOrEqual(50);
  });
});

describe('FavoriteProviderSchema', () => {
  it('accepts the canonical sample', () => {
    expect(FavoriteProviderSchema.safeParse(sampleFavorite).success).toBe(true);
  });

  it('accepts null seniorId and null notes', () => {
    expect(
      FavoriteProviderSchema.safeParse({
        ...sampleFavorite,
        seniorId: null,
        notes: null,
      }).success,
    ).toBe(true);
  });

  it('rejects unknown fields', () => {
    expect(FavoriteProviderSchema.safeParse({ ...sampleFavorite, bogus: true }).success).toBe(
      false,
    );
  });

  it('rejects empty providerId', () => {
    expect(FavoriteProviderSchema.safeParse({ ...sampleFavorite, providerId: '' }).success).toBe(
      false,
    );
  });

  it('rejects empty ownerUserId', () => {
    expect(FavoriteProviderSchema.safeParse({ ...sampleFavorite, ownerUserId: '' }).success).toBe(
      false,
    );
  });

  it('rejects notes longer than the cap', () => {
    expect(
      FavoriteProviderSchema.safeParse({
        ...sampleFavorite,
        notes: 'x'.repeat(FAVORITE_PROVIDER_NOTES_MAX_LENGTH + 1),
      }).success,
    ).toBe(false);
  });
});

describe('CreateFavoriteProviderRequestSchema', () => {
  const valid: CreateFavoriteProviderRequest = {
    providerId: 'provider_chef',
    seniorId: 'senior_mom',
    notes: 'Loved the carbonara.',
  };

  it('accepts a valid request', () => {
    expect(CreateFavoriteProviderRequestSchema.safeParse(valid).success).toBe(true);
  });

  it('accepts a minimal request (just providerId)', () => {
    expect(
      CreateFavoriteProviderRequestSchema.safeParse({ providerId: 'provider_chef' }).success,
    ).toBe(true);
  });

  it('accepts null seniorId and null notes', () => {
    expect(
      CreateFavoriteProviderRequestSchema.safeParse({
        ...valid,
        seniorId: null,
        notes: null,
      }).success,
    ).toBe(true);
  });

  it('rejects an ownerUserId in the body (server-derived)', () => {
    expect(
      CreateFavoriteProviderRequestSchema.safeParse({
        ...valid,
        ownerUserId: 'user_other',
      }).success,
    ).toBe(false);
  });

  it('rejects missing providerId', () => {
    const { providerId: _unused, ...rest } = valid;
    void _unused;
    expect(CreateFavoriteProviderRequestSchema.safeParse(rest).success).toBe(false);
  });

  it('rejects an empty-string notes (use null to clear)', () => {
    expect(CreateFavoriteProviderRequestSchema.safeParse({ ...valid, notes: '' }).success).toBe(
      false,
    );
  });
});

describe('CreateFavoriteProviderResponseSchema', () => {
  it('accepts the three outcomes', () => {
    for (const outcome of ['created', 'updated', 'unchanged'] as const) {
      expect(
        CreateFavoriteProviderResponseSchema.safeParse({
          outcome,
          favorite: sampleFavorite,
        }).success,
      ).toBe(true);
    }
  });

  it('rejects unknown outcomes', () => {
    expect(
      CreateFavoriteProviderResponseSchema.safeParse({
        outcome: 'wat',
        favorite: sampleFavorite,
      }).success,
    ).toBe(false);
  });
});

describe('FavoriteProvidersListResponseSchema', () => {
  it('accepts an empty list', () => {
    expect(FavoriteProvidersListResponseSchema.safeParse({ favorites: [] }).success).toBe(true);
  });

  it('accepts a list of valid rows', () => {
    expect(
      FavoriteProvidersListResponseSchema.safeParse({
        favorites: [sampleFavorite],
      }).success,
    ).toBe(true);
  });

  it('rejects an unwrapped array', () => {
    expect(FavoriteProvidersListResponseSchema.safeParse([sampleFavorite]).success).toBe(false);
  });
});

describe('DeleteFavoriteProviderResponseSchema', () => {
  it('accepts the deleted outcome', () => {
    expect(
      DeleteFavoriteProviderResponseSchema.safeParse({
        outcome: 'deleted',
        id: 'fp_abc',
      }).success,
    ).toBe(true);
  });

  it('accepts the not_found outcome', () => {
    expect(
      DeleteFavoriteProviderResponseSchema.safeParse({
        outcome: 'not_found',
        id: 'fp_abc',
      }).success,
    ).toBe(true);
  });

  it('rejects unknown outcomes', () => {
    expect(
      DeleteFavoriteProviderResponseSchema.safeParse({
        outcome: 'wat',
        id: 'fp_abc',
      }).success,
    ).toBe(false);
  });
});
