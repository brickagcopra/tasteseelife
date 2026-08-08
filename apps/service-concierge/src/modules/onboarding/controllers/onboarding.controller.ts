import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import type { RequestContext } from '@taste-and-see/auth-sdk';
import {
  ConciergeOnboardingStepKeySchema,
  ConciergeOnboardingsListResponseSchema,
  CreateConciergeOnboardingRequestSchema,
  CreateConciergeOnboardingResponseSchema,
  GetConciergeOnboardingResponseSchema,
  HOUSEHOLD_SCOPE_HEADER,
  ListConciergeOnboardingsQuerySchema,
  MyConciergeOnboardingResponseSchema,
  UpdateConciergeOnboardingRequestSchema,
  UpdateConciergeOnboardingResponseSchema,
  UpdateConciergeOnboardingStepRequestSchema,
  UpdateConciergeOnboardingStepResponseSchema,
  type ConciergeOnboardingStepKey,
  type ConciergeOnboardingsListResponse,
  type CreateConciergeOnboardingRequest,
  type CreateConciergeOnboardingResponse,
  type GetConciergeOnboardingResponse,
  type ListConciergeOnboardingsQuery,
  type MyConciergeOnboardingResponse,
  type UpdateConciergeOnboardingRequest,
  type UpdateConciergeOnboardingResponse,
  type UpdateConciergeOnboardingStepRequest,
  type UpdateConciergeOnboardingStepResponse,
} from '@taste-and-see/contracts';
import {
  AccessTokenGuard,
  PermissionGuard,
  RequirePermissions,
  type RequestWithContext,
} from '@taste-and-see/nest-auth';
import { ZodValidationPipe } from '@taste-and-see/nest-common';
import { Idempotent } from '@taste-and-see/nest-idempotency';

import { OnboardingService } from '../services/onboarding.service';

/**
 * Tier-3 onboarding ("white-glove kickoff") HTTP boundary (TS-228; PRD §5.1
 * Tier 3; PDD §10.6).
 *
 * Admin ops surfaces (behind `AccessTokenGuard` + `PermissionGuard`):
 *
 *   POST   /api/v1/admin/concierge/onboardings
 *     Open a kickoff checklist for a household (`householdId` in the body —
 *     the ops actor is global-scoped). Seeds the six frozen template steps.
 *     409 when the household already has an active onboarding. `concierge:write`.
 *
 *   GET    /api/v1/admin/concierge/onboardings?householdId=&status=&limit=
 *     Onboarding summaries (with step counts) newest-first. `concierge:read`.
 *
 *   GET    /api/v1/admin/concierge/onboardings/:onboardingId
 *     Full onboarding + ordered checklist steps. 404 missing/soft-deleted.
 *     `concierge:read`.
 *
 *   PATCH  /api/v1/admin/concierge/onboardings/:onboardingId
 *     Edit kickoff time / notes, or cancel (`status='canceled'`). A canceled
 *     onboarding rejects edits (409). `concierge:write`.
 *
 *   PATCH  /api/v1/admin/concierge/onboardings/:onboardingId/steps/:stepKey
 *     Advance / re-open one checklist step + recompute the rollup.
 *     `concierge:write`.
 *
 * Family surface (behind `AccessTokenGuard` only):
 *
 *   GET    /api/v1/concierge/onboarding/me
 *     The household's onboarding (read-only progress card), resolved from the
 *     token `tenantScope: {type:'household', householdId}` claim. No household
 *     id crosses the wire. `{ householdId, onboarding: null }` when none.
 *
 * **Authorisation.** The admin endpoints layer `PermissionGuard` over
 * `AccessTokenGuard` (the gateway BFF enforces the same gate at the edge —
 * defence-in-depth), reusing the `concierge:read` / `concierge:write`
 * permissions TS-224 added. The family read needs only a household-scoped
 * token.
 *
 * **Idempotency.** The three mutating endpoints wear `@Idempotent()` so a
 * retried request with the same `Idempotency-Key` returns the cached response
 * (CLAUDE.md §3.3 / §17.5).
 *
 * **Actor attribution.** The acting staff member's id is the authoritative
 * `userId` from the verified token — never the body — so `started_by_user_id`
 * + `completed_by_user_id` + the structured logs capture who did what.
 */
