import {
  BadGatewayException,
  Body,
  Controller,
  Get,
  GatewayTimeoutException,
  Headers,
  HttpCode,
  HttpException,
  HttpStatus,
  Param,
  Post,
  Put,
  Query,
  Req,
  ServiceUnavailableException,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import {
  AdvanceMandatedReporterCaseRequestSchema,
  ListMandatedReporterCasesQuerySchema,
  MandatedReporterCaseListResponseSchema,
  MandatedReporterCaseResponseSchema,
  MandatedReporterJurisdictionListResponseSchema,
  MandatedReporterJurisdictionResponseSchema,
  OpenMandatedReporterCaseRequestSchema,
  ResolveIncidentRequestSchema,
  ResolveIncidentResponseSchema,
  SetMandatedReporterJurisdictionVerificationRequestSchema,
  UpsertMandatedReporterJurisdictionRequestSchema,
  type MandatedReporterCaseListResponse,
  type MandatedReporterCaseResponse,
  type MandatedReporterJurisdictionListResponse,
  type MandatedReporterJurisdictionResponse,
  type ResolveIncidentResponse,
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

/** The permission every route on this proxy requires. */
const TRUST_SAFETY_WRITE = 'trust_safety:write';

/**
 * Mandated-reporter workflow BFF proxy (TS-303b; PRD §10.14, §11.4; PDD
 * §16.1, §16.4; CLAUDE.md §12).
 *
 *   `POST /api/v1/admin/trust-safety/mandated-reporter/cases`
 *   `POST /api/v1/admin/trust-safety/mandated-reporter/cases/{caseId}/transitions`
 *   `GET  /api/v1/admin/trust-safety/mandated-reporter/cases` (queue, TS-303c2a)
 *   `GET  /api/v1/admin/trust-safety/mandated-reporter/cases/by-incident/{incidentId}`
 *   `POST /api/v1/admin/trust-safety/incidents/{incidentId}/resolution`
 *
 * Every route is gated on `trust_safety:write` — unlike the TS-301 intake
 * proxies, none of this is reachable by a family or a provider. The incident
 * resolution route lives here rather than on
 * `AdminTrustSafetyIncidentsProxyController` because it belongs to the
 * mandated-reporter gate's story and carries a different permission
 * (`trust_safety:write`, not `concierge:write`) — a concierge who may file a
 * concern on a household's behalf is not thereby authorised to close one.
 *
 * Guard order is `AccessTokenGuard` → `PermissionGuard` (evaluates
 * `@RequirePermissions`) → `RateLimitGuard`, per the documented convention.
 * service-trust-safety re-checks the same permission itself — the edge gate is
 * never the only gate.
 *
 * The 4xx pass-through matters more here than usual: the downstream returns
 * 422 for an unverified jurisdiction, 409 for a self-signoff or a blocked
 * closure, and each of those is an operator-facing explanation, not an
 * internal detail. `client_error` forwards the downstream problem body
 * verbatim so the console can render it.
 */
@Controller()
@UseGuards(AccessTokenGuard, PermissionGuard, RateLimitGuard)
export class AdminTrustSafetyMandatedReporterProxyController {
  constructor(private readonly downstream: DownstreamHttpClient) {}

  @Post('api/v1/admin/trust-safety/mandated-reporter/cases')
  @HttpCode(HttpStatus.CREATED)
  @RequirePermissions(TRUST_SAFETY_WRITE)
  async openCase(
    @Body() body: unknown,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Req() request: RequestWithContext,
  ): Promise<MandatedReporterCaseResponse> {
    const ctx = requireContext(request);
    const traceId = extractTraceId(request);

    const parsed = OpenMandatedReporterCaseRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw badRequest('Mandated-reporter case payload failed validation.', parsed.error.issues);
    }

    const result: DownstreamResult = await this.downstream.call({
      service: 'trust-safety',
      path: '/api/v1/admin/trust-safety/mandated-reporter/cases',
      method: 'POST',
      body: parsed.data,
      actor: ctx,
      traceId,
      idempotencyKey,
    });

    return mapResult(
      result,
      MandatedReporterCaseResponseSchema,
      'trust-safety-mandated-reporter-open',
      traceId,
    );
  }

  @Post('api/v1/admin/trust-safety/mandated-reporter/cases/:caseId/transitions')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(TRUST_SAFETY_WRITE)
  async advanceCase(
    @Param('caseId') caseId: string,
    @Body() body: unknown,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Req() request: RequestWithContext,
  ): Promise<MandatedReporterCaseResponse> {
    const ctx = requireContext(request);
    const traceId = extractTraceId(request);

    const parsed = AdvanceMandatedReporterCaseRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw badRequest(
        'Mandated-reporter transition payload failed validation.',
        parsed.error.issues,
      );
    }

    const result: DownstreamResult = await this.downstream.call({
      service: 'trust-safety',
      path: `/api/v1/admin/trust-safety/mandated-reporter/cases/${encodeURIComponent(caseId)}/transitions`,
      method: 'POST',
      body: parsed.data,
      actor: ctx,
      traceId,
      idempotencyKey,
    });

    return mapResult(
      result,
      MandatedReporterCaseResponseSchema,
      'trust-safety-mandated-reporter-advance',
      traceId,
    );
  }

  @Get('api/v1/admin/trust-safety/mandated-reporter/cases')
  @RequirePermissions(TRUST_SAFETY_WRITE)
  async listCases(
    @Query() query: Record<string, string | undefined>,
    @Req() request: RequestWithContext,
  ): Promise<MandatedReporterCaseListResponse> {
    const ctx = requireContext(request);
    const traceId = extractTraceId(request);

    // Parsed at the edge so a bad `limit` or an unknown status is a 400 here
    // rather than a downstream round-trip, and re-serialised from the PARSED
    // value so the raw query string never reaches the downstream URL.
    const parsed = ListMandatedReporterCasesQuerySchema.safeParse(query);
    if (!parsed.success) {
      throw badRequest(
        'Mandated-reporter case queue query failed validation.',
        parsed.error.issues,
      );
    }

    const search = new URLSearchParams();
    if (parsed.data.status !== undefined) search.set('status', parsed.data.status);
    if (parsed.data.stateCode !== undefined) search.set('stateCode', parsed.data.stateCode);
    search.set('limit', String(parsed.data.limit));

    const result: DownstreamResult = await this.downstream.call({
      service: 'trust-safety',
      path: `/api/v1/admin/trust-safety/mandated-reporter/cases?${search.toString()}`,
      method: 'GET',
      actor: ctx,
      traceId,
    });

    return mapResult(
      result,
      MandatedReporterCaseListResponseSchema,
      'trust-safety-mandated-reporter-queue',
      traceId,
    );
  }

  @Get('api/v1/admin/trust-safety/mandated-reporter/cases/by-incident/:incidentId')
  @RequirePermissions(TRUST_SAFETY_WRITE)
  async getCaseByIncident(
    @Param('incidentId') incidentId: string,
    @Req() request: RequestWithContext,
  ): Promise<MandatedReporterCaseResponse> {
    const ctx = requireContext(request);
    const traceId = extractTraceId(request);

    const result: DownstreamResult = await this.downstream.call({
      service: 'trust-safety',
      path: `/api/v1/admin/trust-safety/mandated-reporter/cases/by-incident/${encodeURIComponent(incidentId)}`,
      method: 'GET',
      actor: ctx,
      traceId,
    });

    return mapResult(
      result,
      MandatedReporterCaseResponseSchema,
      'trust-safety-mandated-reporter-read',
      traceId,
    );
  }

  // ─── Jurisdiction kit (TS-303c1) ────────────────────────────────────

  @Get('api/v1/admin/trust-safety/mandated-reporter/jurisdictions')
  @RequirePermissions(TRUST_SAFETY_WRITE)
  async listJurisdictions(
    @Query('unverifiedOnly') unverifiedOnly: string | undefined,
    @Req() request: RequestWithContext,
  ): Promise<MandatedReporterJurisdictionListResponse> {
    const ctx = requireContext(request);
    const traceId = extractTraceId(request);

    const query = unverifiedOnly === 'true' ? '?unverifiedOnly=true' : '';
    const result: DownstreamResult = await this.downstream.call({
      service: 'trust-safety',
      path: `/api/v1/admin/trust-safety/mandated-reporter/jurisdictions${query}`,
      method: 'GET',
      actor: ctx,
      traceId,
    });

    return mapResult(
      result,
      MandatedReporterJurisdictionListResponseSchema,
      'trust-safety-jurisdiction-list',
      traceId,
    );
  }

  @Get('api/v1/admin/trust-safety/mandated-reporter/jurisdictions/:stateCode')
  @RequirePermissions(TRUST_SAFETY_WRITE)
  async getJurisdiction(
    @Param('stateCode') stateCode: string,
    @Req() request: RequestWithContext,
  ): Promise<MandatedReporterJurisdictionResponse> {
    const ctx = requireContext(request);
    const traceId = extractTraceId(request);

    const result: DownstreamResult = await this.downstream.call({
      service: 'trust-safety',
      path: `/api/v1/admin/trust-safety/mandated-reporter/jurisdictions/${encodeURIComponent(stateCode)}`,
      method: 'GET',
      actor: ctx,
      traceId,
    });

    return mapResult(
      result,
      MandatedReporterJurisdictionResponseSchema,
      'trust-safety-jurisdiction-read',
      traceId,
    );
  }

  @Put('api/v1/admin/trust-safety/mandated-reporter/jurisdictions/:stateCode')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(TRUST_SAFETY_WRITE)
  async upsertJurisdiction(
    @Param('stateCode') stateCode: string,
    @Body() body: unknown,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Req() request: RequestWithContext,
  ): Promise<MandatedReporterJurisdictionResponse> {
    const ctx = requireContext(request);
    const traceId = extractTraceId(request);

    const parsed = UpsertMandatedReporterJurisdictionRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw badRequest('Jurisdiction kit payload failed validation.', parsed.error.issues);
    }

    const result: DownstreamResult = await this.downstream.call({
      service: 'trust-safety',
      path: `/api/v1/admin/trust-safety/mandated-reporter/jurisdictions/${encodeURIComponent(stateCode)}`,
      method: 'PUT',
      body: parsed.data,
      actor: ctx,
      traceId,
      idempotencyKey,
    });

    return mapResult(
      result,
      MandatedReporterJurisdictionResponseSchema,
      'trust-safety-jurisdiction-upsert',
      traceId,
    );
  }

  @Post('api/v1/admin/trust-safety/mandated-reporter/jurisdictions/:stateCode/verification')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(TRUST_SAFETY_WRITE)
  async setJurisdictionVerification(
    @Param('stateCode') stateCode: string,
    @Body() body: unknown,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Req() request: RequestWithContext,
  ): Promise<MandatedReporterJurisdictionResponse> {
    const ctx = requireContext(request);
    const traceId = extractTraceId(request);

    const parsed = SetMandatedReporterJurisdictionVerificationRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw badRequest('Jurisdiction verification payload failed validation.', parsed.error.issues);
    }

    const result: DownstreamResult = await this.downstream.call({
      service: 'trust-safety',
      path: `/api/v1/admin/trust-safety/mandated-reporter/jurisdictions/${encodeURIComponent(stateCode)}/verification`,
      method: 'POST',
      body: parsed.data,
      actor: ctx,
      traceId,
      idempotencyKey,
    });

    return mapResult(
      result,
      MandatedReporterJurisdictionResponseSchema,
      'trust-safety-jurisdiction-verification',
      traceId,
    );
  }

  @Post('api/v1/admin/trust-safety/incidents/:incidentId/resolution')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(TRUST_SAFETY_WRITE)
  async resolveIncident(
    @Param('incidentId') incidentId: string,
    @Body() body: unknown,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Req() request: RequestWithContext,
  ): Promise<ResolveIncidentResponse> {
    const ctx = requireContext(request);
    const traceId = extractTraceId(request);

    const parsed = ResolveIncidentRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw badRequest('Incident resolution payload failed validation.', parsed.error.issues);
    }

    const result: DownstreamResult = await this.downstream.call({
      service: 'trust-safety',
      path: `/api/v1/admin/trust-safety/incidents/${encodeURIComponent(incidentId)}/resolution`,
      method: 'POST',
      body: parsed.data,
      actor: ctx,
      traceId,
      idempotencyKey,
    });

    return mapResult(
      result,
      ResolveIncidentResponseSchema,
      'trust-safety-incident-resolution',
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
      // Forwarded verbatim on purpose — the downstream 422 (unverified
      // jurisdiction) and 409 (self-signoff / blocked closure) are the
      // operator's explanation, not an internal detail to flatten.
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
