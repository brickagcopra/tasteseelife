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
  Put,
  Req,
  ServiceUnavailableException,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import {
  OrgSecurityPoliciesListResponseSchema,
  OrgSecurityPolicyResponseSchema,
  OrgSecurityPolicyScopeIdSchema,
  UpsertOrgSecurityPolicyRequestSchema,
  type OrgSecurityPoliciesListResponse,
  type OrgSecurityPolicyResponse,
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
 * Org security-policy BFF proxy (TS-296; CLAUDE.md §3.1; PDD §10.1).
 *
 *   GET /api/v1/admin/org-security-policies          — list
 *   PUT /api/v1/admin/org-security-policies/:scopeId — upsert
 *
 * Forwards to service-identity's identical surface at the SAME paths.
 * Gated `rbac:read` / `rbac:write` here via `PermissionGuard` — this
 * surface configures who can obtain an admin session (`ssoRequired`
 * gates admin-staff logins), the RBAC-administration trust boundary;
 * identity re-enforces the same gate (defence-in-depth). Payloads are
 * contract-validated inbound and responses parse-checked outbound
 * (repo idiom); the Idempotency-Key header is forwarded through.
 */
@Controller()
@UseGuards(AccessTokenGuard, PermissionGuard, RateLimitGuard)
export class AdminOrgSecurityPoliciesProxyController {
  constructor(private readonly downstream: DownstreamHttpClient) {}

  @Get('api/v1/admin/org-security-policies')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('rbac:read')
  async listPolicies(@Req() request: RequestWithContext): Promise<OrgSecurityPoliciesListResponse> {
    const ctx = requireContext(request);
    const traceId = extractTraceId(request);

    const result: DownstreamResult = await this.downstream.call({
      service: 'identity',
      path: '/api/v1/admin/org-security-policies',
      method: 'GET',
      actor: ctx,
      traceId,
    });

    return mapResult(
      result,
      OrgSecurityPoliciesListResponseSchema,
      'admin-org-security-policies-list',
      traceId,
    );
  }

  @Put('api/v1/admin/org-security-policies/:scopeId')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('rbac:write')
  async upsertPolicy(
    @Param('scopeId') scopeId: string,
    @Body() body: unknown,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Req() request: RequestWithContext,
  ): Promise<OrgSecurityPolicyResponse> {
    const ctx = requireContext(request);
    const traceId = extractTraceId(request);

    const parsedScope = OrgSecurityPolicyScopeIdSchema.safeParse(scopeId);
    if (!parsedScope.success) {
      throw badRequest('Org security-policy scope id failed validation.', parsedScope.error.issues);
    }
    const parsed = UpsertOrgSecurityPolicyRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw badRequest(
        'Org security-policy upsert payload failed validation.',
        parsed.error.issues,
      );
    }

    const result: DownstreamResult = await this.downstream.call({
      service: 'identity',
      path: `/api/v1/admin/org-security-policies/${encodeURIComponent(parsedScope.data)}`,
      method: 'PUT',
      body: parsed.data,
      actor: ctx,
      traceId,
      idempotencyKey,
    });

    return mapResult(
      result,
      OrgSecurityPolicyResponseSchema,
      'admin-org-security-policy-upsert',
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
