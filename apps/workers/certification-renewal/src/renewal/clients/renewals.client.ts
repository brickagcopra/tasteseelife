import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  InternalCertificationRenewalsResponseSchema,
  type InternalCertificationRenewalsResponse,
} from '@taste-and-see/contracts';

import { ENV_TOKEN } from '../../config/config.module';
import type { Env } from '../../config/env';

import { internalRequest, trimBaseUrl } from './internal-http';

/**
 * Client for service-academy's renewals batch
 * (`GET /api/v1/internal/academy/certifications/renewals`). Returns the
 * cursor-paginated page of ACTIVE certifications at or approaching renewal
 * expiry (lapsed, or expiring within `horizonDays`). The orchestrator
 * walks the cursor to cover the whole at-risk population.
 */
@Injectable()
export class RenewalsClient {
  private readonly logger = new Logger(RenewalsClient.name);

  constructor(@Inject(ENV_TOKEN) private readonly env: Env) {}

  async fetchPage(
    cursor: string | undefined,
    limit: number,
    horizonDays: number,
  ): Promise<InternalCertificationRenewalsResponse> {
    const params = new URLSearchParams({
      limit: String(limit),
      horizonDays: String(horizonDays),
    });
    if (cursor !== undefined) params.set('cursor', cursor);

    const url = `${trimBaseUrl(this.env.ACADEMY_SERVICE_BASE_URL)}/api/v1/internal/academy/certifications/renewals?${params.toString()}`;
    return internalRequest({
      service: 'service-academy',
      url,
      method: 'GET',
      headerName: this.env.ACADEMY_CERTIFICATION_RENEWALS_HEADER_NAME,
      apiKey: this.env.ACADEMY_CERTIFICATION_RENEWALS_API_KEY,
      timeoutMs: this.env.REQUEST_TIMEOUT_MS,
      schema: InternalCertificationRenewalsResponseSchema,
      logger: this.logger,
    });
  }
}
