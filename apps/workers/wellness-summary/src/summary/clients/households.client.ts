import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  InternalWellnessSummaryHouseholdsResponseSchema,
  type InternalWellnessSummaryHouseholdsResponse,
} from '@taste-and-see/contracts';

import { ENV_TOKEN } from '../../config/config.module';
import type { Env } from '../../config/env';

import { internalRequest, trimBaseUrl } from './internal-http';

/**
 * Client for service-household's households-batch endpoint
 * (`GET /api/v1/internal/wellness-summary/households`). Walks the active
 * household population page-by-page via keyset cursor.
 */
@Injectable()
export class HouseholdsClient {
  private readonly logger = new Logger(HouseholdsClient.name);

  constructor(@Inject(ENV_TOKEN) private readonly env: Env) {}

  async fetchPage(
    cursor: string | undefined,
    limit: number,
  ): Promise<InternalWellnessSummaryHouseholdsResponse> {
    const params = new URLSearchParams({ limit: String(limit) });
    if (cursor !== undefined) params.set('cursor', cursor);
    const url = `${trimBaseUrl(this.env.HOUSEHOLD_SERVICE_BASE_URL)}/api/v1/internal/wellness-summary/households?${params.toString()}`;

    return internalRequest({
      service: 'service-household',
      url,
      method: 'GET',
      headerName: this.env.HOUSEHOLD_WELLNESS_SUMMARY_INTERNAL_HEADER_NAME,
      apiKey: this.env.HOUSEHOLD_WELLNESS_SUMMARY_INTERNAL_API_KEY,
      timeoutMs: this.env.REQUEST_TIMEOUT_MS,
      schema: InternalWellnessSummaryHouseholdsResponseSchema,
      logger: this.logger,
    });
  }
}
