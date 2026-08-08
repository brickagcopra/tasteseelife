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
  Put,
  Req,
  ServiceUnavailableException,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import {
  BulkUpsertSeniorPreferencesRequestSchema,
  MySeniorsResponseSchema,
  SeniorAlertPreferencesResponseSchema,
  SeniorConsentResponseSchema,
  SeniorPreferencesResponseSchema,
  SetSeniorAlertPreferencesRequestSchema,
  SetSeniorConsentRequestSchema,
  type MySeniorsResponse,
  type SeniorAlertPreferencesResponse,
  type SeniorConsentResponse,
  type SeniorPreferencesResponse,
} from '@taste-and-see/contracts';
import { AccessTokenGuard, type RequestWithContext } from '@taste-and-see/nest-auth';

import { RateLimitGuard } from '../rate-limit/guards/rate-limit.guard';
import {
  DownstreamHttpClient,
  type DownstreamResult,
} from '../service-registry/services/downstream-http-client';

/**
 * "My seniors" directory BFF proxy (TS-214).
 *
 *   GET /api/v1/me/seniors  — forward the authenticated user's
 *     "list my seniors" read to service-household. The family-portal
 *     entry point into the per-senior surfaces (preference editor,
 *     intake, memory recipes).
 *
 * Authenticated + default-rate-limited. The downstream membership query
 * is the row-level authorisation; the gateway adds no senior-id filter
 * because the actor's token `sub` is the only identity the downstream
 * needs.
 */
@Controller('api/v1/me/seniors')
@UseGuards(AccessTokenGuard, RateLimitGuard)
export class MeSeniorsProxyController {
  constructor(private readonly downstream: DownstreamHttpClient) {}

  @Get()
  @HttpCode(HttpStatus.OK)
  async list(@Req() request: RequestWithContext): Promise<MySeniorsResponse> {
    const ctx = requireContext(request);
    const result: DownstreamResult = await this.downstream.call({
      service: 'household',
      path: '/api/v1/me/seniors',
      method: 'GET',
      actor: ctx,
      traceId: extractTraceId(request),
    });
    return mapResult(result, MySeniorsResponseSchema, 'my-seniors-list', extractTraceId(request));
  }
}

/**
 * Senior preferences BFF proxy (TS-214). Two surfaces forwarding to
 * service-household:
 *
 *   GET   /api/v1/seniors/:seniorId/preferences  — read the senior
 *     memory profile (favourite-childhood-food, regional-tradition,
 *     comfort-food, dementia-sensitive cues).
 *   PATCH /api/v1/seniors/:seniorId/preferences  — bulk merge-upsert
 *     (value:string upserts, value:null deletes; keys absent from the
 *     entries array are untouched).
 *
 * Authenticated + default-rate-limited. The downstream enforces
 * household membership (a non-member gets 403). The PATCH proxy
 * forwards the inbound `Idempotency-Key` so a retried request collapses
 * against the downstream `@Idempotent()` cached response.
 */
@Controller('api/v1/seniors')
@UseGuards(AccessTokenGuard, RateLimitGuard)
export class SeniorPreferencesProxyController {
  constructor(private readonly downstream: DownstreamHttpClient) {}

  @Get(':seniorId/preferences')
  @HttpCode(HttpStatus.OK)
  async getPreferences(
    @Param('seniorId') seniorId: string,
    @Req() request: RequestWithContext,
  ): Promise<SeniorPreferencesResponse> {
    const ctx = requireContext(request);
    const result: DownstreamResult = await this.downstream.call({
      service: 'household',
      path: `/api/v1/seniors/${encodeURIComponent(seniorId)}/preferences`,
      method: 'GET',
      actor: ctx,
      traceId: extractTraceId(request),
    });
    return mapResult(
      result,
      SeniorPreferencesResponseSchema,
      'senior-preferences-get',
      extractTraceId(request),
    );
  }

