import { timingSafeEqual } from 'node:crypto';

import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Inject,
  InternalServerErrorException,
  Logger,
  NotFoundException,
  Post,
  Req,
  UnauthorizedException,
  UseGuards,
  UsePipes,
} from '@nestjs/common';
import {
  CreateKycSessionResponseSchema,
  KycInternalWebhookEventSchema,
  type CreateKycSessionResponse,
  type KycInternalWebhookEvent,
  type KycInternalWebhookResponse,
  type KycRecord as KycRecordDto,
  type KycStatusResponse,
} from '@taste-and-see/contracts';
import { AccessTokenGuard, type RequestWithContext } from '@taste-and-see/nest-auth';
import { ZodValidationPipe } from '@taste-and-see/nest-common';
import { Idempotent } from '@taste-and-see/nest-idempotency';
import {
  TENANT_CONTEXT_STORE_TOKEN,
  type TenantContextStore,
  runWithoutTenantContext,
} from '@taste-and-see/nest-prisma-tenant-scope';
import type { Request } from 'express';

import { ENV_TOKEN } from '../../../config/config.module';
import type { Env } from '../../../config/env';
import { KYC_DISPATCH_HEADER_NAME } from '../kyc.constants';
import { KycService, type KycRecord, type KycServiceFailure } from '../services/kyc.service';

/**
 * KYC HTTP boundary (TS-026). Three endpoints:
 *
 *   POST /api/v1/identity/kyc-sessions
 *     Create a Stripe Identity verification session for the
 *     authenticated user. Returns the client_secret + hosted URL the
 *     portal needs to drive the user through the verification flow.
 *
 *   GET  /api/v1/identity/kyc-sessions/me
 *     Return the most-recent KYC record for the authenticated user.
 *     `record` is null when the user has never started a session.
 *
 *   POST /api/v1/internal/kyc/webhook-events
 *     Internal-only — service-webhook POSTs here after persisting a
 *     verified Stripe `identity.verification_session.*` event. Pinned
 *     to a shared-secret header (`KYC_WEBHOOK_INTERNAL_API_KEY`) as
 *     defence-in-depth against the TS-151 NetworkPolicy that will
 *     restrict this route to in-cluster callers. Returns the updated
 *     record so the dispatcher can stamp `dispatched_at` only on
 *     success.
 *
 * Authentication. The two public endpoints require a valid Bearer
 * access token minted by `service-identity`'s auth surface. The
 * internal endpoint pins the shared-secret header — that header
 * value is the auth model for the route (CLAUDE.md §3.5 mirrors the
 * Stripe-webhook pattern: signature/header IS the auth).
 *
 * Authorization. The user-facing endpoints scope to the authenticated
 * user only ("show me MY KYC"). Tenant scoping (CLAUDE.md §3.2)
 * across organizations / partners lands with TS-141.
 *
 * Tenant scoping (TS-020-followup-2b). The two public endpoints
 * (`createSession`, `getMyStatus`) run AFTER `AccessTokenGuard`, so the
 * `TenantContextInterceptor` (TS-141) seeds a scoped frame from the
 * request context before any Prisma operation fires. The internal
 * dispatch endpoint (`receiveWebhookEvent`) is NOT gated by
 * `AccessTokenGuard` — it pins the shared-secret header instead — so
 * there is no `requestContext` to seed the scoped frame from. The
 * handler therefore wraps its body in `runWithoutTenantContext(store,
 * 'internal-kyc-webhook-dispatch', ...)` so the Prisma extension's
 * gate sees an explicit `exempt` frame rather than a missing-frame
 * `enforce` rejection. This wrap is the last pre-enforcement exempt
 * frame the service needs — the four `AuthController` handlers
 * (TS-020-followup-2a) + `MfaController.verify` (TS-020-followup-2a2)
 * cover the remaining unauthenticated Prisma-touching surfaces.
 *
 * Idempotency. POST /api/v1/identity/kyc-sessions wears `@Idempotent()`
 * so a retried session-create returns the cached response rather than
 * minting two Stripe sessions. Internal dispatch is idempotent on the
 * Stripe `event.id` inside the service (`lastEventId` tracking),
 * which is more reliable than `Idempotency-Key` for a cross-service
 * relay.
 */
@Controller()
export class KycController {
  private readonly logger = new Logger(KycController.name);
  private readonly internalApiKey: string;

