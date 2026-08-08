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
  Put,
  Req,
  ServiceUnavailableException,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import {
  DeleteProviderAvailabilityResponseSchema,
  DeleteProviderServiceAreasResponseSchema,
  ProviderAvailabilitySnapshotResponseSchema,
  ProviderPricingRecordSchema,
  ProviderPricingSnapshotResponseSchema,
  ProviderProfileRecordSchema,
  ProviderServiceAreasSnapshotResponseSchema,
  UpdateProviderAvailabilityRequestSchema,
  UpdateProviderAvailabilityResponseSchema,
  UpdateProviderPricingRequestSchema,
  UpdateProviderPricingResponseSchema,
  UpdateProviderProfileRequestSchema,
  UpdateProviderProfileResponseSchema,
  UpdateProviderServiceAreasRequestSchema,
  UpdateProviderServiceAreasResponseSchema,
  type DeleteProviderAvailabilityResponse,
  type DeleteProviderServiceAreasResponse,
  type ProviderAvailabilitySnapshotResponse,
  type ProviderPricingRecord,
  type ProviderPricingSnapshotResponse,
  type ProviderProfileRecord,
  type ProviderServiceAreasSnapshotResponse,
  type UpdateProviderAvailabilityResponse,
  type UpdateProviderPricingResponse,
  type UpdateProviderProfileResponse,
  type UpdateProviderServiceAreasResponse,
} from '@taste-and-see/contracts';
import { z } from 'zod';
import { AccessTokenGuard, type RequestWithContext } from '@taste-and-see/nest-auth';

import { RateLimitGuard } from '../rate-limit/guards/rate-limit.guard';
import {
  DownstreamHttpClient,
  type DownstreamResult,
} from '../service-registry/services/downstream-http-client';

/**
 * Profile-snapshot response shape — mirrors the inline interface in
 * `service-provider`'s `ProviderProfileController`. Defined locally
 * with Zod (rather than promoted to the contracts package) because
 * the surface is the editor's initial-render shape; the sibling
 * `:providerId/profile` by-id GET surface returns the bare record
 * + 404s on missing, so the two shapes deliberately diverge.
 */
const ProfileSnapshotResponseSchema = z
  .object({
    profile: ProviderProfileRecordSchema.nullable(),
  })
  .strict();
type ProfileSnapshotResponse = z.infer<typeof ProfileSnapshotResponseSchema>;

/**
 * Providers BFF proxy (TS-200).
 *
 *   - `GET /api/v1/providers/me/profile-snapshot`
 *     Forward the authenticated user's profile-snapshot read to
 *     service-provider. Returns `{ profile: ProviderProfileRecord
 *     | null }` — null when the authenticated user has no provider
 *     row (they haven't completed the application yet).
 *
 *   - `GET /api/v1/providers/:providerId/profile` (TS-200-followup-4)
 *     Forward a by-id profile read to service-provider. Returns the
 *     bare `ProviderProfileRecord` on hit; 404 on missing or
 *     soft-deleted. Any authenticated user may read — there's no
 *     gateway-side ownership filter. Used by admin tooling (TS-127)
 *     and the booking-detail page (TS-128).
 *
 *   - `PUT /api/v1/providers/:providerId/profile`
 *     Forward the provider-portal self-service profile-edit body to
 *     `service-provider`'s `PUT /api/v1/providers/:providerId/profile`.
 *     Authenticated + default-rate-limited. The downstream enforces
 *     row ownership (`providers.user_id == actor.userId`); the gateway
 *     does NOT pre-check ownership because the access token's
 *     `sub` is the only identity the downstream needs (it looks up
 *     the row directly).
 *
 * Idempotency. The PUT proxy forwards the inbound `Idempotency-Key`
 * header through to the downstream so a retried request collapses
 * against the cached response (the downstream wears `@Idempotent()`
 * on the corresponding handler).
 *
 * Optimistic concurrency (TS-200-followup-5). The profile PUT proxy
 * also forwards the inbound `If-Match` header verbatim via
 * `extraHeaders` so the downstream's precondition check sees the
 * caller's intended freshness gate. The gateway does NOT itself
 * compare against any cached snapshot — service-provider is the
 * authoritative source of `updated_at` and the cheapest correct
 * compare lives where the row is read.
 *
 * Mirrors the shape of `BookingsProxyController` /
 * `AdminUsersProxyController` so the gateway's proxy surface stays
 * uniform.
 */
