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
  ConciergeEnrichmentSummariesListResponseSchema,
  CreateConciergeEnrichmentSummaryRequestSchema,
  CreateConciergeEnrichmentSummaryResponseSchema,
  GetConciergeEnrichmentSummaryResponseSchema,
  HOUSEHOLD_SCOPE_HEADER,
  ListConciergeEnrichmentSummariesQuerySchema,
  MyConciergeEnrichmentSummariesQuerySchema,
  MyConciergeEnrichmentSummariesResponseSchema,
  MyConciergeEnrichmentSummaryResponseSchema,
  UpdateConciergeEnrichmentSummaryRequestSchema,
  UpdateConciergeEnrichmentSummaryResponseSchema,
  type ConciergeEnrichmentSummariesListResponse,
  type CreateConciergeEnrichmentSummaryRequest,
  type CreateConciergeEnrichmentSummaryResponse,
  type GetConciergeEnrichmentSummaryResponse,
  type ListConciergeEnrichmentSummariesQuery,
  type MyConciergeEnrichmentSummariesQuery,
  type MyConciergeEnrichmentSummariesResponse,
  type MyConciergeEnrichmentSummaryResponse,
  type UpdateConciergeEnrichmentSummaryRequest,
  type UpdateConciergeEnrichmentSummaryResponse,
} from '@taste-and-see/contracts';
import {
  AccessTokenGuard,
  PermissionGuard,
  RequirePermissions,
  type RequestWithContext,
} from '@taste-and-see/nest-auth';
import { ZodValidationPipe } from '@taste-and-see/nest-common';
import { Idempotent } from '@taste-and-see/nest-idempotency';

import { EnrichmentService } from '../services/enrichment.service';

/**
 * Tier-3 weekly enrichment-summary HTTP boundary (TS-229; PRD §5.1 Tier 3,
 * §6.9; PDD §12.1).
 *
 * Admin ops surfaces (behind `AccessTokenGuard` + `PermissionGuard`):
 *
 *   POST   /api/v1/admin/concierge/enrichment-summaries
 *     Open a new weekly summary as a `draft` (`householdId` + Monday
 *     `weekStartDate` in the body — the ops actor is global-scoped). 409 when
 *     the household already has a summary for that week. `concierge:write`.
 *
 *   GET    /api/v1/admin/concierge/enrichment-summaries?householdId=&status=&limit=
 *     Summaries newest-week-first, filterable. `concierge:read`.
 *
 *   GET    /api/v1/admin/concierge/enrichment-summaries/:summaryId
 *     Full summary. 404 missing/soft-deleted. `concierge:read`.
 *
 *   PATCH  /api/v1/admin/concierge/enrichment-summaries/:summaryId
 *     Edit the narrative + drive the status transition (publish / unpublish /
 *     archive). 409 on an unsupported transition. `concierge:write`.
 *
 * Family surfaces (behind `AccessTokenGuard` only, household-scoped):
 *
 *   GET    /api/v1/concierge/enrichment-summaries/me?limit=
 *     The household's PUBLISHED summaries newest-week-first, resolved from the
 *     token `tenantScope` (no household id crosses the wire).
 *
 *   GET    /api/v1/concierge/enrichment-summaries/me/:summaryId
 *     The permalink target — one PUBLISHED summary scoped to the household.
 *     `{ summary: null }` when the id does not resolve to a published summary
 *     for this household (no oracle).
 *
 * **Authorisation.** The admin endpoints layer `PermissionGuard` over
 * `AccessTokenGuard` (the gateway BFF enforces the same gate at the edge —
 * defence-in-depth), reusing the `concierge:read` / `concierge:write`
 * permissions TS-224 added. The family reads need only a household-scoped token.
 *
 * **Idempotency.** The two mutating endpoints wear `@Idempotent()` so a retried
 * request with the same `Idempotency-Key` returns the cached response
 * (CLAUDE.md §3.3 / §17.5).
 *
 * **Actor attribution.** The acting concierge's id is the authoritative
 * `userId` from the verified token — never the body — so `authored_by_user_id`
 * + `published_by_user_id` + the structured logs capture who wrote / published.
 */
@Controller()
export class EnrichmentController {
  constructor(private readonly enrichment: EnrichmentService) {}

  @Post('api/v1/admin/concierge/enrichment-summaries')
  @HttpCode(HttpStatus.CREATED)
  @RequirePermissions('concierge:write')
  @UseGuards(AccessTokenGuard, PermissionGuard)
  @Idempotent()
  async create(
    @Body(new ZodValidationPipe(CreateConciergeEnrichmentSummaryRequestSchema))
    body: CreateConciergeEnrichmentSummaryRequest,
    @Req() request: RequestWithContext,
  ): Promise<CreateConciergeEnrichmentSummaryResponse> {
    const ctx = requireContext(request);
    const outcome = await this.enrichment.createSummary({
      householdId: body.householdId,
      weekStartDate: body.weekStartDate,
      headline: body.headline,
      visitHighlights: body.visitHighlights,
      wellnessSignals: body.wellnessSignals,
      socialEngagement: body.socialEngagement,
      additionalNotes: body.additionalNotes,
      actorUserId: ctx.userId,
    });
    if (!outcome.ok) {
      throw conflict(
        'This household already has an enrichment summary for that week. Edit the existing one instead.',
      );
    }
    const response: CreateConciergeEnrichmentSummaryResponse = { summary: outcome.summary };
    return CreateConciergeEnrichmentSummaryResponseSchema.parse(response);
  }