  constructor(
    private readonly kyc: KycService,
    @Inject(ENV_TOKEN) env: Env,
    @Inject(TENANT_CONTEXT_STORE_TOKEN) private readonly tenantStore: TenantContextStore,
  ) {
    this.internalApiKey = env.KYC_WEBHOOK_INTERNAL_API_KEY;
  }

  /**
   * POST /api/v1/identity/kyc-sessions — create a Stripe Identity
   * verification session.
   *
   * Status codes:
   *   201 Created       — body is the CreateKycSessionResponse.
   *   400 Bad Request   — invalid_request returned by the service.
   *   401 Unauthorized  — missing / invalid access token.
   *   500 Internal      — Stripe upstream failure. Opaque body so the
   *                       caller doesn't leak Stripe identifiers.
   */
  @Post('api/v1/identity/kyc-sessions')
  @HttpCode(HttpStatus.CREATED)
  @UseGuards(AccessTokenGuard)
  @Idempotent()
  async createSession(
    @Req() request: RequestWithContext,
    @Headers('idempotency-key') idempotencyKey?: string,
  ): Promise<CreateKycSessionResponse> {
    const userId = requireUserId(request);
    const trimmedKey = trimIdempotencyKey(idempotencyKey);

    const result = await this.kyc.startSession({
      userId,
      ...(trimmedKey !== null && { idempotencyKey: trimmedKey }),
    });
    if (!result.ok) {
      throwKycFailure(result.error);
    }

    const response: CreateKycSessionResponse = {
      record: toDto(result.value.record),
      clientSecret: result.value.clientSecret,
      hostedUrl: result.value.hostedUrl,
    };
    // Parse-validate the response shape before returning so a future
    // drift between the service and the contract surfaces at the
    // boundary rather than in the consumer.
    return CreateKycSessionResponseSchema.parse(response);
  }

  /**
   * GET /api/v1/identity/kyc-sessions/me — fetch the authenticated
   * user's latest KYC record.
   *
   * Status codes:
   *   200 OK            — body is the KycStatusResponse (record may
   *                       be null when the user has never started).
   *   401 Unauthorized  — missing / invalid access token.
   */
  @Get('api/v1/identity/kyc-sessions/me')
  @HttpCode(HttpStatus.OK)
  @UseGuards(AccessTokenGuard)
  async getMyStatus(@Req() request: RequestWithContext): Promise<KycStatusResponse> {
    const userId = requireUserId(request);
    const row = await this.kyc.getLatestForUser(userId);
    return {
      record: row !== null ? toDto(row) : null,
    };
  }

  /**
   * POST /api/v1/internal/kyc/webhook-events — internal dispatch
   * endpoint service-webhook calls after persisting an
   * `identity.verification_session.*` event.
   *
   * Auth model. Pinned to a shared-secret header. The TS-151
   * NetworkPolicy restricts the route to in-cluster callers (Phase 2);
   * the header is the application-layer defence-in-depth alongside
   * that network policy.
   *
   * Status codes:
   *   200 OK            — outcome `applied` | `replayed` | `session_mismatch`.
   *   400 Bad Request   — payload failed Zod validation.
   *   401 Unauthorized  — missing or wrong shared-secret header.
   */
  @Post('api/v1/internal/kyc/webhook-events')
  @HttpCode(HttpStatus.OK)
  @UsePipes(new ZodValidationPipe(KycInternalWebhookEventSchema))
  async receiveWebhookEvent(
    @Body() body: KycInternalWebhookEvent,
    @Req() request: Request,
  ): Promise<KycInternalWebhookResponse> {
    // Pre-auth surface (shared-secret header, NOT AccessTokenGuard) so
    // no `requestContext` was seeded by the TenantContextInterceptor.
    // Wrap the entire body — including the 401 short-circuit — so the
    // gate sees an explicit `exempt` frame on every code path. Mirrors
    // the AuthController + MfaController.verify wraps (TS-020-followup-2a /
    // -2a2) and is the prerequisite for the `enforce` ramp in
    // TS-020-followup-2b.
    return runWithoutTenantContext(this.tenantStore, 'internal-kyc-webhook-dispatch', async () => {
      const presented = request.header(KYC_DISPATCH_HEADER_NAME);
      if (!isSharedSecretValid(presented, this.internalApiKey)) {
        throw new UnauthorizedException({
          type: 'about:blank',
          title: 'Unauthorized',
          status: 401,
          detail: 'Internal dispatch authentication failed.',
        });
      }

      const result = await this.kyc.applyWebhookEvent({
        eventId: body.eventId,
        eventType: body.eventType,
        eventCreatedSeconds: body.eventCreatedSeconds,
        session: {
          id: body.session.id,
          status: body.session.status,
          clientSecret: body.session.clientSecret,
          hostedUrl: body.session.hostedUrl,
          verifiedAtSeconds: body.session.verifiedAtSeconds,
        },
        rawPayload: body.rawPayload,
      });

      if (result.ok) {
        return {
          outcome: 'applied',
          record: toDto(result.value),
        };
      }

      switch (result.error.reason) {
        case 'event_replay':
          this.logger.debug(
            { eventId: body.eventId, sessionId: body.session.id },
            'kyc.internal.replay',
          );
          return { outcome: 'replayed', record: null };
        case 'session_mismatch':
          this.logger.warn(
            { sessionId: body.session.id, eventId: body.eventId },
            'kyc.internal.session_mismatch',
          );
          return { outcome: 'session_mismatch', record: null };
        case 'invalid_request':
          throw new BadRequestException({
            type: 'about:blank',
            title: 'Bad Request',
            status: 400,
            detail: result.error.message,
          });
        case 'stripe_unavailable':
          // Should never fire on the dispatch path (we don't call
          // Stripe here) — surface as a generic 500 if it does.
          throw new InternalServerErrorException({
            type: 'about:blank',
            title: 'Internal Server Error',
            status: 500,
            detail: 'unexpected upstream failure',
          });
        case 'record_not_found':
          throw new NotFoundException({
            type: 'about:blank',
            title: 'Not Found',
            status: 404,
            detail: 'KYC record not found.',
          });
      }
    });
  }
}

