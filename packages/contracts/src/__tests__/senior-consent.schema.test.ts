import { describe, expect, it } from 'vitest';

import {
  SENIOR_CONSENT_SURFACES,
  SeniorConsentFlagsSchema,
  SeniorConsentResponseSchema,
  SeniorConsentSurfaceSchema,
  SetSeniorConsentRequestSchema,
} from '../http/senior-consent.schema';

/**
 * Contract tests for the TS-238 senior family-observability consent DTOs.
 */
describe('SeniorConsentSurfaceSchema', () => {
  it.each([...SENIOR_CONSENT_SURFACES])('accepts the %s surface', (surface) => {
    expect(SeniorConsentSurfaceSchema.parse(surface)).toBe(surface);
  });

  it('enumerates exactly photos / notes / location / health', () => {
    expect([...SENIOR_CONSENT_SURFACES]).toEqual(['photos', 'notes', 'location', 'health']);
  });

  it('rejects an unknown surface', () => {
    expect(SeniorConsentSurfaceSchema.safeParse('billing').success).toBe(false);
  });
});

describe('SeniorConsentFlagsSchema / SetSeniorConsentRequestSchema', () => {
  it('accepts a full four-flag body', () => {
    const parsed = SetSeniorConsentRequestSchema.parse({
      photos: true,
      notes: false,
      location: true,
      health: false,
    });
    expect(parsed).toEqual({ photos: true, notes: false, location: true, health: false });
  });

  it('the PUT request schema is the flags schema (full replace)', () => {
    expect(SetSeniorConsentRequestSchema).toBe(SeniorConsentFlagsSchema);
  });

  it.each([...SENIOR_CONSENT_SURFACES])('rejects a body missing the %s flag', (missing) => {
    const body: Record<string, boolean> = {
      photos: false,
      notes: false,
      location: false,
      health: false,
    };
    delete body[missing];
    expect(SetSeniorConsentRequestSchema.safeParse(body).success).toBe(false);
  });

  it('rejects a non-boolean flag', () => {
    expect(
      SetSeniorConsentRequestSchema.safeParse({
        photos: 'yes',
        notes: false,
        location: false,
        health: false,
      }).success,
    ).toBe(false);
  });

  it('rejects unknown fields (.strict)', () => {
    expect(
      SetSeniorConsentRequestSchema.safeParse({
        photos: false,
        notes: false,
        location: false,
        health: false,
        billing: true,
      }).success,
    ).toBe(false);
  });
});

describe('SeniorConsentResponseSchema', () => {
  const base = {
    seniorId: 'senior_abc',
    photos: false,
    notes: true,
    location: false,
    health: true,
    updatedAt: '2026-05-26T12:00:00.000Z',
    updatedByUserId: 'user_xyz',
    canManage: true,
  };

  it('accepts a fully-populated record', () => {
    expect(SeniorConsentResponseSchema.parse(base)).toEqual(base);
  });

  it('accepts the never-set default (null audit metadata)', () => {
    const parsed = SeniorConsentResponseSchema.parse({
      ...base,
      updatedAt: null,
      updatedByUserId: null,
    });
    expect(parsed.updatedAt).toBeNull();
    expect(parsed.updatedByUserId).toBeNull();
  });

  it('rejects a non-datetime updatedAt', () => {
    expect(SeniorConsentResponseSchema.safeParse({ ...base, updatedAt: 'yesterday' }).success).toBe(
      false,
    );
  });

  it('requires canManage', () => {
    const { canManage: _omit, ...withoutCanManage } = base;
    expect(SeniorConsentResponseSchema.safeParse(withoutCanManage).success).toBe(false);
  });

  it('requires an empty-string-rejecting seniorId', () => {
    expect(SeniorConsentResponseSchema.safeParse({ ...base, seniorId: '' }).success).toBe(false);
  });

  it('rejects unknown fields (.strict)', () => {
    expect(SeniorConsentResponseSchema.safeParse({ ...base, extra: 1 }).success).toBe(false);
  });
});
