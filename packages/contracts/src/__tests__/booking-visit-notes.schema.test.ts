import { describe, expect, it } from 'vitest';

import {
  UpsertVisitNotesRequestSchema,
  VISIT_NOTES_FREEFORM_MAX_LENGTH,
  VISIT_NOTES_PHOTO_KEYS_MAX,
  VISIT_NOTES_PHOTO_KEY_MAX_LENGTH,
  VisitNoteAppetiteSchema,
  VisitNoteHydrationSchema,
  VisitNoteMoodSchema,
  VisitNoteSocialEngagementSchema,
  VisitNotesResponseSchema,
} from '../http';

describe('VisitNoteMoodSchema', () => {
  it('accepts every defined level', () => {
    (['low', 'subdued', 'neutral', 'bright', 'joyful'] as const).forEach((value) => {
      expect(VisitNoteMoodSchema.safeParse(value).success).toBe(true);
    });
  });

  it('rejects unknown levels', () => {
    expect(VisitNoteMoodSchema.safeParse('happy').success).toBe(false);
  });
});

describe('VisitNoteAppetiteSchema', () => {
  it('accepts every defined level', () => {
    (['none', 'minimal', 'moderate', 'hearty', 'robust'] as const).forEach((value) => {
      expect(VisitNoteAppetiteSchema.safeParse(value).success).toBe(true);
    });
  });

  it('rejects unknown levels', () => {
    expect(VisitNoteAppetiteSchema.safeParse('great').success).toBe(false);
  });
});

describe('VisitNoteHydrationSchema', () => {
  it('accepts every defined level', () => {
    (['poor', 'light', 'adequate', 'good', 'excellent'] as const).forEach((value) => {
      expect(VisitNoteHydrationSchema.safeParse(value).success).toBe(true);
    });
  });

  it('rejects unknown levels', () => {
    expect(VisitNoteHydrationSchema.safeParse('dry').success).toBe(false);
  });
});

describe('VisitNoteSocialEngagementSchema', () => {
  it('accepts every defined level', () => {
    (['withdrawn', 'reserved', 'present', 'engaged', 'vibrant'] as const).forEach((value) => {
      expect(VisitNoteSocialEngagementSchema.safeParse(value).success).toBe(true);
    });
  });

  it('rejects unknown levels', () => {
    expect(VisitNoteSocialEngagementSchema.safeParse('chatty').success).toBe(false);
  });
});

describe('UpsertVisitNotesRequestSchema', () => {
  const minimal = {
    mood: 'bright' as const,
  };

  it('accepts a minimal valid payload with just mood', () => {
    const result = UpsertVisitNotesRequestSchema.safeParse(minimal);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.photoKeys).toEqual([]);
    }
  });

  it('accepts every structured field plus freeform and photoKeys', () => {
    const full = {
      mood: 'joyful' as const,
      appetite: 'hearty' as const,
      hydration: 'good' as const,
      socialEngagement: 'engaged' as const,
      freeform: 'Mom enjoyed the chicken soup and reminisced about her mother.',
      photoKeys: ['media_abc123', 'media_xyz789'],
    };
    expect(UpsertVisitNotesRequestSchema.safeParse(full).success).toBe(true);
  });

  it('rejects a fully empty payload', () => {
    expect(UpsertVisitNotesRequestSchema.safeParse({}).success).toBe(false);
  });

  it('rejects a payload with only nulls and empty photoKeys', () => {
    const result = UpsertVisitNotesRequestSchema.safeParse({
      mood: null,
      appetite: null,
      hydration: null,
      socialEngagement: null,
      freeform: null,
      photoKeys: [],
    });
    expect(result.success).toBe(false);
  });

  it('treats a payload with just a non-empty freeform as valid', () => {
    expect(UpsertVisitNotesRequestSchema.safeParse({ freeform: 'visit went well' }).success).toBe(
      true,
    );
  });

  it('treats a payload with just photoKeys as valid', () => {
    expect(UpsertVisitNotesRequestSchema.safeParse({ photoKeys: ['media_abc'] }).success).toBe(
      true,
    );
  });

  it('rejects freeform beyond the cap', () => {
    const tooLong = 'x'.repeat(VISIT_NOTES_FREEFORM_MAX_LENGTH + 1);
    expect(UpsertVisitNotesRequestSchema.safeParse({ freeform: tooLong }).success).toBe(false);
  });

  it('rejects too many photoKeys', () => {
    const tooMany = Array.from({ length: VISIT_NOTES_PHOTO_KEYS_MAX + 1 }, (_, i) => `m_${i}`);
    expect(UpsertVisitNotesRequestSchema.safeParse({ photoKeys: tooMany }).success).toBe(false);
  });

  it('rejects a photo key beyond the per-key length cap', () => {
    const longKey = 'a'.repeat(VISIT_NOTES_PHOTO_KEY_MAX_LENGTH + 1);
    expect(UpsertVisitNotesRequestSchema.safeParse({ photoKeys: [longKey] }).success).toBe(false);
  });

  it('rejects a photo key with unsafe characters', () => {
    expect(
      UpsertVisitNotesRequestSchema.safeParse({ photoKeys: ['../../etc/passwd'] }).success,
    ).toBe(false);
  });

  it('rejects unknown fields', () => {
    expect(
      UpsertVisitNotesRequestSchema.safeParse({ mood: 'bright', recordedByUserId: 'usr_abc' })
        .success,
    ).toBe(false);
  });
});

describe('VisitNotesResponseSchema', () => {
  const valid = {
    bookingId: 'bkg_abc',
    mood: 'bright' as const,
    appetite: 'hearty' as const,
    hydration: 'good' as const,
    socialEngagement: 'engaged' as const,
    freeform: 'visit went well',
    photoKeys: ['media_abc'],
    recordedByUserId: 'usr_provider_1',
    recordedAt: '2026-05-14T18:30:00.000Z',
    updatedAt: '2026-05-14T18:30:00.000Z',
  };

  it('accepts a fully-populated response', () => {
    expect(VisitNotesResponseSchema.safeParse(valid).success).toBe(true);
  });

  it('accepts nullable observation fields', () => {
    const minimal = {
      ...valid,
      mood: null,
      appetite: null,
      hydration: null,
      socialEngagement: null,
      freeform: null,
      photoKeys: [],
    };
    expect(VisitNotesResponseSchema.safeParse(minimal).success).toBe(true);
  });

  it('rejects unknown fields', () => {
    expect(VisitNotesResponseSchema.safeParse({ ...valid, extraField: 'noise' }).success).toBe(
      false,
    );
  });

  it('rejects malformed ISO datetimes', () => {
    expect(VisitNotesResponseSchema.safeParse({ ...valid, recordedAt: '2026-05-14' }).success).toBe(
      false,
    );
  });
});
