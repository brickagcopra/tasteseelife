import { describe, expect, it } from 'vitest';

import {
  FamilyWellnessTrendsResponseSchema,
  WELLNESS_TREND_METRICS,
  WELLNESS_TREND_SCORE_MAX,
  WELLNESS_TREND_WINDOW_DAYS_DEFAULT,
  WellnessTrendPointSchema,
  WellnessTrendSeriesSchema,
  WellnessTrendsQuerySchema,
  WellnessTrendsResponseSchema,
  wellnessLevelsForMetric,
  wellnessScoreForLevel,
  type WellnessTrendMetric,
} from '../http/wellness-trends.schema';

/**
 * Contract tests for the TS-231 wellness-trend DTOs + the shared
 * ordinal→score mapping.
 */

const VALID_POINT = {
  bookingId: 'bkg_123',
  visitDate: '2026-05-20T17:00:00.000Z',
  recordedAt: '2026-05-20T18:30:00.000Z',
  level: 'bright',
  score: 4,
};

describe('wellnessScoreForLevel', () => {
  it.each([
    ['mood', 'low', 1],
    ['mood', 'joyful', 5],
    ['appetite', 'none', 1],
    ['appetite', 'robust', 5],
    ['hydration', 'poor', 1],
    ['hydration', 'excellent', 5],
    ['social_engagement', 'withdrawn', 1],
    ['social_engagement', 'vibrant', 5],
  ])('maps %s level "%s" to score %i', (metric, level, score) => {
    expect(wellnessScoreForLevel(metric as WellnessTrendMetric, level)).toBe(score);
  });

  it('returns null for a level not in the scale', () => {
    expect(wellnessScoreForLevel('mood', 'robust')).toBeNull();
    expect(wellnessScoreForLevel('appetite', 'joyful')).toBeNull();
    expect(wellnessScoreForLevel('hydration', 'not-a-level')).toBeNull();
  });

  it('maps every level of every scale to a 1..5 score in order', () => {
    for (const metric of WELLNESS_TREND_METRICS) {
      const levels = wellnessLevelsForMetric(metric);
      expect(levels).toHaveLength(WELLNESS_TREND_SCORE_MAX);
      levels.forEach((level, index) => {
        expect(wellnessScoreForLevel(metric, level)).toBe(index + 1);
      });
    }
  });
});

describe('WellnessTrendsQuerySchema', () => {
  it('defaults windowDays for an empty query', () => {
    expect(WellnessTrendsQuerySchema.parse({}).windowDays).toBe(WELLNESS_TREND_WINDOW_DAYS_DEFAULT);
  });

  it.each([30, 90])('accepts windowDays=%s (coerced from string)', (value) => {
    expect(WellnessTrendsQuerySchema.parse({ windowDays: String(value) }).windowDays).toBe(value);
  });

  it.each([7, 14, 60, 365, 0, -30])('rejects an unsupported windowDays=%s', (value) => {
    expect(WellnessTrendsQuerySchema.safeParse({ windowDays: String(value) }).success).toBe(false);
  });

  it('rejects unknown fields (.strict)', () => {
    expect(WellnessTrendsQuerySchema.safeParse({ seniorId: 'snr_1' }).success).toBe(false);
  });
});

describe('WellnessTrendPointSchema', () => {
  it('accepts a well-formed point', () => {
    expect(WellnessTrendPointSchema.safeParse(VALID_POINT).success).toBe(true);
  });

  it.each([0, 6, -1, 2.5])('rejects an out-of-range or non-integer score=%s', (score) => {
    expect(WellnessTrendPointSchema.safeParse({ ...VALID_POINT, score }).success).toBe(false);
  });

  it('rejects a non-datetime visitDate', () => {
    expect(
      WellnessTrendPointSchema.safeParse({ ...VALID_POINT, visitDate: '2026-05-20' }).success,
    ).toBe(false);
  });

  it('rejects unknown fields (.strict)', () => {
    expect(WellnessTrendPointSchema.safeParse({ ...VALID_POINT, metric: 'mood' }).success).toBe(
      false,
    );
  });
});

describe('WellnessTrendSeriesSchema', () => {
  const series = {
    metric: 'mood',
    points: [VALID_POINT],
    latestScore: 4,
    visitsRecorded: 1,
  };

  it('accepts a populated series', () => {
    expect(WellnessTrendSeriesSchema.safeParse(series).success).toBe(true);
  });

  it('accepts an empty series with a null latestScore', () => {
    expect(
      WellnessTrendSeriesSchema.safeParse({
        metric: 'appetite',
        points: [],
        latestScore: null,
        visitsRecorded: 0,
      }).success,
    ).toBe(true);
  });

  it('rejects an unknown metric', () => {
    expect(WellnessTrendSeriesSchema.safeParse({ ...series, metric: 'mobility' }).success).toBe(
      false,
    );
  });

  it('rejects a negative visitsRecorded', () => {
    expect(WellnessTrendSeriesSchema.safeParse({ ...series, visitsRecorded: -1 }).success).toBe(
      false,
    );
  });
});

describe('WellnessTrendsResponseSchema', () => {
  const response = {
    seniorId: 'snr_123',
    windowDays: 30,
    totalCompletedVisits: 3,
    series: WELLNESS_TREND_METRICS.map((metric) => ({
      metric,
      points: [],
      latestScore: null,
      visitsRecorded: 0,
    })),
    generatedAt: '2026-05-27T12:00:00.000Z',
  };

  it('accepts a well-formed response', () => {
    expect(WellnessTrendsResponseSchema.safeParse(response).success).toBe(true);
  });

  it.each([7, 60])('rejects an unsupported windowDays=%s', (windowDays) => {
    expect(WellnessTrendsResponseSchema.safeParse({ ...response, windowDays }).success).toBe(false);
  });

  it('rejects unknown fields (.strict) — no `shared` leaks into the service shape', () => {
    expect(WellnessTrendsResponseSchema.safeParse({ ...response, shared: true }).success).toBe(
      false,
    );
  });
});

describe('FamilyWellnessTrendsResponseSchema', () => {
  const shape = {
    seniorId: 'snr_123',
    shared: true,
    windowDays: 90,
    totalCompletedVisits: 5,
    series: WELLNESS_TREND_METRICS.map((metric) => ({
      metric,
      points: [],
      latestScore: null,
      visitsRecorded: 0,
    })),
    generatedAt: '2026-05-27T12:00:00.000Z',
  };

  it('accepts the shared aggregate', () => {
    expect(FamilyWellnessTrendsResponseSchema.safeParse(shape).success).toBe(true);
  });

  it('accepts the not-shared empty shape', () => {
    expect(
      FamilyWellnessTrendsResponseSchema.safeParse({
        ...shape,
        shared: false,
        totalCompletedVisits: 0,
        series: [],
      }).success,
    ).toBe(true);
  });

  it('requires the shared flag', () => {
    const { shared: _shared, ...withoutShared } = shape;
    expect(FamilyWellnessTrendsResponseSchema.safeParse(withoutShared).success).toBe(false);
  });
});
