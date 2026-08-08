import { describe, expect, it } from 'vitest';

import {
  PROVIDER_PROFILE_TAG_KIND_CUISINE,
  PROVIDER_PROFILE_TAG_KIND_DIETARY_EXPERTISE,
  PROVIDER_PROFILE_TAG_KIND_LANGUAGE,
  PROVIDER_PROFILE_TAG_MAX_LENGTH,
  PROVIDER_PROFILE_TAGS_MAX_PER_KIND,
  ProviderProfileRecordSchema,
  ProviderProfileTagKindSchema,
  UpdateProviderProfileRequestSchema,
  UpdateProviderProfileResponseSchema,
} from '../http/provider-profile.schema';

const NOW = '2026-05-20T12:00:00.000Z';

const VALID_PROFILE = {
  id: 'prov_abc',
  status: 'active' as const,
  tier: 'certified' as const,
  displayName: 'Chef Sam',
  headline: 'Comfort food specialist',
  bio: 'Cooking for families since 2010.',
  profilePhotoKey: 'media/photo.webp',
  videoIntroKey: null,
  timeZone: 'America/New_York',
  dementiaSensitive: true,
  languages: ['en', 'es'],
  cuisines: ['italian', 'jewish-deli'],
  dietaryExpertise: ['low-sodium', 'diabetic-friendly'],
  createdAt: NOW,
  updatedAt: NOW,
};

const VALID_REQUEST = {
  bio: 'Cooking for families since 2010.',
  languages: ['en', 'es'],
  cuisines: ['italian'],
  dietaryExpertise: ['low-sodium', 'kosher'],
  dementiaSensitive: true,
};

describe('ProviderProfileTagKindSchema', () => {
  it('accepts every supported kind literal', () => {
    for (const kind of [
      PROVIDER_PROFILE_TAG_KIND_LANGUAGE,
      PROVIDER_PROFILE_TAG_KIND_CUISINE,
      PROVIDER_PROFILE_TAG_KIND_DIETARY_EXPERTISE,
    ]) {
      expect(ProviderProfileTagKindSchema.safeParse(kind).success).toBe(true);
    }
  });

  it('rejects unknown kinds', () => {
    expect(ProviderProfileTagKindSchema.safeParse('specialty').success).toBe(false);
    expect(ProviderProfileTagKindSchema.safeParse('').success).toBe(false);
  });
});

describe('UpdateProviderProfileRequestSchema', () => {
  it('accepts a valid request', () => {
    expect(UpdateProviderProfileRequestSchema.safeParse(VALID_REQUEST).success).toBe(true);
  });

  it('accepts `bio: null` (clear-bio path)', () => {
    expect(
      UpdateProviderProfileRequestSchema.safeParse({ ...VALID_REQUEST, bio: null }).success,
    ).toBe(true);
  });

  it('accepts empty tag arrays (clear-tags-of-kind path)', () => {
    expect(
      UpdateProviderProfileRequestSchema.safeParse({
        ...VALID_REQUEST,
        languages: [],
        cuisines: [],
        dietaryExpertise: [],
      }).success,
    ).toBe(true);
  });

  it('rejects unknown fields (`.strict()`)', () => {
    const result = UpdateProviderProfileRequestSchema.safeParse({
      ...VALID_REQUEST,
      headline: 'attempt to update via tag endpoint',
    });
    expect(result.success).toBe(false);
  });

  it('rejects missing required fields', () => {
    const { dementiaSensitive: _, ...rest } = VALID_REQUEST;
    expect(UpdateProviderProfileRequestSchema.safeParse(rest).success).toBe(false);
  });

  it('rejects an empty tag inside an array', () => {
    expect(
      UpdateProviderProfileRequestSchema.safeParse({
        ...VALID_REQUEST,
        languages: ['en', ''],
      }).success,
    ).toBe(false);
  });

  it('rejects tags violating the regex (uppercase, spaces, punctuation)', () => {
    for (const bad of ['English', 'low sodium', 'gluten/free', '-leading-hyphen']) {
      expect(
        UpdateProviderProfileRequestSchema.safeParse({
          ...VALID_REQUEST,
          cuisines: [bad],
        }).success,
        `expected to reject: ${bad}`,
      ).toBe(false);
    }
  });

  it('accepts tags right at the length cap', () => {
    const tag = 'a'.repeat(PROVIDER_PROFILE_TAG_MAX_LENGTH);
    expect(
      UpdateProviderProfileRequestSchema.safeParse({
        ...VALID_REQUEST,
        cuisines: [tag],
      }).success,
    ).toBe(true);
  });

  it('rejects tags exceeding the length cap', () => {
    const tag = 'a'.repeat(PROVIDER_PROFILE_TAG_MAX_LENGTH + 1);
    expect(
      UpdateProviderProfileRequestSchema.safeParse({
        ...VALID_REQUEST,
        cuisines: [tag],
      }).success,
    ).toBe(false);
  });

  it('rejects tag arrays exceeding the per-kind count cap', () => {
    const tags = Array.from(
      { length: PROVIDER_PROFILE_TAGS_MAX_PER_KIND + 1 },
      (_, i) => `tag-${i}`,
    );
    expect(
      UpdateProviderProfileRequestSchema.safeParse({
        ...VALID_REQUEST,
        cuisines: tags,
      }).success,
    ).toBe(false);
  });

  it('rejects duplicate tags inside a single kind', () => {
    expect(
      UpdateProviderProfileRequestSchema.safeParse({
        ...VALID_REQUEST,
        languages: ['en', 'en'],
      }).success,
    ).toBe(false);
  });

  it('accepts the same tag value across different kinds', () => {
    // `kosher` could plausibly appear as both a cuisine and a dietary
    // expertise; the de-dupe rule scopes to per-kind, not per-row.
    expect(
      UpdateProviderProfileRequestSchema.safeParse({
        ...VALID_REQUEST,
        cuisines: ['kosher'],
        dietaryExpertise: ['kosher'],
      }).success,
    ).toBe(true);
  });
});

describe('ProviderProfileRecordSchema', () => {
  it('accepts a valid record', () => {
    expect(ProviderProfileRecordSchema.safeParse(VALID_PROFILE).success).toBe(true);
  });

  it('accepts nullable scalar fields set to null', () => {
    expect(
      ProviderProfileRecordSchema.safeParse({
        ...VALID_PROFILE,
        headline: null,
        bio: null,
        profilePhotoKey: null,
        videoIntroKey: null,
      }).success,
    ).toBe(true);
  });

  it('rejects unknown fields (`.strict()`)', () => {
    expect(ProviderProfileRecordSchema.safeParse({ ...VALID_PROFILE, extra: 'oops' }).success).toBe(
      false,
    );
  });

  it('rejects missing dementiaSensitive flag (additive field must be present)', () => {
    const { dementiaSensitive: _, ...rest } = VALID_PROFILE;
    expect(ProviderProfileRecordSchema.safeParse(rest).success).toBe(false);
  });
});

describe('UpdateProviderProfileResponseSchema', () => {
  it('wraps the record in `{ profile: ... }`', () => {
    expect(UpdateProviderProfileResponseSchema.safeParse({ profile: VALID_PROFILE }).success).toBe(
      true,
    );
  });

  it('rejects an unwrapped record', () => {
    expect(UpdateProviderProfileResponseSchema.safeParse(VALID_PROFILE).success).toBe(false);
  });

  it('rejects unknown top-level fields (`.strict()`)', () => {
    expect(
      UpdateProviderProfileResponseSchema.safeParse({
        profile: VALID_PROFILE,
        snapshot: { foo: 1 },
      }).success,
    ).toBe(false);
  });
});
