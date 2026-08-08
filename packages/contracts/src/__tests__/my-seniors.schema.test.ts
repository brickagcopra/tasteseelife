import { describe, expect, it } from 'vitest';

import type { MySeniorSummary } from '../http';
import {
  MY_SENIORS_HOUSEHOLD_ID_MAX_LENGTH,
  MY_SENIORS_NAME_MAX_LENGTH,
  MY_SENIORS_SENIOR_ID_MAX_LENGTH,
  MySeniorStatusSchema,
  MySeniorSummarySchema,
  MySeniorsResponseSchema,
} from '../http';

const sampleSenior: MySeniorSummary = {
  seniorId: 'senior_mom',
  householdId: 'household_abc',
  firstName: 'Anna',
  lastName: 'Kowalski',
  displayName: 'Bobchi',
  status: 'active',
};

describe('MY_SENIORS constants', () => {
  it('exports sensible caps', () => {
    expect(MY_SENIORS_SENIOR_ID_MAX_LENGTH).toBeGreaterThanOrEqual(24);
    expect(MY_SENIORS_HOUSEHOLD_ID_MAX_LENGTH).toBeGreaterThanOrEqual(24);
    expect(MY_SENIORS_NAME_MAX_LENGTH).toBeGreaterThanOrEqual(100);
  });
});

describe('MySeniorStatusSchema', () => {
  it.each(['active', 'paused', 'archived'])('accepts %s', (value) => {
    expect(MySeniorStatusSchema.safeParse(value).success).toBe(true);
  });

  it('rejects an unknown status', () => {
    expect(MySeniorStatusSchema.safeParse('deceased').success).toBe(false);
  });
});

describe('MySeniorSummarySchema', () => {
  it('accepts the canonical sample', () => {
    expect(MySeniorSummarySchema.safeParse(sampleSenior).success).toBe(true);
  });

  it('accepts a null displayName (fall back to firstName at render)', () => {
    expect(MySeniorSummarySchema.safeParse({ ...sampleSenior, displayName: null }).success).toBe(
      true,
    );
  });

  it('rejects an empty firstName', () => {
    expect(MySeniorSummarySchema.safeParse({ ...sampleSenior, firstName: '' }).success).toBe(false);
  });

  it('rejects an empty displayName (must be null, not blank)', () => {
    expect(MySeniorSummarySchema.safeParse({ ...sampleSenior, displayName: '' }).success).toBe(
      false,
    );
  });

  it('rejects an over-long seniorId', () => {
    expect(
      MySeniorSummarySchema.safeParse({
        ...sampleSenior,
        seniorId: 'x'.repeat(MY_SENIORS_SENIOR_ID_MAX_LENGTH + 1),
      }).success,
    ).toBe(false);
  });

  it('rejects unknown fields (strict)', () => {
    expect(MySeniorSummarySchema.safeParse({ ...sampleSenior, dob: '1940-01-01' }).success).toBe(
      false,
    );
  });
});

describe('MySeniorsResponseSchema', () => {
  it('accepts an empty list (no seniors yet)', () => {
    expect(MySeniorsResponseSchema.safeParse({ seniors: [] }).success).toBe(true);
  });

  it('accepts a populated list', () => {
    expect(
      MySeniorsResponseSchema.safeParse({
        seniors: [sampleSenior, { ...sampleSenior, seniorId: 'senior_dad', firstName: 'Józef' }],
      }).success,
    ).toBe(true);
  });

  it('rejects a list with a malformed entry', () => {
    expect(
      MySeniorsResponseSchema.safeParse({
        seniors: [{ ...sampleSenior, status: 'gone' }],
      }).success,
    ).toBe(false);
  });

  it('rejects unknown top-level fields (strict)', () => {
    expect(MySeniorsResponseSchema.safeParse({ seniors: [], total: 1 }).success).toBe(false);
  });
});
