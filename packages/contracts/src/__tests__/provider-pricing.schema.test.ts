import { describe, expect, it } from 'vitest';

import {
  PROVIDER_PRICING_BANDS,
  PROVIDER_PRICING_CURRENCY_CODE_LENGTH,
  PROVIDER_PRICING_DEFAULT_CURRENCY,
  PROVIDER_PRICING_RATE_MAX_MINOR,
  PROVIDER_PRICING_RATE_MIN_MINOR,
  ProviderPricingBandSchema,
  ProviderPricingRecordSchema,
  ProviderPricingSnapshotResponseSchema,
  UpdateProviderPricingRequestSchema,
  UpdateProviderPricingResponseSchema,
  resolveProviderPricingBand,
} from '../http/provider-pricing.schema';

describe('PROVIDER_PRICING_BANDS (platform policy)', () => {
  it('defines a band for every tier', () => {
    expect(Object.keys(PROVIDER_PRICING_BANDS).sort()).toEqual(['basic', 'certified', 'elite']);
  });

  it('keeps every band min ≤ max and inside the absolute platform rail', () => {
    for (const band of Object.values(PROVIDER_PRICING_BANDS)) {
      expect(band.minHourlyRateMinor).toBeLessThanOrEqual(band.maxHourlyRateMinor);
      expect(band.minHourlyRateMinor).toBeGreaterThanOrEqual(PROVIDER_PRICING_RATE_MIN_MINOR);
      expect(band.maxHourlyRateMinor).toBeLessThanOrEqual(PROVIDER_PRICING_RATE_MAX_MINOR);
    }
  });

  it('widens the band with tier (basic ≤ certified ≤ elite ceilings)', () => {
    expect(PROVIDER_PRICING_BANDS.basic.maxHourlyRateMinor).toBeLessThanOrEqual(
      PROVIDER_PRICING_BANDS.certified.maxHourlyRateMinor,
    );
    expect(PROVIDER_PRICING_BANDS.certified.maxHourlyRateMinor).toBeLessThanOrEqual(
      PROVIDER_PRICING_BANDS.elite.maxHourlyRateMinor,
    );
  });

  it('default currency is USD (Phase-1 launch — PRD §11.4)', () => {
    expect(PROVIDER_PRICING_DEFAULT_CURRENCY).toBe('USD');
    expect(PROVIDER_PRICING_DEFAULT_CURRENCY).toHaveLength(PROVIDER_PRICING_CURRENCY_CODE_LENGTH);
  });
});

describe('resolveProviderPricingBand', () => {
  it('returns the band record for each tier', () => {
    const band = resolveProviderPricingBand('certified');
    expect(band).toEqual({
      tier: 'certified',
      minHourlyRateMinor: PROVIDER_PRICING_BANDS.certified.minHourlyRateMinor,
      maxHourlyRateMinor: PROVIDER_PRICING_BANDS.certified.maxHourlyRateMinor,
    });
  });

  it('produces a value the ProviderPricingBandSchema accepts', () => {
    for (const tier of ['basic', 'certified', 'elite'] as const) {
      expect(ProviderPricingBandSchema.safeParse(resolveProviderPricingBand(tier)).success).toBe(
        true,
      );
    }
  });
});

describe('ProviderPricingBandSchema', () => {
  it('rejects a band whose min exceeds its max', () => {
    expect(
      ProviderPricingBandSchema.safeParse({
        tier: 'basic',
        minHourlyRateMinor: 9000,
        maxHourlyRateMinor: 4000,
      }).success,
    ).toBe(false);
  });

  it('rejects unknown fields (`.strict()`)', () => {
    expect(
      ProviderPricingBandSchema.safeParse({
        tier: 'basic',
        minHourlyRateMinor: 4000,
        maxHourlyRateMinor: 8000,
        extra: 'oops',
      }).success,
    ).toBe(false);
  });
});

