import { describe, expect, it } from 'vitest';

import {
  BulkUpsertSeniorPreferenceEntrySchema,
  BulkUpsertSeniorPreferencesRequestSchema,
  SeniorPreferenceEntrySchema,
  SeniorPreferencesResponseSchema,
  SENIOR_PREFERENCE_KEY_MAX_LENGTH,
  SENIOR_PREFERENCE_VALUE_MAX_LENGTH,
  SENIOR_PREFERENCES_ENTRIES_MAX_PER_REQUEST,
  SENIOR_PREFERENCES_MAX_PER_SENIOR,
} from '../http/senior-preferences.schema';

const validEntry = {
  key: 'favorite_childhood_dish',
  value: "Bobchi's pierogi — the potato + farmer cheese ones, brown butter on top.",
  createdAt: '2026-05-10T12:00:00.000Z',
  updatedAt: '2026-05-10T12:00:00.000Z',
};

describe('SeniorPreferenceEntrySchema', () => {
  it('round-trips a valid entry', () => {
    expect(SeniorPreferenceEntrySchema.parse(validEntry)).toEqual(validEntry);
  });

  it('rejects unknown fields (strict)', () => {
    expect(SeniorPreferenceEntrySchema.safeParse({ ...validEntry, surprise: 'x' }).success).toBe(
      false,
    );
  });

  it('rejects empty key / value', () => {
    expect(SeniorPreferenceEntrySchema.safeParse({ ...validEntry, key: '' }).success).toBe(false);
    expect(SeniorPreferenceEntrySchema.safeParse({ ...validEntry, value: '' }).success).toBe(false);
  });

  it('rejects non-snake_case keys', () => {
    expect(
      SeniorPreferenceEntrySchema.safeParse({ ...validEntry, key: 'FavoriteDish' }).success,
    ).toBe(false);
    expect(
      SeniorPreferenceEntrySchema.safeParse({ ...validEntry, key: 'favorite-dish' }).success,
    ).toBe(false);
    expect(SeniorPreferenceEntrySchema.safeParse({ ...validEntry, key: '1favorite' }).success).toBe(
      false,
    );
    expect(
      SeniorPreferenceEntrySchema.safeParse({ ...validEntry, key: '_leading_underscore' }).success,
    ).toBe(false);
  });

  it('enforces key + value length caps', () => {
    const oversizedKey = 'a'.repeat(SENIOR_PREFERENCE_KEY_MAX_LENGTH + 1);
    expect(
      SeniorPreferenceEntrySchema.safeParse({ ...validEntry, key: oversizedKey }).success,
    ).toBe(false);
    const exactKey = 'a'.repeat(SENIOR_PREFERENCE_KEY_MAX_LENGTH);
    expect(SeniorPreferenceEntrySchema.parse({ ...validEntry, key: exactKey }).key).toBe(exactKey);
    const oversizedVal = 'v'.repeat(SENIOR_PREFERENCE_VALUE_MAX_LENGTH + 1);
    expect(
      SeniorPreferenceEntrySchema.safeParse({ ...validEntry, value: oversizedVal }).success,
    ).toBe(false);
  });

  it('rejects non-ISO timestamps', () => {
    expect(
      SeniorPreferenceEntrySchema.safeParse({ ...validEntry, createdAt: '2026-05-10' }).success,
    ).toBe(false);
  });
});

describe('SeniorPreferencesResponseSchema', () => {
  it('accepts an empty preferences list', () => {
    expect(SeniorPreferencesResponseSchema.parse({ seniorId: 'sn_abc', preferences: [] })).toEqual({
      seniorId: 'sn_abc',
      preferences: [],
    });
  });

  it('accepts multiple entries', () => {
    const parsed = SeniorPreferencesResponseSchema.parse({
      seniorId: 'sn_abc',
      preferences: [validEntry, { ...validEntry, key: 'comfort_food', value: 'Tomato soup.' }],
    });
    expect(parsed.preferences).toHaveLength(2);
  });

  it('rejects unknown top-level fields', () => {
    expect(
      SeniorPreferencesResponseSchema.safeParse({
        seniorId: 'sn_abc',
        preferences: [],
        cursor: 'x',
      }).success,
    ).toBe(false);
  });
});

describe('BulkUpsertSeniorPreferenceEntrySchema', () => {
  it('accepts a string value', () => {
    expect(
      BulkUpsertSeniorPreferenceEntrySchema.parse({
        key: 'comfort_food',
        value: 'Grilled cheese.',
      }).value,
    ).toBe('Grilled cheese.');
  });

  it('accepts null value (delete signal)', () => {
    expect(
      BulkUpsertSeniorPreferenceEntrySchema.parse({ key: 'comfort_food', value: null }).value,
    ).toBeNull();
  });

  it('rejects an empty value string (use null to delete)', () => {
    expect(
      BulkUpsertSeniorPreferenceEntrySchema.safeParse({ key: 'comfort_food', value: '' }).success,
    ).toBe(false);
  });

  it('rejects unknown fields', () => {
    expect(
      BulkUpsertSeniorPreferenceEntrySchema.safeParse({
        key: 'comfort_food',
        value: 'X',
        confidence: 'high',
      }).success,
    ).toBe(false);
  });
});

describe('BulkUpsertSeniorPreferencesRequestSchema', () => {
  it('accepts an empty entries array (service rejects no-op)', () => {
    expect(BulkUpsertSeniorPreferencesRequestSchema.parse({ entries: [] })).toEqual({
      entries: [],
    });
  });

  it('accepts a mixed upsert + delete batch', () => {
    const parsed = BulkUpsertSeniorPreferencesRequestSchema.parse({
      entries: [
        { key: 'comfort_food', value: 'Tomato soup.' },
        { key: 'sunday_ritual', value: null },
      ],
    });
    expect(parsed.entries).toHaveLength(2);
    expect(parsed.entries[1]?.value).toBeNull();
  });

  it('rejects more than the per-request entry cap', () => {
    const entries = Array.from(
      { length: SENIOR_PREFERENCES_ENTRIES_MAX_PER_REQUEST + 1 },
      (_, i) => ({
        key: `key_${i}`,
        value: `value ${i}`,
      }),
    );
    expect(BulkUpsertSeniorPreferencesRequestSchema.safeParse({ entries }).success).toBe(false);
  });

  it('rejects unknown top-level fields', () => {
    expect(
      BulkUpsertSeniorPreferencesRequestSchema.safeParse({ entries: [], surprise: 'x' }).success,
    ).toBe(false);
  });
});

describe('exported caps', () => {
  it('SENIOR_PREFERENCES_MAX_PER_SENIOR is a stable contract', () => {
    expect(SENIOR_PREFERENCES_MAX_PER_SENIOR).toBe(64);
  });

  it('SENIOR_PREFERENCES_ENTRIES_MAX_PER_REQUEST is a stable contract', () => {
    expect(SENIOR_PREFERENCES_ENTRIES_MAX_PER_REQUEST).toBe(64);
  });
});
