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
  Post,
  Query,
  Req,
  ServiceUnavailableException,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import {
  AddConciergeTicketNoteRequestSchema,
  AddConciergeTicketNoteResponseSchema,
  ConciergeOpsTicketDetailResponseSchema,
  ConciergeOpsTicketsListResponseSchema,
  EscalateConciergeTicketRequestSchema,
  EscalateConciergeTicketResponseSchema,
  ListConciergeOpsTicketsQuerySchema,
  TransitionConciergeTicketRequestSchema,
  TransitionConciergeTicketResponseSchema,
  type AddConciergeTicketNoteResponse,
  type ConciergeOpsTicketDetailResponse,
  type ConciergeOpsTicketsListResponse,
  type EscalateConciergeTicketResponse,
  type ListConciergeOpsTicketsQuery,
  type TransitionConciergeTicketResponse,
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
 * Admin concierge ops-console BFF proxy (TS-224; PRD §10.6; PDD §10.6).
 *
 *   GET  /api/v1/admin/concierge/tickets               — SLA-ordered queue
 *   GET  /api/v1/admin/concierge/tickets/:ticketId     — detail + notes
 *   POST /api/v1/admin/concierge/tickets/:ticketId/transition — status move
 *   POST /api/v1/admin/concierge/tickets/:ticketId/escalate   — escalate
 *   POST /api/v1/admin/concierge/tickets/:ticketId/notes      — add note
 *
 * Forwards to service-concierge's `/api/v1/admin/concierge/tickets` surface.
 *
 * **Authorisation.** All endpoints sit behind three guards (in order):
 *   1. `AccessTokenGuard` — verify the JWT + attach RequestContext.
 *   2. `PermissionGuard`  — evaluate the `@RequirePermissions(...)` metadata:
 *      `concierge:read` for the reads, `concierge:write` for the mutations.
 *   3. `RateLimitGuard`   — apply the default policy.
 * service-concierge ALSO enforces the same permission gate (defence-in-depth)
 * so a caller that bypasses the gateway still fails at the service boundary.
 * The actor identity propagates via the signed trust-header envelope the
 * `DownstreamHttpClient` mints (`actor: ctx`).
 *
 * **Idempotency-Key.** The three POST proxies forward the inbound
 * `Idempotency-Key` header so a client-side retry collapses against
 * service-concierge's `@Idempotent()` cached response.
 *
 * This is the first gateway proxy to gate on `PermissionGuard` rather than
 * the local `SuperAdminRoleGuard` — the permission gate is the long-term
 * CLAUDE.md §3.2 destination, and TS-224 wires it end-to-end (the
 * `concierge:read` / `concierge:write` permissions land in the RBAC catalog
 * in the same PR).
 */
@Controller('api/v1/admin/concierge/tickets')
@UseGuards(AccessTokenGuard, PermissionGuard, RateLimitGuard)
export class AdminConciergeOpsProxyController {
  constructor(private readonly downstream: DownstreamHttpClient) {}

  @Get()
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('concierge:read')
  async listQueue(
    @Query() query: Record<string, unknown>,
    @Req() request: RequestWithContext,
  ): Promise<ConciergeOpsTicketsListResponse> {
    const ctx = requireContext(request);
    const traceId = extractTraceId(request);

    const parsed = ListConciergeOpsTicketsQuerySchema.safeParse(query);
    if (!parsed.success) {
      throw badRequest('Concierge ops queue query failed validation.', parsed.error.issues);
    }

    const result: DownstreamResult = await this.downstream.call({
      service: 'concierge',
      path: buildQueuePath(parsed.data),
      method: 'GET',
      actor: ctx,
      traceId,
    });

    return mapResult(
      result,
      ConciergeOpsTicketsListResponseSchema,
      'admin-concierge-ops-queue',
      traceId,
    );
  }

  @Get(':ticketId')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('concierge:read')
  async getTicket(
    @Param('ticketId') ticketId: string,
    @Req() request: RequestWithContext,
  ): Promise<ConciergeOpsTicketDetailResponse> {
    const ctx = requireContext(request);
    const traceId = extractTraceId(request);

    const result: DownstreamResult = await this.downstream.call({
      service: 'concierge',
      path: `/api/v1/admin/concierge/tickets/${encodeURIComponent(ticketId)}`,
      method: 'GET',
      actor: ctx,
      traceId,
    });

    return mapResult(
      result,
      ConciergeOpsTicketDetailResponseSchema,
      'admin-concierge-ops-detail',
      traceId,
    );
  }

  @Post(':ticketId/transition')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('concierge:write')
  async transition(
    @Param('ticketId') ticketId: string,
    @Body() body: unknown,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Req() request: RequestWithContext,
  ): Promise<TransitionConciergeTicketResponse> {
    const ctx = requireContext(request);
    const traceId = extractTraceId(request);

    const parsed = TransitionConciergeTicketRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw badRequest(
        'Concierge ticket transition payload failed validation.',
        parsed.error.issues,
      );
    }

    const result: DownstreamResult = await this.downstream.call({
      service: 'concierge',
      path: `/api/v1/admin/concierge/tickets/${encodeURIComponent(ticketId)}/transition`,
      method: 'POST',
      body: parsed.data,
      actor: ctx,
      traceId,
      idempotencyKey,
    });

    return mapResult(
      result,
      TransitionConciergeTicketResponseSchema,
      'admin-concierge-ops-transition',
      traceId,
    );
  }

  @Post(':ticketId/escalate')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('concierge:write')
  async escalate(
    @Param('ticketId') ticketId: string,
    @Body() body: unknown,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Req() request: RequestWithContext,
  ): Promise<EscalateConciergeTicketResponse> {
    const ctx = requireContext(request);
    const traceId = extractTraceId(request);

    const parsed = EscalateConciergeTicketRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw badRequest('Concierge ticket escalate payload failed validation.', parsed.error.issues);
    }

    const result: DownstreamResult = await this.downstream.call({
      service: 'concierge',
      path: `/api/v1/admin/concierge/tickets/${encodeURIComponent(ticketId)}/escalate`,
      method: 'POST',
      body: parsed.data,
      actor: ctx,
      traceId,
      idempotencyKey,
    });

    return mapResult(
      result,
      EscalateConciergeTicketResponseSchema,
      'admin-concierge-ops-escalate',
      traceId,
    );
  }

  @Post(':ticketId/notes')
  @HttpCode(HttpStatus.CREATED)
  @RequirePermissions('concierge:write')
  async addNote(
    @Param('ticketId') ticketId: string,
    @Body() body: unknown,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Req() request: RequestWithContext,
  ): Promise<AddConciergeTicketNoteResponse> {
    const ctx = requireContext(request);
    const traceId = extractTraceId(request);

    const parsed = AddConciergeTicketNoteRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw badRequest('Concierge ticket note payload failed validation.', parsed.error.issues);
    }

    const result: DownstreamResult = await this.downstream.call({
      service: 'concierge',
      path: `/api/v1/admin/concierge/tickets/${encodeURIComponent(ticketId)}/notes`,
      method: 'POST',
      body: parsed.data,
      actor: ctx,
      traceId,
      idempotencyKey,
    });

    return mapResult(
      result,
      AddConciergeTicketNoteResponseSchema,
      'admin-concierge-ops-note',
      traceId,
    );
  }
}

/**
 * Rebuild the downstream query string from the validated query — a
 * defence-in-depth allow-list so a smuggled param can't ride through to
 * service-concierge.
 */
function buildQueuePath(query: ListConciergeOpsTicketsQuery): string {
  const params = new URLSearchParams();
  params.set('limit', String(query.limit));
  if (query.status !== undefined) params.set('status', query.status);
  if (query.escalationPath !== undefined) params.set('escalationPath', query.escalationPath);
  if (query.kind !== undefined) params.set('kind', query.kind);
  if (query.householdId !== undefined) params.set('householdId', query.householdId);
  return `/api/v1/admin/concierge/tickets?${params.toString()}`;
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
