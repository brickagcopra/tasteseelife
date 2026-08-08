import { describe, expect, it } from 'vitest';

import {
  eventRegistry,
  getEventSchema,
  PROVIDER_AVAILABILITY_UPDATED,
  PROVIDER_CALENDAR_SYNCED,
  PROVIDER_CERTIFICATION_GRANTED,
  PROVIDER_CERTIFICATION_REVOKED,
  PROVIDER_PRICING_UPDATED,
  PROVIDER_PROFILE_UPDATED,
  PROVIDER_SERVICE_AREAS_UPDATED,
  PROVIDER_TIER_CHANGED,
} from '../events';

describe('provider event registry registration', () => {
  it('registers all eight provider events', () => {
    expect(eventRegistry[PROVIDER_CERTIFICATION_GRANTED]).toBeDefined();
    expect(eventRegistry[PROVIDER_CERTIFICATION_REVOKED]).toBeDefined();
    expect(eventRegistry[PROVIDER_TIER_CHANGED]).toBeDefined();
    expect(eventRegistry[PROVIDER_PROFILE_UPDATED]).toBeDefined();
    expect(eventRegistry[PROVIDER_AVAILABILITY_UPDATED]).toBeDefined();
    expect(eventRegistry[PROVIDER_SERVICE_AREAS_UPDATED]).toBeDefined();
    expect(eventRegistry[PROVIDER_PRICING_UPDATED]).toBeDefined();
    expect(eventRegistry[PROVIDER_CALENDAR_SYNCED]).toBeDefined();
  });

  it('getEventSchema returns the same schema as the registry lookup', () => {
    expect(getEventSchema(PROVIDER_CERTIFICATION_GRANTED)).toBe(
      eventRegistry[PROVIDER_CERTIFICATION_GRANTED],
    );
    expect(getEventSchema(PROVIDER_CERTIFICATION_REVOKED)).toBe(
      eventRegistry[PROVIDER_CERTIFICATION_REVOKED],
    );
    expect(getEventSchema(PROVIDER_TIER_CHANGED)).toBe(eventRegistry[PROVIDER_TIER_CHANGED]);
    expect(getEventSchema(PROVIDER_PROFILE_UPDATED)).toBe(eventRegistry[PROVIDER_PROFILE_UPDATED]);
    expect(getEventSchema(PROVIDER_AVAILABILITY_UPDATED)).toBe(
      eventRegistry[PROVIDER_AVAILABILITY_UPDATED],
    );
    expect(getEventSchema(PROVIDER_SERVICE_AREAS_UPDATED)).toBe(
      eventRegistry[PROVIDER_SERVICE_AREAS_UPDATED],
    );
    expect(getEventSchema(PROVIDER_PRICING_UPDATED)).toBe(eventRegistry[PROVIDER_PRICING_UPDATED]);
    expect(getEventSchema(PROVIDER_CALENDAR_SYNCED)).toBe(eventRegistry[PROVIDER_CALENDAR_SYNCED]);
  });

  it('uses past-tense dotted event names (CLAUDE.md §2.2)', () => {
    for (const name of [
      PROVIDER_CERTIFICATION_GRANTED,
      PROVIDER_CERTIFICATION_REVOKED,
      PROVIDER_TIER_CHANGED,
      PROVIDER_PROFILE_UPDATED,
      PROVIDER_AVAILABILITY_UPDATED,
      PROVIDER_SERVICE_AREAS_UPDATED,
      PROVIDER_PRICING_UPDATED,
      PROVIDER_CALENDAR_SYNCED,
    ]) {
      expect(name).toMatch(/^provider\.[a-z][a-z0-9_]*$/);
    }
  });
});

