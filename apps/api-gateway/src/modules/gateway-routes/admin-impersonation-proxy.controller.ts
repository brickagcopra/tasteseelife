import {
  BadGatewayException,
  Body,
  Controller,
  GatewayTimeoutException,
  Headers,
  HttpCode,
  HttpException,
  HttpStatus,
  Param,
  Post,
  Req,
  ServiceUnavailableException,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import {
  EndImpersonationRequestSchema,
  EndImpersonationResponseSchema,
  ImpersonateUserRequestSchema,
  ImpersonateUserResponseSchema,
  type EndImpersonationRequest,
  type EndImpersonationResponse,
  type ImpersonateUserRequest,
  type ImpersonateUserResponse,
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
 * Admin impersonation BFF proxies (TS-297; PRD §10.2).
 *
 *   POST /api/v1/admin/users/:id/impersonate
 *   POST /api/v1/admin/impersonation/end
 *
 * Both sit behind `AccessTokenGuard` → `PermissionGuard`
 * (`user:impersonate` — super_admin only in Phase 1) → `RateLimitGuard`,
 * re-enforcing at the edge the same permission service-identity checks
 * at the service boundary (defence-in-depth, same posture as every
 * admin proxy since TS-290).
 *
 * The inbound `Idempotency-Key` is forwarded so service-identity's
 * `@Idempotent()` interceptor collapses operator-click retries.
 * Response bodies are parse-checked against the contract before being
 * returned upstream — the impersonation response carries raw session
 * tokens, so a drifted downstream body must fail loudly rather than
 * leak an unexpected shape.
 */
@Controller()
@UseGuards(AccessTokenGuard, PermissionGuard, RateLimitGuard)
export class AdminImpersonationProxyController {
  constructor(private readonly downstream: DownstreamHttpClient) {}

  @Post('api/v1/admin/users/:id/impersonate')
  @HttpCode(HttpStatus.CREATED)
  @RequirePermissions('user:impersonate')
  async impersonate(
    @Param('id') id: string,
    @Body() body: unknown,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Req() request: RequestWithContext,
  ): Promise<ImpersonateUserResponse> {
    const ctx = requireContext(request);
    const parsed = ImpersonateUserRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw badRequest('Impersonation payload failed validation.', parsed.error.issues);
    }
    const requestBody: ImpersonateUserRequest = parsed.data;

    const result: DownstreamResult = await this.downstream.call({
      service: 'identity',
      path: `/api/v1/admin/users/${encodeURIComponent(id)}/impersonate`,
      method: 'POST',
      body: requestBody,
      actor: ctx,
      traceId: extractTraceId(request),
      idempotencyKey,
    });
    return mapResult(
      result,
      ImpersonateUserResponseSchema,
      'admin-user-impersonate',
      extractTraceId(request),
    );
  }

  @Post('api/v1/admin/impersonation/end')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('user:impersonate')
  async end(
    @Body() body: unknown,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Req() request: RequestWithContext,
  ): Promise<EndImpersonationResponse> {
    const ctx = requireContext(request);
    const parsed = EndImpersonationRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw badRequest('End-impersonation payload failed validation.', parsed.error.issues);
    }
    const requestBody: EndImpersonationRequest = parsed.data;

    const result: DownstreamResult = await this.downstream.call({
      service: 'identity',
      path: '/api/v1/admin/impersonation/end',
      method: 'POST',
      body: requestBody,
      actor: ctx,
      traceId: extractTraceId(request),
      idempotencyKey,
    });
    return mapResult(
      result,
      EndImpersonationResponseSchema,
      'admin-impersonation-end',
      extractTraceId(request),
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