/**
 * Translate a KycServiceFailure to the matching HTTP exception. Used
 * by `createSession`; the internal-dispatch route handles its own
 * subset because the failure shapes that can occur there are narrower.
 */
function throwKycFailure(failure: KycServiceFailure): never {
  switch (failure.reason) {
    case 'invalid_request':
      throw new BadRequestException({
        type: 'about:blank',
        title: 'Bad Request',
        status: 400,
        detail: failure.message,
      });
    case 'record_not_found':
      throw new NotFoundException({
        type: 'about:blank',
        title: 'Not Found',
        status: 404,
        detail: 'KYC record not found.',
      });
    case 'session_mismatch':
      throw new ConflictException({
        type: 'about:blank',
        title: 'Conflict',
        status: 409,
        detail: `Stripe session mismatch: ${failure.externalId}`,
      });
    case 'event_replay':
      // Not surfaced on the public path; mapped for exhaustiveness.
      throw new ConflictException({
        type: 'about:blank',
        title: 'Conflict',
        status: 409,
        detail: `event already applied: ${failure.eventId}`,
      });
    case 'stripe_unavailable':
      throw new InternalServerErrorException({
        type: 'about:blank',
        title: 'Internal Server Error',
        status: 500,
        detail: 'upstream identity provider unavailable',
      });
  }
}

function requireUserId(request: RequestWithContext): string {
  const ctx = request.requestContext;
  if (ctx === undefined) {
    throw new UnauthorizedException({
      type: 'about:blank',
      title: 'Unauthorized',
      status: 401,
      detail: 'Authentication required.',
    });
  }
  return ctx.userId;
}

function trimIdempotencyKey(raw: string | undefined): string | null {
  if (raw === undefined) return null;
  const trimmed = raw.trim();
  if (trimmed.length < 8) return null;
  if (trimmed.length > 255) return null;
  return trimmed;
}

/**
 * Project the Prisma row to the contract DTO. Drops the encrypted
 * payload columns (internal-only) and serialises dates to ISO.
 */
function toDto(row: KycRecord): KycRecordDto {
  return {
    id: row.id,
    provider: row.provider,
    status: row.status,
    externalId: row.externalId,
    verifiedAt: row.verifiedAt !== null ? row.verifiedAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * Constant-time-ish shared-secret comparison.
 *
 * Plain `===` leaks length / prefix information through timing —
 * irrelevant for high-entropy 32+ char secrets in practice but the
 * `Buffer.compare` shape costs nothing extra and matches the
 * defensive coding posture this codebase favours (mirror of the
 * pattern that lands in TS-073 for inbound third-party webhooks).
 */
function isSharedSecretValid(presented: string | undefined, expected: string): boolean {
  if (presented === undefined) return false;
  const a = Buffer.from(presented, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  // `timingSafeEqual` requires equal-length buffers; the length check
  // is what guards us. The comparison itself is O(N) regardless of
  // where the first byte differs.
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
