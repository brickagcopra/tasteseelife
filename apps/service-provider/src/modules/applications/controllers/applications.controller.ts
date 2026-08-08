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
  ServiceUnavailableException,
  UnauthorizedException,
  UseGuards,
  UsePipes,
} from '@nestjs/common';
import {
  ProviderApplicationStatusResponseSchema,
  ProviderBackgroundCheckInternalWebhookEventSchema,
  SubmitProviderApplicationRequestSchema,
  SubmitProviderApplicationResponseSchema,
  type ProviderApplicationRecord as ProviderApplicationRecordDto,
  type ProviderApplicationStatusResponse,
  type ProviderBackgroundCheckInternalWebhookEvent,
  type ProviderBackgroundCheckInternalWebhookResponse,
  type ProviderBackgroundCheckRecord as ProviderBackgroundCheckRecordDto,
  type ProviderRecord as ProviderRecordDto,
  type SubmitProviderApplicationRequest,
  type SubmitProviderApplicationResponse,
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
import { BACKGROUND_CHECK_DISPATCH_HEADER_NAME } from '../applications.constants';
import {
  ApplicationsService,
  type ApplicationRecord,
  type ApplicationsServiceFailure,
  type ProviderRecord,
} from '../services/applications.service';
import {
  BackgroundCheckService,
  type BackgroundCheckRecord,
} from '../services/background-check.service';

/**
 * Provider applications HTTP boundary (TS-051). Three endpoints:
 *
 *   POST /api/v1/providers/applications
 *     Submit a provider application for the authenticated user.
 *     Creates the providers + provider_applications +
 *     provider_background_checks rows in one orchestration and
 *     returns the projected DTOs.
 *
 *   GET /api/v1/providers/applications/me
 *     Return the authenticated user's provider + latest application
 *     + latest background-check rows (each may be null when
 *     nothing exists).
 *
 *   POST /api/v1/internal/providers/background-check-events
 *     Internal-only — service-webhook POSTs here after persisting a
 *     verified Checkr `report.*` event. Pinned to a shared-secret
 *     header (`BACKGROUND_CHECK_WEBHOOK_INTERNAL_API_KEY`) as
 *     defence-in-depth against the TS-151 NetworkPolicy that will
 *     restrict this route to in-cluster callers. Mirrors TS-026's
 *     `KycController.receiveWebhookEvent`.
 *
 * Authentication. The two public endpoints require a valid Bearer
 * access token minted by `service-identity`. The internal endpoint
 * pins the shared-secret header — that header value is the auth
 * model for the route (CLAUDE.md §3.5 mirrors the Stripe-webhook
 * pattern: signature/header IS the auth).
 *
 * Authorization. The user-facing endpoints scope to the
 * authenticated user only ("show me MY application"). Tenant
 * scoping (CLAUDE.md §3.2) across organizations / partners lands
 * with TS-141.
 *
 * Idempotency. POST /api/v1/providers/applications wears
 * `@Idempotent()` so a retried submission returns the cached
 * response rather than creating duplicate Checkr resources.
 * Internal dispatch is idempotent on the Checkr `event.id` inside
 * the service (`lastEventId` tracking), which is more reliable than
 * `Idempotency-Key` for a cross-service relay.
 *
 * Tenant-scoping (TS-020-followup-2b-platform-rollout). The internal
 * dispatch endpoint (`receiveWebhookEvent`) runs BEFORE any
 * `requestContext` exists — it pins the shared-secret header instead of
 * `AccessTokenGuard`, so the `TenantContextInterceptor` cannot seed a
 * scoped frame. The body is wrapped in
 * `runWithoutTenantContext(..., 'internal-checkr-webhook-dispatch', ...)`
 * so the Prisma extension's gate sees an explicit `exempt` frame rather
 * than failing with `MissingRequestContextError` under the
 * `enforcement: 'enforce'` posture wired in `AppModule`. The two public
 * endpoints (`submitApplication` / `getMyApplication`) sit behind
 * `AccessTokenGuard`, so the interceptor seeds a scoped frame from the
 * access-token claims and no wrap is needed there. Mirrors the canonical
 * shape landed in `service-identity`'s `KycController.receiveWebhookEvent`
 * under TS-020-followup-2b.
 */
@Controller()
export class ApplicationsController {
  private readonly logger = new Logger(ApplicationsController.name);
  private readonly internalApiKey: string;

  constructor(
    private readonly applications: ApplicationsService,
    private readonly backgroundCheck: BackgroundCheckService,
    @Inject(ENV_TOKEN) env: Env,
    @Inject(TENANT_CONTEXT_STORE_TOKEN) private readonly tenantStore: TenantContextStore,
  ) {
    this.internalApiKey = env.BACKGROUND_CHECK_WEBHOOK_INTERNAL_API_KEY;
  }

  /**
   * POST /api/v1/providers/applications — submit a provider
   * application for the authenticated user.
   *
   * Status codes:
   *   201 Created            — body is the SubmitProviderApplicationResponse.
   *   400 Bad Request        — invalid_request / checkr_invalid_applicant.
   *   401 Unauthorized       — missing / invalid access token.
   *   409 Conflict           — the user already has an active (non-
   *                            terminal) application.
   *   503 Service Unavailable — Checkr upstream failure.
   */
  @Post('api/v1/providers/applications')
  @HttpCode(HttpStatus.CREATED)
  @UseGuards(AccessTokenGuard)
  @UsePipes(new ZodValidationPipe(SubmitProviderApplicationRequestSchema))
  @Idempotent()
  async submitApplication(
    @Body() body: SubmitProviderApplicationRequest,
    @Req() request: RequestWithContext,
    @Headers('idempotency-key') idempotencyKey?: string,
  ): Promise<SubmitProviderApplicationResponse> {
    const userId = requireUserId(request);
    const trimmedKey = trimIdempotencyKey(idempotencyKey);

    // Reshape profile / applicant via conditional-spread so undefined
    // optional fields don't trip exactOptionalPropertyTypes.
    const profile = {
      displayName: body.profile.displayName,
      timeZone: body.profile.timeZone,
      ...(body.profile.headline !== undefined && { headline: body.profile.headline }),
      ...(body.profile.bio !== undefined && { bio: body.profile.bio }),
    };
    const applicant = {
      firstName: body.applicant.firstName,
      lastName: body.applicant.lastName,
      email: body.applicant.email,
      phone: body.applicant.phone,
      dob: body.applicant.dob,
      zipcode: body.applicant.zipcode,
      ...(body.applicant.middleName !== undefined && { middleName: body.applicant.middleName }),
      ...(body.applicant.ssnLast4 !== undefined && { ssnLast4: body.applicant.ssnLast4 }),
    };

    const result = await this.applications.submitApplication({
      userId,
      profile,
      applicant,
      ...(body.applicantNotes !== undefined && { applicantNotes: body.applicantNotes }),
      ...(trimmedKey !== null && { idempotencyKey: trimmedKey }),
    });
    if (!result.ok) {
      throwApplicationsFailure(result.error);
    }

    const response: SubmitProviderApplicationResponse = {
      provider: toProviderDto(result.value.provider),
      application: toApplicationDto(result.value.application),
      backgroundCheck: toBackgroundCheckDto(result.value.backgroundCheck),
    };
    // Parse-validate the response shape before returning so a future
    // drift between the service and the contract surfaces at the
    // boundary rather than in the consumer.
    return SubmitProviderApplicationResponseSchema.parse(response);
  }

  /**
   * GET /api/v1/providers/applications/me — fetch the authenticated
   * user's provider + latest application + latest background check.
   *
   * Status codes:
   *   200 OK            — body is the ProviderApplicationStatusResponse.
   *   401 Unauthorized  — missing / invalid access token.
   */
  @Get('api/v1/providers/applications/me')
  @HttpCode(HttpStatus.OK)
  @UseGuards(AccessTokenGuard)
  async getMyApplication(
    @Req() request: RequestWithContext,
  ): Promise<ProviderApplicationStatusResponse> {
    const userId = requireUserId(request);
    const latest = await this.applications.getLatestForUser(userId);
    const response: ProviderApplicationStatusResponse = {
      provider: latest.provider !== null ? toProviderDto(latest.provider) : null,
      application: latest.application !== null ? toApplicationDto(latest.application) : null,
      backgroundCheck:
        latest.backgroundCheck !== null ? toBackgroundCheckDto(latest.backgroundCheck) : null,
    };
    return ProviderApplicationStatusResponseSchema.parse(response);
  }

  /**
   * POST /api/v1/internal/providers/background-check-events —
   * internal dispatch endpoint service-webhook calls after persisting
   * a Checkr `report.*` event.
   *
   * Auth model. Pinned to a shared-secret header. The TS-151
   * NetworkPolicy restricts the route to in-cluster callers (Phase
   * 2); the header is the application-layer defence-in-depth
   * alongside that network policy.
   *
   * Status codes:
   *   200 OK            — outcome `applied` | `replayed` | `report_mismatch`.
   *   400 Bad Request   — payload failed Zod validation.
   *   401 Unauthorized  — missing or wrong shared-secret header.
   */
  @Post('api/v1/internal/providers/background-check-events')
  @HttpCode(HttpStatus.OK)
  @UsePipes(new ZodValidationPipe(ProviderBackgroundCheckInternalWebhookEventSchema))
  async receiveWebhookEvent(
    @Body() body: ProviderBackgroundCheckInternalWebhookEvent,
    @Req() request: Request,
  ): Promise<ProviderBackgroundCheckInternalWebhookResponse> {
    return runWithoutTenantContext(
      this.tenantStore,
      'internal-checkr-webhook-dispatch',
      async () => {
        const presented = request.header(BACKGROUND_CHECK_DISPATCH_HEADER_NAME);
        if (!isSharedSecretValid(presented, this.internalApiKey)) {
          throw new UnauthorizedException({
            type: 'about:blank',
            title: 'Unauthorized',
            status: 401,
            detail: 'Internal dispatch authentication failed.',
          });
        }

        const result = await this.backgroundCheck.applyWebhookEvent({
          eventId: body.eventId,
          eventType: body.eventType,
          eventCreatedSeconds: body.eventCreatedSeconds,
          report: {
            id: body.report.id,
            candidateId: body.report.candidateId,
            status: body.report.status,
          },
          rawPayload: body.rawPayload,
        });

        if (result.ok) {
          return {
            outcome: 'applied',
            record: toBackgroundCheckDto(result.value),
          };
        }

        switch (result.error.reason) {
          case 'event_replay':
            this.logger.debug(
              { eventId: body.eventId, reportId: body.report.id },
              'backgroundCheck.internal.replay',
            );
            return { outcome: 'replayed', record: null };
          case 'report_mismatch':
            this.logger.warn(
              { reportId: body.report.id, eventId: body.eventId },
              'backgroundCheck.internal.report_mismatch',
            );
            return { outcome: 'report_mismatch', record: null };
          case 'invalid_request':
            throw new BadRequestException({
              type: 'about:blank',
              title: 'Bad Request',
              status: 400,
              detail: result.error.message,
            });
          case 'record_not_found':
            throw new NotFoundException({
              type: 'about:blank',
              title: 'Not Found',
              status: 404,
              detail: 'Background-check record not found.',
            });
          case 'checkr_unavailable':
          case 'checkr_invalid_applicant':
            // Should never fire on the dispatch path (we don't call
            // Checkr here) — surface as a generic 500 if it does.
            throw new InternalServerErrorException({
              type: 'about:blank',
              title: 'Internal Server Error',
              status: 500,
              detail: 'unexpected upstream failure',
            });
        }
      },
    );
  }
}

/**
 * Translate an ApplicationsServiceFailure / BackgroundCheckServiceFailure
 * to the matching HTTP exception. Used by `submitApplication`.
 */
function throwApplicationsFailure(failure: ApplicationsServiceFailure): never {
  switch (failure.reason) {
    case 'invalid_request':
      throw new BadRequestException({
        type: 'about:blank',
        title: 'Bad Request',
        status: 400,
        detail: failure.message,
      });
    case 'already_applied':
      throw new ConflictException({
        type: 'about:blank',
        title: 'Conflict',
        status: 409,
        detail: `An active application is already on file: ${failure.applicationId}`,
      });
    case 'checkr_invalid_applicant':
      throw new BadRequestException({
        type: 'about:blank',
        title: 'Bad Request',
        status: 400,
        detail: failure.message,
      });
    case 'checkr_unavailable':
      throw new ServiceUnavailableException({
        type: 'about:blank',
        title: 'Service Unavailable',
        status: 503,
        detail: 'Background-check provider is currently unavailable. Please try again shortly.',
      });
    case 'record_not_found':
      throw new NotFoundException({
        type: 'about:blank',
        title: 'Not Found',
        status: 404,
        detail: 'Background-check record not found.',
      });
    case 'event_replay':
    case 'report_mismatch':
      // Not surfaced on the submitApplication path; mapped for
      // exhaustiveness with the BackgroundCheckServiceFailure union.
      throw new ConflictException({
        type: 'about:blank',
        title: 'Conflict',
        status: 409,
        detail: 'Unexpected webhook-related failure on the submit path.',
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

function toProviderDto(row: ProviderRecord): ProviderRecordDto {
  return {
    id: row.id,
    status: row.status,
    tier: row.tier,
    displayName: row.displayName,
    headline: row.headline,
    bio: row.bio,
    profilePhotoKey: row.profilePhotoKey,
    videoIntroKey: row.videoIntroKey,
    timeZone: row.timeZone,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function toApplicationDto(row: ApplicationRecord): ProviderApplicationRecordDto {
  return {
    id: row.id,
    status: row.status,
    applicantNotes: row.applicantNotes,
    reviewNotes: row.reviewNotes,
    submittedAt: row.submittedAt.toISOString(),
    reviewedAt: row.reviewedAt !== null ? row.reviewedAt.toISOString() : null,
    withdrawnAt: row.withdrawnAt !== null ? row.withdrawnAt.toISOString() : null,
  };
}

function toBackgroundCheckDto(row: BackgroundCheckRecord): ProviderBackgroundCheckRecordDto {
  return {
    id: row.id,
    status: row.status,
    checkrCandidateId: row.checkrCandidateId,
    checkrReportId: row.checkrReportId,
    completedAt: row.completedAt !== null ? row.completedAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * Constant-time-ish shared-secret comparison. Mirrors TS-026's
 * `isSharedSecretValid` — plain `===` leaks length / prefix
 * information through timing; `timingSafeEqual` is the same O(N)
 * comparison regardless of which byte differs.
 */
function isSharedSecretValid(presented: string | undefined, expected: string): boolean {
  if (presented === undefined) return false;
  const a = Buffer.from(presented, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
