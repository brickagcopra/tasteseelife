import { timingSafeEqual } from 'node:crypto';

import {
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Param,
  Query,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import {
  InternalSeniorWellnessObservationSummaryResponseSchema,
  WellnessTrendsQuerySchema,
  type InternalSeniorWellnessObservationSummaryResponse,
  type WellnessTrendsQuery,
} from '@taste-and-see/contracts';
import { ZodValidationPipe } from '@taste-and-see/nest-common';
import {
  TENANT_CONTEXT_STORE_TOKEN,
  type TenantContextStore,
  runWithoutTenantContext,
} from '@taste-and-see/nest-prisma-tenant-scope';
import type { Request } from 'express';

import { ENV_TOKEN } from '../../../config/config.module';
import type { Env } from '../../../config/env';
import { WellnessObservationSummaryService } from '../services/wellness-observation-summary.service';

/**
 * Internal wellness-observation-summary surface (TS-235; PRD §6.4, §6.9;
 * PDD §12.2). One endpoint:
 *
 *   GET /api/v1/internal/bookings/households/:householdId/seniors/:seniorId/wellness-observation-summary?windowDays=
 *     Returns the compact prior-N-day observation roll-up for one senior
 *     (latest + mean + visit count per wellness scale), reusing the
 *     TS-231 `WellnessTrendsService` math. Sole consumer is the monthly
 *     wellness-summary worker (TS-235), which folds the roll-up into the
 *     email per recipient.
 *
 * **Why `householdId` is a path param.** The worker iterates a household
 * batch (`InternalWellnessSummaryHouseholdsResponse`) and already knows
 * each household id; there is no access token to derive it from (this is
 * a shared-secret internal call, not a `/me` family read). Passing it
 * explicitly lets `WellnessTrendsService.loadTrends` scope the booking
 * query to household + senior, so a senior outside the named household
 * yields an empty roll-up rather than a cross-household leak.
 *
 * **Auth model.** Pinned to a shared-secret header (configurable via
 * `BOOKING_WELLNESS_SUMMARY_INTERNAL_HEADER_NAME` /
 * `BOOKING_WELLNESS_SUMMARY_INTERNAL_API_KEY`). Same defence-in-depth
 * pattern as service-booking's `TierGatingController` (TS-064) and
 * service-household's `VisitPrepInternalController` (TS-208). Application-
 * layer; the TS-151 NetworkPolicy further restricts the route to in-
 * cluster callers.
 *
 * **Idempotency.** GET-only and naturally idempotent — no
 * `@Idempotent()` decorator.
 *
 * **Tenant-scoping (TS-020-followup-2b-platform-rollout).** The endpoint
 * runs BEFORE any `requestContext` exists — it pins the shared-secret
 * header instead of `AccessTokenGuard`, so the `TenantContextInterceptor`
 * cannot seed a scoped frame. The handler body is wrapped in
 * `runWithoutTenantContext(this.tenantStore, 'internal-wellness-observation-summary', ...)`
 * so the Prisma extension's gate sees an explicit `exempt` frame rather
 * than failing with `MissingRequestContextError` under the
 * `enforcement: 'enforce'` posture wired in `AppModule`. The reason
 * string is unique + grep-able so an audit-log scan can trace this
 * "no-context" Prisma access back to its dispatch source. Mirrors the
 * shape in `VisitPrepInternalController.getSnapshot`.
 *
 * **Response shape.** Parsed against
 * `InternalSeniorWellnessObservationSummaryResponseSchema` at the boundary
 * so any drift between the service projection + the published contract
 * surfaces here rather than at the worker.
 */
@Controller()
export class WellnessObservationSummaryController {
  private readonly internalApiKey: string;
  private readonly headerName: string;

  constructor(
    private readonly summary: WellnessObservationSummaryService,
    @Inject(ENV_TOKEN) env: Env,
    @Inject(TENANT_CONTEXT_STORE_TOKEN) private readonly tenantStore: TenantContextStore,
  ) {
    this.internalApiKey = env.BOOKING_WELLNESS_SUMMARY_INTERNAL_API_KEY;
    this.headerName = env.BOOKING_WELLNESS_SUMMARY_INTERNAL_HEADER_NAME;
  }

  @Get(
    'api/v1/internal/bookings/households/:householdId/seniors/:seniorId/wellness-observation-summary',
  )
  @HttpCode(HttpStatus.OK)
  async getSummary(
    @Param('householdId') householdId: string,
    @Param('seniorId') seniorId: string,
    @Query(new ZodValidationPipe(WellnessTrendsQuerySchema))
    query: WellnessTrendsQuery,
    @Req() request: Request,
  ): Promise<InternalSeniorWellnessObservationSummaryResponse> {
    return runWithoutTenantContext(
      this.tenantStore,
      'internal-wellness-observation-summary',
      async () => {
        this.requireSharedSecret(request);
        const result = await this.summary.buildSummary({
          householdId,
          seniorId,
          windowDays: query.windowDays,
        });
        // Defence-in-depth — parse at the boundary so drift between the
        // service projection + the contract surfaces here rather than at
        // the worker.
        return InternalSeniorWellnessObservationSummaryResponseSchema.parse(result);
      },
    );
  }

  private requireSharedSecret(request: Request): void {
    const presented = request.header(this.headerName);
    if (!isSharedSecretValid(presented, this.internalApiKey)) {
      throw new UnauthorizedException({
        type: 'about:blank',
        title: 'Unauthorized',
        status: 401,
        detail: 'Internal authentication required.',
      });
    }
  }
}

/**
 * Constant-time shared-secret comparison. Mirrors the shape used in
 * service-booking's `TierGatingController` and service-household's
 * `VisitPrepInternalController` — length check as the early reject,
 * `timingSafeEqual` over equal-length buffers as the authoritative
 * compare. Defence-in-depth against timing oracles even though this
 * surface is in-cluster only.
 */
function isSharedSecretValid(presented: string | undefined, expected: string): boolean {
  if (presented === undefined) return false;
  const a = Buffer.from(presented, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
