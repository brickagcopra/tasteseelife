import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  ExpireCertificationResponseSchema,
  type ExpireCertificationResponse,
} from '@taste-and-see/contracts';

import { ENV_TOKEN } from '../../config/config.module';
import type { Env } from '../../config/env';

import { internalRequest, trimBaseUrl } from './internal-http';

/**
 * Client for service-academy's lapse-expire write
 * (`POST /api/v1/internal/academy/certifications/:id/expire`). Flips an
 * active, past-expiry certification to `expired`; the call is idempotent
 * (an already-expired / revoked / not-yet-past row is a no-op `changed:
 * false`). A non-2xx (e.g. 404 unknown certification, 401 bad secret) is a
 * transport error the client throws — the orchestrator counts it and moves
 * on to the next candidate.
 */
@Injectable()
export class ExpireClient {
  private readonly logger = new Logger(ExpireClient.name);

  constructor(@Inject(ENV_TOKEN) private readonly env: Env) {}

  async expire(certificationId: string): Promise<ExpireCertificationResponse> {
    const url = `${trimBaseUrl(this.env.ACADEMY_SERVICE_BASE_URL)}/api/v1/internal/academy/certifications/${encodeURIComponent(certificationId)}/expire`;
    return internalRequest({
      service: 'service-academy',
      url,
      method: 'POST',
      headerName: this.env.ACADEMY_CERTIFICATION_RENEWALS_HEADER_NAME,
      apiKey: this.env.ACADEMY_CERTIFICATION_RENEWALS_API_KEY,
      timeoutMs: this.env.REQUEST_TIMEOUT_MS,
      schema: ExpireCertificationResponseSchema,
      logger: this.logger,
    });
  }
}
