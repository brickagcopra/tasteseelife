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
  AdminDataSubjectRequestListResponseSchema,
  CreateDataSubjectRequestSchema,
  DataSubjectRequestListResponseSchema,
  DataSubjectRequestReceiptResponseSchema,
  DataSubjectRequestResponseSchema,
  ExtendDataSubjectRequestSchema,
  ListDataSubjectRequestsQuerySchema,
  RefuseDataSubjectRequestSchema,
  VerifyDataSubjectRequestSchema,
  type AdminDataSubjectRequestListResponse,
  type DataSubjectRequestListResponse,
  type DataSubjectRequestReceiptResponse,
  type DataSubjectRequestResponse,
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
 * Privacy Center BFF proxies (TS-309a-followup-1; PRD §11.4; PDD §16.3).
 *
 * Two controllers over one downstream lifecycle, because the two surfaces
 * have genuinely different gates:
 *
 *   `PrivacyRequestsProxyController` — the REQUESTER's routes. **No
 *   `PermissionGuard`**, and that is the design, not an omission: these are
 *   for any authenticated user exercising a statutory right about themselves,
 *   and requiring an RBAC permission would mean the platform granting people
 *   permission to ask what it holds about them. Customer roles carry empty
 *   permission sets, so a permission gate here would lock out exactly the
 *   people the routes exist for. Row-level scoping happens downstream against
 *   the verified `userId`.
 *
 *   `AdminPrivacyRequestsProxyController` — the OPERATOR's routes, gated
 *   `privacy:read` / `privacy:write` at the edge as well as downstream. The
 *   edge gate is never the only gate (CLAUDE.md §3.2).
 *
 * **The response re-validation matters more here than on most proxies.** The
 * requester receipt and the operator record differ precisely in what they are
 * allowed to disclose — the receipt withholds the verification method, the
 * internal notes and the ids. A drifted downstream body is therefore not a
 * cosmetic mismatch but a potential over-disclosure, so a body that fails its
 * schema is a 502 rather than something forwarded verbatim.
 */
@Controller('api/v1/privacy/requests')
@UseGuards(AccessTokenGuard, RateLimitGuard)
export class PrivacyRequestsProxyController {
  constructor(private readonly downstream: DownstreamHttpClient) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  async file(
    @Body() body: unknown,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Req() request: RequestWithContext,
  ): Promise<DataSubjectRequestReceiptResponse> {
    const ctx = requireContext(request);
    const traceId = extractTraceId(request);

    // `.strict()` at the edge, so an unknown key is a 400 here rather than a
    // surprise downstream. In particular a body attempting to name its own
    // `requesterUserId` dies here — the contract has no such field, and the
    // requester is stamped from the verified token by the service.
    const parsed = CreateDataSubjectRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw badRequest('Privacy request payload failed validation.', parsed.error.issues);
    }

    const result: DownstreamResult = await this.downstream.call({
      service: 'identity',
      path: '/api/v1/privacy/requests',
      method: 'POST',
      body: parsed.data,
      actor: ctx,
      traceId,
      idempotencyKey,
    });

    return mapResult(
      result,
      DataSubjectRequestReceiptResponseSchema,
      'privacy-request-receipt',
      traceId,
    );
  }

  @Get()
  async listMine(@Req() request: RequestWithContext): Promise<DataSubjectRequestListResponse> {
    const ctx = requireContext(request);
    const traceId = extractTraceId(request);

    const result: DownstreamResult = await this.downstream.call({
      service: 'identity',
      path: '/api/v1/privacy/requests',
      method: 'GET',
      actor: ctx,
      traceId,
    });

    return mapResult(result, DataSubjectRequestListResponseSchema, 'privacy-request-list', traceId);
  }

  @Get(':requestId')
  async getMine(
    @Param('requestId') requestId: string,
    @Req() request: RequestWithContext,
  ): Promise<DataSubjectRequestReceiptResponse> {
    const ctx = requireContext(request);
    const traceId = extractTraceId(request);

    const result: DownstreamResult = await this.downstream.call({
      service: 'identity',
      path: `/api/v1/privacy/requests/${encodeURIComponent(requestId)}`,
      method: 'GET',
      actor: ctx,
      traceId,
    });

    return mapResult(
      result,
      DataSubjectRequestReceiptResponseSchema,
      'privacy-request-receipt',
      traceId,
    );
  }

  @Post(':requestId/withdraw')
  @HttpCode(HttpStatus.OK)
  async withdraw(
    @Param('requestId') requestId: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Req() request: RequestWithContext,
  ): Promise<DataSubjectRequestReceiptResponse> {
    const ctx = requireContext(request);
    const traceId = extractTraceId(request);

    const result: DownstreamResult = await this.downstream.call({
      service: 'identity',
      path: `/api/v1/privacy/requests/${encodeURIComponent(requestId)}/withdraw`,
      method: 'POST',
      actor: ctx,
      traceId,
      idempotencyKey,
    });

    return mapResult(
      result,
      DataSubjectRequestReceiptResponseSchema,
      'privacy-request-receipt',
      traceId,
    );
  }
}

