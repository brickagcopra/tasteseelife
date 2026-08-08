import { Injectable, Logger } from '@nestjs/common';
import {
  detectWellnessAnomalies,
  type WellnessAnomalyFlag,
  type WellnessTrendWindowDays,
} from '@taste-and-see/contracts';

import { WellnessTrendsService } from '../../wellness-trends/services/wellness-trends.service';

export interface LoadWellnessAnomaliesArgs {
  /** Resolved from the token `tenantScope` — never client-supplied. */
  readonly householdId: string;
  /** The senior whose observations are evaluated (path param). */
  readonly seniorId: string;
  readonly windowDays: WellnessTrendWindowDays;
}

export interface WellnessAnomaliesResult {
  readonly seniorId: string;
  readonly windowDays: WellnessTrendWindowDays;
  readonly totalCompletedVisits: number;
  readonly flags: readonly WellnessAnomalyFlag[];
  readonly generatedAt: Date;
}

/**
 * `WellnessAnomalyService` (TS-236; PRD §6.9; PDD §23.1).
 *
 * The early-warning layer on the TS-231 wellness trends. Rather than
 * re-querying `booking_visit_notes`, it leans on `WellnessTrendsService`
 * (exported by `WellnessTrendsModule`) for the per-visit scored series,
 * then runs the shared `detectWellnessAnomalies` decline detector over
 * each scale. Reusing the trend read keeps the scan + the score math in
 * exactly one place, so the live trends a family sees and the anomaly
 * the detector fires on can never disagree.
 *
 * **Scope + consent.** Inherited from the trend read: the `where`
 * always pins `householdId` (token-derived) AND `seniorId`, so a senior
 * outside the actor's household yields no flags rather than a leak. The
 * `notes` consent gate (TS-238) lives at the gateway BFF — this surface
 * trusts the gateway applied it but is safe even reached directly.
 *
 * **Read-only, deterministic.** No mutation, no event emission. The
 * detector is pure given the series; the only non-determinism is
 * `generatedAt` (the wall-clock the read ran).
 */
@Injectable()
export class WellnessAnomalyService {
  private readonly logger = new Logger(WellnessAnomalyService.name);

  constructor(private readonly trends: WellnessTrendsService) {}

  async loadAnomalies(args: LoadWellnessAnomaliesArgs): Promise<WellnessAnomaliesResult> {
    const trends = await this.trends.loadTrends({
      householdId: args.householdId,
      seniorId: args.seniorId,
      windowDays: args.windowDays,
    });

    const flags = detectWellnessAnomalies(trends.series);

    this.logger.log(
      `wellness-anomaly.load householdId=${args.householdId} seniorId=${args.seniorId} windowDays=${args.windowDays} totalCompletedVisits=${trends.totalCompletedVisits} flags=${flags.length}`,
    );

    return {
      seniorId: trends.seniorId,
      windowDays: trends.windowDays,
      totalCompletedVisits: trends.totalCompletedVisits,
      flags,
      generatedAt: trends.generatedAt,
    };
  }
}