@Controller()
export class OnboardingController {
  constructor(private readonly onboarding: OnboardingService) {}

  @Post('api/v1/admin/concierge/onboardings')
  @HttpCode(HttpStatus.CREATED)
  @RequirePermissions('concierge:write')
  @UseGuards(AccessTokenGuard, PermissionGuard)
  @Idempotent()
  async create(
    @Body(new ZodValidationPipe(CreateConciergeOnboardingRequestSchema))
    body: CreateConciergeOnboardingRequest,
    @Req() request: RequestWithContext,
  ): Promise<CreateConciergeOnboardingResponse> {
    const ctx = requireContext(request);
    const outcome = await this.onboarding.createOnboarding({
      householdId: body.householdId,
      kickoffScheduledAt: body.kickoffScheduledAt,
      notes: body.notes,
      actorUserId: ctx.userId,
    });
    if (!outcome.ok) {
      throw new ConflictException({
        type: 'about:blank',
        title: 'Conflict',
        status: HttpStatus.CONFLICT,
        detail: 'This household already has an active onboarding. End it before opening a new one.',
      });
    }
    const response: CreateConciergeOnboardingResponse = { onboarding: outcome.onboarding };
    return CreateConciergeOnboardingResponseSchema.parse(response);
  }

  @Get('api/v1/admin/concierge/onboardings')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('concierge:read')
  @UseGuards(AccessTokenGuard, PermissionGuard)
  async list(
    @Query(new ZodValidationPipe(ListConciergeOnboardingsQuerySchema))
    query: ListConciergeOnboardingsQuery,
  ): Promise<ConciergeOnboardingsListResponse> {
    const onboardings = await this.onboarding.listOnboardings({
      householdId: query.householdId,
      status: query.status,
      limit: query.limit,
    });
    const response: ConciergeOnboardingsListResponse = { onboardings: [...onboardings] };
    return ConciergeOnboardingsListResponseSchema.parse(response);
  }

  @Get('api/v1/admin/concierge/onboardings/:onboardingId')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('concierge:read')
  @UseGuards(AccessTokenGuard, PermissionGuard)
  async get(@Param('onboardingId') onboardingId: string): Promise<GetConciergeOnboardingResponse> {
    const onboarding = await this.onboarding.getOnboarding(onboardingId);
    if (onboarding === null) throw onboardingNotFound(onboardingId);
    const response: GetConciergeOnboardingResponse = { onboarding };
    return GetConciergeOnboardingResponseSchema.parse(response);
  }

  @Patch('api/v1/admin/concierge/onboardings/:onboardingId')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('concierge:write')
  @UseGuards(AccessTokenGuard, PermissionGuard)
  @Idempotent()
  async update(
    @Param('onboardingId') onboardingId: string,
    @Body(new ZodValidationPipe(UpdateConciergeOnboardingRequestSchema))
    body: UpdateConciergeOnboardingRequest,
    @Req() request: RequestWithContext,
  ): Promise<UpdateConciergeOnboardingResponse> {
    const ctx = requireContext(request);
    const outcome = await this.onboarding.updateOnboarding({
      onboardingId,
      kickoffScheduledAt: body.kickoffScheduledAt,
      notes: body.notes,
      cancel: body.status === 'canceled',
      actorUserId: ctx.userId,
    });
    if (!outcome.ok) {
      if (outcome.reason === 'not_found') throw onboardingNotFound(onboardingId);
      throw conflict('Cannot edit a canceled onboarding.');
    }
    const response: UpdateConciergeOnboardingResponse = { onboarding: outcome.onboarding };
    return UpdateConciergeOnboardingResponseSchema.parse(response);
  }

