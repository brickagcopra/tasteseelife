import {
  BadGatewayException,
  Body,
  Controller,
  Delete,
  GatewayTimeoutException,
  Get,
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
  MfaConfirmRequestSchema,
  MfaConfirmResponseSchema,
  MfaEnrollRequestSchema,
  MfaEnrollResponseSchema,
  MfaListResponseSchema,
  MfaRemoveResponseSchema,
  type MfaConfirmResponse,
  type MfaEnrollResponse,
  type MfaListResponse,
  type MfaRemoveResponse,
} from '@taste-and-see/contracts';
import { AccessTokenGuard, type RequestWithContext } from '@taste-and-see/nest-auth';

import { RateLimit } from '../rate-limit/decorators/rate-limit.decorator';
import { RateLimitGuard } from '../rate-limit/guards/rate-limit.guard';
import {
  DownstreamHttpClient,
  type DownstreamResult,
} from '../service-registry/services/downstream-http-client';

/**
 * Authenticated MFA management proxy (TS-309d-followup-1).
 *
 *   POST   /api/v1/auth/mfa/totp/enroll   — begin TOTP enrolment
 *   POST   /api/v1/auth/mfa/totp/confirm  — finish it, receive recovery codes
 *   GET    /api/v1/auth/mfa/methods       — list enrolled factors
 *   DELETE /api/v1/auth/mfa/methods/:id   — remove one
 *
 * **This closes a hole, not a gap in polish.** `web-family` and `web-provider`
 * could COMPLETE an MFA challenge at login but neither could ENROL a factor:
 * the gateway proxied `POST /api/v1/auth/mfa/verify` and nothing else of the
 * MFA surface, while service-identity has owned all four of these endpoints
 * since TS-023. A customer who never enrolled therefore could not obtain an
 * `mfaVerified` session **by any route the product offered** — which closed
 * TS-309a's Privacy Center filing gate to them permanently, and would close
 * every future step-up-protected action too.
 *
 * **The gate is right; the enrolment surface was what was missing.** TS-309a
 * made a session the verification, and a session is only worth that if it is
 * MFA-backed. Nothing here relaxes it.
 *
 * **No `PermissionGuard`.** Customer roles are seeded with empty permission
 * sets (see `seed-catalog.ts`), so a permission gate here would refuse exactly
 * the population the endpoints exist for. Being the authenticated user IS the
 * authorisation — service-identity reads the subject from the verified token
 * and never from the path or the body, so one customer cannot enrol or remove
 * a factor for another. Same shape as the TS-309a-followup-1 requester routes.
 *
 * **`sensitive` rate-limit policy throughout**, including on the reads. These
 * routes mint and destroy authentication factors; `methods` enumerates them.
 *
 * The pre-auth halves of the MFA surface — `mfa/verify` and
 * `mfa/recovery/verify` — live on `AuthProxyController`, because they carry a
 * challenge token rather than a session and they mint one.
 */
@Controller('api/v1/auth/mfa')
@UseGuards(AccessTokenGuard, RateLimitGuard)
export class MfaProxyController {
  constructor(private readonly downstream: DownstreamHttpClient) {}

  @Post('totp/enroll')
  @HttpCode(HttpStatus.CREATED)
  @RateLimit({ policy: 'sensitive' })
  async enroll(
    @Body() body: unknown,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Req() request: RequestWithContext,
  ): Promise<MfaEnrollResponse> {
    const ctx = requireContext(request);
    const traceId = extractTraceId(request);

    const parsed = MfaEnrollRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw badRequest('MFA enrolment payload failed validation.', parsed.error.issues);
    }

    const result: DownstreamResult = await this.downstream.call({
      service: 'identity',
      path: '/api/v1/auth/mfa/totp/enroll',
      method: 'POST',
      body: parsed.data,
      actor: ctx,
      traceId,
      idempotencyKey,
    });

    return mapResult(result, MfaEnrollResponseSchema, 'mfa-enroll', traceId);
  }

  @Post('totp/confirm')
  @HttpCode(HttpStatus.OK)
  @RateLimit({ policy: 'sensitive' })
  async confirm(
    @Body() body: unknown,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Req() request: RequestWithContext,
  ): Promise<MfaConfirmResponse> {
    const ctx = requireContext(request);
    const traceId = extractTraceId(request);

    const parsed = MfaConfirmRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw badRequest('MFA confirmation payload failed validation.', parsed.error.issues);
    }

    const result: DownstreamResult = await this.downstream.call({
      service: 'identity',
      path: '/api/v1/auth/mfa/totp/confirm',
      method: 'POST',
      body: parsed.data,
      actor: ctx,
      traceId,
      idempotencyKey,
    });

    // The confirm response carries the one-time recovery codes. They cross this
    // hop exactly once and are never re-readable — `MfaListResponse` has no
    // field for them by design — so a portal that fails to show them here has
    // lost them. The response schema is re-validated like every other, which
    // means a downstream that stopped returning them is a 502 rather than a
    // silently code-less enrolment.
    return mapResult(result, MfaConfirmResponseSchema, 'mfa-confirm', traceId);
  }

  @Get('methods')
  @HttpCode(HttpStatus.OK)
  @RateLimit({ policy: 'sensitive' })
  async list(@Req() request: RequestWithContext): Promise<MfaListResponse> {
    const ctx = requireContext(request);
    const traceId = extractTraceId(request);

    const result: DownstreamResult = await this.downstream.call({
      service: 'identity',
      path: '/api/v1/auth/mfa/methods',
      method: 'GET',
      actor: ctx,
      traceId,
    });

    return mapResult(result, MfaListResponseSchema, 'mfa-methods', traceId);
  }

  @Delete('methods/:methodId')
  @HttpCode(HttpStatus.OK)
  @RateLimit({ policy: 'sensitive' })
  async remove(
    @Param('methodId') methodId: string,
    @Req() request: RequestWithContext,
    @Headers('idempotency-key') idempotencyKey?: string,
  ): Promise<MfaRemoveResponse> {
    const ctx = requireContext(request);
    const traceId = extractTraceId(request);

    const result: DownstreamResult = await this.downstream.call({
      service: 'identity',
      path: `/api/v1/auth/mfa/methods/${encodeURIComponent(methodId)}`,
      method: 'DELETE',
      actor: ctx,
      traceId,
      idempotencyKey,
    });

    return mapResult(result, MfaRemoveResponseSchema, 'mfa-remove', traceId);
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
