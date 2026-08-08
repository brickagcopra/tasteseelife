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
  AdminRoleApprovalResponseSchema,
  AdminRoleApprovalsListQuerySchema,
  AdminRoleApprovalsListResponseSchema,
  DecideRoleApprovalRequestSchema,
  RequestRoleApprovalRequestSchema,
  type AdminRoleApprovalResponse,
  type AdminRoleApprovalsListQuery,
  type AdminRoleApprovalsListResponse,
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
 * Admin RBAC role-APPROVAL BFF proxy (TS-294; CLAUDE.md §3.2).
 *
 *   POST /api/v1/admin/role-approvals               — request a sensitive-role grant
 *   GET  /api/v1/admin/role-approvals?status=       — reviewer queue / history
 *   POST /api/v1/admin/role-approvals/:id/approve   — second-admin approval
 *   POST /api/v1/admin/role-approvals/:id/reject    — rejection / self-cancel
 *
 * Forwards to service-identity's identical surface. Mirrors the
 * role-assignments proxy (TS-292): `rbac:read` for the list,
 * `rbac:write` for mutations — enforced here AND downstream
 * (defence-in-depth; the downstream ADDITIONALLY requires the approver
 * to hold super_admin and not be the requester — policy the gateway
 * does not duplicate because it needs row state). Payloads
 * contract-validated in both directions; Idempotency-Key forwarded on
 * the mutations.
 */
@Controller()
@UseGuards(AccessTokenGuard, PermissionGuard, RateLimitGuard)
export class AdminRoleApprovalsProxyController {
  constructor(private readonly downstream: DownstreamHttpClient) {}

  @Get('api/v1/admin/role-approvals')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('rbac:read')
  async list(
    @Query() query: Record<string, unknown>,
    @Req() request: RequestWithContext,
  ): Promise<AdminRoleApprovalsListResponse> {
    const ctx = requireContext(request);
    const traceId = extractTraceId(request);

    const parsed = AdminRoleApprovalsListQuerySchema.safeParse(query);
    if (!parsed.success) {
      throw badRequest('Role-approvals list query failed validation.', parsed.error.issues);
    }

    const result: DownstreamResult = await this.downstream.call({
      service: 'identity',
      path: buildListPath(parsed.data),
      method: 'GET',
      actor: ctx,
      traceId,
    });
    return mapResult(
      result,
      AdminRoleApprovalsListResponseSchema,
      'admin-role-approvals-list',
      traceId,
    );
  }

  @Post('api/v1/admin/role-approvals')
  @HttpCode(HttpStatus.CREATED)
  @RequirePermissions('rbac:write')
  async request(
    @Body() body: unknown,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Req() request: RequestWithContext,
  ): Promise<AdminRoleApprovalResponse> {
    const ctx = requireContext(request);
    const traceId = extractTraceId(request);

    const parsed = RequestRoleApprovalRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw badRequest('Role-approval request payload failed validation.', parsed.error.issues);
    }

    const result: DownstreamResult = await this.downstream.call({
      service: 'identity',
      path: '/api/v1/admin/role-approvals',
      method: 'POST',
      body: parsed.data,
      actor: ctx,
      traceId,
      idempotencyKey,
    });
    return mapResult(
      result,
      AdminRoleApprovalResponseSchema,
      'admin-role-approval-request',
      traceId,
    );
  }

  @Post('api/v1/admin/role-approvals/:approvalId/approve')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('rbac:write')
  async approve(
    @Param('approvalId') approvalId: string,
    @Body() body: unknown,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Req() request: RequestWithContext,
  ): Promise<AdminRoleApprovalResponse> {
    return this.decide('approve', approvalId, body, idempotencyKey, request);
  }

  @Post('api/v1/admin/role-approvals/:approvalId/reject')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('rbac:write')
  async reject(
    @Param('approvalId') approvalId: string,
    @Body() body: unknown,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Req() request: RequestWithContext,
  ): Promise<AdminRoleApprovalResponse> {
    return this.decide('reject', approvalId, body, idempotencyKey, request);
  }

  private async decide(
    action: 'approve' | 'reject',
    approvalId: string,
    body: unknown,
    idempotencyKey: string | undefined,
    request: RequestWithContext,
  ): Promise<AdminRoleApprovalResponse> {
    const ctx = requireContext(request);
    const traceId = extractTraceId(request);

    const parsed = DecideRoleApprovalRequestSchema.safeParse(body ?? {});
    if (!parsed.success) {
      throw badRequest('Role-approval decision payload failed validation.', parsed.error.issues);
    }

    const result: DownstreamResult = await this.downstream.call({
      service: 'identity',
      path: `/api/v1/admin/role-approvals/${encodeURIComponent(approvalId)}/${action}`,
      method: 'POST',
      body: parsed.data,
      actor: ctx,
      traceId,
      idempotencyKey,
    });
    return mapResult(
      result,
      AdminRoleApprovalResponseSchema,
      `admin-role-approval-${action}`,
      traceId,
    );
  }
}

/** Forward only contract-allow-listed query fields. */
function buildListPath(query: AdminRoleApprovalsListQuery): string {
  const base = '/api/v1/admin/role-approvals';
  if (query.status === undefined) return base;
  return `${base}?status=${encodeURIComponent(query.status)}`;
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
          detail: `Downstream service-identity returned a body that does not conform to the ${surface} contract.`,
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