describe('ProviderCertificationGranted payload', () => {
  const valid = {
    eventId: 'evt_grant_1',
    occurredAt: '2026-05-16T12:00:00.000Z',
    providerId: 'prov_abc',
    providerCertificationId: 'pcert_001',
    certificationCode: 'ccc',
    issuedAt: '2026-05-16T12:00:00.000Z',
    expiresAt: '2028-05-16T12:00:00.000Z',
    issuerUserId: 'user_ops',
  };

  it('accepts a valid payload', () => {
    expect(eventRegistry[PROVIDER_CERTIFICATION_GRANTED].safeParse(valid).success).toBe(true);
  });

  it('accepts `expiresAt: null` (catalog without default validity)', () => {
    expect(
      eventRegistry[PROVIDER_CERTIFICATION_GRANTED].safeParse({ ...valid, expiresAt: null })
        .success,
    ).toBe(true);
  });

  it('accepts `issuerUserId: null` (system grant)', () => {
    expect(
      eventRegistry[PROVIDER_CERTIFICATION_GRANTED].safeParse({ ...valid, issuerUserId: null })
        .success,
    ).toBe(true);
  });

  it('rejects unknown fields (`.strict()`)', () => {
    expect(
      eventRegistry[PROVIDER_CERTIFICATION_GRANTED].safeParse({ ...valid, extra: 'oops' }).success,
    ).toBe(false);
  });

  it('rejects a non-ISO `occurredAt`', () => {
    expect(
      eventRegistry[PROVIDER_CERTIFICATION_GRANTED].safeParse({ ...valid, occurredAt: 'now' })
        .success,
    ).toBe(false);
  });

  it('rejects empty `providerId` / `certificationCode`', () => {
    expect(
      eventRegistry[PROVIDER_CERTIFICATION_GRANTED].safeParse({ ...valid, providerId: '' }).success,
    ).toBe(false);
    expect(
      eventRegistry[PROVIDER_CERTIFICATION_GRANTED].safeParse({
        ...valid,
        certificationCode: '',
      }).success,
    ).toBe(false);
  });
});

describe('ProviderCertificationRevoked payload', () => {
  const valid = {
    eventId: 'evt_revoke_1',
    occurredAt: '2026-05-16T12:00:00.000Z',
    providerId: 'prov_abc',
    providerCertificationId: 'pcert_001',
    certificationCode: 'ccc',
    revocationReason: 'auto-revoked on regrant (prior grant expired)',
    revokerUserId: 'user_ops',
  };

  it('accepts a valid payload', () => {
    expect(eventRegistry[PROVIDER_CERTIFICATION_REVOKED].safeParse(valid).success).toBe(true);
  });

  it('accepts `revokerUserId: null` (system revocation path)', () => {
    expect(
      eventRegistry[PROVIDER_CERTIFICATION_REVOKED].safeParse({ ...valid, revokerUserId: null })
        .success,
    ).toBe(true);
  });

  it('rejects empty `revocationReason`', () => {
    expect(
      eventRegistry[PROVIDER_CERTIFICATION_REVOKED].safeParse({ ...valid, revocationReason: '' })
        .success,
    ).toBe(false);
  });

  it('rejects unknown fields (`.strict()`)', () => {
    expect(
      eventRegistry[PROVIDER_CERTIFICATION_REVOKED].safeParse({ ...valid, extra: 'oops' }).success,
    ).toBe(false);
  });
});

describe('ProviderTierChanged payload', () => {
  const valid = {
    eventId: 'evt_tier_1',
    occurredAt: '2026-05-16T12:00:00.000Z',
    providerId: 'prov_abc',
    fromTier: 'basic' as const,
    toTier: 'certified' as const,
    reason: 'auto_evaluation' as const,
    triggeredByUserId: 'user_ops',
  };

  it('accepts a valid payload', () => {
    expect(eventRegistry[PROVIDER_TIER_CHANGED].safeParse(valid).success).toBe(true);
  });

  it('accepts `fromTier: null` for the first transition on a row', () => {
    expect(
      eventRegistry[PROVIDER_TIER_CHANGED].safeParse({ ...valid, fromTier: null }).success,
    ).toBe(true);
  });

  it('accepts `triggeredByUserId: null` (system-driven transition)', () => {
    expect(
      eventRegistry[PROVIDER_TIER_CHANGED].safeParse({ ...valid, triggeredByUserId: null }).success,
    ).toBe(true);
  });

  it('rejects unknown reason values', () => {
    expect(
      eventRegistry[PROVIDER_TIER_CHANGED].safeParse({ ...valid, reason: 'expiry' }).success,
    ).toBe(false);
  });

  it('rejects unknown tier values', () => {
    expect(
      eventRegistry[PROVIDER_TIER_CHANGED].safeParse({ ...valid, toTier: 'platinum' }).success,
    ).toBe(false);
  });

  it('rejects unknown fields (`.strict()`)', () => {
    expect(
      eventRegistry[PROVIDER_TIER_CHANGED].safeParse({ ...valid, extra: 'oops' }).success,
    ).toBe(false);
  });
});

