import { timingSafeEqual } from 'node:crypto';

import {
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Param,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import type { InternalSeniorPrepSnapshotResponse } from '@taste-and-see/contracts';
import { InternalSeniorPrepSnapshotResponseSchema } from '@taste-and-see/contracts';
import {
  TENANT_CONTEXT_STORE_TOKEN,
  type TenantContextStore,
  runWithoutTenantContext,
} from '@taste-and-see/nest-prisma-tenant-scope';
import type { Request } from 'express';

import { ENV_TOKEN } from '../../../config/config.module';
import type { Env } from '../../../config/env';
import { VisitPrepService } from '../services/visit-prep.service';

/**
 * Internal visit-prep snapshot surface (TS-208). One endpoint:
 *
 *   GET /api/v1/internal/seniors/:seniorId/prep-snapshot
 *     Returns the senior's operational intake projection +
 *     memory-recipe catalog (sliced + ordered per
 *     `VisitPrepService.getSnapshot`). Sole consumer is api-gateway's
 *     BFF aggregator, which assembles this response together with the
 *     booking row + the actor's own provider profile lookup into the
 *     public `VisitPrepChecklistResponse`.
 *
 * **Auth model.** Pinned to a shared-secret header (configurable via
 * `HOUSEHOLD_VISIT_PREP_INTERNAL_HEADER_NAME` /
 * `HOUSEHOLD_VISIT_PREP_INTERNAL_API_KEY`). Same defence-in-depth
 * pattern as service-provider's `ProviderDiscoveryController` (TS-053)
 * and service-booking's `TierGatingController` (TS-064). Application-
 * layer; NetworkPolicy (TS-151) further restricts the route to in-
 * cluster callers.
 *
 * **Idempotency.** GET-only and naturally idempotent — no
 * `@Idempotent()` decorator.
 *
 * **Tenant-scoping (TS-020-followup-2b-platform-rollout).** The
 * endpoint runs BEFORE any `requestContext` exists — it pins the
 * shared-secret header instead of `AccessTokenGuard`, so the
 * `TenantContextInterceptor` cannot seed a scoped frame. The handler
 * body is wrapped in
 * `runWithoutTenantContext(this.tenantStore, 'internal-visit-prep-snapshot', ...)`
 * so the Prisma extension's gate sees an explicit `exempt` frame
 * rather than failing with `MissingRequestContextError` under the
 * `enforcement: 'enforce'` posture wired in `AppModule`. The exempt
 * frame is correct here — the gateway BFF has already verified
 * provider authz at the upstream boundary; this surface is the
 * downstream cross-tenant projector.
 *
 * **Response shape.** Parsed against `InternalSeniorPrepSnapshotResponseSchema`
 * at the boundary so any future drift between the service projection +
 * the published contract surfaces at the controller rather than at the
 * gateway. Mirrors the pattern from service-provider's discovery
 * snapshot.
 */
@Controller()
export class VisitPrepInternalController {
  private readonly internalApiKey: string;
  private readonly headerName: string;

  constructor(
    private readonly visitPrep: VisitPrepService,
    @Inject(ENV_TOKEN) env: Env,
    @Inject(TENANT_CONTEXT_STORE_TOKEN) private readonly tenantStore: TenantContextStore,
  ) {
    this.internalApiKey = env.HOUSEHOLD_VISIT_PREP_INTERNAL_API_KEY;
    this.headerName = env.HOUSEHOLD_VISIT_PREP_INTERNAL_HEADER_NAME;
  }

  @Get('api/v1/internal/seniors/:seniorId/prep-snapshot')
  @HttpCode(HttpStatus.OK)
  async getSnapshot(
    @Param('seniorId') seniorId: string,
    @Req() request: Request,
  ): Promise<InternalSeniorPrepSnapshotResponse> {
    return runWithoutTenantContext(this.tenantStore, 'internal-visit-prep-snapshot', async () => {
      this.requireSharedSecret(request);
      const snapshot = await this.visitPrep.getSnapshot({ seniorId });
      // Defence-in-depth — parse at the boundary so drift between the
      // service projection + the contract surfaces here rather than
      // at the gateway aggregator.
      return InternalSeniorPrepSnapshotResponseSchema.parse(snapshot);
    });
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
 * service-booking's `TierGatingController` and service-provider's
 * `ProviderDiscoverySharedSecretGuard` — length check as the early
 * reject, `timingSafeEqual` over equal-length buffers as the
 * authoritative compare. Defence-in-depth against timing oracles even
 * though this surface is in-cluster only.
 */
function isSharedSecretValid(presented: string | undefined, expected: string): boolean {
  if (presented === undefined) return false;
  const a = Buffer.from(presented, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