/**
 * The operator half. See the requester controller's doc-block for why the two
 * are separate classes.
 *
 * There is no `fulfil` and no `withdraw` here, mirroring the downstream
 * service: fulfilment belongs to TS-309b's export job (a button asserting it
 * would close a statutory obligation by claiming it was met), and withdrawal
 * is the requester's own act — an operator who thinks a request should not
 * proceed refuses it, with a categorical reason, on the record.
 */
@Controller('api/v1/admin/privacy/requests')
@UseGuards(AccessTokenGuard, PermissionGuard, RateLimitGuard)
export class AdminPrivacyRequestsProxyController {
  constructor(private readonly downstream: DownstreamHttpClient) {}

  @Get()
  @RequirePermissions('privacy:read')
  async list(
    @Query() query: Record<string, string | undefined>,
    @Req() request: RequestWithContext,
  ): Promise<AdminDataSubjectRequestListResponse> {
    const ctx = requireContext(request);
    const traceId = extractTraceId(request);

    // Parsed at the edge, then the downstream query string is re-serialised
    // from the PARSED value — nothing unvalidated reaches it.
    const parsed = ListDataSubjectRequestsQuerySchema.safeParse(query);
    if (!parsed.success) {
      throw badRequest('Privacy request queue query failed validation.', parsed.error.issues);
    }

    const search = new URLSearchParams();
    for (const key of ['status', 'kind', 'subjectKind'] as const) {
      const value = parsed.data[key];
      if (value !== undefined) search.set(key, value);
    }
    search.set('limit', String(parsed.data.limit));

    const result: DownstreamResult = await this.downstream.call({
      service: 'identity',
      path: `/api/v1/admin/privacy/requests?${search.toString()}`,
      method: 'GET',
      actor: ctx,
      traceId,
    });

    return mapResult(
      result,
      AdminDataSubjectRequestListResponseSchema,
      'privacy-request-queue',
      traceId,
    );
  }

  @Get(':requestId')
  @RequirePermissions('privacy:read')
  async get(
    @Param('requestId') requestId: string,
    @Req() request: RequestWithContext,
  ): Promise<DataSubjectRequestResponse> {
    const ctx = requireContext(request);
    const traceId = extractTraceId(request);

    const result: DownstreamResult = await this.downstream.call({
      service: 'identity',
      path: `/api/v1/admin/privacy/requests/${encodeURIComponent(requestId)}`,
      method: 'GET',
      actor: ctx,
      traceId,
    });

    return mapResult(result, DataSubjectRequestResponseSchema, 'privacy-request-detail', traceId);
  }

  @Post(':requestId/verify')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('privacy:write')
  async verify(
    @Param('requestId') requestId: string,
    @Body() body: unknown,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Req() request: RequestWithContext,
  ): Promise<DataSubjectRequestResponse> {
    return this.forwardAction(
      requestId,
      'verify',
      VerifyDataSubjectRequestSchema.safeParse(body),
      idempotencyKey,
      request,
    );
  }

