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
  AdminUserActionResponseSchema,
  AdminUserDetailResponseSchema,
  AdminUsersListQuerySchema,
  AdminUsersListResponseSchema,
  ReinstateUserRequestSchema,
  SuspendUserRequestSchema,
  UnlockUserRequestSchema,
  type AdminUserActionResponse,
  type AdminUserDetailResponse,
  type AdminUsersListQuery,
  type AdminUsersListResponse,
  type ReinstateUserRequest,
  type SuspendUserRequest,
  type UnlockUserRequest,
} from '@taste-and-see/contracts';

import { AccessTokenGuard, type RequestWithContext } from '@taste-and-see/nest-auth';
import { SuperAdminRoleGuard } from '../../common/guards/admin-role.guard';
import { RateLimitGuard } from '../rate-limit/guards/rate-limit.guard';
import {
  DownstreamHttpClient,
  type DownstreamResult,
} from '../service-registry/services/downstream-http-client';

/**
 * Admin users BFF proxies (TS-126 Slice 1).
 *
 *   GET /api/v1/admin/users
 *     Cursor-paginated search across the identity service's users
 *     table. Forwards the allow-listed query params to
 *     service-identity. Returns the same `AdminUsersListResponse`
 *     shape.
 *
 *   GET /api/v1/admin/users/:id
 *     Forward the path-param to service-identity and return the
 *     `AdminUserDetailResponse`. 404 is forwarded verbatim from the
 *     downstream when the id does not resolve.
 *
 * Both endpoints sit behind three guards (in order):
 *   1. `AccessTokenGuard`   — verify the JWT + attach RequestContext.
 *   2. `SuperAdminRoleGuard` — require an active super_admin role.
 *   3. `RateLimitGuard`     — apply the default policy.
 *
 * The downstream service-identity ALSO enforces the super_admin gate
 * (defence-in-depth) so a caller that bypasses the gateway and hits
 * service-identity directly still fails at the service boundary.
 *
 * **Slice 1 + TS-126-followup-1 scope.** Read + the three mutations
 * named in TS-025-followup-2. Impersonation, KYC document review,
 * and background-check status surfaces arrive in subsequent TS-126
 * follow-ups; their proxies will slot in alongside these.
 *
 * **Idempotency forwarding.** Each mutation proxy extracts the
 * inbound `Idempotency-Key` header and forwards it to the downstream
 * so the service-identity `@Idempotent()` interceptor can collapse a
 * client-side retry against the cached response. CLAUDE.md §3.3 /
 * §17.5. Closes TS-140-followup-5 / TS-125-followup-10 for the
 * proxies that adopt it.
 */
@Controller('api/v1/admin/users')
@UseGuards(AccessTokenGuard, SuperAdminRoleGuard, RateLimitGuard)
export class AdminUsersProxyController {
  constructor(private readonly downstream: DownstreamHttpClient) {}

  @Get()
  @HttpCode(HttpStatus.OK)
  async list(
    @Query() query: Record<string, unknown>,
    @Req() request: RequestWithContext,
  ): Promise<AdminUsersListResponse> {
    const ctx = requireContext(request);
    const parsed = AdminUsersListQuerySchema.safeParse(query);
    if (!parsed.success) {
      throw new HttpException(
        {
          type: 'about:blank',
          title: 'Bad Request',
          status: HttpStatus.BAD_REQUEST,
          detail: 'Admin users list query failed validation.',
          issues: parsed.error.issues,
        },
        HttpStatus.BAD_REQUEST,
      );
    }

    const downstreamPath = buildListPath(parsed.data);
    const result: DownstreamResult = await this.downstream.call({
      service: 'identity',
      path: downstreamPath,
      method: 'GET',
      actor: ctx,
      traceId: extractTraceId(request),
    });

    return mapResult(
      result,
      AdminUsersListResponseSchema,
      'admin-users-list',
      extractTraceId(request),
    );
  }

  @Get(':id')
  @HttpCode(HttpStatus.OK)
  async getById(
    @Param('id') id: string,
    @Req() request: RequestWithContext,
  ): Promise<AdminUserDetailResponse> {
    const ctx = requireContext(request);

    const result: DownstreamResult = await this.downstream.call({
      service: 'identity',
      path: `/api/v1/admin/users/${encodeURIComponent(id)}`,
      method: 'GET',
      actor: ctx,
      traceId: extractTraceId(request),
    });

    return mapResult(
      result,
      AdminUserDetailResponseSchema,
      'admin-user-detail',
      extractTraceId(request),
    );
  }

