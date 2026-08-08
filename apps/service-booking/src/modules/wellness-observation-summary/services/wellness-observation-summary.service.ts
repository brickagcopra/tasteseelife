import { Injectable, Logger } from '@nestjs/common';
import {
  type InternalSeniorWellnessObservationSummaryResponse,
  type WellnessObservationMetricSummary,
  type WellnessTrendWindowDays,
} from '@taste-and-see/contracts';

import {
  WellnessTrendsService,
  type WellnessTrendsResult,
} from '../../wellness-trends/services/wellness-trends.service';

export interface BuildObservationSummaryArgs {
  /** Path-param — the internal caller (worker) already knows it. */
  readonly householdId: string;
  /** The senior whose summary is requested (path param). */
  readonly seniorId: string;
  readonly windowDays: WellnessTrendWindowDays;
}

/**
 * `WellnessObservationSummaryService` (TS-235; PRD §6.4, §6.9; PDD §12.2).
 *
 * Compact monthly roll-up of one senior's wellness observations for the
 * wellness-summary worker's email. Reuses the TS-231
 * `WellnessTrendsService` per-visit series math wholesale — this service
 * adds nothing to the read path, it only folds each scale's per-visit
 * series into the headline numbers the email carries:
 *
 *   - `latestScore` — the most-recent recorded reading (or null).
 *   - `averageScore` — the mean of every recorded reading, rounded to one
 *     decimal (or null when the scale was never recorded in the window).
 *   - `visitsRecorded` — how many visits captured this scale.
 *
 * Unlike the family-facing trend view (which plots every point), the
 * email is a summary, so the per-visit `points` are collapsed here and
 * never leave the service. The four scales are returned in the same fixed
 * order `WellnessTrendsService` emits them.
 *
 * **No PII in logs.** The roll-up never logs the senior's prose, photos,
 * or recorded scores — only the household + senior soft-FK ids, the
 * window, and the aggregate counts (CLAUDE.md §3.6 / §12).
 */
@Injectable()
export class WellnessObservationSummaryService {
  private readonly logger = new Logger(WellnessObservationSummaryService.name);

  constructor(private readonly trends: WellnessTrendsService) {}

  async buildSummary(
    args: BuildObservationSummaryArgs,
  ): Promise<InternalSeniorWellnessObservationSummaryResponse> {
    const result = await this.trends.loadTrends({
      householdId: args.householdId,
      seniorId: args.seniorId,
      windowDays: args.windowDays,
    });

    const metrics = result.series.map((series) => toMetricSummary(series));

    this.logger.log(
      `wellness-observation-summary.build householdId=${args.householdId} seniorId=${args.seniorId} windowDays=${args.windowDays} totalCompletedVisits=${result.totalCompletedVisits}`,
    );

    return buildResponse(result, metrics);
  }
}

/**
 * Collapse one scale's per-visit series into the headline summary. The
 * `latestScore` is the series' already-computed most-recent reading; the
 * `averageScore` is the mean of every plotted point's score rounded to
 * one decimal, or null when the scale recorded no visits.
 */
function toMetricSummary(
  series: WellnessTrendsResult['series'][number],
): WellnessObservationMetricSummary {
  return {
    metric: series.metric,
    latestScore: series.latestScore,
    averageScore: meanScore(series.points),
    visitsRecorded: series.visitsRecorded,
  };
}

/**
 * Mean of the points' scores rounded to one decimal, or null when there
 * are no points (so the scale renders as "not recorded" rather than a
 * misleading 0).
 */
function meanScore(points: readonly { readonly score: number }[]): number | null {
  if (points.length === 0) return null;
  const sum = points.reduce((acc, point) => acc + point.score, 0);
  const mean = sum / points.length;
  return Math.round(mean * 10) / 10;
}

function buildResponse(
  result: WellnessTrendsResult,
  metrics: readonly WellnessObservationMetricSummary[],
): InternalSeniorWellnessObservationSummaryResponse {
  return {
    seniorId: result.seniorId,
    windowDays: result.windowDays,
    totalCompletedVisits: result.totalCompletedVisits,
    metrics: [...metrics],
    generatedAt: result.generatedAt.toISOString(),
  };
}
