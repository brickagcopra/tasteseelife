import { describe, expect, it } from 'vitest';

import {
  ComputeSaasMetricsRequestSchema,
  ComputeSaasMetricsResponseSchema,
  ListSaasMetricsResponseSchema,
  SAAS_METRICS_DATE_REGEX,
  SAAS_METRICS_MAX_MINOR,
  SAAS_METRICS_MAX_RETENTION_PPM,
  SAAS_METRICS_PPM_SCALE,
  SAAS_METRICS_RANGE_MAX_ROWS,
  SaasMetricsDateSchema,
  SaasMetricsRangeQuerySchema,
  SaasMetricsRecordSchema,
} from '../http/saas-metrics.schema';

function validRecord() {
  return {
    metricDate: '2026-05-28',
    currency: 'USD' as const,
    mrrMinor: 1_500_000,
    arrMinor: 18_000_000,
    arpuMinor: 15_000,
    activeSubscriptions: 100,
    newMrrMinor: 30_000,
    expansionMrrMinor: 5_000,
    contractionMrrMinor: 2_000,
    churnedMrrMinor: 9_000,
    churnedSubscriptions: 3,
    netNewMrrMinor: 24_000,
    priorMrrMinor: 1_476_000,
    netRevenueRetentionPpm: 1_002_710,
    grossRevenueRetentionPpm: 992_547,
    ltvMinor: null,
    cacMinor: null,
    comparisonDate: '2026-05-27',
    computedAt: '2026-05-28T02:00:00.000Z',
  };
}

describe('SaasMetricsDateSchema', () => {
  it('accepts UTC calendar dates', () => {
    expect(SaasMetricsDateSchema.parse('2026-05-28')).toBe('2026-05-28');
    expect(SaasMetricsDateSchema.parse('2026-01-01')).toBe('2026-01-01');
  });

  it('rejects datetimes, partial dates, and garbage', () => {
    expect(SaasMetricsDateSchema.safeParse('2026-05-28T00:00:00Z').success).toBe(false);
    expect(SaasMetricsDateSchema.safeParse('2026-5-8').success).toBe(false);
    expect(SaasMetricsDateSchema.safeParse('2026/05/28').success).toBe(false);
    expect(SaasMetricsDateSchema.safeParse('not-a-date').success).toBe(false);
  });

  it('exposes the regex constant for downstream reuse', () => {
    expect(SAAS_METRICS_DATE_REGEX.test('2026-05-28')).toBe(true);
    expect(SAAS_METRICS_DATE_REGEX.test('2026-05-28T00:00:00Z')).toBe(false);
  });
});

describe('SaasMetricsRecordSchema', () => {
  it('accepts a fully-populated record', () => {
    expect(SaasMetricsRecordSchema.parse(validRecord())).toEqual(validRecord());
  });

  it('accepts null retention + LTV/CAC (first-run / Phase-1 shape)', () => {
    const record = {
      ...validRecord(),
      netRevenueRetentionPpm: null,
      grossRevenueRetentionPpm: null,
      ltvMinor: null,
      cacMinor: null,
      comparisonDate: null,
    };
    expect(SaasMetricsRecordSchema.parse(record)).toEqual(record);
  });

  it('allows a negative netNewMrrMinor (contraction + churn heavy day)', () => {
    const record = { ...validRecord(), netNewMrrMinor: -50_000 };
    expect(SaasMetricsRecordSchema.safeParse(record).success).toBe(true);
  });

  it('rejects a negative magnitude on a non-net field', () => {
    expect(SaasMetricsRecordSchema.safeParse({ ...validRecord(), mrrMinor: -1 }).success).toBe(
      false,
    );
    expect(
      SaasMetricsRecordSchema.safeParse({ ...validRecord(), churnedMrrMinor: -1 }).success,
    ).toBe(false);
  });

  it('rejects non-integer monetary fields', () => {
    expect(SaasMetricsRecordSchema.safeParse({ ...validRecord(), mrrMinor: 10.5 }).success).toBe(
      false,
    );
  });

  it('rejects monetary fields above the Decimal(12,2) envelope', () => {
    expect(
      SaasMetricsRecordSchema.safeParse({
        ...validRecord(),
        arrMinor: SAAS_METRICS_MAX_MINOR + 1,
      }).success,
    ).toBe(false);
  });

  it('rejects retention ppm above the Decimal(9,6) envelope', () => {
    expect(
      SaasMetricsRecordSchema.safeParse({
        ...validRecord(),
        netRevenueRetentionPpm: SAAS_METRICS_MAX_RETENTION_PPM + 1,
      }).success,
    ).toBe(false);
  });

  it('rejects unknown fields (strict)', () => {
    expect(SaasMetricsRecordSchema.safeParse({ ...validRecord(), extra: 1 }).success).toBe(false);
  });

  it('rejects a datetime in metricDate / comparisonDate', () => {
    expect(
      SaasMetricsRecordSchema.safeParse({
        ...validRecord(),
        metricDate: '2026-05-28T02:00:00.000Z',
      }).success,
    ).toBe(false);
  });

  it('exposes the ppm scale constant (1.0 === 1,000,000 ppm)', () => {
    expect(SAAS_METRICS_PPM_SCALE).toBe(1_000_000);
  });
});

