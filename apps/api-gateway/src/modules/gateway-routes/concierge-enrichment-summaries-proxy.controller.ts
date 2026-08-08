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
  MyConciergeEnrichmentSummariesQuerySchema,
  MyConciergeEnrichmentSummariesResponseSchema,
  MyConciergeEnrichmentSummaryResponseSchema,
  type MyConciergeEnrichmentSummariesQuery,
  type MyConciergeEnrichmentSummariesResponse,
  type MyConciergeEnrichmentSummaryResponse,
} from '@taste-and-see/contracts';
import { AccessTokenGuard, type RequestWithContext } from '@taste-and-see/nest-auth';

import { RateLimitGuard } from '../rate-limit/guards/rate-limit.guard';
import {
  DownstreamHttpClient,
  type DownstreamResult,
} from '../service-registry/services/downstream-http-client';

/**
 * Family concierge enrichment-summary BFF proxy (TS-229; PRD §5.1 Tier 3, §6.9).
 *
 *   `GET /api/v1/concierge/enrichment-summaries/me?limit=`
 *     The household's PUBLISHED weekly summaries (newest-week-first), resolved
 *     from the token's `tenantScope` claim (no household id crosses the wire).
 *
 *   `GET /api/v1/concierge/enrichment-summaries/me/:summaryId`
 *     The permalink target — one PUBLISHED summary scoped to the household.
 *     service-concierge returns `{ summary: null }` when the id does not
 *     resolve to a published summary for this household (no oracle).
 *
 * Authenticated under the default rate-limit policy; the gateway is a thin
 * pass-through forwarding the verified actor identity. A non-household-scoped
 * actor (admin / partner) receives the downstream 400 verbatim.
 */
@Controller('api/v1/concierge/enrichment-summaries')
@UseGuards(AccessTokenGuard, RateLimitGuard)
export class ConciergeEnrichmentSummariesProxyController {
  constructor(private readonly downstream: DownstreamHttpClient) {}

  @Get('me')
  @HttpCode(HttpStatus.OK)
  async listMine(
    @Query() query: Record<string, unknown>,
    @Req() request: RequestWithContext,
  ): Promise<MyConciergeEnrichmentSummariesResponse> {
    const ctx = requireContext(request);
    const traceId = extractTraceId(request);

    const parsed = MyConciergeEnrichmentSummariesQuerySchema.safeParse(query);
    if (!parsed.success) {
      throw badRequest('Enrichment-summaries query failed validation.', parsed.error.issues);
    }

    const result: DownstreamResult = await this.downstream.call({
      service: 'concierge',
      path: buildMinePath(parsed.data),
      method: 'GET',
      actor: ctx,
      traceId,
    });

    return mapResult(
      result,
      MyConciergeEnrichmentSummariesResponseSchema,
      'concierge-enrichment-summaries-me',
      traceId,
    );
  }

  @Get('me/:summaryId')
  @HttpCode(HttpStatus.OK)
  async getMine(
    @Param('summaryId') summaryId: string,
    @Req() request: RequestWithContext,
  ): Promise<MyConciergeEnrichmentSummaryResponse> {
    const ctx = requireContext(request);
    const traceId = extractTraceId(request);

    const result: DownstreamResult = await this.downstream.call({
      service: 'concierge',
      path: `/api/v1/concierge/enrichment-summaries/me/${encodeURIComponent(summaryId)}`,
      method: 'GET',
      actor: ctx,
      traceId,
    });

    return mapResult(
      result,
      MyConciergeEnrichmentSummaryResponseSchema,
      'concierge-enrichment-summary-me-permalink',
      traceId,
    );
  }
}

function buildMinePath(query: MyConciergeEnrichmentSummariesQuery): string {
  const params = new URLSearchParams();
  params.set('limit', String(query.limit));
  return `/api/v1/concierge/enrichment-summaries/me?${params.toString()}`;
}

function badRequest(detail: string, issues: unknown): HttpException {
  return new HttpException(
    {
      type: 'about:blank',
      title: 'Bad Request',
      status: HttpStatus.BAD_REQUEST,
      detail,
      issues,
    },
    HttpStatus.BAD_REQUEST,
  );
}

function mapResult<TResponse>(
  result: DownstreamResult,
  schema: {
    safeParse: (input: unknown) => { success: true; data: TResponse } | { success: false };
  },
  surface: string,
  traceId: string | undefined,
): TResponse {
  switch (result.kind) {
    case 'ok': {
      const parsed = schema.safeParse(result.body);
      if (!parsed.success) {
        throw new BadGatewayException({
          type: 'about:blank',
          title: 'Bad Gateway',
          status: HttpStatus.BAD_GATEWAY,
          detail: `Downstream service-concierge returned a body that does not conform to the ${surface} contract.`,
          ...(traceId !== undefined && { traceId }),
        });
      }
      return parsed.data;
    }
    case 'client_error': {
      const body = toBodyOrFallback(result.body, 'Downstream client error.');
      throw new HttpException(body, result.status);
    }
    case 'server_error': {
      throw new BadGatewayException({
        type: 'about:blank',
        title: 'Bad Gateway',
        status: HttpStatus.BAD_GATEWAY,
        detail: 'Downstream service-concierge returned an unsuccessful response.',
        ...(traceId !== undefined && { traceId }),
      });
    }
    case 'timeout': {
      throw new GatewayTimeoutException({
        type: 'about:blank',
        title: 'Gateway Timeout',
        status: HttpStatus.GATEWAY_TIMEOUT,
        detail: 'Downstream service-concierge did not respond within the timeout window.',
        ...(traceId !== undefined && { traceId }),
      });
    }
    case 'network_error': {
      throw new BadGatewayException({
        type: 'about:blank',
        title: 'Bad Gateway',
        status: HttpStatus.BAD_GATEWAY,
        detail: 'Downstream service-concierge is unreachable.',
        ...(traceId !== undefined && { traceId }),
      });
    }
    case 'not_configured': {
      throw new ServiceUnavailableException({
        type: 'about:blank',
        title: 'Service Unavailable',
        status: HttpStatus.SERVICE_UNAVAILABLE,
        detail: `Gateway has no route for the '${result.service}' service. Configure CONCIERGE_SERVICE_BASE_URL.`,
        ...(traceId !== undefined && { traceId }),
      });
    }
  }
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