  @Patch(':seniorId/preferences')
  @HttpCode(HttpStatus.OK)
  async bulkUpsertPreferences(
    @Param('seniorId') seniorId: string,
    @Body() body: unknown,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Req() request: RequestWithContext,
  ): Promise<SeniorPreferencesResponse> {
    const ctx = requireContext(request);
    const parsed = BulkUpsertSeniorPreferencesRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw new HttpException(
        {
          type: 'about:blank',
          title: 'Bad Request',
          status: HttpStatus.BAD_REQUEST,
          detail: 'Senior-preferences bulk-upsert payload failed validation.',
          issues: parsed.error.issues,
        },
        HttpStatus.BAD_REQUEST,
      );
    }

    const result: DownstreamResult = await this.downstream.call({
      service: 'household',
      path: `/api/v1/seniors/${encodeURIComponent(seniorId)}/preferences`,
      method: 'PATCH',
      body: parsed.data,
      actor: ctx,
      traceId: extractTraceId(request),
      idempotencyKey,
    });
    return mapResult(
      result,
      SeniorPreferencesResponseSchema,
      'senior-preferences-bulk-upsert',
      extractTraceId(request),
    );
  }
}

/**
 * Senior family-observability consent BFF proxy (TS-238). Two surfaces
 * forwarding to service-household:
 *
 *   GET /api/v1/seniors/:seniorId/consent  — read the four surface-
 *     visibility flags (photos / notes / location / health) + the
 *     caller's `canManage` capability. Any active household member may
 *     read.
 *   PUT /api/v1/seniors/:seniorId/consent  — full-replace the four flags.
 *     The downstream authorises the manager-role (primary payer / senior
 *     end-user) and returns 403 to a family observer.
 *
 * Authenticated + default-rate-limited. The downstream enforces
 * household membership + the manager-role capability. The PUT proxy
 * forwards the inbound `Idempotency-Key` so a retried request collapses
 * against the downstream `@Idempotent()` cached response.
 */
@Controller('api/v1/seniors')
@UseGuards(AccessTokenGuard, RateLimitGuard)
export class SeniorConsentProxyController {
  constructor(private readonly downstream: DownstreamHttpClient) {}

  @Get(':seniorId/consent')
  @HttpCode(HttpStatus.OK)
  async getConsent(
    @Param('seniorId') seniorId: string,
    @Req() request: RequestWithContext,
  ): Promise<SeniorConsentResponse> {
    const ctx = requireContext(request);
    const result: DownstreamResult = await this.downstream.call({
      service: 'household',
      path: `/api/v1/seniors/${encodeURIComponent(seniorId)}/consent`,
      method: 'GET',
      actor: ctx,
      traceId: extractTraceId(request),
    });
    return mapResult(
      result,
      SeniorConsentResponseSchema,
      'senior-consent-get',
      extractTraceId(request),
    );
  }

  @Put(':seniorId/consent')
  @HttpCode(HttpStatus.OK)
  async setConsent(
    @Param('seniorId') seniorId: string,
    @Body() body: unknown,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Req() request: RequestWithContext,
  ): Promise<SeniorConsentResponse> {
    const ctx = requireContext(request);
    const parsed = SetSeniorConsentRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw new HttpException(
        {
          type: 'about:blank',
          title: 'Bad Request',
          status: HttpStatus.BAD_REQUEST,
          detail: 'Senior-consent payload failed validation.',
          issues: parsed.error.issues,
        },
        HttpStatus.BAD_REQUEST,
      );
    }

    const result: DownstreamResult = await this.downstream.call({
      service: 'household',
      path: `/api/v1/seniors/${encodeURIComponent(seniorId)}/consent`,
      method: 'PUT',
      body: parsed.data,
      actor: ctx,
      traceId: extractTraceId(request),
      idempotencyKey,
    });
    return mapResult(
      result,
      SeniorConsentResponseSchema,
      'senior-consent-set',
      extractTraceId(request),
    );
  }
}

/**
 * Per-(senior × family-member) alert subscription BFF proxy (TS-234). Two
 * surfaces forwarding to service-household:
 *
 *   GET /api/v1/seniors/:seniorId/alert-preferences  — read the
 *     authenticated member's own three alert-type flags (missedVisit /
 *     concerningObservation / emergencyFlag) for the senior. The absence
 *     of a stored row is the synthesised default (operational + safety
 *     on, observation off).
 *   PUT /api/v1/seniors/:seniorId/alert-preferences  — full-replace the
 *     caller's own three flags. Any active household member may set their
 *     own subscription; a non-member gets 403.
 *
 * Authenticated + default-rate-limited. The downstream enforces household
 * membership and keys the row to the authenticated caller (never to a
 * client-supplied userId). The PUT proxy forwards the inbound
 * `Idempotency-Key` so a retried request collapses against the downstream
 * `@Idempotent()` cached response.
 */