describe('ComputeSaasMetricsRequestSchema', () => {
  it('accepts an empty body (asOf defaults server-side)', () => {
    expect(ComputeSaasMetricsRequestSchema.parse({})).toEqual({});
  });

  it('accepts an explicit ISO-8601 asOf', () => {
    const body = { asOf: '2026-05-15T00:00:00.000Z' };
    expect(ComputeSaasMetricsRequestSchema.parse(body)).toEqual(body);
  });

  it('rejects a date-only asOf (must be a full datetime)', () => {
    expect(ComputeSaasMetricsRequestSchema.safeParse({ asOf: '2026-05-15' }).success).toBe(false);
  });

  it('rejects unknown fields (strict)', () => {
    expect(ComputeSaasMetricsRequestSchema.safeParse({ when: 'now' }).success).toBe(false);
  });
});

describe('ComputeSaasMetricsResponseSchema', () => {
  it('wraps the record plus the snapshot count', () => {
    const body = { metrics: validRecord(), subscriptionsSnapshotted: 100 };
    expect(ComputeSaasMetricsResponseSchema.parse(body)).toEqual(body);
  });

  it('rejects a negative snapshot count', () => {
    expect(
      ComputeSaasMetricsResponseSchema.safeParse({
        metrics: validRecord(),
        subscriptionsSnapshotted: -1,
      }).success,
    ).toBe(false);
  });

  it('rejects a malformed nested record', () => {
    expect(
      ComputeSaasMetricsResponseSchema.safeParse({
        metrics: { ...validRecord(), mrrMinor: -1 },
        subscriptionsSnapshotted: 0,
      }).success,
    ).toBe(false);
  });
});

describe('SaasMetricsRangeQuerySchema', () => {
  it('accepts an empty query (both bounds unbounded)', () => {
    expect(SaasMetricsRangeQuerySchema.parse({})).toEqual({});
  });

  it('accepts a from-only / to-only / both range', () => {
    expect(SaasMetricsRangeQuerySchema.parse({ from: '2026-01-01' })).toEqual({
      from: '2026-01-01',
    });
    expect(SaasMetricsRangeQuerySchema.parse({ to: '2026-05-28' })).toEqual({
      to: '2026-05-28',
    });
    const both = { from: '2026-01-01', to: '2026-05-28' };
    expect(SaasMetricsRangeQuerySchema.parse(both)).toEqual(both);
  });

  it('accepts from === to (single-day window)', () => {
    const same = { from: '2026-05-28', to: '2026-05-28' };
    expect(SaasMetricsRangeQuerySchema.parse(same)).toEqual(same);
  });

  it('rejects from after to', () => {
    expect(
      SaasMetricsRangeQuerySchema.safeParse({ from: '2026-05-28', to: '2026-01-01' }).success,
    ).toBe(false);
  });

  it('rejects a datetime bound (must be a calendar date)', () => {
    expect(
      SaasMetricsRangeQuerySchema.safeParse({ from: '2026-05-28T00:00:00.000Z' }).success,
    ).toBe(false);
  });

  it('rejects unknown fields (strict)', () => {
    expect(SaasMetricsRangeQuerySchema.safeParse({ window: '90d' }).success).toBe(false);
  });

  it('exposes the row-cap constant', () => {
    expect(SAAS_METRICS_RANGE_MAX_ROWS).toBe(400);
  });
});

describe('ListSaasMetricsResponseSchema', () => {
  it('accepts an ascending series plus echoed window bounds', () => {
    const body = {
      metrics: [validRecord()],
      from: '2026-05-28',
      to: '2026-05-28',
    };
    expect(ListSaasMetricsResponseSchema.parse(body)).toEqual(body);
  });

  it('accepts an empty series with null bounds (no rows in range)', () => {
    const body = { metrics: [], from: null, to: null };
    expect(ListSaasMetricsResponseSchema.parse(body)).toEqual(body);
  });

  it('rejects a malformed nested record', () => {
    expect(
      ListSaasMetricsResponseSchema.safeParse({
        metrics: [{ ...validRecord(), arrMinor: -1 }],
        from: '2026-05-28',
        to: '2026-05-28',
      }).success,
    ).toBe(false);
  });

  it('rejects unknown fields (strict)', () => {
    expect(
      ListSaasMetricsResponseSchema.safeParse({
        metrics: [],
        from: null,
        to: null,
        total: 0,
      }).success,
    ).toBe(false);
  });
});
