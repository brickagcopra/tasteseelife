import {
  BadGatewayException,
  Controller,
  GatewayTimeoutException,
  Get,
  HttpCode,
  HttpException,
  HttpStatus,
  Query,
  Req,
  ServiceUnavailableException,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import {
  AuditEventsListResponseSchema,
  ListAuditEventsByActorQuerySchema,
  ListAuditEventsByResourceKindQuerySchema,
  ListAuditEventsByResourceQuerySchema,
  type AuditEventsListResponse,
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
 * Admin audit-events BFF proxy (TS-295; PRD §10.12, §10.13; PDD §10.3,
 * §17.1; CLAUDE.md §3.6).
 *
 *   GET /api/v1/admin/audit/events/by-resource-kind — kind-wide stream
 *       (the RBAC History view: `rbac_role,rbac_assignment,rbac_approval`)
 *   GET /api/v1/admin/audit/events/by-resource      — one resource's trail
 *   GET /api/v1/admin/audit/events/by-actor         — one actor's trail
 *
 * Forwards to service-audit's identical read surface at the SAME paths.
 * Gated `audit:read` here via `PermissionGuard` (seeded to super_admin,
 * trust & safety, and read_only_auditor since TS-290's catalog);
 * downstream re-checks the access token (the downstream `audit:read`
 * PermissionGuard lift rides TS-052-followup-11). Queries are
 * contract-allow-listed inbound and rebuilt from parsed fields — only
 * fields the schema accepted reach the downstream; responses are
 * parse-checked outbound (repo idiom).
 */
@Controller()
@UseGuards(AccessTokenGuard, PermissionGuard, RateLimitGuard)
export class AdminAuditEventsProxyController {
  constructor(private readonly downstream: DownstreamHttpClient) {}

  @Get('api/v1/admin/audit/events/by-resource-kind')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('audit:read')
  async listByResourceKind(
    @Query() query: Record<string, unknown>,
    @Req() request: RequestWithContext,
  ): Promise<AuditEventsListResponse> {
    const parsed = ListAuditEventsByResourceKindQuerySchema.safeParse(query);
    if (!parsed.success) {
      throw badRequest('Audit by-resource-kind query failed validation.', parsed.error.issues);
    }
    return this.proxyList(
      request,
      buildPath('/api/v1/admin/audit/events/by-resource-kind', {
        resourceKinds: parsed.data.resourceKinds,
        action: parsed.data.action,
        actorUserId: parsed.data.actorUserId,
        order: parsed.data.order,
        cursor: parsed.data.cursor,
        limit: String(parsed.data.limit),
      }),
      'admin-audit-events-by-resource-kind',
    );
  }

  @Get('api/v1/admin/audit/events/by-resource')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('audit:read')
  async listByResource(
    @Query() query: Record<string, unknown>,
    @Req() request: RequestWithContext,
  ): Promise<AuditEventsListResponse> {
    const parsed = ListAuditEventsByResourceQuerySchema.safeParse(query);
    if (!parsed.success) {
      throw badRequest('Audit by-resource query failed validation.', parsed.error.issues);
    }
    return this.proxyList(
      request,
      buildPath('/api/v1/admin/audit/events/by-resource', {
        resourceKind: parsed.data.resourceKind,
        resourceId: parsed.data.resourceId,
        cursor: parsed.data.cursor,
        limit: String(parsed.data.limit),
      }),
      'admin-audit-events-by-resource',
    );
  }

  @Get('api/v1/admin/audit/events/by-actor')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('audit:read')
  async listByActor(
    @Query() query: Record<string, unknown>,
    @Req() request: RequestWithContext,
  ): Promise<AuditEventsListResponse> {
    const parsed = ListAuditEventsByActorQuerySchema.safeParse(query);
    if (!parsed.success) {
      throw badRequest('Audit by-actor query failed validation.', parsed.error.issues);
    }
    return this.proxyList(
      request,
      buildPath('/api/v1/admin/audit/events/by-actor', {
        actorUserId: parsed.data.actorUserId,
        cursor: parsed.data.cursor,
        limit: String(parsed.data.limit),
      }),
      'admin-audit-events-by-actor',
    );
  }

  private async proxyList(
    request: RequestWithContext,
    path: string,
    surface: string,
  ): Promise<AuditEventsListResponse> {
    const ctx = requireContext(request);
    const traceId = extractTraceId(request);

    const result: DownstreamResult = await this.downstream.call({
      service: 'audit',
      path,
      method: 'GET',
      actor: ctx,
      traceId,
    });

    return mapResult(result, AuditEventsListResponseSchema, surface, traceId);
  }
}

/**
 * Rebuild the downstream query string from contract-allow-listed
 * fields — `undefined` values are dropped; everything else is
 * URL-encoded by `URLSearchParams`.
 */
function buildPath(base: string, fields: Record<string, string | undefined>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined) params.set(key, value);
  }
  const qs = params.toString();
  return qs.length > 0 ? `${base}?${qs}` : base;
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
          detail: `Downstream service-audit returned a body that does not conform to the ${surface} contract.`,
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
        detail: 'Downstream service-audit returned an unsuccessful response.',
        ...(traceId !== undefined && { traceId }),
      });
    }
    case 'timeout': {
      throw new GatewayTimeoutException({
        type: 'about:blank',
        title: 'Gateway Timeout',
        status: HttpStatus.GATEWAY_TIMEOUT,
        detail: 'Downstream service-audit did not respond within the timeout window.',
        ...(traceId !== undefined && { traceId }),
      });
    }
    case 'network_error': {
      throw new BadGatewayException({
        type: 'about:blank',
        title: 'Bad Gateway',
        status: HttpStatus.BAD_GATEWAY,
        detail: 'Downstream service-audit is unreachable.',
        ...(traceId !== undefined && { traceId }),
      });
    }
    case 'not_configured': {
      throw new ServiceUnavailableException({
        type: 'about:blank',
        title: 'Service Unavailable',
        status: HttpStatus.SERVICE_UNAVAILABLE,
        detail: `Gateway has no route for the '${result.service}' service. Configure AUDIT_SERVICE_BASE_URL.`,
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
