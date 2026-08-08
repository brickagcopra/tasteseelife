import { Injectable, Logger } from '@nestjs/common';

import { ReconciliationClient } from './clients/reconciliation.client';

/**
 * Orchestrates one nightly reconciliation run. Thin by design — the
 * accounting service owns the Stripe read + the ledger comparison + the
 * ops-ticket persistence; this worker only triggers it and records the
 * outcome. A failed run is logged and swallowed (returns `false`) so the
 * scheduler re-arms; the next tick (or the next night) retries, and the
 * date-keyed idempotency makes a retry harmless.
 */
@Injectable()
export class ReconciliationOrchestratorService {
  private readonly logger = new Logger(ReconciliationOrchestratorService.name);

  constructor(private readonly client: ReconciliationClient) {}

  /**
   * Trigger the reconciliation for the given UTC day. Returns whether it
   * succeeded. Never throws — transport / contract failures are logged and
   * reported via the boolean.
   */
  async runForDay(dayKey: string): Promise<boolean> {
    const idempotencyKey = `stripe-reconciliation:run:${dayKey}`;
    try {
      const result = await this.client.run(idempotencyKey);
      const log = result.openMismatchCount > 0 ? 'warn' : 'log';
      this.logger[log](
        {
          dayKey,
          reconciliationDate: result.reconciliationDate,
          mode: result.mode,
          openMismatchCount: result.openMismatchCount,
        },
        result.openMismatchCount > 0
          ? 'stripe-reconciliation.run.mismatch'
          : 'stripe-reconciliation.run.ok',
      );
      return true;
    } catch (err) {
      this.logger.error(
        { dayKey, error: err instanceof Error ? err.message : String(err) },
        'stripe-reconciliation.run.failed',
      );
      return false;
    }
  }
}
