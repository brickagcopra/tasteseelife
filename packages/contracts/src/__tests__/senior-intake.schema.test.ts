import { describe, expect, it } from 'vitest';

import {
  DementiaStatusSchema,
  SENIOR_INTAKE_NOTES_MAX_LENGTH,
  SeniorIntakeResponseSchema,
  SeniorIntakeSchema,
  SeniorMobilityLevelSchema,
  UpsertSeniorIntakeRequestSchema,
} from '../http/senior-intake.schema';

describe('SeniorIntakeSchema', () => {
  it('accepts an empty object — every field is optional with safe defaults', () => {
    const parsed = SeniorIntakeSchema.parse({});
    expect(parsed.dementiaStatus).toBe('none');
    expect(parsed.mobilityLevel).toBe('unknown');
    expect(parsed.dietaryTags).toEqual([]);
    expect(parsed.allergenTags).toEqual([]);
    expect(parsed.languageTags).toEqual([]);
    expect(parsed.dateOfBirth).toBeUndefined();
    expect(parsed.dietaryNotes).toBeUndefined();
  });

  it('round-trips a fully-populated payload unchanged (modulo defaults)', () => {
    const payload = {
      dateOfBirth: '1942-03-14',
      dementiaStatus: 'early_dementia' as const,
      mobilityLevel: 'aided_walker' as const,
      languageTags: ['en', 'es-419'],
      dietaryTags: ['kosher', 'low_sodium'],
      allergenTags: ['peanut', 'shellfish'],
      dietaryNotes: 'No raw fish; loves Friday brisket.',
      allergyNotes: 'Anaphylaxis on peanut exposure in 2008.',
      mobilityNotes: 'Walker since 2024 hip replacement.',
      medicalNotes: 'Type 2 diabetes, well controlled.',
    };
    expect(SeniorIntakeSchema.parse(payload)).toEqual(payload);
  });

  it('rejects unknown fields (strict)', () => {
    const result = SeniorIntakeSchema.safeParse({ favouriteColour: 'green' });
    expect(result.success).toBe(false);
  });

  it('rejects a malformed dateOfBirth', () => {
    expect(SeniorIntakeSchema.safeParse({ dateOfBirth: '1942-3-14' }).success).toBe(false);
    expect(SeniorIntakeSchema.safeParse({ dateOfBirth: '42-03-14' }).success).toBe(false);
    expect(SeniorIntakeSchema.safeParse({ dateOfBirth: '1942/03/14' }).success).toBe(false);
    expect(SeniorIntakeSchema.safeParse({ dateOfBirth: '1800-03-14' }).success).toBe(false);
    expect(SeniorIntakeSchema.safeParse({ dateOfBirth: '1942-13-14' }).success).toBe(false);
  });

  it('accepts dateOfBirth = null (cleared / not-yet-filled)', () => {
    const parsed = SeniorIntakeSchema.parse({ dateOfBirth: null });
    expect(parsed.dateOfBirth).toBeNull();
  });

  it('rejects an over-long notes field', () => {
    const oversized = 'a'.repeat(SENIOR_INTAKE_NOTES_MAX_LENGTH + 1);
    expect(SeniorIntakeSchema.safeParse({ dietaryNotes: oversized }).success).toBe(false);
    expect(SeniorIntakeSchema.safeParse({ medicalNotes: oversized }).success).toBe(false);
  });

  it('accepts notes at exactly the max length', () => {
    const atCap = 'a'.repeat(SENIOR_INTAKE_NOTES_MAX_LENGTH);
    expect(SeniorIntakeSchema.parse({ dietaryNotes: atCap }).dietaryNotes).toBe(atCap);
  });

  it('rejects malformed tag values', () => {
    expect(SeniorIntakeSchema.safeParse({ dietaryTags: ['Kosher'] }).success).toBe(false); // uppercase
    expect(SeniorIntakeSchema.safeParse({ dietaryTags: ['gluten-free'] }).success).toBe(false); // hyphen
    expect(SeniorIntakeSchema.safeParse({ dietaryTags: ['_leading'] }).success).toBe(false); // leading underscore
    expect(SeniorIntakeSchema.safeParse({ allergenTags: ['1tree'] }).success).toBe(false); // leading digit
  });

  it('caps tag-array length to defeat pathological payloads', () => {
    const tooMany = Array.from({ length: 33 }, (_, i) => `tag_${i}`);
    expect(SeniorIntakeSchema.safeParse({ dietaryTags: tooMany }).success).toBe(false);
    expect(SeniorIntakeSchema.safeParse({ allergenTags: tooMany }).success).toBe(false);
  });

  it('caps language-tag array length at 16', () => {
    const tooMany = Array.from({ length: 17 }, () => 'en');
    expect(SeniorIntakeSchema.safeParse({ languageTags: tooMany }).success).toBe(false);
  });

  it('rejects malformed BCP-47 language tags', () => {
    expect(SeniorIntakeSchema.safeParse({ languageTags: ['en_US'] }).success).toBe(false); // underscore
    expect(SeniorIntakeSchema.safeParse({ languageTags: ['e'] }).success).toBe(false); // too short
    expect(SeniorIntakeSchema.safeParse({ languageTags: ['english'] }).success).toBe(false); // 7 chars no region
  });

  it('accepts common BCP-47 shapes', () => {
    const parsed = SeniorIntakeSchema.parse({
      languageTags: ['en', 'en-US', 'zh-CN', 'pt-BR', 'es-419'],
    });
    expect(parsed.languageTags).toHaveLength(5);
  });
});