  @Patch('api/v1/admin/concierge/onboardings/:onboardingId/steps/:stepKey')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('concierge:write')
  @UseGuards(AccessTokenGuard, PermissionGuard)
  @Idempotent()
  async updateStep(
    @Param('onboardingId') onboardingId: string,
    @Param('stepKey') stepKeyRaw: string,
    @Body(new ZodValidationPipe(UpdateConciergeOnboardingStepRequestSchema))
    body: UpdateConciergeOnboardingStepRequest,
    @Req() request: RequestWithContext,
  ): Promise<UpdateConciergeOnboardingStepResponse> {
    const ctx = requireContext(request);
    const stepKey = parseStepKey(stepKeyRaw);
    const outcome = await this.onboarding.updateStep({
      onboardingId,
      stepKey,
      status: body.status,
      notes: body.notes,
      actorUserId: ctx.userId,
    });
    if (!outcome.ok) {
      if (outcome.reason === 'not_found') throw onboardingNotFound(onboardingId);
      if (outcome.reason === 'step_not_found') {
        throw new NotFoundException({
          type: 'about:blank',
          title: 'Not Found',
          status: HttpStatus.NOT_FOUND,
          detail: `No '${stepKey}' step found on onboarding '${onboardingId}'.`,
        });
      }
      throw conflict('Cannot edit a step on a canceled onboarding.');
    }
    const response: UpdateConciergeOnboardingStepResponse = { onboarding: outcome.onboarding };
    return UpdateConciergeOnboardingStepResponseSchema.parse(response);
  }

  @Get('api/v1/concierge/onboarding/me')
  @HttpCode(HttpStatus.OK)
  @UseGuards(AccessTokenGuard)
  async getMine(@Req() request: RequestWithContext): Promise<MyConciergeOnboardingResponse> {
    const ctx = requireContext(request);
    const householdId = requireHouseholdScope(ctx);
    const onboarding = await this.onboarding.getOnboardingForHousehold(householdId);
    const response: MyConciergeOnboardingResponse = { householdId, onboarding };
    return MyConciergeOnboardingResponseSchema.parse(response);
  }
}

/** Validate the `:stepKey` path param against the enum (400 on a bad value). */
function parseStepKey(raw: string): ConciergeOnboardingStepKey {
  const parsed = ConciergeOnboardingStepKeySchema.safeParse(raw);
  if (!parsed.success) {
    throw new BadRequestException({
      type: 'about:blank',
      title: 'Bad Request',
      status: HttpStatus.BAD_REQUEST,
      detail: `Unknown onboarding step '${raw}'.`,
    });
  }
  return parsed.data;
}

function onboardingNotFound(onboardingId: string): NotFoundException {
  return new NotFoundException({
    type: 'about:blank',
    title: 'Not Found',
    status: HttpStatus.NOT_FOUND,
    detail: `No concierge onboarding found for id '${onboardingId}'.`,
  });
}

function conflict(detail: string): ConflictException {
  return new ConflictException({
    type: 'about:blank',
    title: 'Conflict',
    status: HttpStatus.CONFLICT,
    detail,
  });
}

function requireContext(request: RequestWithContext): RequestContext {
  const ctx = request.requestContext;
  if (ctx === undefined) {
    throw new UnauthorizedException({
      type: 'about:blank',
      title: 'Unauthorized',
      status: 401,
      detail: 'Authentication required.',
    });
  }
  return ctx;
}

/**
 * Resolve the household the family actor is acting in from the token's
 * `tenantScope`. The `/me` surface is for household-scoped actors only — an
 * admin (global scope) token has no "my household", so it gets a 400 rather
 * than a silent empty result.
 */
function requireHouseholdScope(ctx: RequestContext): string {
  if (ctx.tenantScope.type !== 'household') {
    throw new BadRequestException({
      type: 'about:blank',
      title: 'Bad Request',
      status: 400,
      detail:
        `This endpoint is only available to household members. If you belong to more ` +
        `than one household, name the one you are acting in with the ` +
        `${HOUSEHOLD_SCOPE_HEADER} header.`,
    });
  }
  return ctx.tenantScope.householdId;
}
