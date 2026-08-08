import { describe, expect, it } from 'vitest';

import {
  SERVICE_CATALOG_CURRENCY_CODE_LENGTH,
  SERVICE_CATALOG_DEFAULT_CURRENCY,
  SERVICE_CATALOG_DESCRIPTION_MAX_LENGTH,
  SERVICE_CATALOG_DURATION_MAX_MINUTES,
  SERVICE_CATALOG_DURATION_MIN_MINUTES,
  SERVICE_CATALOG_NAME_MAX_LENGTH,
  SERVICE_CATALOG_RATE_MAX_MINOR,
  SERVICE_CATALOG_RATE_MIN_MINOR,
  SERVICE_CATALOG_SORT_POSITION_MAX,
  ServiceCatalogListResponseSchema,
  ServiceCatalogRecordSchema,
  UpsertServiceCatalogEntryRequestSchema,
  UpsertServiceCatalogEntryResponseSchema,
} from '../http/service-catalog.schema';

const validRecord = {
  kind: 'companion_dining' as const,
  name: 'Companion dining',
  description: 'A chef prepares and shares a meal with your loved one.',
  baseRateMinMinor: 15_000,
  baseRateMaxMinor: 25_000,
  durationMinutes: 120,
  currency: SERVICE_CATALOG_DEFAULT_CURRENCY,
  active: true,
  requiredProviderTier: null,
  sortPosition: 0,
  updatedAt: '2026-05-25T12:00:00.000Z',
};

const validUpsert = {
  name: 'Companion dining',
  description: 'A chef prepares and shares a meal with your loved one.',
  baseRateMinMinor: 15_000,
  baseRateMaxMinor: 25_000,
  durationMinutes: 120,
  currency: SERVICE_CATALOG_DEFAULT_CURRENCY,
  active: true,
  requiredProviderTier: null,
  sortPosition: 0,
};

describe('constants', () => {
  it('USD default is 3 chars long', () => {
    expect(SERVICE_CATALOG_DEFAULT_CURRENCY).toHaveLength(SERVICE_CATALOG_CURRENCY_CODE_LENGTH);
  });

  it('rate rail floor ≤ ceiling, duration rail floor ≤ ceiling', () => {
    expect(SERVICE_CATALOG_RATE_MIN_MINOR).toBeLessThanOrEqual(SERVICE_CATALOG_RATE_MAX_MINOR);
    expect(SERVICE_CATALOG_DURATION_MIN_MINUTES).toBeLessThanOrEqual(
      SERVICE_CATALOG_DURATION_MAX_MINUTES,
    );
  });
});

describe('ServiceCatalogRecordSchema', () => {
  it('accepts a well-formed record', () => {
    expect(ServiceCatalogRecordSchema.parse(validRecord)).toMatchObject({
      kind: 'companion_dining',
      baseRateMinMinor: 15_000,
      baseRateMaxMinor: 25_000,
    });
  });

  it('accepts a band whose floor equals its ceiling', () => {
    expect(
      ServiceCatalogRecordSchema.safeParse({
        ...validRecord,
        baseRateMinMinor: 20_000,
        baseRateMaxMinor: 20_000,
      }).success,
    ).toBe(true);
  });

  it('rejects an inverted band (min > max)', () => {
    const result = ServiceCatalogRecordSchema.safeParse({
      ...validRecord,
      baseRateMinMinor: 25_000,
      baseRateMaxMinor: 15_000,
    });
    expect(result.success).toBe(false);
  });

  it('rejects an unknown service kind', () => {
    expect(ServiceCatalogRecordSchema.safeParse({ ...validRecord, kind: 'spa_day' }).success).toBe(
      false,
    );
  });

  it('rejects a non-integer rate', () => {
    expect(
      ServiceCatalogRecordSchema.safeParse({ ...validRecord, baseRateMinMinor: 150.5 }).success,
    ).toBe(false);
  });

  it('rejects a rate below the platform floor', () => {
    expect(
      ServiceCatalogRecordSchema.safeParse({
        ...validRecord,
        baseRateMinMinor: SERVICE_CATALOG_RATE_MIN_MINOR - 1,
        baseRateMaxMinor: SERVICE_CATALOG_RATE_MIN_MINOR - 1,
      }).success,
    ).toBe(false);
  });

  it('rejects a rate above the platform ceiling', () => {
    expect(
      ServiceCatalogRecordSchema.safeParse({
        ...validRecord,
        baseRateMaxMinor: SERVICE_CATALOG_RATE_MAX_MINOR + 1,
      }).success,
    ).toBe(false);
  });

  it('rejects a duration below the floor and above the ceiling', () => {
    expect(
      ServiceCatalogRecordSchema.safeParse({
        ...validRecord,
        durationMinutes: SERVICE_CATALOG_DURATION_MIN_MINUTES - 1,
      }).success,
    ).toBe(false);
    expect(
      ServiceCatalogRecordSchema.safeParse({
        ...validRecord,
        durationMinutes: SERVICE_CATALOG_DURATION_MAX_MINUTES + 1,
      }).success,
    ).toBe(false);
  });

  it('rejects a currency code that is not exactly 3 chars', () => {
    expect(ServiceCatalogRecordSchema.safeParse({ ...validRecord, currency: 'US' }).success).toBe(
      false,
    );
    expect(ServiceCatalogRecordSchema.safeParse({ ...validRecord, currency: 'USDX' }).success).toBe(
      false,
    );
  });

  it('rejects an over-length name', () => {
    expect(
      ServiceCatalogRecordSchema.safeParse({
        ...validRecord,
        name: 'x'.repeat(SERVICE_CATALOG_NAME_MAX_LENGTH + 1),
      }).success,
    ).toBe(false);
  });

  it('rejects an over-length description', () => {
    expect(
      ServiceCatalogRecordSchema.safeParse({
        ...validRecord,
        description: 'x'.repeat(SERVICE_CATALOG_DESCRIPTION_MAX_LENGTH + 1),
      }).success,
    ).toBe(false);
  });

  it('rejects a sort position above the rail', () => {
    expect(
      ServiceCatalogRecordSchema.safeParse({
        ...validRecord,
        sortPosition: SERVICE_CATALOG_SORT_POSITION_MAX + 1,
      }).success,
    ).toBe(false);
  });

  it('rejects unknown fields (strict)', () => {
    expect(ServiceCatalogRecordSchema.safeParse({ ...validRecord, surprise: true }).success).toBe(
      false,
    );
  });

  it('rejects a non-ISO updatedAt', () => {
    expect(
      ServiceCatalogRecordSchema.safeParse({ ...validRecord, updatedAt: 'yesterday' }).success,
    ).toBe(false);
  });

  it('accepts a Tier-3 concierge kind requiring an elite provider', () => {
    const result = ServiceCatalogRecordSchema.safeParse({
      ...validRecord,
      kind: 'tea_social',
      requiredProviderTier: 'elite',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.requiredProviderTier).toBe('elite');
    }
  });

  it('accepts each provider tier for requiredProviderTier', () => {
    for (const tier of ['basic', 'certified', 'elite'] as const) {
      expect(
        ServiceCatalogRecordSchema.safeParse({ ...validRecord, requiredProviderTier: tier })
          .success,
      ).toBe(true);
    }
  });

  it('rejects an unknown requiredProviderTier', () => {
    expect(
      ServiceCatalogRecordSchema.safeParse({ ...validRecord, requiredProviderTier: 'platinum' })
        .success,
    ).toBe(false);
  });

  it('rejects a missing requiredProviderTier (required, may be null)', () => {
    const { requiredProviderTier: _omit, ...withoutTier } = validRecord;
    expect(ServiceCatalogRecordSchema.safeParse(withoutTier).success).toBe(false);
  });
});

