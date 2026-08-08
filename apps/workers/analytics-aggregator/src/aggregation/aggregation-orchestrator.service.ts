import { Injectable, Logger } from '@nestjs/common';

import { AggregationClient } from './clients/aggregation.client';
import { startOfUtcDayIso } from './schedule';

/**
 * Orchestrates one nightly search-relevance aggregation. Thin by design —
 * service-analytics owns the raw-table read + the aggregation; this worker
 * only triggers it for the target day and records the outcome. A failed run
 * is logged and swallowed (returns `false`) so the scheduler re-arms; the next
 * tick (or the next night) retries, and the date-keyed idempotency makes a
 * retry harmless.
 */
@Injectable()
export class AggregationOrchestratorService {
  private readonly logger = new Logger(AggregationOrchestratorService.name);

  constructor(private readonly client: AggregationClient) {}

  /**
   * Trigger the aggregation for the given target UTC day (the PREVIOUS
   * complete day relative to the run instant). Returns whether it succeeded.
   * Never throws — transport / contract failures are logged and reported via
   * the boolean.
   */
  async runForDay(targetDayKey: string): Promise<boolean> {
    const idempotencyKey = `search-relevance:compute:${targetDayKey}`;
    const asOf = startOfUtcDayIso(targetDayKey);
    try {
      const result = await this.client.compute(asOf, idempotencyKey);
      this.logger.log(
        {
          targetDayKey,
          metricDate: result.metricDate,
          totalSearches: result.totalSearches,
          zeroResultSearches: result.zeroResultSearches,
          bookingsCreated: result.bookingsCreated,
          attributedBookings: result.attributedBookings,
          topQueryCount: result.topQueryCount,
          runId: result.runId,
        },
        'analytics-aggregator.compute.ok',
      );
      return true;
    } catch (err) {
      this.logger.error(
        { targetDayKey, error: err instanceof Error ? err.message : String(err) },
        'analytics-aggregator.compute.failed',
      );
      return false;
    }
  }
}
