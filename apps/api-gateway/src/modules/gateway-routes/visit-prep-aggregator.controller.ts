import {
  BadGatewayException,
  Controller,
  ForbiddenException,
  GatewayTimeoutException,
  Get,
  HttpCode,
  HttpException,
  HttpStatus,
  Inject,
  Logger,
  NotFoundException,
  Param,
  Req,
  ServiceUnavailableException,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import {
  BookingResponseSchema,
  InternalSeniorPrepSnapshotResponseSchema,
  VisitPrepChecklistResponseSchema,
  type BookingResponse,
  type InternalSeniorPrepSnapshotResponse,
  type VisitPrepChecklistResponse,
} from '@taste-and-see/contracts';
import { AccessTokenGuard, type RequestWithContext } from '@taste-and-see/nest-auth';
import { z } from 'zod';

import { ENV_TOKEN } from '../../config/config.module';
import type { Env } from '../../config/env';
import { RateLimitGuard } from '../rate-limit/guards/rate-limit.guard';
import {
  DownstreamHttpClient,
  type DownstreamResult,
} from '../service-registry/services/downstream-http-client';

/**
 * Visit prep checklist BFF aggregator (TS-208).
 *
 *   GET /api/v1/bookings/:bookingId/prep-checklist
 *     Returns the provider-facing "what do I need to know before I
 *     arrive?" snapshot for a single booking. Aggregates three
 *     upstream sources:
 *
 *       1. `service-booking` — booking row read via the actor's own
 *          token (existing authenticated endpoint).
 *       2. `service-provider` — actor's own provider profile snapshot
 *          (existing authenticated endpoint) for the authz check
 *          (booking.providerId === provider.id).
 *       3. `service-household` — senior operational profile + memory
 *          recipes via the internal shared-secret endpoint
 *          (`/api/v1/internal/seniors/:seniorId/prep-snapshot`).
 *          Pinned by `HOUSEHOLD_VISIT_PREP_INTERNAL_API_KEY` on the
 *          downstream side. The provider isn't a household member so
 *          can't authenticate as one; the gateway has already
 *          verified provider authz before issuing this hop.
 *
 * **Authorization.** Provider self-service:
 *   - The actor must be authenticated (AccessTokenGuard).
 *   - The actor must have a `service-provider` row whose `id` equals
 *     `booking.providerId`. The gateway derives this from
 *     `GET /api/v1/providers/me/profile-snapshot` rather than trusting
 *     the path param. A 404 / null snapshot means the actor isn't a
 *     provider; the booking's providerId mismatch means the actor
 *     isn't this booking's assigned provider.
 *   - Admin override is NOT covered here; admins access the same data
 *     via the future admin-bookings surface (TS-128-followup).
 *
 * **Failure modes.**
 *   - 401 — missing/invalid access token (AccessTokenGuard).
 *   - 403 — actor isn't a provider OR isn't this booking's provider.
 *   - 404 — booking does not exist (propagates from service-booking).
 *   - 502 — any upstream is unreachable / returned a malformed body.
 *   - 503 — `HOUSEHOLD_VISIT_PREP_INTERNAL_API_KEY` is unset on the
 *           gateway env (the prep-checklist endpoint is optional
 *           Phase-1 surface — the gateway boots without it).
 *   - 504 — any upstream times out.
 *
 * **No idempotency-key handling** — GET is naturally idempotent.
 *
 * **Failure-mapping shape** mirrors the rest of the gateway proxies —
 * RFC 7807 Problem Details bodies with traceId propagation.
 */
@Controller('api/v1/bookings')
@UseGuards(AccessTokenGuard, RateLimitGuard)
export class VisitPrepAggregatorController {
  private readonly logger = new Logger(VisitPrepAggregatorController.name);

  constructor(
    private readonly downstream: DownstreamHttpClient,
    @Inject(ENV_TOKEN) private readonly env: Env,
  ) {}

  @Get(':bookingId/prep-checklist')
  @HttpCode(HttpStatus.OK)
  async getPrepChecklist(
    @Param('bookingId') bookingId: string,
    @Req() request: RequestWithContext,
  ): Promise<VisitPrepChecklistResponse> {
    const ctx = requireContext(request);
    const traceId = extractTraceId(request);

    // Fail fast if the gateway is missing the internal shared secret.
    // Better a 503 with a specific detail than a silent failure when
    // the household call later returns 401.
    if (this.env.HOUSEHOLD_VISIT_PREP_INTERNAL_API_KEY === undefined) {
      throw new ServiceUnavailableException({
        type: 'about:blank',
        title: 'Service Unavailable',
        status: HttpStatus.SERVICE_UNAVAILABLE,
        detail:
          'Gateway has no shared secret for the household visit-prep endpoint. Configure HOUSEHOLD_VISIT_PREP_INTERNAL_API_KEY.',
        ...(traceId !== undefined && { traceId }),
      });
    }

    // Step 1 — fetch the booking with the actor's own token. Routes
    // any household / provider authz the downstream wants to enforce
    // through the existing surface; lets us reuse the established
    // failure-mapping shape.
    const bookingResult = await this.downstream.call({
      service: 'booking',
      path: `/api/v1/bookings/${encodeURIComponent(bookingId)}`,
      method: 'GET',
      actor: ctx,
      traceId,
    });
    const booking = mapBookingResult(bookingResult, traceId);

    // Step 2 — fetch the actor's own provider profile snapshot to
    // verify they're the assigned provider for this booking. The
    // service-provider snapshot endpoint returns `{ profile: null }`
    // when the actor isn't a provider; the gateway treats null as
    // "not a provider".
    const profileResult = await this.downstream.call({
      service: 'provider',
      path: '/api/v1/providers/me/profile-snapshot',
      method: 'GET',
      actor: ctx,
      traceId,
    });
    const profile = mapProfileResult(profileResult, traceId);
    if (profile === null) {
      throw new ForbiddenException({
        type: 'about:blank',
        title: 'Forbidden',
        status: HttpStatus.FORBIDDEN,
        detail: 'You do not have a provider profile on file.',
        ...(traceId !== undefined && { traceId }),
      });
    }
    if (profile.id !== booking.providerId) {
      this.logger.warn(
        {
          bookingId,
          actorProviderId: profile.id,
          bookingProviderId: booking.providerId,
        },
        'visit-prep authz mismatch — actor is not this booking provider',
      );
      throw new ForbiddenException({
        type: 'about:blank',
        title: 'Forbidden',
        status: HttpStatus.FORBIDDEN,
        detail: 'You are not the assigned provider for this booking.',
        ...(traceId !== undefined && { traceId }),
      });
    }

    // Step 3 — fetch the senior's operational profile + memory recipes
    // via the internal shared-secret endpoint. The gateway has now
    // verified provider authz; this hop trusts the gateway.
    const householdResult = await this.downstream.call({
      service: 'household',
      path: `/api/v1/internal/seniors/${encodeURIComponent(booking.seniorId)}/prep-snapshot`,
      method: 'GET',
      // Deliberately no `actor` — the internal endpoint pins the
      // shared secret, not the actor-context trust headers. Passing
      // an actor here would still work (the downstream ignores unknown
      // headers) but conveys the wrong intent.
      traceId,
      extraHeaders: {
        [this.env.HOUSEHOLD_VISIT_PREP_INTERNAL_HEADER_NAME]:
          this.env.HOUSEHOLD_VISIT_PREP_INTERNAL_API_KEY,
      },
    });
    const householdSnapshot = mapHouseholdResult(householdResult, traceId);

    // Final aggregation. Parse at the boundary so any future drift
    // between the upstream projections + the published contract
    // surfaces at the gateway rather than at the web-provider
    // consumer. `generatedAt` is wall-clock time at composition; the
    // provider portal renders "as of …" without an extra round-trip.
    return VisitPrepChecklistResponseSchema.parse({
      booking: {
        id: booking.id,
        householdId: booking.householdId,
        seniorId: booking.seniorId,
        providerId: booking.providerId,
        serviceKind: booking.serviceKind,
        status: booking.status,
        scheduledStart: booking.scheduledStart,
        scheduledEnd: booking.scheduledEnd,
        acceptWindowExpiresAt: booking.acceptWindowExpiresAt,
        // TS-304-followup-1 — the provider opens this on their way to the
        // visit. A held booking they cannot see is a wasted journey at best.
        onHold: booking.onHold,
      },
      senior: householdSnapshot.senior,
      memoryRecipes: householdSnapshot.memoryRecipes,
      generatedAt: new Date().toISOString(),
    });
  }
}

// ─────────────────────────────────────────────────────────────────────
// Per-upstream result mappers. Each translates the
// `DownstreamResult` discriminated union into either a typed body
// (and the local schema parse) OR a thrown HTTP exception. Keeping
// them per-upstream lets the failure detail line name the actual
// downstream — easier to debug than a generic "downstream returned
// 404".
// ─────────────────────────────────────────────────────────────────────

function mapBookingResult(result: DownstreamResult, traceId: string | undefined): BookingResponse {
  switch (result.kind) {
    case 'ok': {
      const parsed = BookingResponseSchema.safeParse(result.body);
      if (!parsed.success) {
        throw new BadGatewayException({
          type: 'about:blank',
          title: 'Bad Gateway',
          status: HttpStatus.BAD_GATEWAY,
          detail:
            'Downstream service-booking returned a body that does not conform to the booking contract.',
          ...(traceId !== undefined && { traceId }),
        });
      }
      return parsed.data;
    }
    case 'client_error': {
      if (result.status === HttpStatus.NOT_FOUND) {
        throw new NotFoundException({
          type: 'about:blank',
          title: 'Not Found',
          status: HttpStatus.NOT_FOUND,
          detail: 'Booking not found.',
          ...(traceId !== undefined && { traceId }),
        });
      }
      const body = toBodyOrFallback(result.body, 'Downstream client error.');
      throw new HttpException(body, result.status);
    }
    case 'server_error':
      throw new BadGatewayException({
        type: 'about:blank',
        title: 'Bad Gateway',
        status: HttpStatus.BAD_GATEWAY,
        detail: 'Downstream service-booking returned an unsuccessful response.',
        ...(traceId !== undefined && { traceId }),
      });
    case 'timeout':
      throw new GatewayTimeoutException({
        type: 'about:blank',
        title: 'Gateway Timeout',
        status: HttpStatus.GATEWAY_TIMEOUT,
        detail: 'Downstream service-booking did not respond within the timeout window.',
        ...(traceId !== undefined && { traceId }),
      });
    case 'network_error':
      throw new BadGatewayException({
        type: 'about:blank',
        title: 'Bad Gateway',
        status: HttpStatus.BAD_GATEWAY,
        detail: 'Downstream service-booking is unreachable.',
        ...(traceId !== undefined && { traceId }),
      });
    case 'not_configured':
      throw new ServiceUnavailableException({
        type: 'about:blank',
        title: 'Service Unavailable',
        status: HttpStatus.SERVICE_UNAVAILABLE,
        detail: `Gateway has no route for the '${result.service}' service. Configure BOOKING_SERVICE_BASE_URL.`,
        ...(traceId !== undefined && { traceId }),
      });
  }
}

/**
 * The service-provider profile-snapshot response shape — `{ profile:
 * ProviderProfileRecord | null }`. We don't promote this to the
 * contracts package because the upstream surface defines it inline as
 * the editor's initial-render shape (see service-provider's
 * `provider-profile.controller.ts` — the `ProfileSnapshotResponse`
 * interface lives in the controller file rather than in
 * `packages/contracts`). The gateway parses the field set it actually
 * reads (`profile.id`) — every other field is opaque to this
 * aggregator.
 */
const ProviderProfileSnapshotResponseSchema = z
  .object({
    profile: z
      .object({
        id: z.string().min(1),
      })
      .passthrough()
      .nullable(),
  })
  .strict();

function mapProfileResult(
  result: DownstreamResult,
  traceId: string | undefined,
): { readonly id: string } | null {
  switch (result.kind) {
    case 'ok': {
      const parsed = ProviderProfileSnapshotResponseSchema.safeParse(result.body);
      if (!parsed.success) {
        throw new BadGatewayException({
          type: 'about:blank',
          title: 'Bad Gateway',
          status: HttpStatus.BAD_GATEWAY,
          detail:
            'Downstream service-provider returned a body that does not conform to the profile-snapshot contract.',
          ...(traceId !== undefined && { traceId }),
        });
      }
      return parsed.data.profile === null ? null : { id: parsed.data.profile.id };
    }
    case 'client_error': {
      // The snapshot endpoint returns 200 + null for "no provider row";
      // any 4xx here is unexpected.
      const body = toBodyOrFallback(result.body, 'Downstream client error.');
      throw new HttpException(body, result.status);
    }
    case 'server_error':
      throw new BadGatewayException({
        type: 'about:blank',
        title: 'Bad Gateway',
        status: HttpStatus.BAD_GATEWAY,
        detail: 'Downstream service-provider returned an unsuccessful response.',
        ...(traceId !== undefined && { traceId }),
      });
    case 'timeout':
      throw new GatewayTimeoutException({
        type: 'about:blank',
        title: 'Gateway Timeout',
        status: HttpStatus.GATEWAY_TIMEOUT,
        detail: 'Downstream service-provider did not respond within the timeout window.',
        ...(traceId !== undefined && { traceId }),
      });
    case 'network_error':
      throw new BadGatewayException({
        type: 'about:blank',
        title: 'Bad Gateway',
        status: HttpStatus.BAD_GATEWAY,
        detail: 'Downstream service-provider is unreachable.',
        ...(traceId !== undefined && { traceId }),
      });
    case 'not_configured':
      throw new ServiceUnavailableException({
        type: 'about:blank',
        title: 'Service Unavailable',
        status: HttpStatus.SERVICE_UNAVAILABLE,
        detail: `Gateway has no route for the '${result.service}' service. Configure PROVIDER_SERVICE_BASE_URL.`,
        ...(traceId !== undefined && { traceId }),
      });
  }
}

function mapHouseholdResult(
  result: DownstreamResult,
  traceId: string | undefined,
): InternalSeniorPrepSnapshotResponse {
  switch (result.kind) {
    case 'ok': {
      const parsed = InternalSeniorPrepSnapshotResponseSchema.safeParse(result.body);
      if (!parsed.success) {
        throw new BadGatewayException({
          type: 'about:blank',
          title: 'Bad Gateway',
          status: HttpStatus.BAD_GATEWAY,
          detail:
            'Downstream service-household returned a body that does not conform to the visit-prep contract.',
          ...(traceId !== undefined && { traceId }),
        });
      }
      return parsed.data;
    }
    case 'client_error': {
      // A 401 from service-household here means the shared secret is
      // misconfigured — surface as 502 (not 401, since the upstream
      // caller's own auth is fine). A 404 means the senior is missing,
      // which we map back to 404.
      if (result.status === HttpStatus.NOT_FOUND) {
        throw new NotFoundException({
          type: 'about:blank',
          title: 'Not Found',
          status: HttpStatus.NOT_FOUND,
          detail: 'Senior not found.',
          ...(traceId !== undefined && { traceId }),
        });
      }
      throw new BadGatewayException({
        type: 'about:blank',
        title: 'Bad Gateway',
        status: HttpStatus.BAD_GATEWAY,
        detail: `Downstream service-household rejected the internal request (status ${result.status}).`,
        ...(traceId !== undefined && { traceId }),
      });
    }
    case 'server_error':
      throw new BadGatewayException({
        type: 'about:blank',
        title: 'Bad Gateway',
        status: HttpStatus.BAD_GATEWAY,
        detail: 'Downstream service-household returned an unsuccessful response.',
        ...(traceId !== undefined && { traceId }),
      });
    case 'timeout':
      throw new GatewayTimeoutException({
        type: 'about:blank',
        title: 'Gateway Timeout',
        status: HttpStatus.GATEWAY_TIMEOUT,
        detail: 'Downstream service-household did not respond within the timeout window.',
        ...(traceId !== undefined && { traceId }),
      });
    case 'network_error':
      throw new BadGatewayException({
        type: 'about:blank',
        title: 'Bad Gateway',
        status: HttpStatus.BAD_GATEWAY,
        detail: 'Downstream service-household is unreachable.',
        ...(traceId !== undefined && { traceId }),
      });
    case 'not_configured':
      throw new ServiceUnavailableException({
        type: 'about:blank',
        title: 'Service Unavailable',
        status: HttpStatus.SERVICE_UNAVAILABLE,
        detail: `Gateway has no route for the '${result.service}' service. Configure HOUSEHOLD_SERVICE_BASE_URL.`,
        ...(traceId !== undefined && { traceId }),
      });
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
