import {
  BadGatewayException,
  Body,
  Controller,
  Delete,
  GatewayTimeoutException,
  Get,
  Headers,
  HttpCode,
  HttpException,
  HttpStatus,
  Param,
  Post,
  Query,
  Req,
  ServiceUnavailableException,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import {
  ConciergeAssignmentsListResponseSchema,
  CreateConciergeAssignmentRequestSchema,
  CreateConciergeAssignmentResponseSchema,
  EndConciergeAssignmentResponseSchema,
  ListConciergeAssignmentsQuerySchema,
  type ConciergeAssignmentsListResponse,
  type CreateConciergeAssignmentResponse,
  type EndConciergeAssignmentResponse,
  type ListConciergeAssignmentsQuery,
} from '@taste-and-see/contracts';
import { AccessTokenGuard, type RequestWithContext } from '@taste-and-see/nest-auth';

import { SuperAdminRoleGuard } from '../../common/guards/admin-role.guard';
import { RateLimitGuard } from '../rate-limit/guards/rate-limit.guard';
import {
  DownstreamHttpClient,
  type DownstreamResult,
} from '../service-registry/services/downstream-http-client';

/**
 * Admin concierge-assignments BFF proxy (TS-222; PRD §5.1 Tier 3, §6.6;
 * PDD §10.6).
 *
 *   `POST   /api/v1/admin/concierge/assignments`               — assign / replace
 *   `GET    /api/v1/admin/concierge/assignments?householdId=…` — per-household history
 *   `DELETE /api/v1/admin/concierge/assignments/:assignmentId` — end
 *
 * Forwards to service-concierge's `/api/v1/concierge/assignments`
 * surface. All three sit behind three guards (in order):
 *   1. `AccessTokenGuard`    — verify the JWT + attach RequestContext.
 *   2. `SuperAdminRoleGuard` — require an active super_admin role.
 *   3. `RateLimitGuard`      — apply the default policy.
 *
 * service-concierge ALSO enforces the super_admin gate (defence-in-depth)
 * so a caller that bypasses the gateway still fails at the service
 * boundary. The actor identity propagates via the signed trust-header
 * envelope the `DownstreamHttpClient` mints (`actor: ctx`).
 *
 * **Actor attribution on create.** The gateway stamps the authenticated
 * actor's `userId` into the POST body's `assignedByUserId`, overriding any
 * smuggled value. (service-concierge ALSO derives the attribution from the
 * verified token, so this is belt-and-braces — the body field exists for
 * the gateway-stamping convention + forward-compat.)
 *
 * **Idempotency-Key.** The POST + DELETE proxies forward the inbound
 * `Idempotency-Key` header so a client-side retry collapses against
 * service-concierge's `@Idempotent()` cached response.
 */
@Controller('api/v1/admin/concierge/assignments')
@UseGuards(AccessTokenGuard, SuperAdminRoleGuard, RateLimitGuard)
export class AdminConciergeAssignmentsProxyController {
  constructor(private readonly downstream: DownstreamHttpClient) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  async create(
    @Body() body: unknown,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Req() request: RequestWithContext,
  ): Promise<CreateConciergeAssignmentResponse> {
    const ctx = requireContext(request);
    const traceId = extractTraceId(request);

    const parsed = CreateConciergeAssignmentRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw badRequest('Concierge assignment payload failed validation.', parsed.error.issues);
    }

    // Stamp the authenticated actor so ops audit captures who made the
    // assignment. Overrides any smuggled value.
    const forwardBody = { ...parsed.data, assignedByUserId: ctx.userId };

    const result: DownstreamResult = await this.downstream.call({
      service: 'concierge',
      path: '/api/v1/concierge/assignments',
      method: 'POST',
      body: forwardBody,
      actor: ctx,
      traceId,
      idempotencyKey,
    });

    return mapResult(
      result,
      CreateConciergeAssignmentResponseSchema,
      'admin-concierge-assignment-create',
      traceId,
    );
  }

  @Get()
  @HttpCode(HttpStatus.OK)
  async list(
    @Query() query: Record<string, unknown>,
    @Req() request: RequestWithContext,
  ): Promise<ConciergeAssignmentsListResponse> {
    const ctx = requireContext(request);
    const traceId = extractTraceId(request);

    const parsed = ListConciergeAssignmentsQuerySchema.safeParse(query);
    if (!parsed.success) {
      throw badRequest('Concierge assignments list query failed validation.', parsed.error.issues);
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
      ConciergeAssignmentsListResponseSchema,
      'admin-concierge-assignments-list',
      traceId,
    );
  }

  @Delete(':assignmentId')
  @HttpCode(HttpStatus.OK)
  async end(
    @Param('assignmentId') assignmentId: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Req() request: RequestWithContext,
  ): Promise<EndConciergeAssignmentResponse> {
    const ctx = requireContext(request);
    const traceId = extractTraceId(request);

    const result: DownstreamResult = await this.downstream.call({
      service: 'concierge',
      path: `/api/v1/concierge/assignments/${encodeURIComponent(assignmentId)}`,
      method: 'DELETE',
      actor: ctx,
      traceId,
      idempotencyKey,
    });

    return mapResult(
      result,
      EndConciergeAssignmentResponseSchema,
      'admin-concierge-assignment-end',
      traceId,
    );
  }
}

/**
 * Rebuild the downstream query string from the validated query — a
 * defence-in-depth allow-list so a smuggled param can't ride through to
 * service-concierge.
 */
function buildListPath(query: ListConciergeAssignmentsQuery): string {
  const params = new URLSearchParams();
  params.set('householdId', query.householdId);
  params.set('limit', String(query.limit));
  if (query.activeOnly !== undefined) params.set('activeOnly', String(query.activeOnly));
  return `/api/v1/concierge/assignments?${params.toString()}`;
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
