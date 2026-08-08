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
  CreativeReviewDetailResponseSchema,
  CreativeReviewMutationResponseSchema,
  CreativeReviewQueueResponseSchema,
  ListCreativeReviewQueueQuerySchema,
  ReviewAdCreativeRequestSchema,
  UpdateAdCreativeAccessibilityRequestSchema,
  type CreativeReviewDetailResponse,
  type CreativeReviewMutationResponse,
  type CreativeReviewQueueResponse,
  type ListCreativeReviewQueueQuery,
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
 * Admin ad-creative approval-workflow BFF proxy (TS-277b; PRD §10.9; PDD §18.3).
 *
 *   GET   /api/v1/admin/ads/creatives/review-queue              — pending queue
 *   GET   /api/v1/admin/ads/creatives/:creativeId/review        — review detail
 *   PATCH /api/v1/admin/ads/creatives/:creativeId/accessibility — a11y metadata
 *   POST  /api/v1/admin/ads/creatives/:creativeId/review        — decision
 *
 * Forwards to service-ads's identical `/api/v1/admin/ads/creatives` surface
 * (TS-277a) at the SAME path.
 *
 * **Authorisation — two trust tiers.** All endpoints sit behind three guards
 * (in order): `AccessTokenGuard` → `PermissionGuard` → `RateLimitGuard`. The
 * review surface (queue, detail, decision) requires `marketing:approve_creative`
 * — a SEPARATE, higher-trust gate than `ads:write` so the campaign author cannot
 * self-approve. The accessibility-metadata edit is the author's `ads:write`.
 * service-ads ALSO enforces the same gate (defence-in-depth). The acting admin's
 * identity propagates via the signed trust-header envelope the
 * `DownstreamHttpClient` mints (`actor: ctx`); the actor id is never read from
 * the body.
 *
 * **Idempotency-Key.** The PATCH / POST proxies forward the inbound
 * `Idempotency-Key` header so a client-side retry collapses against service-ads's
 * `@Idempotent()` cached response.
 *
 * Sibling of the TS-271b ad-campaigns proxy.
 */
@Controller('api/v1/admin/ads/creatives')
@UseGuards(AccessTokenGuard, PermissionGuard, RateLimitGuard)
export class AdminAdsCreativesProxyController {
  constructor(private readonly downstream: DownstreamHttpClient) {}

  @Get('review-queue')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('marketing:approve_creative')
  async queue(
    @Query() query: Record<string, unknown>,
    @Req() request: RequestWithContext,
  ): Promise<CreativeReviewQueueResponse> {
    const ctx = requireContext(request);
    const traceId = extractTraceId(request);

    const parsed = ListCreativeReviewQueueQuerySchema.safeParse(query);
    if (!parsed.success) {
      throw badRequest('Creative review-queue query failed validation.', parsed.error.issues);
    }

    const result: DownstreamResult = await this.downstream.call({
      service: 'ads',
      path: buildQueuePath(parsed.data),
      method: 'GET',
      actor: ctx,
      traceId,
    });

    return mapResult(
      result,
      CreativeReviewQueueResponseSchema,
      'admin-ads-creative-review-queue',
      traceId,
    );
  }

  @Get(':creativeId/review')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('marketing:approve_creative')
  async detail(
    @Param('creativeId') creativeId: string,
    @Req() request: RequestWithContext,
  ): Promise<CreativeReviewDetailResponse> {
    const ctx = requireContext(request);
    const traceId = extractTraceId(request);

    const result: DownstreamResult = await this.downstream.call({
      service: 'ads',
      path: `/api/v1/admin/ads/creatives/${encodeURIComponent(creativeId)}/review`,
      method: 'GET',
      actor: ctx,
      traceId,
    });

    return mapResult(
      result,
      CreativeReviewDetailResponseSchema,
      'admin-ads-creative-review-detail',
      traceId,
    );
  }

  @Patch(':creativeId/accessibility')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('ads:write')
  async updateAccessibility(
    @Param('creativeId') creativeId: string,
    @Body() body: unknown,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Req() request: RequestWithContext,
  ): Promise<CreativeReviewMutationResponse> {
    const ctx = requireContext(request);
    const traceId = extractTraceId(request);

    const parsed = UpdateAdCreativeAccessibilityRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw badRequest('Creative accessibility payload failed validation.', parsed.error.issues);
    }

    const result: DownstreamResult = await this.downstream.call({
      service: 'ads',
      path: `/api/v1/admin/ads/creatives/${encodeURIComponent(creativeId)}/accessibility`,
      method: 'PATCH',
      body: parsed.data,
      actor: ctx,
      traceId,
      idempotencyKey,
    });

    return mapResult(
      result,
      CreativeReviewMutationResponseSchema,
      'admin-ads-creative-accessibility',
      traceId,
    );
  }

  @Post(':creativeId/review')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('marketing:approve_creative')
  async review(
    @Param('creativeId') creativeId: string,
    @Body() body: unknown,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Req() request: RequestWithContext,
  ): Promise<CreativeReviewMutationResponse> {
    const ctx = requireContext(request);
    const traceId = extractTraceId(request);

    const parsed = ReviewAdCreativeRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw badRequest('Creative review payload failed validation.', parsed.error.issues);
    }

    const result: DownstreamResult = await this.downstream.call({
      service: 'ads',
      path: `/api/v1/admin/ads/creatives/${encodeURIComponent(creativeId)}/review`,
      method: 'POST',
      body: parsed.data,
      actor: ctx,
      traceId,
      idempotencyKey,
    });

    return mapResult(
      result,
      CreativeReviewMutationResponseSchema,
      'admin-ads-creative-review',
      traceId,
    );
  }
}

/**
 * Rebuild the downstream query string from the validated query — a
 * defence-in-depth allow-list so a smuggled param can't ride through to
 * service-ads.
 */
function buildQueuePath(query: ListCreativeReviewQueueQuery): string {
  const params = new URLSearchParams();
  params.set('limit', String(query.limit));
  return `/api/v1/admin/ads/creatives/review-queue?${params.toString()}`;
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
          detail: `Downstream service-ads returned a body that does not conform to the ${surface} contract.`,
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
        detail: 'Downstream service-ads returned an unsuccessful response.',
        ...(traceId !== undefined && { traceId }),
      });
    }
    case 'timeout': {
      throw new GatewayTimeoutException({
        type: 'about:blank',
        title: 'Gateway Timeout',
        status: HttpStatus.GATEWAY_TIMEOUT,
        detail: 'Downstream service-ads did not respond within the timeout window.',
        ...(traceId !== undefined && { traceId }),
      });
    }
    case 'network_error': {
      throw new BadGatewayException({
        type: 'about:blank',
        title: 'Bad Gateway',
        status: HttpStatus.BAD_GATEWAY,
        detail: 'Downstream service-ads is unreachable.',
        ...(traceId !== undefined && { traceId }),
      });
    }
    case 'not_configured': {
      throw new ServiceUnavailableException({
        type: 'about:blank',
        title: 'Service Unavailable',
        status: HttpStatus.SERVICE_UNAVAILABLE,
        detail: `Gateway has no route for the '${result.service}' service. Configure ADS_SERVICE_BASE_URL.`,
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
