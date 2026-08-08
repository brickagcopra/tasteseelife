import {
  BadRequestException,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Query,
  Req,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import type { RequestContext } from '@taste-and-see/auth-sdk';
import {
  FamilyVisitsDashboardQuerySchema,
  FamilyVisitsDashboardResponseSchema,
  HOUSEHOLD_SCOPE_HEADER,
  type FamilyVisitsDashboardQuery,
  type FamilyVisitsDashboardResponse,
} from '@taste-and-see/contracts';
import { AccessTokenGuard, type RequestWithContext } from '@taste-and-see/nest-auth';
import { ZodValidationPipe } from '@taste-and-see/nest-common';

import { toBookingResponse } from '../../bookings/mappers/booking.mapper';
import { FamilyDashboardService } from '../services/family-dashboard.service';

/**
 * Family peace-of-mind dashboard HTTP boundary (TS-230; PRD §6.4,
 * §6.9; PDD §10).
 *
 *   GET /api/v1/bookings/dashboard/me?windowDays=&seniorId=&historyCursor=&historyLimit=
 *
 * Returns, for the household resolved from the token `tenantScope`:
 *   - the window-bounded (7 / 30 / 90 days) upcoming-visit list, and
 *   - the cursor-paginated completed-visit history with each visit's
 *     visit-note summary inlined.
 *
 * **Household-scoped only.** No `householdId` crosses the wire — the
 * `/me` surface resolves it from the verified token, mirroring the
 * concierge enrichment `/me` endpoints. An admin (global-scope) token
 * has no "my household", so it gets a 400 rather than an empty result.
 *
 * **Authentication.** `AccessTokenGuard` attaches the decoded
 * `requestContext`; the TS-141 `TenantContextInterceptor` seeds the
 * tenant-scope frame from it before the Prisma read fires (the service
 * sits in `enforce` mode). Read-only — no idempotency / mutation.
 *
 * Status codes:
 *   200 OK            — body is the FamilyVisitsDashboardResponse.
 *   400 Bad Request   — query failed validation, or the actor is not a
 *                       household member.
 *   401 Unauthorized  — missing / invalid access token.
 */
@Controller()
export class FamilyDashboardController {
  constructor(private readonly dashboard: FamilyDashboardService) {}

  @Get('api/v1/bookings/dashboard/me')
  @HttpCode(HttpStatus.OK)
  @UseGuards(AccessTokenGuard)
  async getMyDashboard(
    @Query(new ZodValidationPipe(FamilyVisitsDashboardQuerySchema))
    query: FamilyVisitsDashboardQuery,
    @Req() request: RequestWithContext,
  ): Promise<FamilyVisitsDashboardResponse> {
    const ctx = requireContext(request);
    const householdId = requireHouseholdScope(ctx);

    const result = await this.dashboard.loadDashboard({
      householdId,
      seniorId: query.seniorId,
      windowDays: query.windowDays,
      historyCursor: query.historyCursor,
      historyLimit: query.historyLimit,
    });

    const response: FamilyVisitsDashboardResponse = {
      householdId: result.householdId,
      seniorId: result.seniorId,
      windowDays: result.windowDays,
      upcoming: result.upcoming.map((row) => toBookingResponse(row)),
      history: [...result.history],
      historyNextCursor: result.historyNextCursor,
    };
    return FamilyVisitsDashboardResponseSchema.parse(response);
  }
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
 * Resolve the acting family member's household from the token
 * `tenantScope`. The dashboard `/me` surface is for household-scoped
 * actors only — an admin (global scope) token has no "my household",
 * so it gets a 400 rather than a silent empty result. Mirrors the
 * concierge enrichment `/me` helper.
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