@Controller('api/v1/seniors')
@UseGuards(AccessTokenGuard, RateLimitGuard)
export class SeniorAlertPreferencesProxyController {
  constructor(private readonly downstream: DownstreamHttpClient) {}

  @Get(':seniorId/alert-preferences')
  @HttpCode(HttpStatus.OK)
  async getPreferences(
    @Param('seniorId') seniorId: string,
    @Req() request: RequestWithContext,
  ): Promise<SeniorAlertPreferencesResponse> {
    const ctx = requireContext(request);
    const result: DownstreamResult = await this.downstream.call({
      service: 'household',
      path: `/api/v1/seniors/${encodeURIComponent(seniorId)}/alert-preferences`,
      method: 'GET',
      actor: ctx,
      traceId: extractTraceId(request),
    });
    return mapResult(
      result,
      SeniorAlertPreferencesResponseSchema,
      'senior-alert-preferences-get',
      extractTraceId(request),
    );
  }

  @Put(':seniorId/alert-preferences')
  @HttpCode(HttpStatus.OK)
  async setPreferences(
    @Param('seniorId') seniorId: string,
    @Body() body: unknown,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Req() request: RequestWithContext,
  ): Promise<SeniorAlertPreferencesResponse> {
    const ctx = requireContext(request);
    const parsed = SetSeniorAlertPreferencesRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw new HttpException(
        {
          type: 'about:blank',
          title: 'Bad Request',
          status: HttpStatus.BAD_REQUEST,
          detail: 'Senior-alert-preferences payload failed validation.',
          issues: parsed.error.issues,
        },
        HttpStatus.BAD_REQUEST,
      );
    }

    const result: DownstreamResult = await this.downstream.call({
      service: 'household',
      path: `/api/v1/seniors/${encodeURIComponent(seniorId)}/alert-preferences`,
      method: 'PUT',
      body: parsed.data,
      actor: ctx,
      traceId: extractTraceId(request),
      idempotencyKey,
    });
    return mapResult(
      result,
      SeniorAlertPreferencesResponseSchema,
      'senior-alert-preferences-set',
      extractTraceId(request),
    );
  }
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
          detail: `Downstream service-household returned a body that does not conform to the ${surface} contract.`,
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
        detail: 'Downstream service-household returned an unsuccessful response.',
        ...(traceId !== undefined && { traceId }),
      });
    }
    case 'timeout': {
      throw new GatewayTimeoutException({
        type: 'about:blank',
        title: 'Gateway Timeout',
        status: HttpStatus.GATEWAY_TIMEOUT,
        detail: 'Downstream service-household did not respond within the timeout window.',
        ...(traceId !== undefined && { traceId }),
      });
    }
    case 'network_error': {
      throw new BadGatewayException({
        type: 'about:blank',
        title: 'Bad Gateway',
        status: HttpStatus.BAD_GATEWAY,
        detail: 'Downstream service-household is unreachable.',
        ...(traceId !== undefined && { traceId }),
      });
    }
    case 'not_configured': {
      throw new ServiceUnavailableException({
        type: 'about:blank',
        title: 'Service Unavailable',
        status: HttpStatus.SERVICE_UNAVAILABLE,
        detail: `Gateway has no route for the '${result.service}' service. Configure HOUSEHOLD_SERVICE_BASE_URL.`,
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

function extractTraceId(request: RequestWithContext): string | undefined {
  const candidates = [request.headers['x-trace-id'], request.headers['x-request-id']];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.length > 0) return candidate;
  }
  return undefined;
}

function toBodyOrFallback(body: unknown, fallbackDetail: string): string | Record<string, unknown> {
  if (body !== null && typeof body === 'object' && !Array.isArray(body)) {
    return body as Record<string, unknown>;
  }
  return { type: 'about:blank', title: 'Error', detail: fallbackDetail };
}
