import {
  BadGatewayException,
  Controller,
  GatewayTimeoutException,
  Get,
  HttpCode,
  HttpException,
  HttpStatus,
  Param,
  Query,
  Req,
  ServiceUnavailableException,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import {
  FamilyWellnessAnomalyResponseSchema,
  SeniorConsentResponseSchema,
  WellnessAnomalyResponseSchema,
  WellnessTrendsQuerySchema,
  type FamilyWellnessAnomalyResponse,
  type SeniorConsentResponse,
  type WellnessAnomalyResponse,
} from '@taste-and-see/contracts';
import { AccessTokenGuard, type RequestWithContext } from '@taste-and-see/nest-auth';

import { RateLimitGuard } from '../rate-limit/guards/rate-limit.guard';
import {
  DownstreamHttpClient,
  type DownstreamResult,
} from '../service-registry/services/downstream-http-client';

/**
 * Consent-gated wellness-anomaly BFF aggregator (TS-236; PRD §6.9).
 *
 *   GET /api/v1/seniors/:seniorId/wellness-anomalies?windowDays=
 *     Returns the early-warning decline flags a family member is
 *     permitted to see for the senior. Aggregates two upstreams exactly
 *     like the TS-231 wellness-trends aggregator:
 *
 *       1. `service-household` — the senior's consent record
 *          (`GET /api/v1/seniors/:seniorId/consent`, TS-238) read with
 *          the actor's own token. BOTH the consent gate AND the
 *          household-membership gate (403/404 verbatim for a non-member /
 *          missing senior, so a foreign senior id can't be probed).
 *       2. `service-booking` — the anomaly flags
 *          (`GET /api/v1/bookings/seniors/:seniorId/wellness-anomalies`),
 *          called only when the caller is allowed to see them.
 *
 * **The consent gate (CLAUDE.md §12 — default opt-out).** The caller may
 * see anomalies when `canManage` is true (primary payer / senior) OR the
 * senior's `notes` surface is shared (a family observer the senior has
 * opted in). Otherwise `shared: false` with empty `flags` — nothing
 * crosses. Mirrors the wellness-trends gate exactly, keyed on the same
 * `notes` surface.
 *
 * **Failure modes** mirror the trends aggregator: 401 (no token), 400
 * (bad query), 403/404 (propagated from the consent read), 502
 * (upstream unreachable / malformed), 503 (route unconfigured), 504
 * (upstream timeout).
 *
 * Read-only — no idempotency-key handling. RFC 7807 problem-details
 * bodies with traceId propagation throughout.
 */
@Controller('api/v1/seniors')
@UseGuards(AccessTokenGuard, RateLimitGuard)
export class WellnessAnomalyAggregatorController {
  constructor(private readonly downstream: DownstreamHttpClient) {}

  @Get(':seniorId/wellness-anomalies')
  @HttpCode(HttpStatus.OK)
  async getWellnessAnomalies(
    @Param('seniorId') seniorId: string,
    @Query() query: unknown,
    @Req() request: RequestWithContext,
  ): Promise<FamilyWellnessAnomalyResponse> {
    const ctx = requireContext(request);
    const traceId = extractTraceId(request);

    const parsedQuery = WellnessTrendsQuerySchema.safeParse(query ?? {});
    if (!parsedQuery.success) {
      throw new HttpException(
        {
          type: 'about:blank',
          title: 'Bad Request',
          status: HttpStatus.BAD_REQUEST,
          detail: 'Wellness-anomaly query failed validation.',
          issues: parsedQuery.error.issues,
          ...(traceId !== undefined && { traceId }),
        },
        HttpStatus.BAD_REQUEST,
      );
    }
    const windowDays = parsedQuery.data.windowDays;

    // Step 1 — the consent read. Both authorises household membership
    // (403/404 verbatim) and tells us whether the caller may see the
    // wellness observations.
    const consentResult = await this.downstream.call({
      service: 'household',
      path: `/api/v1/seniors/${encodeURIComponent(seniorId)}/consent`,
      method: 'GET',
      actor: ctx,
      traceId,
    });
    const consent = mapConsentResult(consentResult, traceId);

    const shared = consent.canManage || consent.notes;
    if (!shared) {
      return FamilyWellnessAnomalyResponseSchema.parse({
        seniorId,
        shared: false,
        windowDays,
        totalCompletedVisits: 0,
        flags: [],
        generatedAt: new Date().toISOString(),
      });
    }

    // Step 2 — the anomaly read. Forward the validated window.
    const anomalyResult = await this.downstream.call({
      service: 'booking',
      path: `/api/v1/bookings/seniors/${encodeURIComponent(seniorId)}/wellness-anomalies?windowDays=${windowDays}`,
      method: 'GET',
      actor: ctx,
      traceId,
    });
    const anomalies = mapAnomalyResult(anomalyResult, traceId);

    return FamilyWellnessAnomalyResponseSchema.parse({
      seniorId: anomalies.seniorId,
      shared: true,
      windowDays: anomalies.windowDays,
      totalCompletedVisits: anomalies.totalCompletedVisits,
      flags: anomalies.flags,
      generatedAt: anomalies.generatedAt,
    });
  }
}

// ─────────────────────────────────────────────────────────────────────
// Per-upstream result mappers — each names its downstream service in the
// failure detail so an operator can tell consent failures from anomaly
// failures at a glance.
// ─────────────────────────────────────────────────────────────────────

function mapConsentResult(
  result: DownstreamResult,
  traceId: string | undefined,
): SeniorConsentResponse {
  switch (result.kind) {
    case 'ok': {
      const parsed = SeniorConsentResponseSchema.safeParse(result.body);
      if (!parsed.success) {
        throw new BadGatewayException(
          problem(
            'Downstream service-household returned a body that does not conform to the consent contract.',
            traceId,
          ),
        );
      }
      return parsed.data;
    }
    case 'client_error': {
      // 403 (non-member) / 404 (missing senior) propagate verbatim — the
      // anomaly surface's membership gate is the consent read's own.
      throw new HttpException(
        toBodyOrFallback(result.body, 'Downstream client error.'),
        result.status,
      );
    }
    case 'server_error':
      throw new BadGatewayException(
        problem('Downstream service-household returned an unsuccessful response.', traceId),
      );
    case 'timeout':
      throw new GatewayTimeoutException(
        timeout('Downstream service-household did not respond within the timeout window.', traceId),
      );
    case 'network_error':
      throw new BadGatewayException(
        problem('Downstream service-household is unreachable.', traceId),
      );
    case 'not_configured':
      throw new ServiceUnavailableException(
        unavailable(
          "Gateway has no route for the 'household' service. Configure HOUSEHOLD_SERVICE_BASE_URL.",
          traceId,
        ),
      );
  }
}

function mapAnomalyResult(
  result: DownstreamResult,
  traceId: string | undefined,
): WellnessAnomalyResponse {
  switch (result.kind) {
    case 'ok': {
      const parsed = WellnessAnomalyResponseSchema.safeParse(result.body);
      if (!parsed.success) {
        throw new BadGatewayException(
          problem(
            'Downstream service-booking returned a body that does not conform to the wellness-anomaly contract.',
            traceId,
          ),
        );
      }
      return parsed.data;
    }
    case 'client_error':
      // The gateway already authorised the caller via the consent read
      // and validated the query; a 4xx from booking here is unexpected
      // (mis-wiring), so surface it as a 502 rather than leaking the
      // internal status to the family client.
      throw new BadGatewayException(
        problem(
          `Downstream service-booking rejected the request (status ${result.status}).`,
          traceId,
        ),
      );
    case 'server_error':
      throw new BadGatewayException(
        problem('Downstream service-booking returned an unsuccessful response.', traceId),
      );
    case 'timeout':
      throw new GatewayTimeoutException(
        timeout('Downstream service-booking did not respond within the timeout window.', traceId),
      );
    case 'network_error':
      throw new BadGatewayException(problem('Downstream service-booking is unreachable.', traceId));
    case 'not_configured':
      throw new ServiceUnavailableException(
        unavailable(
          "Gateway has no route for the 'booking' service. Configure BOOKING_SERVICE_BASE_URL.",
          traceId,
        ),
      );
  }
}

function problem(detail: string, traceId: string | undefined): Record<string, unknown> {
  return {
    type: 'about:blank',
    title: 'Bad Gateway',
    status: HttpStatus.BAD_GATEWAY,
    detail,
    ...(traceId !== undefined && { traceId }),
  };
}

function timeout(detail: string, traceId: string | undefined): Record<string, unknown> {
  return {
    type: 'about:blank',
    title: 'Gateway Timeout',
    status: HttpStatus.GATEWAY_TIMEOUT,
    detail,
    ...(traceId !== undefined && { traceId }),
  };
}

function unavailable(detail: string, traceId: string | undefined): Record<string, unknown> {
  return {
    type: 'about:blank',
    title: 'Service Unavailable',
    status: HttpStatus.SERVICE_UNAVAILABLE,
    detail,
    ...(traceId !== undefined && { traceId }),
  };
}

function requireContext(
  request: RequestWithContext,
): NonNullable<RequestWithContext['requestContext']> {
  const ctx = request.requestContext;
  if (ctx === undefined) {
    throw new UnauthorizedException({
      type: 'about:blank',
      title: 'Unauthorized',
      status: HttpStatus.UNAUTHORIZED,
      detail: 'Authentication required.',
    });
  }
  return ctx;
}

function toBodyOrFallback(body: unknown, fallbackDetail: string): string | Record<string, unknown> {
  if (body !== null && typeof body === 'object' && !Array.isArray(body)) {
    return body as Record<string, unknown>;
  }
  return { type: 'about:blank', title: 'Error', detail: fallbackDetail };
}

function extractTraceId(request: RequestWithContext): string | undefined {
  const candidates = [request.headers['x-trace-id'], request.headers['x-request-id']];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.length > 0) return candidate;
  }
  return undefined;
}