@Controller('api/v1/providers')
@UseGuards(AccessTokenGuard, RateLimitGuard)
export class ProvidersProxyController {
  constructor(private readonly downstream: DownstreamHttpClient) {}

  @Get('me/profile-snapshot')
  @HttpCode(HttpStatus.OK)
  async getMyProfileSnapshot(@Req() request: RequestWithContext): Promise<ProfileSnapshotResponse> {
    const ctx = requireContext(request);
    const result: DownstreamResult = await this.downstream.call({
      service: 'provider',
      path: '/api/v1/providers/me/profile-snapshot',
      method: 'GET',
      actor: ctx,
      traceId: extractTraceId(request),
    });
    return mapResult(
      result,
      ProfileSnapshotResponseSchema,
      'provider-profile-snapshot',
      extractTraceId(request),
    );
  }

  @Get(':providerId/profile')
  @HttpCode(HttpStatus.OK)
  async getProfileById(
    @Param('providerId') providerId: string,
    @Req() request: RequestWithContext,
  ): Promise<ProviderProfileRecord> {
    const ctx = requireContext(request);
    const result: DownstreamResult = await this.downstream.call({
      service: 'provider',
      path: `/api/v1/providers/${encodeURIComponent(providerId)}/profile`,
      method: 'GET',
      actor: ctx,
      traceId: extractTraceId(request),
    });
    return mapResult(
      result,
      ProviderProfileRecordSchema,
      'provider-profile-by-id',
      extractTraceId(request),
    );
  }

  @Put(':providerId/profile')
  @HttpCode(HttpStatus.OK)
  async updateProfile(
    @Param('providerId') providerId: string,
    @Body() body: unknown,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Headers('if-match') ifMatch: string | undefined,
    @Req() request: RequestWithContext,
  ): Promise<UpdateProviderProfileResponse> {
    const ctx = requireContext(request);
    const parsed = UpdateProviderProfileRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw new HttpException(
        {
          type: 'about:blank',
          title: 'Bad Request',
          status: HttpStatus.BAD_REQUEST,
          detail: 'Update-profile payload failed validation.',
          issues: parsed.error.issues,
        },
        HttpStatus.BAD_REQUEST,
      );
    }

    const result: DownstreamResult = await this.downstream.call({
      service: 'provider',
      path: `/api/v1/providers/${encodeURIComponent(providerId)}/profile`,
      method: 'PUT',
      body: parsed.data,
      actor: ctx,
      traceId: extractTraceId(request),
      idempotencyKey,
      // TS-200-followup-5: forward If-Match verbatim. The downstream
      // parses + compares + 412s on mismatch; the gateway is a pure
      // pass-through here so the freshness compare lives where the
      // authoritative `updated_at` row read happens.
      ...(typeof ifMatch === 'string' &&
        ifMatch.length > 0 && { extraHeaders: { 'if-match': ifMatch } }),
    });

