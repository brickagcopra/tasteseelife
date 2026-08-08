import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  RunStripeReconciliationResponseSchema,
  type RunStripeReconciliationResponse,
} from '@taste-and-see/contracts';

import { ENV_TOKEN } from '../../config/config.module';
import type { Env } from '../../config/env';
import { internalRequest, trimBaseUrl } from './internal-http';

const RUN_PATH = '/api/v1/internal/accounting/stripe-reconciliation/run';

/**
 * Calls service-accounting's internal Stripe-reconciliation run endpoint.
 * The server defaults the reconciliation target to the most-recently-
 * completed UTC day (yesterday), so the worker sends an empty body — the
 * accounting service's wall clock is authoritative.
 *
 * The `Idempotency-Key` is deterministic per UTC day
 * (`stripe-reconciliation:run:<dayKey>`): a same-day re-run (crash +
 * restart) replays the cached success rather than re-running, while the
 * accounting endpoint's @Idempotent decorator only caches a SUCCESSFUL
 * response — so a first attempt that failed before persisting is retried by
 * the next tick. (Ops same-day recompute goes through the separate admin
 * endpoint with its own key.)
 */
@Injectable()
export class ReconciliationClient {
  private readonly logger = new Logger(ReconciliationClient.name);

  constructor(@Inject(ENV_TOKEN) private readonly env: Env) {}

  async run(idempotencyKey: string): Promise<RunStripeReconciliationResponse> {
    const url = `${trimBaseUrl(this.env.ACCOUNTING_SERVICE_BASE_URL)}${RUN_PATH}`;
    return internalRequest({
      service: 'service-accounting',
      url,
      method: 'POST',
      headerName: this.env.STRIPE_RECONCILIATION_INTERNAL_HEADER_NAME,
      apiKey: this.env.STRIPE_RECONCILIATION_INTERNAL_API_KEY,
      timeoutMs: this.env.REQUEST_TIMEOUT_MS,
      schema: RunStripeReconciliationResponseSchema,
      logger: this.logger,
      body: {},
      extraHeaders: { 'idempotency-key': idempotencyKey },
    });
  }
}
