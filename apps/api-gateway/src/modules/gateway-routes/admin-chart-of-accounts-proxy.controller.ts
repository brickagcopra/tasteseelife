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
  Query,
  Req,
  ServiceUnavailableException,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import {
  AccountsListResponseSchema,
  ListAccountsQuerySchema,
  UpdateAccountActiveRequestSchema,
  UpdateAccountActiveResponseSchema,
  type AccountsListResponse,
  type ListAccountsQuery,
  type UpdateAccountActiveResponse,
} from '@taste-and-see/contracts';

import { AccessTokenGuard, type RequestWithContext } from '@taste-and-see/nest-auth';
import { SuperAdminRoleGuard } from '../../common/guards/admin-role.guard';
import { RateLimitGuard } from '../rate-limit/guards/rate-limit.guard';
import {
  DownstreamHttpClient,
  type DownstreamResult,
} from '../service-registry/services/downstream-http-client';

/**
 * Admin chart-of-accounts BFF proxies (TS-129-followup-1).
 *
 *   GET   /api/v1/admin/accounts
 *     Read-through proxy of the existing public catalog endpoint
 *     (`GET /api/v1/accounts` on service-accounting). The admin gate is
 *     enforced at the gateway edge; the downstream public endpoint is
 *     `AccessTokenGuard`-only, but the surface here is admin-only by
 *     contract so the gate is effectively layered.
 *
 *   PATCH /api/v1/admin/accounts/:id
 *     Forwards the validated PATCH body to service-accounting's admin
 *     surface (`PATCH /api/v1/admin/accounts/:id`). Carries
 *     `Idempotency-Key` through so the downstream `@Idempotent()`
 *     interceptor can collapse a client-side retry against the cached
 *     response.
 *
 * Both endpoints sit behind three guards (in order):
 *   1. `AccessTokenGuard`     — verify the JWT + attach RequestContext.
 *   2. `SuperAdminRoleGuard`  — require an active super_admin role.
 *   3. `RateLimitGuard`       — apply the default policy.
 *
 * The downstream service-accounting ALSO enforces the super_admin gate
 * on the PATCH endpoint (defence-in-depth). Mirrors
 * `AdminJournalsProxyController` (TS-129 Slice 1) shape one-for-one.
 */
@Controller('api/v1/admin/accounts')
@UseGuards(AccessTokenGuard, SuperAdminRoleGuard, RateLimitGuard)
export class AdminChartOfAccountsProxyController {
  constructor(private readonly downstream: DownstreamHttpClient) {}

  @Get()
  @HttpCode(HttpStatus.OK)
  async list(
    @Query() query: Record<string, unknown>,
    @Req() request: RequestWithContext,
  ): Promise<AccountsListResponse> {
    const ctx = requireContext(request);
    const parsed = ListAccountsQuerySchema.safeParse(query);
    if (!parsed.success) {
      throw badRequest(
        'Admin chart-of-accounts list query failed validation.',
        parsed.error.issues,
      );
    }

    const downstreamPath = buildListPath(parsed.data, query);
    const result: DownstreamResult = await this.downstream.call({
      service: 'accounting',
      path: downstreamPath,
      method: 'GET',
      actor: ctx,
      traceId: extractTraceId(request),
    });

    return mapResult(
      result,
      AccountsListResponseSchema,
      'admin-chart-of-accounts-list',
      extractTraceId(request),
    );
  }

  @Patch(':id')
  @HttpCode(HttpStatus.OK)
  async setActive(
    @Param('id') id: string,
    @Body() body: unknown,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Req() request: RequestWithContext,
  ): Promise<UpdateAccountActiveResponse> {
    const ctx = requireContext(request);
    const parsed = UpdateAccountActiveRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw badRequest('Update account active payload failed validation.', parsed.error.issues);
    }

    const result: DownstreamResult = await this.downstream.call({
      service: 'accounting',
      path: `/api/v1/admin/accounts/${encodeURIComponent(id)}`,
      method: 'PATCH',
      body: parsed.data,
      actor: ctx,
      traceId: extractTraceId(request),
      idempotencyKey,
    });

    return mapResult(
      result,
      UpdateAccountActiveResponseSchema,
      'admin-chart-of-accounts-set-active',
      extractTraceId(request),
    );
  }
}

/**
 * Build the downstream `GET /api/v1/accounts` path from the
 * contract-allow-listed query fields plus the inbound `activeOnly`
 * literal. Defence-in-depth — only fields the schema accepted are
 * forwarded, so query-string smuggling can't reach the downstream.
 *
 * The `activeOnly` field round-trips as the literal string `'true'` /
 * `'false'` on the downstream (the schema there does a
 * `union → transform` step). We forward whatever the inbound query
 * carried (default: 'true' if absent), so an admin caller asking for
 * the retired accounts must pass `activeOnly=false` explicitly.
 */
function buildListPath(parsed: ListAccountsQuery, rawQuery: Record<string, unknown>): string {
  const params = new URLSearchParams();
  if (parsed.type !== undefined) params.set('type', parsed.type);
  if (parsed.parentId !== undefined) params.set('parentId', parsed.parentId);

  // `parsed.activeOnly` is the post-transform boolean (default true).
  // We forward the literal string the downstream expects on the wire;
  // the inbound shape is the same.
  const rawActiveOnly = rawQuery['activeOnly'];
  if (typeof rawActiveOnly === 'string') {
    params.set('activeOnly', rawActiveOnly);
  }

  const qs = params.toString();
  return qs.length === 0 ? '/api/v1/accounts' : `/api/v1/accounts?${qs}`;
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
          detail: `Downstream service-accounting returned a body that does not conform to the ${surface} contract.`,
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
        detail: 'Downstream service-accounting returned an unsuccessful response.',
        ...(traceId !== undefined && { traceId }),
      });
    }
    case 'timeout': {
      throw new GatewayTimeoutException({
        type: 'about:blank',
        title: 'Gateway Timeout',
        status: HttpStatus.GATEWAY_TIMEOUT,
        detail: 'Downstream service-accounting did not respond within the timeout window.',
        ...(traceId !== undefined && { traceId }),
      });
    }
    case 'network_error': {
      throw new BadGatewayException({
        type: 'about:blank',
        title: 'Bad Gateway',
        status: HttpStatus.BAD_GATEWAY,
        detail: 'Downstream service-accounting is unreachable.',
        ...(traceId !== undefined && { traceId }),
      });
    }
    case 'not_configured': {
      throw new ServiceUnavailableException({
        type: 'about:blank',
        title: 'Service Unavailable',
        status: HttpStatus.SERVICE_UNAVAILABLE,
        detail: `Gateway has no route for the '${result.service}' service. Configure ACCOUNTING_SERVICE_BASE_URL.`,
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
