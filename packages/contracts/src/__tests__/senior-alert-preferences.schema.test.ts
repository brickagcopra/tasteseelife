import { describe, expect, it } from 'vitest';

import {
  SENIOR_ALERT_PREFERENCES_DEFAULTS,
  SENIOR_ALERT_TYPES,
  SeniorAlertPreferencesFlagsSchema,
  SeniorAlertPreferencesResponseSchema,
  SeniorAlertTypeSchema,
  SetSeniorAlertPreferencesRequestSchema,
} from '../http/senior-alert-preferences.schema';

/**
 * Contract tests for the TS-234 per-(senior × family-member) alert
 * subscription DTOs.
 */
describe('SeniorAlertTypeSchema', () => {
  it.each([...SENIOR_ALERT_TYPES])('accepts the %s type', (type) => {
    expect(SeniorAlertTypeSchema.parse(type)).toBe(type);
  });

  it('enumerates exactly missedVisit / concerningObservation / emergencyFlag', () => {
    expect([...SENIOR_ALERT_TYPES]).toEqual([
      'missedVisit',
      'concerningObservation',
      'emergencyFlag',
    ]);
  });

  it('rejects an unknown type', () => {
    expect(SeniorAlertTypeSchema.safeParse('coupon_expired').success).toBe(false);
  });
});

describe('SeniorAlertPreferencesFlagsSchema / SetSeniorAlertPreferencesRequestSchema', () => {
  it('accepts a full three-flag body', () => {
    const parsed = SetSeniorAlertPreferencesRequestSchema.parse({
      missedVisit: true,
      concerningObservation: false,
      emergencyFlag: true,
    });
    expect(parsed).toEqual({
      missedVisit: true,
      concerningObservation: false,
      emergencyFlag: true,
    });
  });

  it('the PUT request schema is the flags schema (full replace)', () => {
    expect(SetSeniorAlertPreferencesRequestSchema).toBe(SeniorAlertPreferencesFlagsSchema);
  });

  it.each([...SENIOR_ALERT_TYPES])('rejects a body missing the %s flag', (missing) => {
    const body: Record<string, boolean> = {
      missedVisit: false,
      concerningObservation: false,
      emergencyFlag: false,
    };
    delete body[missing];
    expect(SetSeniorAlertPreferencesRequestSchema.safeParse(body).success).toBe(false);
  });

  it('rejects a non-boolean flag', () => {
    expect(
      SetSeniorAlertPreferencesRequestSchema.safeParse({
        missedVisit: 'yes',
        concerningObservation: false,
        emergencyFlag: false,
      }).success,
    ).toBe(false);
  });

  it('rejects unknown fields (.strict)', () => {
    expect(
      SetSeniorAlertPreferencesRequestSchema.safeParse({
        missedVisit: false,
        concerningObservation: false,
        emergencyFlag: false,
        couponExpired: true,
      }).success,
    ).toBe(false);
  });
});

describe('SENIOR_ALERT_PREFERENCES_DEFAULTS', () => {
  it('defaults operational + safety alerts on, observation off', () => {
    expect(SENIOR_ALERT_PREFERENCES_DEFAULTS).toEqual({
      missedVisit: true,
      concerningObservation: false,
      emergencyFlag: true,
    });
  });

  it('is a valid flags body', () => {
    expect(
      SeniorAlertPreferencesFlagsSchema.safeParse(SENIOR_ALERT_PREFERENCES_DEFAULTS).success,
    ).toBe(true);
  });
});

describe('SeniorAlertPreferencesResponseSchema', () => {
  const base = {
    seniorId: 'senior_abc',
    missedVisit: true,
    concerningObservation: false,
    emergencyFlag: true,
    updatedAt: '2026-05-27T12:00:00.000Z',
  };

  it('accepts a fully-populated record', () => {
    expect(SeniorAlertPreferencesResponseSchema.parse(base)).toEqual(base);
  });

  it('accepts the never-set default (null updatedAt)', () => {
    const parsed = SeniorAlertPreferencesResponseSchema.parse({ ...base, updatedAt: null });
    expect(parsed.updatedAt).toBeNull();
  });

  it('rejects a non-datetime updatedAt', () => {
    expect(
      SeniorAlertPreferencesResponseSchema.safeParse({ ...base, updatedAt: 'yesterday' }).success,
    ).toBe(false);
  });

  it('requires an empty-string-rejecting seniorId', () => {
    expect(SeniorAlertPreferencesResponseSchema.safeParse({ ...base, seniorId: '' }).success).toBe(
      false,
    );
  });

  it('rejects unknown fields (.strict)', () => {
    expect(SeniorAlertPreferencesResponseSchema.safeParse({ ...base, extra: 1 }).success).toBe(
      false,
    );
  });
});
