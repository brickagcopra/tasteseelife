import {
  BadGatewayException,
  Body,
  Controller,
  GatewayTimeoutException,
  Headers,
  HttpCode,
  HttpException,
  HttpStatus,
  Get,
  Param,
  Post,
  Query,
  Req,
  ServiceUnavailableException,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import {
  AdminReportConcernRequestSchema,
  ListTrustSafetyIncidentsQuerySchema,
  ReportConcernResponseSchema,
  TrustSafetyIncidentListResponseSchema,
  TrustSafetyIncidentResponseSchema,
  type ReportConcernResponse,
  type TrustSafetyIncidentListResponse,
  type TrustSafetyIncidentResponse,
} from '@taste-and-see/contracts';
import {
  AccessTokenGuard,
  PermissionGuard,
  RequirePermissions,
  type RequestWithContext,
} from '@taste-and-see/nest-auth';

import { RateLimitGuard } from '../rate-limit/guards/rate-limit.guard';
import {
  DownstreamHttpClient,
  type DownstreamResult,
} from '../service-registry/services/downstream-http-client';

/**
 * Admin incident BFF proxy (TS-301b, TS-303c2d; PRD §10.14; PDD §16.1).
 *
 *   `POST /api/v1/admin/trust-safety/incidents`
 *     A concierge files a concern FOR a household. Gated on
 *     `concierge:write`; the household id rides the body and is authorised
 *     by that permission (and re-checked downstream).
 *
 *   `GET /api/v1/admin/trust-safety/incidents` (TS-303c2d)
 *     The operator queue. Gated `trust_safety:read`. Summary rows only — no
 *     `description`, no `resolutionNotes`.
 *
 *   `GET /api/v1/admin/trust-safety/incidents/{incidentId}` (TS-303c2d)
 *     One incident with its free text. Gated `trust_safety:WRITE`, not
 *     `:read` — see the downstream controller's doc-block. The narrative is
 *     a family's account of what happened to a named senior, and the stronger
 *     gate keeps a future read-only ops role able to see the queue's shape
 *     without being handed the narratives.
 *
 * Three different permissions on one path prefix, deliberately: filing on a
 * household's behalf, triaging the queue, and reading a report are three
 * different authorities.
 *
 * **Why this is not a branch of `TrustSafetyIncidentsProxyController`.** That
 * route deliberately carries no `PermissionGuard` — filing about your own
 * household is authenticated + scope-validated, and customer roles hold
 * empty permission sets. Gating that same route on `concierge:write` would
 * lock every family out of it. So the on-behalf path — the only path where a
 * household id crosses the wire — gets its own route and its own gate,
 * matching the `admin-concierge-*` proxies.
 *
 * Guard order is `AccessTokenGuard` → `PermissionGuard` (evaluates
 * `@RequirePermissions`) → `RateLimitGuard`, per the documented convention.
 * service-trust-safety re-checks `concierge:write` itself — the edge gate is
 * never the only gate.
 */
@Controller('api/v1/admin/trust-safety/incidents')
@UseGuards(AccessTokenGuard, PermissionGuard, RateLimitGuard)
export class AdminTrustSafetyIncidentsProxyController {
  constructor(private readonly downstream: DownstreamHttpClient) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @RequirePermissions('concierge:write')
  async reportOnBehalf(
    @Body() body: unknown,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Req() request: RequestWithContext,
  ): Promise<ReportConcernResponse> {
    const ctx = requireContext(request);
    const traceId = extractTraceId(request);

    const parsed = AdminReportConcernRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw badRequest('On-behalf concern report payload failed validation.', parsed.error.issues);
    }

    const result: DownstreamResult = await this.downstream.call({
      service: 'trust-safety',
      path: '/api/v1/admin/trust-safety/incidents',
      method: 'POST',
      body: parsed.data,
      actor: ctx,
      traceId,
      idempotencyKey,
    });

    return mapResult(
      result,
      ReportConcernResponseSchema,
      'trust-safety-admin-report-concern',
      traceId,
    );
  }

  @Get()
  @RequirePermissions('trust_safety:read')
  async listIncidents(
    @Query() query: Record<string, string | undefined>,
    @Req() request: RequestWithContext,
  ): Promise<TrustSafetyIncidentListResponse> {
    const ctx = requireContext(request);
    const traceId = extractTraceId(request);

    // Parsed at the edge, then the downstream URL is re-serialised from the
    // PARSED value — `.strict()` makes an unknown key a 400 here, and nothing
    // unvalidated reaches the downstream query string.
    const parsed = ListTrustSafetyIncidentsQuerySchema.safeParse(query);
    if (!parsed.success) {
      throw badRequest('Incident queue query failed validation.', parsed.error.issues);
    }

    const search = new URLSearchParams();
    for (const key of [
      'status',
      'severity',
      'category',
      'householdId',
      'seniorId',
      'providerId',
    ] as const) {
      const value = parsed.data[key];
      if (value !== undefined) search.set(key, value);
    }
    search.set('limit', String(parsed.data.limit));

    const result: DownstreamResult = await this.downstream.call({
      service: 'trust-safety',
      path: `/api/v1/admin/trust-safety/incidents?${search.toString()}`,
      method: 'GET',
      actor: ctx,
      traceId,
    });

    return mapResult(
      result,
      TrustSafetyIncidentListResponseSchema,
      'trust-safety-incident-queue',
      traceId,
    );
  }

  @Get(':incidentId')
  @RequirePermissions('trust_safety:write')
  async getIncident(
    @Param('incidentId') incidentId: string,
    @Req() request: RequestWithContext,
  ): Promise<TrustSafetyIncidentResponse> {
    const ctx = requireContext(request);
    const traceId = extractTraceId(request);

    const result: DownstreamResult = await this.downstream.call({
      service: 'trust-safety',
      path: `/api/v1/admin/trust-safety/incidents/${encodeURIComponent(incidentId)}`,
      method: 'GET',
      actor: ctx,
      traceId,
    });

    return mapResult(
      result,
      TrustSafetyIncidentResponseSchema,
      'trust-safety-incident-detail',
      traceId,
    );
  }
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
          detail: `Downstream service-trust-safety returned a body that does not conform to the ${surface} contract.`,
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
        detail: 'Downstream service-trust-safety returned an unsuccessful response.',
        ...(traceId !== undefined && { traceId }),
      });
    }
    case 'timeout': {
      throw new GatewayTimeoutException({
        type: 'about:blank',
        title: 'Gateway Timeout',
        status: HttpStatus.GATEWAY_TIMEOUT,
        detail: 'Downstream service-trust-safety did not respond within the timeout window.',
        ...(traceId !== undefined && { traceId }),
      });
    }
    case 'network_error': {
      throw new BadGatewayException({
        type: 'about:blank',
        title: 'Bad Gateway',
        status: HttpStatus.BAD_GATEWAY,
        detail: 'Downstream service-trust-safety is unreachable.',
        ...(traceId !== undefined && { traceId }),
      });
    }
    case 'not_configured': {
      throw new ServiceUnavailableException({
        type: 'about:blank',
        title: 'Service Unavailable',
        status: HttpStatus.SERVICE_UNAVAILABLE,
        detail: `Gateway has no route for the '${result.service}' service. Configure TRUST_SAFETY_SERVICE_BASE_URL.`,
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
