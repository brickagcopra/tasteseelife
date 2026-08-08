import { describe, expect, it } from 'vitest';

import {
  HOUSEHOLD_ACCESS_FIELD_MAX_LENGTH,
  HouseholdAccessInstructionsResponseSchema,
  HouseholdAccessInstructionsSchema,
  UpsertHouseholdAccessInstructionsRequestSchema,
} from '../http/household-access.schema';

describe('HouseholdAccessInstructionsSchema', () => {
  it('accepts an empty object — every field optional', () => {
    const parsed = HouseholdAccessInstructionsSchema.parse({});
    expect(parsed.doorCode).toBeUndefined();
    expect(parsed.alarmCode).toBeUndefined();
  });

  it('round-trips a fully-populated payload', () => {
    const payload = {
      doorCode: '4242',
      keyLocation: 'Lockbox to left of front door, combo 4242.',
      alarmCode: '8888',
      alarmDisarmInstructions: '30s to disarm after door opens. Panel by closet.',
      parkingInstructions: 'Guest spots 12–15. After 8pm anywhere on 3rd St.',
      doormanInfo: 'Mike 7am–3pm; Lisa 3pm–11pm.',
      petInfo: 'Indoor cat Whiskers — never let outside.',
      generalNotes: 'Mrs. Schwartz prefers a quiet entry.',
    };
    expect(HouseholdAccessInstructionsSchema.parse(payload)).toEqual(payload);
  });

  it('rejects unknown fields (strict)', () => {
    expect(
      HouseholdAccessInstructionsSchema.safeParse({ wifiPassword: 'tasteandsee2026' }).success,
    ).toBe(false);
  });

  it('allows every field to be null (explicit clear)', () => {
    const parsed = HouseholdAccessInstructionsSchema.parse({
      doorCode: null,
      keyLocation: null,
      alarmCode: null,
      alarmDisarmInstructions: null,
      parkingInstructions: null,
      doormanInfo: null,
      petInfo: null,
      generalNotes: null,
    });
    expect(parsed.doorCode).toBeNull();
    expect(parsed.alarmCode).toBeNull();
  });

  it('enforces the per-field length cap', () => {
    const oversize = 'x'.repeat(HOUSEHOLD_ACCESS_FIELD_MAX_LENGTH + 1);
    expect(HouseholdAccessInstructionsSchema.safeParse({ doorCode: oversize }).success).toBe(false);
    expect(HouseholdAccessInstructionsSchema.safeParse({ generalNotes: oversize }).success).toBe(
      false,
    );
  });

  it('accepts fields exactly at the length cap', () => {
    const atCap = 'x'.repeat(HOUSEHOLD_ACCESS_FIELD_MAX_LENGTH);
    expect(HouseholdAccessInstructionsSchema.parse({ doorCode: atCap }).doorCode).toBe(atCap);
  });
});

describe('UpsertHouseholdAccessInstructionsRequestSchema', () => {
  it('is the same shape as HouseholdAccessInstructionsSchema today', () => {
    expect(UpsertHouseholdAccessInstructionsRequestSchema.parse({})).toEqual(
      HouseholdAccessInstructionsSchema.parse({}),
    );
  });
});

describe('HouseholdAccessInstructionsResponseSchema', () => {
  it('adds server-owned audit fields on top of the access payload', () => {
    const parsed = HouseholdAccessInstructionsResponseSchema.parse({
      householdId: 'hh_abc',
      accessInstructionsUpdatedAt: '2026-05-10T12:00:00.000Z',
      updatedAt: '2026-05-10T12:00:00.000Z',
    });
    expect(parsed.householdId).toBe('hh_abc');
    expect(parsed.accessInstructionsUpdatedAt).toBe('2026-05-10T12:00:00.000Z');
  });

  it('allows accessInstructionsUpdatedAt = null (never filled)', () => {
    const parsed = HouseholdAccessInstructionsResponseSchema.parse({
      householdId: 'hh_abc',
      accessInstructionsUpdatedAt: null,
      updatedAt: '2026-05-10T12:00:00.000Z',
    });
    expect(parsed.accessInstructionsUpdatedAt).toBeNull();
  });

  it('requires the audit metadata (householdId + updatedAt)', () => {
    expect(
      HouseholdAccessInstructionsResponseSchema.safeParse({
        accessInstructionsUpdatedAt: null,
        updatedAt: '2026-05-10T12:00:00.000Z',
      }).success,
    ).toBe(false);
    expect(
      HouseholdAccessInstructionsResponseSchema.safeParse({
        householdId: 'hh_abc',
        accessInstructionsUpdatedAt: null,
      }).success,
    ).toBe(false);
  });

  it('rejects a non-ISO updatedAt', () => {
    expect(
      HouseholdAccessInstructionsResponseSchema.safeParse({
        householdId: 'hh_abc',
        accessInstructionsUpdatedAt: null,
        updatedAt: 'not-a-date',
      }).success,
    ).toBe(false);
  });
});