describe('ServiceCatalogListResponseSchema', () => {
  it('accepts an empty list', () => {
    expect(ServiceCatalogListResponseSchema.parse({ entries: [] })).toEqual({ entries: [] });
  });

  it('accepts a list of records', () => {
    expect(
      ServiceCatalogListResponseSchema.safeParse({ entries: [validRecord, validRecord] }).success,
    ).toBe(true);
  });

  it('rejects a list with a malformed entry', () => {
    expect(
      ServiceCatalogListResponseSchema.safeParse({
        entries: [{ ...validRecord, baseRateMinMinor: -1 }],
      }).success,
    ).toBe(false);
  });
});

describe('UpsertServiceCatalogEntryRequestSchema', () => {
  it('accepts a well-formed upsert body', () => {
    expect(UpsertServiceCatalogEntryRequestSchema.parse(validUpsert)).toMatchObject({
      name: 'Companion dining',
      active: true,
    });
  });

  it('does not accept a kind field (kind is the path param)', () => {
    expect(
      UpsertServiceCatalogEntryRequestSchema.safeParse({
        ...validUpsert,
        kind: 'companion_dining',
      }).success,
    ).toBe(false);
  });

  it('rejects an inverted band', () => {
    expect(
      UpsertServiceCatalogEntryRequestSchema.safeParse({
        ...validUpsert,
        baseRateMinMinor: 30_000,
        baseRateMaxMinor: 10_000,
      }).success,
    ).toBe(false);
  });

  it('rejects a missing required field', () => {
    const { durationMinutes: _omit, ...withoutDuration } = validUpsert;
    expect(UpsertServiceCatalogEntryRequestSchema.safeParse(withoutDuration).success).toBe(false);
  });

  it('accepts an elite requiredProviderTier (Tier-3 concierge experience)', () => {
    expect(
      UpsertServiceCatalogEntryRequestSchema.safeParse({
        ...validUpsert,
        requiredProviderTier: 'elite',
      }).success,
    ).toBe(true);
  });

  it('rejects a missing requiredProviderTier (required, may be null)', () => {
    const { requiredProviderTier: _omit, ...withoutTier } = validUpsert;
    expect(UpsertServiceCatalogEntryRequestSchema.safeParse(withoutTier).success).toBe(false);
  });
});

describe('UpsertServiceCatalogEntryResponseSchema', () => {
  it('wraps a record under { entry }', () => {
    expect(UpsertServiceCatalogEntryResponseSchema.safeParse({ entry: validRecord }).success).toBe(
      true,
    );
  });

  it('rejects a bare record (must be wrapped)', () => {
    expect(UpsertServiceCatalogEntryResponseSchema.safeParse(validRecord).success).toBe(false);
  });
});