describe('ProviderProfileUpdated payload (TS-200)', () => {
  const valid = {
    eventId: 'evt_profile_1',
    occurredAt: '2026-05-20T12:00:00.000Z',
    providerId: 'prov_abc',
    changedKinds: ['bio', 'language'] as const,
    actorUserId: 'user_self',
  };

  it('accepts a valid payload', () => {
    expect(eventRegistry[PROVIDER_PROFILE_UPDATED].safeParse(valid).success).toBe(true);
  });

  it('accepts the full set of changedKinds', () => {
    expect(
      eventRegistry[PROVIDER_PROFILE_UPDATED].safeParse({
        ...valid,
        changedKinds: ['bio', 'dementia_sensitive', 'language', 'cuisine', 'dietary_expertise'],
      }).success,
    ).toBe(true);
  });

  it('accepts `actorUserId: null` (admin-override / system-edit forward path)', () => {
    expect(
      eventRegistry[PROVIDER_PROFILE_UPDATED].safeParse({ ...valid, actorUserId: null }).success,
    ).toBe(true);
  });

  it('rejects an empty changedKinds array (every emission must touch something)', () => {
    expect(
      eventRegistry[PROVIDER_PROFILE_UPDATED].safeParse({ ...valid, changedKinds: [] }).success,
    ).toBe(false);
  });

  it('rejects unknown changedKinds values', () => {
    expect(
      eventRegistry[PROVIDER_PROFILE_UPDATED].safeParse({
        ...valid,
        changedKinds: ['display_name'],
      }).success,
    ).toBe(false);
  });

  it('rejects unknown fields (`.strict()`)', () => {
    expect(
      eventRegistry[PROVIDER_PROFILE_UPDATED].safeParse({ ...valid, extra: 'oops' }).success,
    ).toBe(false);
  });
});

describe('ProviderAvailabilityUpdated payload (TS-203)', () => {
  const valid = {
    eventId: 'evt_avail_1',
    occurredAt: '2026-05-20T12:00:00.000Z',
    providerId: 'prov_abc',
    windowCount: 3,
    exceptionCount: 1,
    actorUserId: 'user_self',
  };

  it('accepts a valid payload', () => {
    expect(eventRegistry[PROVIDER_AVAILABILITY_UPDATED].safeParse(valid).success).toBe(true);
  });

  it('accepts zero counts (full clear)', () => {
    expect(
      eventRegistry[PROVIDER_AVAILABILITY_UPDATED].safeParse({
        ...valid,
        windowCount: 0,
        exceptionCount: 0,
      }).success,
    ).toBe(true);
  });

  it('accepts `actorUserId: null` (admin-override / system forward path)', () => {
    expect(
      eventRegistry[PROVIDER_AVAILABILITY_UPDATED].safeParse({ ...valid, actorUserId: null })
        .success,
    ).toBe(true);
  });

  it('rejects negative counts', () => {
    expect(
      eventRegistry[PROVIDER_AVAILABILITY_UPDATED].safeParse({ ...valid, windowCount: -1 }).success,
    ).toBe(false);
  });

  it('rejects unknown fields (`.strict()`)', () => {
    expect(
      eventRegistry[PROVIDER_AVAILABILITY_UPDATED].safeParse({ ...valid, extra: 'oops' }).success,
    ).toBe(false);
  });
});

describe('ProviderServiceAreasUpdated payload (TS-202)', () => {
  const valid = {
    eventId: 'evt_areas_1',
    occurredAt: '2026-05-25T12:00:00.000Z',
    providerId: 'prov_abc',
    areaCount: 2,
    actorUserId: 'user_self',
  };

  it('accepts a valid payload', () => {
    expect(eventRegistry[PROVIDER_SERVICE_AREAS_UPDATED].safeParse(valid).success).toBe(true);
  });

  it('accepts zero areaCount (full clear)', () => {
    expect(
      eventRegistry[PROVIDER_SERVICE_AREAS_UPDATED].safeParse({ ...valid, areaCount: 0 }).success,
    ).toBe(true);
  });

  it('accepts `actorUserId: null` (admin-override / system forward path)', () => {
    expect(
      eventRegistry[PROVIDER_SERVICE_AREAS_UPDATED].safeParse({ ...valid, actorUserId: null })
        .success,
    ).toBe(true);
  });

  it('rejects negative areaCount', () => {
    expect(
      eventRegistry[PROVIDER_SERVICE_AREAS_UPDATED].safeParse({ ...valid, areaCount: -1 }).success,
    ).toBe(false);
  });

  it('rejects areaCount over the cap', () => {
    expect(
      eventRegistry[PROVIDER_SERVICE_AREAS_UPDATED].safeParse({ ...valid, areaCount: 11 }).success,
    ).toBe(false);
  });

  it('rejects unknown fields (`.strict()`)', () => {
    expect(
      eventRegistry[PROVIDER_SERVICE_AREAS_UPDATED].safeParse({ ...valid, extra: 'oops' }).success,
    ).toBe(false);
  });
});

