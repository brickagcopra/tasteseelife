import { describe, expect, it } from 'vitest';

import {
  wellnessLevelsForMetric,
  type WellnessTrendMetric,
  type WellnessTrendPoint,
  type WellnessTrendSeries,
} from '../http/wellness-trends.schema';
import {
  FamilyWellnessAnomalyResponseSchema,
  WELLNESS_ANOMALY_DROP_HIGH,
  WELLNESS_ANOMALY_DROP_MODERATE,
  WELLNESS_ANOMALY_MIN_POINTS,
  WELLNESS_ANOMALY_RECENT_WINDOW,
  WellnessAnomalyFlagSchema,
  WellnessAnomalyResponseSchema,
  detectWellnessAnomalies,
  detectWellnessAnomaly,
} from '../http/wellness-anomaly.schema';

/**
 * Build a one-scale trend series from a chronological list of 1..5
 * scores. `level` is the scale's own ordinal word at that score, so the
 * flag's echoed `latestLevel` reads realistically.
 */
function seriesOf(metric: WellnessTrendMetric, scores: readonly number[]): WellnessTrendSeries {
  const levels = wellnessLevelsForMetric(metric);
  const points: WellnessTrendPoint[] = scores.map((score, index) => ({
    bookingId: `bk_${index}`,
    visitDate: new Date(Date.UTC(2026, 0, index + 1)).toISOString(),
    recordedAt: new Date(Date.UTC(2026, 0, index + 1, 18)).toISOString(),
    level: levels[score - 1] ?? 'neutral',
    score,
  }));
  const latest = points.at(-1);
  return {
    metric,
    points,
    latestScore: latest?.score ?? null,
    visitsRecorded: points.length,
  };
}

describe('detectWellnessAnomaly', () => {
  it('returns null below the minimum sample size', () => {
    expect(detectWellnessAnomaly(seriesOf('appetite', [5, 1]))).toBeNull();
    expect(detectWellnessAnomaly(seriesOf('appetite', [5, 5, 1]))).toBeNull();
    // exactly one short of the floor
    expect(seriesOf('appetite', [5, 5, 1]).points).toHaveLength(WELLNESS_ANOMALY_MIN_POINTS - 1);
  });

  it('returns null for a stable series', () => {
    expect(detectWellnessAnomaly(seriesOf('mood', [4, 4, 4, 4]))).toBeNull();
  });

  it('returns null for a persistently low (but not declining) series', () => {
    // All `minimal` appetite — concerning in absolute terms, but a steady
    // state, not a decline. Owned by the welfare path + a future
    // absolute-floor detector, not this decline detector.
    expect(detectWellnessAnomaly(seriesOf('appetite', [2, 2, 2, 2]))).toBeNull();
  });

  it('returns null for a rising series', () => {
    expect(detectWellnessAnomaly(seriesOf('mood', [2, 2, 4, 4]))).toBeNull();
  });

  it('flags a moderate decline at exactly the moderate threshold', () => {
    // baseline EWMA([4,4]) = 4; recent mean([4,2]) = 3; drop = 1.0.
    const flag = detectWellnessAnomaly(seriesOf('appetite', [4, 4, 4, 2]));
    expect(flag).not.toBeNull();
    expect(flag?.metric).toBe('appetite');
    expect(flag?.severity).toBe('moderate');
    expect(flag?.baselineScore).toBe(4);
    expect(flag?.recentScore).toBe(3);
    expect(flag?.drop).toBe(WELLNESS_ANOMALY_DROP_MODERATE);
  });

  it('flags a high-severity decline for a pronounced slide', () => {
    // baseline EWMA([5,5]) = 5; recent mean([3,1]) = 2; drop = 3.0.
    const flag = detectWellnessAnomaly(seriesOf('mood', [5, 5, 3, 1]));
    expect(flag).not.toBeNull();
    expect(flag?.severity).toBe('high');
    expect(flag?.drop).toBeGreaterThanOrEqual(WELLNESS_ANOMALY_DROP_HIGH);
  });

  it('echoes the most recent reading + the sample size on the flag', () => {
    const series = seriesOf('hydration', [5, 5, 3, 1]);
    const flag = detectWellnessAnomaly(series);
    const lastPoint = series.points.at(-1);
    expect(flag?.latestLevel).toBe(lastPoint?.level);
    expect(flag?.latestVisitDate).toBe(lastPoint?.visitDate);
    expect(flag?.observationCount).toBe(series.points.length);
  });

  it('weights the baseline toward the visits just before the recent window', () => {
    // A long-ago dip recovers; the established level just before the
    // recent window is high, so a recent drop is still caught.
    const flag = detectWellnessAnomaly(seriesOf('social_engagement', [1, 5, 5, 5, 2, 2]));
    expect(flag).not.toBeNull();
    expect(flag?.severity).toBe('high');
  });

  it('produces a flag that satisfies the published Zod contract', () => {
    const flag = detectWellnessAnomaly(seriesOf('appetite', [5, 5, 2, 1]));
    expect(() => WellnessAnomalyFlagSchema.parse(flag)).not.toThrow();
  });

  it('uses a recent window of two visits', () => {
    expect(WELLNESS_ANOMALY_RECENT_WINDOW).toBe(2);
  });
});

