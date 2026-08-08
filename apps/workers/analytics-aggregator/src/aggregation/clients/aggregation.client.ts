import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  ComputeSearchRelevanceMetricsResponseSchema,
  type ComputeSearchRelevanceMetricsResponse,
} from '@taste-and-see/contracts';

import { ENV_TOKEN } from '../../config/config.module';
import type { Env } from '../../config/env';
import { internalRequest, trimBaseUrl } from './internal-http';

const COMPUTE_PATH = '/api/v1/internal/analytics/search-relevance/compute';

/**
 * Calls service-analytics' internal search-relevance compute endpoint.
 *
 * The worker sends an explicit `asOf` inside the PREVIOUS complete UTC day
 * (unlike the accounting-metrics worker, which sends an empty body and lets
 * the server default `asOf` to "now") — so service-analytics aggregates a
 * full 24h window rather than the partial current day.
 *
 * The `Idempotency-Key` is deterministic per target UTC day
 * (`search-relevance:compute:<dayKey>`): a same-day re-run (crash + restart)
 * replays the cached success rather than recomputing, while the analytics
 * endpoint's @Idempotent decorator only caches a SUCCESSFUL response — so a
 * first attempt that failed before persisting is retried by the next tick and
 * recomputes. (Ops back-fill goes through the separate admin endpoint with its
 * own key.)
 */
@Injectable()
export class AggregationClient {
  private readonly logger = new Logger(AggregationClient.name);

  constructor(@Inject(ENV_TOKEN) private readonly env: Env) {}

  async compute(
    asOf: string,
    idempotencyKey: string,
  ): Promise<ComputeSearchRelevanceMetricsResponse> {
    const url = `${trimBaseUrl(this.env.ANALYTICS_SERVICE_BASE_URL)}${COMPUTE_PATH}`;
    return internalRequest({
      service: 'service-analytics',
      url,
      method: 'POST',
      headerName: this.env.ANALYTICS_AGGREGATION_INTERNAL_HEADER_NAME,
      apiKey: this.env.ANALYTICS_AGGREGATION_INTERNAL_API_KEY,
      timeoutMs: this.env.REQUEST_TIMEOUT_MS,
      schema: ComputeSearchRelevanceMetricsResponseSchema,
      logger: this.logger,
      body: { asOf },
      extraHeaders: { 'idempotency-key': idempotencyKey },
    });
  }
}
