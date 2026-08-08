import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  DispatchResponseSchema,
  type DispatchNotificationRequest,
  type DispatchResponse,
} from '@taste-and-see/contracts';

import { ENV_TOKEN } from '../../config/config.module';
import type { Env } from '../../config/env';

import { internalRequest, trimBaseUrl } from './internal-http';

/**
 * Client for service-notification's dispatch endpoint
 * (`POST /api/v1/internal/notification/dispatch`). The dispatch endpoint
 * renders the template + applies the preference / quiet-hours gate
 * server-side and returns a `DispatchResponse` (status `sent` /
 * `suppressed_*` / `failed`) with HTTP 200. A non-2xx (e.g. 404 template
 * missing, 422 variable mismatch, 401 bad secret) is a transport error
 * the client throws — the orchestrator counts it and moves on.
 *
 * Replay safety: the request carries a deterministic `idempotencyKey`
 * (`wellness-summary:{period}:{seniorId}:{recipientUserId}`), so a
 * re-run of the same monthly period collapses against the original
 * dispatch row (`replayed: true`) rather than double-sending.
 */
@Injectable()
export class DispatchClient {
  private readonly logger = new Logger(DispatchClient.name);

  constructor(@Inject(ENV_TOKEN) private readonly env: Env) {}

  async dispatch(body: DispatchNotificationRequest): Promise<DispatchResponse> {
    const url = `${trimBaseUrl(this.env.NOTIFICATION_SERVICE_BASE_URL)}/api/v1/internal/notification/dispatch`;
    return internalRequest({
      service: 'service-notification',
      url,
      method: 'POST',
      headerName: this.env.NOTIFICATION_DISPATCH_HEADER_NAME,
      apiKey: this.env.NOTIFICATION_DISPATCH_API_KEY,
      timeoutMs: this.env.REQUEST_TIMEOUT_MS,
      schema: DispatchResponseSchema,
      logger: this.logger,
      body,
    });
  }
}