  @Get('api/v1/admin/concierge/enrichment-summaries')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('concierge:read')
  @UseGuards(AccessTokenGuard, PermissionGuard)
  async list(
    @Query(new ZodValidationPipe(ListConciergeEnrichmentSummariesQuerySchema))
    query: ListConciergeEnrichmentSummariesQuery,
  ): Promise<ConciergeEnrichmentSummariesListResponse> {
    const summaries = await this.enrichment.listSummaries({
      householdId: query.householdId,
      status: query.status,
      limit: query.limit,
    });
    const response: ConciergeEnrichmentSummariesListResponse = { summaries: [...summaries] };
    return ConciergeEnrichmentSummariesListResponseSchema.parse(response);
  }

  @Get('api/v1/admin/concierge/enrichment-summaries/:summaryId')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('concierge:read')
  @UseGuards(AccessTokenGuard, PermissionGuard)
  async get(@Param('summaryId') summaryId: string): Promise<GetConciergeEnrichmentSummaryResponse> {
    const summary = await this.enrichment.getSummary(summaryId);
    if (summary === null) throw summaryNotFound(summaryId);
    const response: GetConciergeEnrichmentSummaryResponse = { summary };
    return GetConciergeEnrichmentSummaryResponseSchema.parse(response);
  }

  @Patch('api/v1/admin/concierge/enrichment-summaries/:summaryId')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('concierge:write')
  @UseGuards(AccessTokenGuard, PermissionGuard)
  @Idempotent()
  async update(
    @Param('summaryId') summaryId: string,
    @Body(new ZodValidationPipe(UpdateConciergeEnrichmentSummaryRequestSchema))
    body: UpdateConciergeEnrichmentSummaryRequest,
    @Req() request: RequestWithContext,
  ): Promise<UpdateConciergeEnrichmentSummaryResponse> {
    const ctx = requireContext(request);
    const outcome = await this.enrichment.updateSummary({
      summaryId,
      headline: body.headline,
      visitHighlights: body.visitHighlights,
      wellnessSignals: body.wellnessSignals,
      socialEngagement: body.socialEngagement,
      additionalNotes: body.additionalNotes,
      status: body.status,
      actorUserId: ctx.userId,
    });
    if (!outcome.ok) {
      if (outcome.reason === 'not_found') throw summaryNotFound(summaryId);
      throw conflict(`Cannot transition this summary from '${outcome.from}' to '${outcome.to}'.`);
    }
    const response: UpdateConciergeEnrichmentSummaryResponse = { summary: outcome.summary };
    return UpdateConciergeEnrichmentSummaryResponseSchema.parse(response);
  }

  @Get('api/v1/concierge/enrichment-summaries/me')
  @HttpCode(HttpStatus.OK)
  @UseGuards(AccessTokenGuard)
  async listMine(
    @Query(new ZodValidationPipe(MyConciergeEnrichmentSummariesQuerySchema))
    query: MyConciergeEnrichmentSummariesQuery,
    @Req() request: RequestWithContext,
  ): Promise<MyConciergeEnrichmentSummariesResponse> {
    const ctx = requireContext(request);
    const householdId = requireHouseholdScope(ctx);
    const summaries = await this.enrichment.listPublishedForHousehold(householdId, query.limit);
    const response: MyConciergeEnrichmentSummariesResponse = {
      householdId,
      summaries: [...summaries],
    };
    return MyConciergeEnrichmentSummariesResponseSchema.parse(response);
  }

  @Get('api/v1/concierge/enrichment-summaries/me/:summaryId')
  @HttpCode(HttpStatus.OK)
  @UseGuards(AccessTokenGuard)
  async getMine(
    @Param('summaryId') summaryId: string,
    @Req() request: RequestWithContext,
  ): Promise<MyConciergeEnrichmentSummaryResponse> {
    const ctx = requireContext(request);
    const householdId = requireHouseholdScope(ctx);
    const summary = await this.enrichment.getPublishedForHousehold(householdId, summaryId);
    const response: MyConciergeEnrichmentSummaryResponse = { householdId, summary };
    return MyConciergeEnrichmentSummaryResponseSchema.parse(response);
  }
}

function summaryNotFound(summaryId: string): NotFoundException {
  return new NotFoundException({
    type: 'about:blank',
    title: 'Not Found',
    status: HttpStatus.NOT_FOUND,
    detail: `No concierge enrichment summary found for id '${summaryId}'.`,
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
 * `tenantScope`. The `/me` surfaces are for household-scoped actors only — an
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