  @Post(':requestId/refuse')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('privacy:write')
  async refuse(
    @Param('requestId') requestId: string,
    @Body() body: unknown,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Req() request: RequestWithContext,
  ): Promise<DataSubjectRequestResponse> {
    return this.forwardAction(
      requestId,
      'refuse',
      RefuseDataSubjectRequestSchema.safeParse(body),
      idempotencyKey,
      request,
    );
  }

  @Post(':requestId/extend')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('privacy:write')
  async extend(
    @Param('requestId') requestId: string,
    @Body() body: unknown,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Req() request: RequestWithContext,
  ): Promise<DataSubjectRequestResponse> {
    return this.forwardAction(
      requestId,
      'extend',
      ExtendDataSubjectRequestSchema.safeParse(body),
      idempotencyKey,
      request,
    );
  }

  /**
   * The three operator actions differ only in their path segment and their
   * payload schema, so they share one forwarder rather than three copies of
   * the same twelve lines. Each caller does its own `safeParse` so the schema
   * stays visible at the route it belongs to.
   */
  private async forwardAction(
    requestId: string,
    action: 'verify' | 'refuse' | 'extend',
    parsed: { success: true; data: unknown } | { success: false; error: { issues: unknown } },
    idempotencyKey: string | undefined,
    request: RequestWithContext,
  ): Promise<DataSubjectRequestResponse> {
    const ctx = requireContext(request);
    const traceId = extractTraceId(request);

    if (!parsed.success) {
      throw badRequest(`Privacy request ${action} payload failed validation.`, parsed.error.issues);
    }

    const result: DownstreamResult = await this.downstream.call({
      service: 'identity',
      path: `/api/v1/admin/privacy/requests/${encodeURIComponent(requestId)}/${action}`,
      method: 'POST',
      body: parsed.data,
      actor: ctx,
      traceId,
      idempotencyKey,
    });

    return mapResult(
      result,
      DataSubjectRequestResponseSchema,
      `privacy-request-${action}`,
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
        // Not cosmetic: the receipt and the record differ exactly in what may
        // be disclosed, so a drifted body is a potential over-disclosure.
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
      // Forwarded verbatim: a 404 for somebody else's request, a 409 for a
      // duplicate, and the 403 `mfa_required` that tells a client to step up
      // are all answers the caller needs unaltered.
      throw new HttpException(
        toBodyOrFallback(result.body, 'Downstream client error.'),
        result.status,
      );
    }
    case 'server_error':
      throw new BadGatewayException({
        type: 'about:blank',
        title: 'Bad Gateway',
        status: HttpStatus.BAD_GATEWAY,
        detail: 'Downstream service-identity returned an unsuccessful response.',
        ...(traceId !== undefined && { traceId }),
      });
    case 'timeout':
      throw new GatewayTimeoutException({
        type: 'about:blank',
        title: 'Gateway Timeout',
        status: HttpStatus.GATEWAY_TIMEOUT,
        detail: 'Downstream service-identity did not respond within the timeout window.',
        ...(traceId !== undefined && { traceId }),
      });
    case 'network_error':
      throw new BadGatewayException({
        type: 'about:blank',
        title: 'Bad Gateway',
        status: HttpStatus.BAD_GATEWAY,
        detail: 'Downstream service-identity is unreachable.',
        ...(traceId !== undefined && { traceId }),
      });
    case 'not_configured':
      throw new ServiceUnavailableException({
        type: 'about:blank',
        title: 'Service Unavailable',
        status: HttpStatus.SERVICE_UNAVAILABLE,
        detail: `Gateway has no route for the '${result.service}' service. Configure IDENTITY_SERVICE_BASE_URL.`,
        ...(traceId !== undefined && { traceId }),
      });
  }
}

function toBodyOrFallback(body: unknown, fallback: string): Record<string, unknown> {
  if (typeof body === 'object' && body !== null) return body as Record<string, unknown>;
  return { type: 'about:blank', title: 'Error', detail: fallback };
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

function extractTraceId(request: RequestWithContext): string | undefined {
  const headers = (request as unknown as { headers?: Record<string, unknown> }).headers ?? {};
  const value = headers['x-trace-id'];
  return typeof value === 'string' ? value : undefined;
}