describe('UpdateProviderPricingRequestSchema', () => {
  const valid = { hourlyRateMinor: 7500, currency: 'USD' };

  it('accepts a valid body', () => {
    expect(UpdateProviderPricingRequestSchema.safeParse(valid).success).toBe(true);
  });

  it('rejects a non-integer rate', () => {
    expect(
      UpdateProviderPricingRequestSchema.safeParse({ ...valid, hourlyRateMinor: 75.5 }).success,
    ).toBe(false);
  });

  it('rejects a rate below the absolute platform floor', () => {
    expect(
      UpdateProviderPricingRequestSchema.safeParse({
        ...valid,
        hourlyRateMinor: PROVIDER_PRICING_RATE_MIN_MINOR - 1,
      }).success,
    ).toBe(false);
  });

  it('rejects a rate above the absolute platform ceiling', () => {
    expect(
      UpdateProviderPricingRequestSchema.safeParse({
        ...valid,
        hourlyRateMinor: PROVIDER_PRICING_RATE_MAX_MINOR + 1,
      }).success,
    ).toBe(false);
  });

  it('rejects a currency that is not exactly 3 chars', () => {
    expect(UpdateProviderPricingRequestSchema.safeParse({ ...valid, currency: 'US' }).success).toBe(
      false,
    );
  });

  it('rejects unknown fields (`.strict()`)', () => {
    expect(UpdateProviderPricingRequestSchema.safeParse({ ...valid, extra: 'oops' }).success).toBe(
      false,
    );
  });
});

describe('ProviderPricingRecordSchema', () => {
  const valid = {
    providerId: 'prov_abc',
    status: 'active' as const,
    tier: 'certified' as const,
    hourlyRateMinor: 7500,
    currency: 'USD',
    band: resolveProviderPricingBand('certified'),
    updatedAt: '2026-05-25T12:00:00.000Z',
  };

  it('accepts a fully-populated record', () => {
    expect(ProviderPricingRecordSchema.safeParse(valid).success).toBe(true);
  });

  it('accepts a record with both rate + currency null (no rate set yet)', () => {
    expect(
      ProviderPricingRecordSchema.safeParse({ ...valid, hourlyRateMinor: null, currency: null })
        .success,
    ).toBe(true);
  });

  it('rejects a half-populated record (rate set, currency null)', () => {
    expect(ProviderPricingRecordSchema.safeParse({ ...valid, currency: null }).success).toBe(false);
  });

  it('rejects a half-populated record (currency set, rate null)', () => {
    expect(ProviderPricingRecordSchema.safeParse({ ...valid, hourlyRateMinor: null }).success).toBe(
      false,
    );
  });

  it('rejects a non-ISO updatedAt', () => {
    expect(ProviderPricingRecordSchema.safeParse({ ...valid, updatedAt: 'now' }).success).toBe(
      false,
    );
  });

  it('rejects unknown fields (`.strict()`)', () => {
    expect(ProviderPricingRecordSchema.safeParse({ ...valid, extra: 'oops' }).success).toBe(false);
  });
});

describe('UpdateProviderPricingResponseSchema / ProviderPricingSnapshotResponseSchema', () => {
  const record = {
    providerId: 'prov_abc',
    status: 'active' as const,
    tier: 'elite' as const,
    hourlyRateMinor: 15000,
    currency: 'USD',
    band: resolveProviderPricingBand('elite'),
    updatedAt: '2026-05-25T12:00:00.000Z',
  };

  it('wraps the record in { pricing } on the PUT response', () => {
    expect(UpdateProviderPricingResponseSchema.safeParse({ pricing: record }).success).toBe(true);
  });

  it('accepts a null pricing on the snapshot (pre-application provider)', () => {
    expect(ProviderPricingSnapshotResponseSchema.safeParse({ pricing: null }).success).toBe(true);
  });

  it('accepts a populated pricing on the snapshot', () => {
    expect(ProviderPricingSnapshotResponseSchema.safeParse({ pricing: record }).success).toBe(true);
  });
});
