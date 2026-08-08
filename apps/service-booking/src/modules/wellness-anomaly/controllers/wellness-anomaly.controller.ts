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
  WellnessAnomalyResponseSchema,
  WellnessTrendsQuerySchema,
  type WellnessAnomalyResponse,
  type WellnessTrendsQuery,
} from '@taste-and-see/contracts';
import { AccessTokenGuard, type RequestWithContext } from '@taste-and-see/nest-auth';
import { ZodValidationPipe } from '@taste-and-see/nest-common';

import { WellnessAnomalyService } from '../services/wellness-anomaly.service';

/**
 * Wellness-anomaly HTTP boundary (TS-236; PRD §6.9; PDD §23.1).
 *
 *   GET /api/v1/bookings/seniors/:seniorId/wellness-anomalies?windowDays=
 *
 * Returns, for the requested senior within the household resolved from
 * the token `tenantScope`, the wellness scales whose recent observations
 * have *declined* relative to the senior's own recent baseline (the
 * EWMA-baseline-vs-recent-mean detector). `flags` is empty when all is
 * well — the common case.
 *
 * **Window.** Reuses the TS-231 `WellnessTrendsQuerySchema` (30 / 90,
 * default 30) so the family wellness page can drive the trends + the
 * anomalies off one window selector.
 *
 * **Household-scoped only.** No `householdId` crosses the wire — the
 * service resolves it from the verified token and filters by household +
 * senior, so a foreign senior id yields no flags rather than a leak. An
 * admin (global-scope) token has no "my household", so it gets a 400.
 *
 * **Consent.** The senior's `notes` consent gate (TS-238) is applied at
 * the gateway BFF (`GET /api/v1/seniors/:seniorId/wellness-anomalies`,
 * the TS-231 trends pattern). This service surface is internal — it
 * trusts the gateway gate but is safe even reached directly.
 *
 * **Authentication.** `AccessTokenGuard` attaches the decoded
 * `requestContext`; the TS-141 `TenantContextInterceptor` seeds the
 * tenant-scope frame before the Prisma read fires. Read-only.
 *
 * Status codes:
 *   200 OK            — body is the WellnessAnomalyResponse.
 *   400 Bad Request   — query failed validation, or the actor is not a
 *                       household member.
 *   401 Unauthorized  — missing / invalid access token.
 */
@Controller()
export class WellnessAnomalyController {
  constructor(private readonly anomalies: WellnessAnomalyService) {}

  @Get('api/v1/bookings/seniors/:seniorId/wellness-anomalies')
  @HttpCode(HttpStatus.OK)
  @UseGuards(AccessTokenGuard)
  async getWellnessAnomalies(
    @Param('seniorId') seniorId: string,
    @Query(new ZodValidationPipe(WellnessTrendsQuerySchema))
    query: WellnessTrendsQuery,
    @Req() request: RequestWithContext,
  ): Promise<WellnessAnomalyResponse> {
    const ctx = requireContext(request);
    const householdId = requireHouseholdScope(ctx);

    const result = await this.anomalies.loadAnomalies({
      householdId,
      seniorId,
      windowDays: query.windowDays,
    });

    const response: WellnessAnomalyResponse = {
      seniorId: result.seniorId,
      windowDays: result.windowDays,
      totalCompletedVisits: result.totalCompletedVisits,
      flags: [...result.flags],
      generatedAt: result.generatedAt.toISOString(),
    };
    return WellnessAnomalyResponseSchema.parse(response);
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
 * `tenantScope`. The anomaly surface is for household-scoped actors only
 * — an admin (global scope) token has no "my household", so it gets a
 * 400 rather than a silent empty result. Mirrors the TS-231 wellness
 * trends helper.
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
