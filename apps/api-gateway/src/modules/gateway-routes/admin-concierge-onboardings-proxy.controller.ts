import {
  BadGatewayException,
  Body,
  Controller,
  GatewayTimeoutException,
  Get,
  Headers,
  HttpCode,
  HttpException,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
  Req,
  ServiceUnavailableException,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import {
  ConciergeOnboardingStepKeySchema,
  ConciergeOnboardingsListResponseSchema,
  CreateConciergeOnboardingRequestSchema,
  CreateConciergeOnboardingResponseSchema,
  GetConciergeOnboardingResponseSchema,
  ListConciergeOnboardingsQuerySchema,
  UpdateConciergeOnboardingRequestSchema,
  UpdateConciergeOnboardingResponseSchema,
  UpdateConciergeOnboardingStepRequestSchema,
  UpdateConciergeOnboardingStepResponseSchema,
  type ConciergeOnboardingsListResponse,
  type CreateConciergeOnboardingResponse,
  type GetConciergeOnboardingResponse,
  type ListConciergeOnboardingsQuery,
  type UpdateConciergeOnboardingResponse,
  type UpdateConciergeOnboardingStepResponse,
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
 * Admin concierge onboarding BFF proxy (TS-228; PRD §5.1 Tier 3; PDD §10.6).
 *
 *   GET   /api/v1/admin/concierge/onboardings?householdId=&status=&limit=  — list
 *   POST  /api/v1/admin/concierge/onboardings                             — create
 *   GET   /api/v1/admin/concierge/onboardings/:onboardingId               — detail
 *   PATCH /api/v1/admin/concierge/onboardings/:onboardingId               — update / cancel
 *   PATCH /api/v1/admin/concierge/onboardings/:onboardingId/steps/:stepKey — advance a step
 *
 * Forwards to service-concierge's `/api/v1/admin/concierge/onboardings`
 * surface (the TS-228 Tier-3 white-glove kickoff checklist).
 *
 * **Authorisation.** All endpoints sit behind three guards (in order):
 *   1. `AccessTokenGuard` — verify the JWT + attach RequestContext.
 *   2. `PermissionGuard`  — evaluate `@RequirePermissions(...)`:
 *      `concierge:read` for the reads, `concierge:write` for the mutations.
 *   3. `RateLimitGuard`   — apply the default policy.
 * service-concierge ALSO enforces the same permission gate (defence-in-depth).
 * The acting staff member's identity propagates via the signed trust-header
 * envelope the `DownstreamHttpClient` mints (`actor: ctx`) — service-concierge
 * stamps `started_by_user_id` / `completed_by_user_id` from the verified token,
 * never the body.
 *
 * **Idempotency-Key.** The POST + PATCH proxies forward the inbound
 * `Idempotency-Key` header so a client-side retry collapses against
 * service-concierge's `@Idempotent()` cached response.
 *
 * Sibling of `AdminConciergeScheduledEventsProxyController` (TS-227) — both
 * gate on `PermissionGuard` rather than `SuperAdminRoleGuard`.
 */
@Controller('api/v1/admin/concierge/onboardings')
@UseGuards(AccessTokenGuard, PermissionGuard, RateLimitGuard)
export class AdminConciergeOnboardingsProxyController {
  constructor(private readonly downstream: DownstreamHttpClient) {}

  @Get()
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('concierge:read')
  async list(
    @Query() query: Record<string, unknown>,
    @Req() request: RequestWithContext,
  ): Promise<ConciergeOnboardingsListResponse> {
    const ctx = requireContext(request);
    const traceId = extractTraceId(request);

    const parsed = ListConciergeOnboardingsQuerySchema.safeParse(query);
    if (!parsed.success) {
      throw badRequest('Concierge onboardings query failed validation.', parsed.error.issues);
    }

    const result: DownstreamResult = await this.downstream.call({
      service: 'concierge',
      path: buildListPath(parsed.data),
      method: 'GET',
      actor: ctx,
      traceId,
    });

    return mapResult(
      result,
      ConciergeOnboardingsListResponseSchema,
      'admin-concierge-onboardings-list',
      traceId,
    );
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @RequirePermissions('concierge:write')
  async create(
    @Body() body: unknown,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Req() request: RequestWithContext,
  ): Promise<CreateConciergeOnboardingResponse> {
    const ctx = requireContext(request);
    const traceId = extractTraceId(request);

    const parsed = CreateConciergeOnboardingRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw badRequest(
        'Concierge onboarding create payload failed validation.',
        parsed.error.issues,
      );
    }

    const result: DownstreamResult = await this.downstream.call({
      service: 'concierge',
      path: '/api/v1/admin/concierge/onboardings',
      method: 'POST',
      body: parsed.data,
      actor: ctx,
      traceId,
      idempotencyKey,
    });

    return mapResult(
      result,
      CreateConciergeOnboardingResponseSchema,
      'admin-concierge-onboardings-create',
      traceId,
    );
  }

  @Get(':onboardingId')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('concierge:read')
  async get(
    @Param('onboardingId') onboardingId: string,
    @Req() request: RequestWithContext,
  ): Promise<GetConciergeOnboardingResponse> {
    const ctx = requireContext(request);
    const traceId = extractTraceId(request);

    const result: DownstreamResult = await this.downstream.call({
      service: 'concierge',
      path: `/api/v1/admin/concierge/onboardings/${encodeURIComponent(onboardingId)}`,
      method: 'GET',
      actor: ctx,
      traceId,
    });

    return mapResult(
      result,
      GetConciergeOnboardingResponseSchema,
      'admin-concierge-onboardings-get',
      traceId,
    );
  }

  @Patch(':onboardingId')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('concierge:write')
  async update(
    @Param('onboardingId') onboardingId: string,
    @Body() body: unknown,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Req() request: RequestWithContext,
  ): Promise<UpdateConciergeOnboardingResponse> {
    const ctx = requireContext(request);
    const traceId = extractTraceId(request);

    const parsed = UpdateConciergeOnboardingRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw badRequest(
        'Concierge onboarding update payload failed validation.',
        parsed.error.issues,
      );
    }

    const result: DownstreamResult = await this.downstream.call({
      service: 'concierge',
      path: `/api/v1/admin/concierge/onboardings/${encodeURIComponent(onboardingId)}`,
      method: 'PATCH',
      body: parsed.data,
      actor: ctx,
      traceId,
      idempotencyKey,
    });

    return mapResult(
      result,
      UpdateConciergeOnboardingResponseSchema,
      'admin-concierge-onboardings-update',
      traceId,
    );
  }

  @Patch(':onboardingId/steps/:stepKey')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('concierge:write')
  async updateStep(
    @Param('onboardingId') onboardingId: string,
    @Param('stepKey') stepKey: string,
    @Body() body: unknown,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Req() request: RequestWithContext,
  ): Promise<UpdateConciergeOnboardingStepResponse> {
    const ctx = requireContext(request);
    const traceId = extractTraceId(request);

    // Validate the step key at the edge — a typo shaves the downstream hop.
    const parsedStepKey = ConciergeOnboardingStepKeySchema.safeParse(stepKey);
    if (!parsedStepKey.success) {
      throw badRequest(`Unknown onboarding step '${stepKey}'.`, parsedStepKey.error.issues);
    }

    const parsed = UpdateConciergeOnboardingStepRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw badRequest(
        'Concierge onboarding step update payload failed validation.',
        parsed.error.issues,
      );
    }

    const result: DownstreamResult = await this.downstream.call({
      service: 'concierge',
      path: `/api/v1/admin/concierge/onboardings/${encodeURIComponent(onboardingId)}/steps/${encodeURIComponent(parsedStepKey.data)}`,
      method: 'PATCH',
      body: parsed.data,
      actor: ctx,
      traceId,
      idempotencyKey,
    });

    return mapResult(
      result,
      UpdateConciergeOnboardingStepResponseSchema,
      'admin-concierge-onboardings-update-step',
      traceId,
    );
  }
}

/**
 * Rebuild the downstream query string from the validated query — a
 * defence-in-depth allow-list so a smuggled param can't ride through to
 * service-concierge.
 */
function buildListPath(query: ListConciergeOnboardingsQuery): string {
  const params = new URLSearchParams();
  params.set('limit', String(query.limit));
  if (query.householdId !== undefined) params.set('householdId', query.householdId);
  if (query.status !== undefined) params.set('status', query.status);
  return `/api/v1/admin/concierge/onboardings?${params.toString()}`;
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
