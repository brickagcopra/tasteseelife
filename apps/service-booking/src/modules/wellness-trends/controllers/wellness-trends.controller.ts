import {
  BadRequestException,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Query,
  Req,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import type { RequestContext } from '@taste-and-see/auth-sdk';
import {
  HOUSEHOLD_SCOPE_HEADER,
  WellnessTrendsQuerySchema,
  WellnessTrendsResponseSchema,
  type WellnessTrendsQuery,
  type WellnessTrendsResponse,
} from '@taste-and-see/contracts';
import { AccessTokenGuard, type RequestWithContext } from '@taste-and-see/nest-auth';
import { ZodValidationPipe } from '@taste-and-see/nest-common';

import { WellnessTrendsService } from '../services/wellness-trends.service';

/**
 * Wellness-trend HTTP boundary (TS-231; PRD §6.4, §6.9; PDD §23.1).
 *
 *   GET /api/v1/bookings/seniors/:seniorId/wellness-trends?windowDays=
 *
 * Returns, for the requested senior within the household resolved from
 * the token `tenantScope`, one per-visit trend series per wellness
 * scale over the 30 / 90-day window.
 *
 * **Household-scoped only.** No `householdId` crosses the wire — the
 * service resolves it from the verified token and filters bookings by
 * household + senior, so a foreign senior id yields empty series rather
 * than a leak. An admin (global-scope) token has no "my household", so
 * it gets a 400.
 *
 * **Consent.** The senior's `notes` consent gate (TS-238) is applied at
 * the gateway BFF (`GET /api/v1/seniors/:seniorId/wellness-trends`, the
 * TS-232 photo-gallery pattern). This service surface is internal — it
 * trusts the gateway gate but is safe even reached directly, since it
 * can only ever return the actor's own household's data.
 *
 * **Authentication.** `AccessTokenGuard` attaches the decoded
 * `requestContext`; the TS-141 `TenantContextInterceptor` seeds the
 * tenant-scope frame before the Prisma read fires. Read-only — no
 * idempotency / mutation.
 *
 * Status codes:
 *   200 OK            — body is the WellnessTrendsResponse.
 *   400 Bad Request   — query failed validation, or the actor is not a
 *                       household member.
 *   401 Unauthorized  — missing / invalid access token.
 */
@Controller()
export class WellnessTrendsController {
  constructor(private readonly trends: WellnessTrendsService) {}

  @Get('api/v1/bookings/seniors/:seniorId/wellness-trends')
  @HttpCode(HttpStatus.OK)
  @UseGuards(AccessTokenGuard)
  async getWellnessTrends(
    @Param('seniorId') seniorId: string,
    @Query(new ZodValidationPipe(WellnessTrendsQuerySchema))
    query: WellnessTrendsQuery,
    @Req() request: RequestWithContext,
  ): Promise<WellnessTrendsResponse> {
    const ctx = requireContext(request);
    const householdId = requireHouseholdScope(ctx);

    const result = await this.trends.loadTrends({
      householdId,
      seniorId,
      windowDays: query.windowDays,
    });

    const response: WellnessTrendsResponse = {
      seniorId: result.seniorId,
      windowDays: result.windowDays,
      totalCompletedVisits: result.totalCompletedVisits,
      series: [...result.series],
      generatedAt: result.generatedAt.toISOString(),
    };
    return WellnessTrendsResponseSchema.parse(response);
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
 * `tenantScope`. The trend surface is for household-scoped actors only
 * — an admin (global scope) token has no "my household", so it gets a
 * 400 rather than a silent empty result. Mirrors the TS-230 family
 * dashboard helper.
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