describe('DementiaStatusSchema', () => {
  it('exposes the documented categories', () => {
    expect(DementiaStatusSchema.options).toEqual([
      'none',
      'mild_cognitive_impairment',
      'early_dementia',
      'moderate_dementia',
      'advanced_dementia',
    ]);
  });

  it('rejects unknown stages', () => {
    expect(DementiaStatusSchema.safeParse('progressive').success).toBe(false);
  });
});

describe('SeniorMobilityLevelSchema', () => {
  it('includes the explicit `unknown` placeholder', () => {
    expect(SeniorMobilityLevelSchema.parse('unknown')).toBe('unknown');
  });

  it('rejects unknown levels', () => {
    expect(SeniorMobilityLevelSchema.safeParse('limping').success).toBe(false);
  });
});

describe('UpsertSeniorIntakeRequestSchema', () => {
  it('is the same shape as SeniorIntakeSchema today', () => {
    // Same as SeniorIntakeSchema by construction. This guards against an
    // accidental shape drift if a future commit extends one without the
    // other (the intent is documented in the schema file).
    expect(UpsertSeniorIntakeRequestSchema.parse({})).toEqual(SeniorIntakeSchema.parse({}));
  });
});

describe('SeniorIntakeResponseSchema', () => {
  it('adds server-owned audit fields on top of SeniorIntake', () => {
    const parsed = SeniorIntakeResponseSchema.parse({
      seniorId: 'snr_123',
      intakeCompletedAt: '2026-05-10T12:00:00.000Z',
      updatedAt: '2026-05-10T12:00:00.000Z',
    });
    expect(parsed.seniorId).toBe('snr_123');
    expect(parsed.intakeCompletedAt).toBe('2026-05-10T12:00:00.000Z');
    expect(parsed.dementiaStatus).toBe('none');
  });

  it('allows intakeCompletedAt = null (intake never finished)', () => {
    const parsed = SeniorIntakeResponseSchema.parse({
      seniorId: 'snr_123',
      intakeCompletedAt: null,
      updatedAt: '2026-05-10T12:00:00.000Z',
    });
    expect(parsed.intakeCompletedAt).toBeNull();
  });

  it('requires the audit metadata (seniorId + updatedAt)', () => {
    expect(
      SeniorIntakeResponseSchema.safeParse({
        intakeCompletedAt: null,
        updatedAt: '2026-05-10T12:00:00.000Z',
      }).success,
    ).toBe(false);
    expect(
      SeniorIntakeResponseSchema.safeParse({ seniorId: 's', intakeCompletedAt: null }).success,
    ).toBe(false);
  });

  it('rejects a non-ISO updatedAt', () => {
    expect(
      SeniorIntakeResponseSchema.safeParse({
        seniorId: 'snr_123',
        intakeCompletedAt: null,
        updatedAt: 'not-a-date',
      }).success,
    ).toBe(false);
  });
});