describe('detectWellnessAnomalies', () => {
  it('returns the tripped flags in input order and drops the healthy scales', () => {
    const flags = detectWellnessAnomalies([
      seriesOf('mood', [4, 4, 4, 4]), // stable → no flag
      seriesOf('appetite', [5, 5, 2, 1]), // decline → flag
      seriesOf('hydration', [3, 3, 3, 3]), // stable → no flag
      seriesOf('social_engagement', [5, 5, 3, 2]), // decline → flag
    ]);
    expect(flags.map((flag) => flag.metric)).toEqual(['appetite', 'social_engagement']);
  });

  it('returns an empty array when no scale is concerning', () => {
    expect(detectWellnessAnomalies([seriesOf('mood', [4, 4, 4, 4])])).toEqual([]);
  });
});

describe('WellnessAnomalyResponseSchema', () => {
  const base = {
    seniorId: 'snr_1',
    windowDays: 30 as const,
    totalCompletedVisits: 6,
    flags: [detectWellnessAnomaly(seriesOf('appetite', [5, 5, 2, 1]))],
    generatedAt: new Date().toISOString(),
  };

  it('accepts a well-formed response', () => {
    expect(() => WellnessAnomalyResponseSchema.parse(base)).not.toThrow();
  });

  it('accepts an empty flags array', () => {
    expect(() => WellnessAnomalyResponseSchema.parse({ ...base, flags: [] })).not.toThrow();
  });

  it('rejects an unknown field (.strict)', () => {
    expect(() => WellnessAnomalyResponseSchema.parse({ ...base, sneaky: true })).toThrow();
  });

  it('rejects a window outside the offered values', () => {
    expect(() => WellnessAnomalyResponseSchema.parse({ ...base, windowDays: 7 })).toThrow();
  });
});

describe('FamilyWellnessAnomalyResponseSchema', () => {
  it('carries the consent shared flag', () => {
    const notShared = {
      seniorId: 'snr_1',
      shared: false,
      windowDays: 90 as const,
      totalCompletedVisits: 0,
      flags: [],
      generatedAt: new Date().toISOString(),
    };
    expect(() => FamilyWellnessAnomalyResponseSchema.parse(notShared)).not.toThrow();
  });

  it('rejects a missing shared flag (.strict)', () => {
    expect(() =>
      FamilyWellnessAnomalyResponseSchema.parse({
        seniorId: 'snr_1',
        windowDays: 30,
        totalCompletedVisits: 0,
        flags: [],
        generatedAt: new Date().toISOString(),
      }),
    ).toThrow();
  });
});