describe('ProviderPricingUpdated payload (TS-204)', () => {
  const valid = {
    eventId: 'evt_pricing_1',
    occurredAt: '2026-05-25T12:00:00.000Z',
    providerId: 'prov_abc',
    hourlyRateMinor: 7500,
    currency: 'USD',
    tier: 'certified' as const,
    actorUserId: 'user_self',
  };

  it('accepts a valid payload', () => {
    expect(eventRegistry[PROVIDER_PRICING_UPDATED].safeParse(valid).success).toBe(true);
  });

  it('accepts `actorUserId: null` (admin-override / system forward path)', () => {
    expect(
      eventRegistry[PROVIDER_PRICING_UPDATED].safeParse({ ...valid, actorUserId: null }).success,
    ).toBe(true);
  });

  it('rejects a non-integer hourlyRateMinor', () => {
    expect(
      eventRegistry[PROVIDER_PRICING_UPDATED].safeParse({ ...valid, hourlyRateMinor: 75.5 })
        .success,
    ).toBe(false);
  });

  it('rejects a zero / negative hourlyRateMinor', () => {
    expect(
      eventRegistry[PROVIDER_PRICING_UPDATED].safeParse({ ...valid, hourlyRateMinor: 0 }).success,
    ).toBe(false);
  });

  it('rejects a currency that is not exactly 3 chars', () => {
    expect(
      eventRegistry[PROVIDER_PRICING_UPDATED].safeParse({ ...valid, currency: 'US' }).success,
    ).toBe(false);
  });

  it('rejects an unknown tier value', () => {
    expect(
      eventRegistry[PROVIDER_PRICING_UPDATED].safeParse({ ...valid, tier: 'platinum' }).success,
    ).toBe(false);
  });

  it('rejects unknown fields (`.strict()`)', () => {
    expect(
      eventRegistry[PROVIDER_PRICING_UPDATED].safeParse({ ...valid, extra: 'oops' }).success,
    ).toBe(false);
  });
});

describe('ProviderCalendarSynced payload (TS-206)', () => {
  const valid = {
    eventId: 'evt_cal_1',
    occurredAt: '2026-05-29T12:00:00.000Z',
    providerId: 'prov_abc',
    calendarProvider: 'google' as const,
    externalBusyCount: 12,
    actorUserId: 'user_self',
  };

  it('accepts a valid payload', () => {
    expect(eventRegistry[PROVIDER_CALENDAR_SYNCED].safeParse(valid).success).toBe(true);
  });

  it('accepts zero externalBusyCount (disconnect / empty calendar)', () => {
    expect(
      eventRegistry[PROVIDER_CALENDAR_SYNCED].safeParse({ ...valid, externalBusyCount: 0 }).success,
    ).toBe(true);
  });

  it('accepts `actorUserId: null` (periodic background re-sync)', () => {
    expect(
      eventRegistry[PROVIDER_CALENDAR_SYNCED].safeParse({ ...valid, actorUserId: null }).success,
    ).toBe(true);
  });

  it('rejects an unknown calendarProvider', () => {
    expect(
      eventRegistry[PROVIDER_CALENDAR_SYNCED].safeParse({ ...valid, calendarProvider: 'icloud' })
        .success,
    ).toBe(false);
  });

  it('rejects a negative externalBusyCount', () => {
    expect(
      eventRegistry[PROVIDER_CALENDAR_SYNCED].safeParse({ ...valid, externalBusyCount: -1 })
        .success,
    ).toBe(false);
  });

  it('rejects unknown fields (`.strict()`)', () => {
    expect(
      eventRegistry[PROVIDER_CALENDAR_SYNCED].safeParse({ ...valid, extra: 'oops' }).success,
    ).toBe(false);
  });
});
