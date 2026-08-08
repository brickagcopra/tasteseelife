import { Injectable, Logger } from '@nestjs/common';

import { MetricsClient } from './clients/metrics.client';

/**
 * Orchestrates one nightly metrics compute. Thin by design — the
 * accounting service owns the ledger read + the money math; this worker
 * only triggers it and records the outcome. A failed run is logged and
 * swallowed (returns `false`) so the scheduler re-arms; the next tick
 * (or the next night) retries, and the date-keyed idempotency makes a
 * retry harmless.
 */
@Injectable()
export class MetricsOrchestratorService {
  private readonly logger = new Logger(MetricsOrchestratorService.name);

  constructor(private readonly client: MetricsClient) {}

  /**
   * Trigger the compute for the given UTC day. Returns whether it
   * succeeded. Never throws — transport / contract failures are logged
   * and reported via the boolean.
   */
  async runForDay(dayKey: string): Promise<boolean> {
    const idempotencyKey = `saas-metrics:compute:${dayKey}`;
    try {
      const result = await this.client.compute(idempotencyKey);
      this.logger.log(
        {
          dayKey,
          metricDate: result.metrics.metricDate,
          mrrMinor: result.metrics.mrrMinor,
          arrMinor: result.metrics.arrMinor,
          activeSubscriptions: result.metrics.activeSubscriptions,
          subscriptionsSnapshotted: result.subscriptionsSnapshotted,
        },
        'accounting-metrics.compute.ok',
      );
      return true;
    } catch (err) {
      this.logger.error(
        { dayKey, error: err instanceof Error ? err.message : String(err) },
        'accounting-metrics.compute.failed',
      );
      return false;
    }
  }
}
