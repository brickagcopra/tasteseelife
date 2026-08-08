import {
  WELLNESS_TREND_METRICS,
  wellnessLevelsForMetric,
  type WellnessTrendMetric,
  type WellnessTrendSeries,
} from '@taste-and-see/contracts';
import { describe, expect, it, vi } from 'vitest';

import {
  WellnessTrendsService,
  type WellnessTrendsResult,
} from '../../wellness-trends/services/wellness-trends.service';
import { WellnessAnomalyService } from './wellness-anomaly.service';

/** Build a one-scale series from chronological 1..5 scores. */
function seriesOf(metric: WellnessTrendMetric, scores: readonly number[]): WellnessTrendSeries {
  const levels = wellnessLevelsForMetric(metric);
  const points = scores.map((score, index) => ({
    bookingId: `bk_${index}`,
    visitDate: new Date(Date.UTC(2026, 0, index + 1)).toISOString(),
    recordedAt: new Date(Date.UTC(2026, 0, index + 1, 18)).toISOString(),
    level: levels[score - 1] ?? 'neutral',
    score,
  }));
  return {
    metric,
    points,
    latestScore: scores.at(-1) ?? null,
    visitsRecorded: scores.length,
  };
}

function buildService(trendsResult: WellnessTrendsResult): {
  service: WellnessAnomalyService;
  loadTrends: ReturnType<typeof vi.fn>;
} {
  const loadTrends = vi.fn(async () => trendsResult);
  const trends = { loadTrends } as unknown as WellnessTrendsService;
  return { service: new WellnessAnomalyService(trends), loadTrends };
}

function emptyTrends(overrides: Partial<WellnessTrendsResult> = {}): WellnessTrendsResult {
  return {
    seniorId: 'snr_1',
    windowDays: 30,
    totalCompletedVisits: 0,
    series: WELLNESS_TREND_METRICS.map((metric) => ({
      metric,
      points: [],
      latestScore: null,
      visitsRecorded: 0,
    })),
    generatedAt: new Date('2026-05-27T12:00:00.000Z'),
    ...overrides,
  };
}

describe('WellnessAnomalyService.loadAnomalies', () => {
  it('forwards the household + senior + window to the trend read', async () => {
    const { service, loadTrends } = buildService(emptyTrends());
    await service.loadAnomalies({ householdId: 'hh_9', seniorId: 'snr_7', windowDays: 90 });
    expect(loadTrends).toHaveBeenCalledWith({
      householdId: 'hh_9',
      seniorId: 'snr_7',
      windowDays: 90,
    });
  });

  it('returns no flags when every scale is stable', async () => {
    const { service } = buildService(
      emptyTrends({
        totalCompletedVisits: 4,
        series: [
          seriesOf('mood', [4, 4, 4, 4]),
          seriesOf('appetite', [3, 3, 3, 3]),
          seriesOf('hydration', [5, 5, 5, 5]),
          seriesOf('social_engagement', [3, 3, 3, 3]),
        ],
      }),
    );
    const result = await service.loadAnomalies({
      householdId: 'hh_1',
      seniorId: 'snr_1',
      windowDays: 30,
    });
    expect(result.flags).toEqual([]);
  });

  it('flags only the declining scales, in series order', async () => {
    const { service } = buildService(
      emptyTrends({
        totalCompletedVisits: 4,
        series: [
          seriesOf('mood', [4, 4, 4, 4]), // stable
          seriesOf('appetite', [5, 5, 2, 1]), // decline → high
          seriesOf('hydration', [4, 4, 4, 4]), // stable
          seriesOf('social_engagement', [5, 5, 3, 2]), // decline → moderate-ish
        ],
      }),
    );
    const result = await service.loadAnomalies({
      householdId: 'hh_1',
      seniorId: 'snr_1',
      windowDays: 30,
    });
    expect(result.flags.map((flag) => flag.metric)).toEqual(['appetite', 'social_engagement']);
    expect(result.flags[0]?.severity).toBe('high');
  });

  it('passes through the trend read window, denominator + generatedAt', async () => {
    const { service } = buildService(
      emptyTrends({
        windowDays: 90,
        totalCompletedVisits: 13,
        generatedAt: new Date('2026-05-27T08:30:00.000Z'),
      }),
    );
    const result = await service.loadAnomalies({
      householdId: 'hh_1',
      seniorId: 'snr_1',
      windowDays: 90,
    });
    expect(result.totalCompletedVisits).toBe(13);
    expect(result.windowDays).toBe(90);
    expect(result.generatedAt.toISOString()).toBe('2026-05-27T08:30:00.000Z');
  });
});
