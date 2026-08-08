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
  FamilyWellnessTrendsResponseSchema,
  SeniorConsentResponseSchema,
  WellnessTrendsQuerySchema,
  WellnessTrendsResponseSchema,
  type FamilyWellnessTrendsResponse,
  type SeniorConsentResponse,
  type WellnessTrendsResponse,
} from '@taste-and-see/contracts';
import { AccessTokenGuard, type RequestWithContext } from '@taste-and-see/nest-auth';

import { RateLimitGuard } from '../rate-limit/guards/rate-limit.guard';
import {
  DownstreamHttpClient,
  type DownstreamResult,
} from '../service-registry/services/downstream-http-client';

/**
 * Consent-gated wellness-trend BFF aggregator (TS-231; PRD §6.4, §6.9).
 *
 *   GET /api/v1/seniors/:seniorId/wellness-trends?windowDays=
 *     Returns the senior's 30 / 90-day wellness-observation trends a
 *     family member is permitted to see. Aggregates two upstreams:
 *
 *       1. `service-household` — the senior's consent record
 *          (`GET /api/v1/seniors/:seniorId/consent`, TS-238) read with
 *          the actor's own token. This call is BOTH the consent gate AND
 *          the household-membership gate: a non-member gets the
 *          downstream 403/404 verbatim, so a foreign senior id can't be
 *          probed.
 *       2. `service-booking` — the per-visit trend series
 *          (`GET /api/v1/bookings/seniors/:seniorId/wellness-trends`),
 *          called only when the caller is allowed to see them.
 *
 * **The consent gate (CLAUDE.md §12 — default opt-out).** The caller may
 * see trends when `canManage` is true (primary payer / senior — they
 * always see what they manage) OR the senior's `notes` surface is shared
 * (a family observer the senior has opted in). Otherwise `shared: false`
 * with empty series — the observations never cross. A senior with no
 * consent row defaults to all-false, so an observer sees nothing until
 * the senior opts in. Mirrors the TS-232 photo-gallery gate exactly,
 * keyed on the `notes` surface rather than `photos`.
 *
 * **Failure modes.**
 *   - 401 — missing/invalid access token (AccessTokenGuard).
 *   - 400 — malformed query (windowDays not 30/90 / unknown field).
 *   - 403 / 404 — propagated verbatim from the consent read (non-member /
 *     missing senior).
 *   - 502 — either upstream unreachable / returned a malformed body.
 *   - 503 — HOUSEHOLD_SERVICE_BASE_URL / BOOKING_SERVICE_BASE_URL unset.
 *   - 504 — either upstream times out.
 *
 * Read-only — no idempotency-key handling (GET is naturally idempotent).
 * RFC 7807 problem-details bodies with traceId propagation throughout.
 */
@Controller('api/v1/seniors')
@UseGuards(AccessTokenGuard, RateLimitGuard)
export class WellnessTrendsAggregatorController {
  constructor(private readonly downstream: DownstreamHttpClient) {}

  @Get(':seniorId/wellness-trends')
  @HttpCode(HttpStatus.OK)
  async getWellnessTrends(
    @Param('seniorId') seniorId: string,
    @Query() query: unknown,
    @Req() request: RequestWithContext,
  ): Promise<FamilyWellnessTrendsResponse> {
    const ctx = requireContext(request);
    const traceId = extractTraceId(request);

    const parsedQuery = WellnessTrendsQuerySchema.safeParse(query ?? {});
    if (!parsedQuery.success) {
      throw new HttpException(
        {
          type: 'about:blank',
          title: 'Bad Request',
          status: HttpStatus.BAD_REQUEST,
          detail: 'Wellness-trends query failed validation.',
          issues: parsedQuery.error.issues,
          ...(traceId !== undefined && { traceId }),
        },
        HttpStatus.BAD_REQUEST,
      );
    }
    const windowDays = parsedQuery.data.windowDays;

    // Step 1 — the consent read. This both authorises household
    // membership (403/404 verbatim for a non-member / missing senior)
    // and tells us whether the caller may see the wellness notes.
    const consentResult = await this.downstream.call({
      service: 'household',
      path: `/api/v1/seniors/${encodeURIComponent(seniorId)}/consent`,
      method: 'GET',
      actor: ctx,
      traceId,
    });
    const consent = mapConsentResult(consentResult, traceId);

    // The gate: managers (payer / senior) always see; an observer sees
    // only when the senior has turned the `notes` surface on. Default
    // opt-out — a missing consent row reads all-false.
    const shared = consent.canManage || consent.notes;
    if (!shared) {
      return FamilyWellnessTrendsResponseSchema.parse({
        seniorId,
        shared: false,
        windowDays,
        totalCompletedVisits: 0,
        series: [],
        generatedAt: new Date().toISOString(),
      });
    }

    // Step 2 — the trend read. Forward the validated window.
    const trendsResult = await this.downstream.call({
      service: 'booking',
      path: `/api/v1/bookings/seniors/${encodeURIComponent(seniorId)}/wellness-trends?windowDays=${windowDays}`,
      method: 'GET',
      actor: ctx,
      traceId,
    });
    const trends = mapTrendsResult(trendsResult, traceId);

    // Parse the composed aggregate at the boundary so any future drift
    // between the service shape + the published family contract surfaces
    // here rather than at the web-family consumer.
    return FamilyWellnessTrendsResponseSchema.parse({
      seniorId: trends.seniorId,
      shared: true,
      windowDays: trends.windowDays,
      totalCompletedVisits: trends.totalCompletedVisits,
      series: trends.series,
      generatedAt: trends.generatedAt,
    });
  }
}

// ─────────────────────────────────────────────────────────────────────
// Per-upstream result mappers — each names its downstream service in the
// failure detail so an operator can tell consent failures from trend
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
      // trend surface's membership gate is the consent read's own.
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

function mapTrendsResult(
  result: DownstreamResult,
  traceId: string | undefined,
): WellnessTrendsResponse {
  switch (result.kind) {
    case 'ok': {
      const parsed = WellnessTrendsResponseSchema.safeParse(result.body);
      if (!parsed.success) {
        throw new BadGatewayException(
          problem(
            'Downstream service-booking returned a body that does not conform to the wellness-trends contract.',
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
