import {
  WELLNESS_TREND_METRICS,
  type WellnessTrendMetric,
  type WellnessTrendPoint,
  type WellnessTrendSeries,
} from '@taste-and-see/contracts';
import { describe, expect, it, vi } from 'vitest';

import {
  WellnessTrendsService,
  type WellnessTrendsResult,
} from '../../wellness-trends/services/wellness-trends.service';
import { WellnessObservationSummaryService } from './wellness-observation-summary.service';

/**
 * `WellnessObservationSummaryService` tests (TS-235).
 *
 * The service is a pure fold over the TS-231 `WellnessTrendsService`
 * series — these tests pin the math (mean + one-decimal rounding, null
 * for empty points, latest passthrough) and the all-four-metrics ordered
 * mapping, using a FAKE `WellnessTrendsService` so no Prisma is needed.
 */

/** Build a single trend point with just the score the fold cares about. */
function point(score: number, index = 0): WellnessTrendPoint {
  return {
    bookingId: `bkg_${index}`,
    visitDate: '2026-05-20T17:00:00.000Z',
    recordedAt: '2026-05-20T18:00:00.000Z',
    level: 'bright',
    score,
  };
}

function series(
  metric: WellnessTrendMetric,
  scores: readonly number[],
  latestScore: number | null,
): WellnessTrendSeries {
  return {
    metric,
    points: scores.map((score, index) => point(score, index)),
    latestScore,
    visitsRecorded: scores.length,
  };
}

/** A full four-scale series list with custom per-scale scores. */
function allMetricsSeries(
  byMetric: Partial<Record<WellnessTrendMetric, { scores: number[]; latest: number | null }>>,
): WellnessTrendSeries[] {
  return WELLNESS_TREND_METRICS.map((metric) => {
    const spec = byMetric[metric] ?? { scores: [], latest: null };
    return series(metric, spec.scores, spec.latest);
  });
}

function buildService(result: Partial<WellnessTrendsResult> = {}): {
  service: WellnessObservationSummaryService;
  loadTrends: ReturnType<typeof vi.fn>;
} {
  const fullResult: WellnessTrendsResult = {
    seniorId: 'snr_1',
    windowDays: 30,
    totalCompletedVisits: 0,
    series: allMetricsSeries({}),
    generatedAt: new Date('2026-05-27T12:00:00.000Z'),
    ...result,
  };
  const loadTrends = vi.fn(async () => fullResult);
  const trends = { loadTrends } as unknown as WellnessTrendsService;
  return { service: new WellnessObservationSummaryService(trends), loadTrends };
}

describe('WellnessObservationSummaryService.buildSummary', () => {
  it('forwards householdId + seniorId + windowDays to loadTrends', async () => {
    const { service, loadTrends } = buildService();
    await service.buildSummary({ householdId: 'hh_9', seniorId: 'snr_7', windowDays: 90 });
    expect(loadTrends).toHaveBeenCalledWith({
      householdId: 'hh_9',
      seniorId: 'snr_7',
      windowDays: 90,
    });
  });

  it('returns all four metrics in WELLNESS_TREND_METRICS order', async () => {
    const { service } = buildService();
    const summary = await service.buildSummary({
      householdId: 'hh_1',
      seniorId: 'snr_1',
      windowDays: 30,
    });
    expect(summary.metrics.map((m) => m.metric)).toEqual([...WELLNESS_TREND_METRICS]);
  });

  it('computes the mean of the points rounded to one decimal', async () => {
    // mood scores 1,2,4 → mean 2.333... → 2.3
    const { service } = buildService({
      series: allMetricsSeries({ mood: { scores: [1, 2, 4], latest: 4 } }),
    });
    const summary = await service.buildSummary({
      householdId: 'hh_1',
      seniorId: 'snr_1',
      windowDays: 30,
    });
    const mood = summary.metrics.find((m) => m.metric === 'mood');
    expect(mood?.averageScore).toBe(2.3);
  });

  it('rounds a .x5 mean up to one decimal (3,4 → 3.5)', async () => {
    const { service } = buildService({
      series: allMetricsSeries({ appetite: { scores: [3, 4], latest: 4 } }),
    });
    const summary = await service.buildSummary({
      householdId: 'hh_1',
      seniorId: 'snr_1',
      windowDays: 30,
    });
    const appetite = summary.metrics.find((m) => m.metric === 'appetite');
    expect(appetite?.averageScore).toBe(3.5);
  });

  it('returns averageScore = the score itself for a single point', async () => {
    const { service } = buildService({
      series: allMetricsSeries({ hydration: { scores: [5], latest: 5 } }),
    });
    const summary = await service.buildSummary({
      householdId: 'hh_1',
      seniorId: 'snr_1',
      windowDays: 30,
    });
    const hydration = summary.metrics.find((m) => m.metric === 'hydration');
    expect(hydration?.averageScore).toBe(5);
    expect(hydration?.visitsRecorded).toBe(1);
  });

  it('returns null averageScore + null latestScore when a scale has no points', async () => {
    const { service } = buildService({
      series: allMetricsSeries({
        mood: { scores: [3], latest: 3 },
        // appetite / hydration / social_engagement left empty
      }),
    });
    const summary = await service.buildSummary({
      householdId: 'hh_1',
      seniorId: 'snr_1',
      windowDays: 30,
    });
    const social = summary.metrics.find((m) => m.metric === 'social_engagement');
    expect(social?.averageScore).toBeNull();
    expect(social?.latestScore).toBeNull();
    expect(social?.visitsRecorded).toBe(0);
  });

  it('passes the series latestScore straight through', async () => {
    // points 2,5 but latestScore pinned to 5 (the most-recent reading) —
    // proving latest is NOT recomputed from the points by this service.
    const { service } = buildService({
      series: allMetricsSeries({ mood: { scores: [2, 5], latest: 5 } }),
    });
    const summary = await service.buildSummary({
      householdId: 'hh_1',
      seniorId: 'snr_1',
      windowDays: 30,
    });
    const mood = summary.metrics.find((m) => m.metric === 'mood');
    expect(mood?.latestScore).toBe(5);
    expect(mood?.averageScore).toBe(3.5);
    expect(mood?.visitsRecorded).toBe(2);
  });

  it('echoes seniorId, windowDays, totalCompletedVisits, and ISO generatedAt', async () => {
    const { service } = buildService({
      seniorId: 'snr_42',
      windowDays: 90,
      totalCompletedVisits: 7,
      generatedAt: new Date('2026-05-27T12:00:00.000Z'),
    });
    const summary = await service.buildSummary({
      householdId: 'hh_1',
      seniorId: 'snr_42',
      windowDays: 90,
    });
    expect(summary.seniorId).toBe('snr_42');
    expect(summary.windowDays).toBe(90);
    expect(summary.totalCompletedVisits).toBe(7);
    expect(summary.generatedAt).toBe('2026-05-27T12:00:00.000Z');
  });
});
