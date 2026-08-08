import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  ComputeSaasMetricsResponseSchema,
  type ComputeSaasMetricsResponse,
} from '@taste-and-see/contracts';

import { ENV_TOKEN } from '../../config/config.module';
import type { Env } from '../../config/env';
import { internalRequest, trimBaseUrl } from './internal-http';

const COMPUTE_PATH = '/api/v1/internal/accounting/saas-metrics/compute';

/**
 * Calls service-accounting's internal SaaS-metrics compute endpoint. The
 * server defaults `asOf` to its own clock, so the worker sends an empty
 * body — the accounting service's wall clock is the authoritative "now"
 * for the metric date.
 *
 * The `Idempotency-Key` is deterministic per UTC day
 * (`saas-metrics:compute:<dayKey>`): a same-day re-run (crash + restart)
 * replays the cached success rather than recomputing, while the
 * accounting endpoint's @Idempotent decorator only caches a SUCCESSFUL
 * response — so a first attempt that failed before persisting is retried
 * by the next tick and recomputes. (Ops same-day recompute goes through
 * the separate admin endpoint with its own key.)
 */
@Injectable()
export class MetricsClient {
  private readonly logger = new Logger(MetricsClient.name);

  constructor(@Inject(ENV_TOKEN) private readonly env: Env) {}

  async compute(idempotencyKey: string): Promise<ComputeSaasMetricsResponse> {
    const url = `${trimBaseUrl(this.env.ACCOUNTING_SERVICE_BASE_URL)}${COMPUTE_PATH}`;
    return internalRequest({
      service: 'service-accounting',
      url,
      method: 'POST',
      headerName: this.env.ACCOUNTING_SAAS_METRICS_INTERNAL_HEADER_NAME,
      apiKey: this.env.ACCOUNTING_SAAS_METRICS_INTERNAL_API_KEY,
      timeoutMs: this.env.REQUEST_TIMEOUT_MS,
      schema: ComputeSaasMetricsResponseSchema,
      logger: this.logger,
      body: {},
      extraHeaders: { 'idempotency-key': idempotencyKey },
    });
  }
}
