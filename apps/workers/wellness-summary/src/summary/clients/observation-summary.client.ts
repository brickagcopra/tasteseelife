import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  InternalSeniorWellnessObservationSummaryResponseSchema,
  type InternalSeniorWellnessObservationSummaryResponse,
} from '@taste-and-see/contracts';

import { ENV_TOKEN } from '../../config/config.module';
import type { Env } from '../../config/env';

import { internalRequest, trimBaseUrl } from './internal-http';

/**
 * Client for service-booking's observation-summary endpoint
 * (`GET /api/v1/internal/bookings/households/:householdId/seniors/:seniorId/wellness-observation-summary`).
 * Returns one senior's compact wellness roll-up over the window. The
 * householdId is passed explicitly because the internal endpoint has no
 * token to derive it from — it scopes the booking read by both ids.
 */
@Injectable()
export class ObservationSummaryClient {
  private readonly logger = new Logger(ObservationSummaryClient.name);

  constructor(@Inject(ENV_TOKEN) private readonly env: Env) {}

  async fetch(
    householdId: string,
    seniorId: string,
    windowDays: 30 | 90,
  ): Promise<InternalSeniorWellnessObservationSummaryResponse> {
    const base = trimBaseUrl(this.env.BOOKING_SERVICE_BASE_URL);
    const path = `/api/v1/internal/bookings/households/${encodeURIComponent(householdId)}/seniors/${encodeURIComponent(seniorId)}/wellness-observation-summary`;
    const url = `${base}${path}?windowDays=${String(windowDays)}`;

    return internalRequest({
      service: 'service-booking',
      url,
      method: 'GET',
      headerName: this.env.BOOKING_WELLNESS_SUMMARY_INTERNAL_HEADER_NAME,
      apiKey: this.env.BOOKING_WELLNESS_SUMMARY_INTERNAL_API_KEY,
      timeoutMs: this.env.REQUEST_TIMEOUT_MS,
      schema: InternalSeniorWellnessObservationSummaryResponseSchema,
      logger: this.logger,
    });
  }
}