  @Post(':id/suspend')
  @HttpCode(HttpStatus.OK)
  async suspend(
    @Param('id') id: string,
    @Body() body: unknown,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Req() request: RequestWithContext,
  ): Promise<AdminUserActionResponse> {
    const ctx = requireContext(request);
    const parsed = SuspendUserRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw badRequest('Suspend user payload failed validation.', parsed.error.issues);
    }
    return this.callAction({
      ctx,
      path: `/api/v1/admin/users/${encodeURIComponent(id)}/suspend`,
      body: parsed.data,
      idempotencyKey,
      surface: 'admin-user-suspend',
      request,
    });
  }

  @Post(':id/reinstate')
  @HttpCode(HttpStatus.OK)
  async reinstate(
    @Param('id') id: string,
    @Body() body: unknown,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Req() request: RequestWithContext,
  ): Promise<AdminUserActionResponse> {
    const ctx = requireContext(request);
    const parsed = ReinstateUserRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw badRequest('Reinstate user payload failed validation.', parsed.error.issues);
    }
    return this.callAction({
      ctx,
      path: `/api/v1/admin/users/${encodeURIComponent(id)}/reinstate`,
      body: parsed.data,
      idempotencyKey,
      surface: 'admin-user-reinstate',
      request,
    });
  }

  @Post(':id/unlock')
  @HttpCode(HttpStatus.OK)
  async unlock(
    @Param('id') id: string,
    @Body() body: unknown,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Req() request: RequestWithContext,
  ): Promise<AdminUserActionResponse> {
    const ctx = requireContext(request);
    const parsed = UnlockUserRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw badRequest('Unlock user payload failed validation.', parsed.error.issues);
    }
    return this.callAction({
      ctx,
      path: `/api/v1/admin/users/${encodeURIComponent(id)}/unlock`,
      body: parsed.data,
      idempotencyKey,
      surface: 'admin-user-unlock',
      request,
    });
  }

  private async callAction(args: {
    readonly ctx: NonNullable<RequestWithContext['requestContext']>;
    readonly path: string;
    readonly body: SuspendUserRequest | ReinstateUserRequest | UnlockUserRequest;
    readonly idempotencyKey: string | undefined;
    readonly surface: string;
    readonly request: RequestWithContext;
  }): Promise<AdminUserActionResponse> {
    const result: DownstreamResult = await this.downstream.call({
      service: 'identity',
      path: args.path,
      method: 'POST',
      body: args.body,
      actor: args.ctx,
      traceId: extractTraceId(args.request),
      idempotencyKey: args.idempotencyKey,
    });
    return mapResult(
      result,
      AdminUserActionResponseSchema,
      args.surface,
      extractTraceId(args.request),
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

/**
 * Build the downstream list path from the contract-allow-listed query
 * fields. Defence-in-depth — only fields the schema accepted are
 * forwarded, so query-string smuggling can't reach the downstream.
 */
function buildListPath(query: AdminUsersListQuery): string {
  const params = new URLSearchParams();
  params.set('limit', String(query.limit));
  if (query.q !== undefined) params.set('q', query.q);
  if (query.status !== undefined) params.set('status', query.status);
  if (query.roleName !== undefined) params.set('roleName', query.roleName);
  if (query.cursor !== undefined) params.set('cursor', query.cursor);
  return `/api/v1/admin/users?${params.toString()}`;
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
          detail: `Downstream service-identity returned a body that does not conform to the ${surface} contract.`,
          ...(traceId !== undefined && { traceId }),
        });
      }
      return parsed.data;
    }
    case 'client_error': {
      // Forward the downstream's status verbatim (404 / 403 / etc.)
      // alongside the problem-details body it returned.
      const body = toBodyOrFallback(result.body, 'Downstream client error.');
      throw new HttpException(body, result.status);
    }
    case 'server_error': {
      throw new BadGatewayException({
        type: 'about:blank',
        title: 'Bad Gateway',
        status: HttpStatus.BAD_GATEWAY,
        detail: 'Downstream service-identity returned an unsuccessful response.',
        ...(traceId !== undefined && { traceId }),
      });
    }
    case 'timeout': {
      throw new GatewayTimeoutException({
        type: 'about:blank',
        title: 'Gateway Timeout',
        status: HttpStatus.GATEWAY_TIMEOUT,
        detail: 'Downstream service-identity did not respond within the timeout window.',
        ...(traceId !== undefined && { traceId }),
      });
    }
    case 'network_error': {
      throw new BadGatewayException({
        type: 'about:blank',
        title: 'Bad Gateway',
        status: HttpStatus.BAD_GATEWAY,
        detail: 'Downstream service-identity is unreachable.',
        ...(traceId !== undefined && { traceId }),
      });
    }
    case 'not_configured': {
      throw new ServiceUnavailableException({
        type: 'about:blank',
        title: 'Service Unavailable',
        status: HttpStatus.SERVICE_UNAVAILABLE,
        detail: `Gateway has no route for the '${result.service}' service. Configure IDENTITY_SERVICE_BASE_URL.`,
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
