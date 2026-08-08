import { timingSafeEqual } from 'node:crypto';

import {
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Query,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import type {
  InternalWellnessSummaryHouseholdsQuery,
  InternalWellnessSummaryHouseholdsResponse,
} from '@taste-and-see/contracts';
import {
  InternalWellnessSummaryHouseholdsQuerySchema,
  InternalWellnessSummaryHouseholdsResponseSchema,
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
import { WellnessSummaryService } from '../services/wellness-summary.service';

/**
 * Internal wellness-summary households surface (TS-235). One endpoint:
 *
 *   GET /api/v1/internal/wellness-summary/households?cursor=&limit=
 *     Cursor-paginated batch of active households, each carrying its
 *     active seniors (id, firstName, status, the senior's `notes` consent
 *     flag) + its active recipients (userId + membership role). Sole
 *     consumer is the monthly wellness-summary worker, which iterates the
 *     whole population page-by-page, joins the identity recipient-contacts
 *     + booking observation summaries, and dispatches one email per
 *     recipient.
 *
 * **Auth model.** Pinned to a shared-secret header (configurable via
 * `HOUSEHOLD_WELLNESS_SUMMARY_INTERNAL_HEADER_NAME` /
 * `HOUSEHOLD_WELLNESS_SUMMARY_INTERNAL_API_KEY`). Same defence-in-depth
 * pattern as the TS-208 visit-prep internal snapshot. Application-layer;
 * NetworkPolicy (TS-151) further restricts the route to in-cluster
 * callers.
 *
 * **Idempotency.** GET-only and naturally idempotent — no
 * `@Idempotent()` decorator.
 *
 * **Tenant-scoping (TS-020-followup-2b-platform-rollout).** The endpoint
 * runs BEFORE any `requestContext` exists — it pins the shared-secret
 * header instead of `AccessTokenGuard`, so the `TenantContextInterceptor`
 * cannot seed a scoped frame. The handler body is wrapped in
 * `runWithoutTenantContext(this.tenantStore, 'internal-wellness-summary-households', ...)`
 * so the Prisma extension's gate sees an explicit `exempt` frame rather
 * than failing with `MissingRequestContextError` under the
 * `enforcement: 'enforce'` posture wired in `AppModule`. The exempt frame
 * is correct here — this is a cross-tenant population read for the
 * platform worker, not a per-household request.
 *
 * **Response shape.** Parsed against
 * `InternalWellnessSummaryHouseholdsResponseSchema` at the boundary so
 * any future drift between the service projection + the published
 * contract surfaces at the controller rather than at the worker. Mirrors
 * the TS-208 visit-prep pattern.
 */
@Controller()
export class WellnessSummaryInternalController {
  private readonly internalApiKey: string;
  private readonly headerName: string;

  constructor(
    private readonly wellnessSummary: WellnessSummaryService,
    @Inject(ENV_TOKEN) env: Env,
    @Inject(TENANT_CONTEXT_STORE_TOKEN) private readonly tenantStore: TenantContextStore,
  ) {
    this.internalApiKey = env.HOUSEHOLD_WELLNESS_SUMMARY_INTERNAL_API_KEY;
    this.headerName = env.HOUSEHOLD_WELLNESS_SUMMARY_INTERNAL_HEADER_NAME;
  }

  @Get('api/v1/internal/wellness-summary/households')
  @HttpCode(HttpStatus.OK)
  async listHouseholds(
    @Query(new ZodValidationPipe(InternalWellnessSummaryHouseholdsQuerySchema))
    query: InternalWellnessSummaryHouseholdsQuery,
    @Req() request: Request,
  ): Promise<InternalWellnessSummaryHouseholdsResponse> {
    return runWithoutTenantContext(
      this.tenantStore,
      'internal-wellness-summary-households',
      async () => {
        this.requireSharedSecret(request);
        const page = await this.wellnessSummary.listHouseholds({
          cursor: query.cursor,
          limit: query.limit,
        });
        // Defence-in-depth — parse at the boundary so drift between the
        // service projection + the contract surfaces here rather than at
        // the worker.
        return InternalWellnessSummaryHouseholdsResponseSchema.parse(page);
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
 * Constant-time shared-secret comparison. Mirrors the TS-208 visit-prep
 * shape — length check as the early reject, `timingSafeEqual` over
 * equal-length buffers as the authoritative compare. Defence-in-depth
 * against timing oracles even though this surface is in-cluster only.
 */
function isSharedSecretValid(presented: string | undefined, expected: string): boolean {
  if (presented === undefined) return false;
  const a = Buffer.from(presented, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