    return mapResult(
      result,
      UpdateProviderProfileResponseSchema,
      'provider-profile-update',
      extractTraceId(request),
    );
  }

  // ─── Availability (TS-203) ─────────────────────────────────────────────

  @Get('me/availability-snapshot')
  @HttpCode(HttpStatus.OK)
  async getMyAvailabilitySnapshot(
    @Req() request: RequestWithContext,
  ): Promise<ProviderAvailabilitySnapshotResponse> {
    const ctx = requireContext(request);
    const result: DownstreamResult = await this.downstream.call({
      service: 'provider',
      path: '/api/v1/providers/me/availability-snapshot',
      method: 'GET',
      actor: ctx,
      traceId: extractTraceId(request),
    });
    return mapResult(
      result,
      ProviderAvailabilitySnapshotResponseSchema,
      'provider-availability-snapshot',
      extractTraceId(request),
    );
  }

  @Put(':providerId/availability')
  @HttpCode(HttpStatus.OK)
  async updateAvailability(
    @Param('providerId') providerId: string,
    @Body() body: unknown,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Req() request: RequestWithContext,
  ): Promise<UpdateProviderAvailabilityResponse> {
    const ctx = requireContext(request);
    const parsed = UpdateProviderAvailabilityRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw new HttpException(
        {
          type: 'about:blank',
          title: 'Bad Request',
          status: HttpStatus.BAD_REQUEST,
          detail: 'Update-availability payload failed validation.',
          issues: parsed.error.issues,
        },
        HttpStatus.BAD_REQUEST,
      );
    }

    const result: DownstreamResult = await this.downstream.call({
      service: 'provider',
      path: `/api/v1/providers/${encodeURIComponent(providerId)}/availability`,
      method: 'PUT',
      body: parsed.data,
      actor: ctx,
      traceId: extractTraceId(request),
      idempotencyKey,
    });

    return mapResult(
      result,
      UpdateProviderAvailabilityResponseSchema,
      'provider-availability-update',
      extractTraceId(request),
    );
  }

  @Delete(':providerId/availability')
  @HttpCode(HttpStatus.OK)
  async deleteAvailability(
    @Param('providerId') providerId: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Req() request: RequestWithContext,
  ): Promise<DeleteProviderAvailabilityResponse> {
    const ctx = requireContext(request);

    const result: DownstreamResult = await this.downstream.call({
      service: 'provider',
      path: `/api/v1/providers/${encodeURIComponent(providerId)}/availability`,
      method: 'DELETE',
      actor: ctx,
      traceId: extractTraceId(request),
      idempotencyKey,
    });

    return mapResult(
      result,
      DeleteProviderAvailabilityResponseSchema,
      'provider-availability-delete',
      extractTraceId(request),
    );
  }

  // ─── Service areas (TS-202) ────────────────────────────────────────────

  @Get('me/service-areas-snapshot')
  @HttpCode(HttpStatus.OK)
  async getMyServiceAreasSnapshot(
    @Req() request: RequestWithContext,
  ): Promise<ProviderServiceAreasSnapshotResponse> {
    const ctx = requireContext(request);
    const result: DownstreamResult = await this.downstream.call({
      service: 'provider',
      path: '/api/v1/providers/me/service-areas-snapshot',
      method: 'GET',
      actor: ctx,
      traceId: extractTraceId(request),
    });
    return mapResult(
      result,
      ProviderServiceAreasSnapshotResponseSchema,
      'provider-service-areas-snapshot',
      extractTraceId(request),
    );
  }

  @Put(':providerId/service-areas')
  @HttpCode(HttpStatus.OK)
  async updateServiceAreas(
    @Param('providerId') providerId: string,
    @Body() body: unknown,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Req() request: RequestWithContext,
  ): Promise<UpdateProviderServiceAreasResponse> {
    const ctx = requireContext(request);
    const parsed = UpdateProviderServiceAreasRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw new HttpException(
        {
          type: 'about:blank',
          title: 'Bad Request',
          status: HttpStatus.BAD_REQUEST,
          detail: 'Update-service-areas payload failed validation.',
          issues: parsed.error.issues,
        },
        HttpStatus.BAD_REQUEST,
      );
    }

    const result: DownstreamResult = await this.downstream.call({
      service: 'provider',
      path: `/api/v1/providers/${encodeURIComponent(providerId)}/service-areas`,
      method: 'PUT',
      body: parsed.data,
      actor: ctx,
      traceId: extractTraceId(request),
      idempotencyKey,
    });

    return mapResult(
      result,
      UpdateProviderServiceAreasResponseSchema,
      'provider-service-areas-update',
      extractTraceId(request),
    );
  }

  @Delete(':providerId/service-areas')
  @HttpCode(HttpStatus.OK)
  async deleteServiceAreas(
    @Param('providerId') providerId: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Req() request: RequestWithContext,
  ): Promise<DeleteProviderServiceAreasResponse> {
    const ctx = requireContext(request);

    const result: DownstreamResult = await this.downstream.call({
      service: 'provider',
      path: `/api/v1/providers/${encodeURIComponent(providerId)}/service-areas`,
      method: 'DELETE',
      actor: ctx,
      traceId: extractTraceId(request),
      idempotencyKey,
    });

    return mapResult(
      result,
      DeleteProviderServiceAreasResponseSchema,
      'provider-service-areas-delete',
      extractTraceId(request),
    );
  }

  // ─── Pricing (TS-204) ──────────────────────────────────────────────────

  @Get('me/pricing-snapshot')
  @HttpCode(HttpStatus.OK)
  async getMyPricingSnapshot(
    @Req() request: RequestWithContext,
  ): Promise<ProviderPricingSnapshotResponse> {
    const ctx = requireContext(request);
    const result: DownstreamResult = await this.downstream.call({
      service: 'provider',
      path: '/api/v1/providers/me/pricing-snapshot',
      method: 'GET',
      actor: ctx,
      traceId: extractTraceId(request),
    });
    return mapResult(
      result,
      ProviderPricingSnapshotResponseSchema,
      'provider-pricing-snapshot',
      extractTraceId(request),
    );
  }

  @Get(':providerId/pricing')
  @HttpCode(HttpStatus.OK)
  async getPricingById(
    @Param('providerId') providerId: string,
    @Req() request: RequestWithContext,
  ): Promise<ProviderPricingRecord> {
    const ctx = requireContext(request);
    const result: DownstreamResult = await this.downstream.call({
      service: 'provider',
      path: `/api/v1/providers/${encodeURIComponent(providerId)}/pricing`,
      method: 'GET',
      actor: ctx,
      traceId: extractTraceId(request),
    });
    return mapResult(
      result,
      ProviderPricingRecordSchema,
      'provider-pricing-by-id',
      extractTraceId(request),
    );
  }

  @Put(':providerId/pricing')
  @HttpCode(HttpStatus.OK)
  async updatePricing(
    @Param('providerId') providerId: string,
    @Body() body: unknown,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Headers('if-match') ifMatch: string | undefined,
    @Req() request: RequestWithContext,
  ): Promise<UpdateProviderPricingResponse> {
    const ctx = requireContext(request);
    const parsed = UpdateProviderPricingRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw new HttpException(
        {
          type: 'about:blank',
          title: 'Bad Request',
          status: HttpStatus.BAD_REQUEST,
          detail: 'Update-pricing payload failed validation.',
          issues: parsed.error.issues,
        },
        HttpStatus.BAD_REQUEST,
      );
    }

    const result: DownstreamResult = await this.downstream.call({
      service: 'provider',
      path: `/api/v1/providers/${encodeURIComponent(providerId)}/pricing`,
      method: 'PUT',
      body: parsed.data,
      actor: ctx,
      traceId: extractTraceId(request),
      idempotencyKey,
      // Forward If-Match verbatim — the downstream owns the
      // optimistic-concurrency compare against the authoritative
      // `updated_at` row read (mirrors the profile proxy).
      ...(typeof ifMatch === 'string' &&
        ifMatch.length > 0 && { extraHeaders: { 'if-match': ifMatch } }),
    });

    return mapResult(
      result,
      UpdateProviderPricingResponseSchema,
      'provider-pricing-update',
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
          detail: `Downstream service-provider returned a body that does not conform to the ${surface} contract.`,
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
        detail: 'Downstream service-provider returned an unsuccessful response.',
        ...(traceId !== undefined && { traceId }),
      });
    }
    case 'timeout': {
      throw new GatewayTimeoutException({
        type: 'about:blank',
        title: 'Gateway Timeout',
        status: HttpStatus.GATEWAY_TIMEOUT,
        detail: 'Downstream service-provider did not respond within the timeout window.',
        ...(traceId !== undefined && { traceId }),
      });
    }
    case 'network_error': {
      throw new BadGatewayException({
        type: 'about:blank',
        title: 'Bad Gateway',
        status: HttpStatus.BAD_GATEWAY,
        detail: 'Downstream service-provider is unreachable.',
        ...(traceId !== undefined && { traceId }),
      });
    }
    case 'not_configured': {
      throw new ServiceUnavailableException({
        type: 'about:blank',
        title: 'Service Unavailable',
        status: HttpStatus.SERVICE_UNAVAILABLE,
        detail: `Gateway has no route for the '${result.service}' service. Configure PROVIDER_SERVICE_BASE_URL.`,
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
  const header = request.headers?.['x-trace-id'];
  if (typeof header === 'string' && header.length > 0) return header;
  if (Array.isArray(header) && header[0] !== undefined) return header[0];
  return undefined;
}

function toBodyOrFallback(body: unknown, fallback: string): Record<string, unknown> {
  if (body !== null && typeof body === 'object') {
    return body as Record<string, unknown>;
  }
  return {
    type: 'about:blank',
    title: 'Error',
    detail: fallback,
  };
}
