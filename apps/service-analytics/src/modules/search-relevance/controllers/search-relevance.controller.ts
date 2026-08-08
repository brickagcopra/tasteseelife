import { timingSafeEqual } from 'node:crypto';

import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Inject,
  Logger,
  Post,
  Req,
  UnauthorizedException,
  UseGuards,
  UsePipes,
} from '@nestjs/common';
import {
  ComputeSearchRelevanceMetricsRequestSchema,
  type ComputeSearchRelevanceMetricsRequest,
  type ComputeSearchRelevanceMetricsResponse,
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
import { SearchRelevanceService } from '../services/search-relevance.service';

/**
 * Header carrying the internal-dispatch shared secret pinning the nightly
 * compute endpoint. The `analytics-aggregator` worker presents the value of
 * `INTERNAL_AGGREGATION_API_KEY` here. Mirrors service-accounting's
 * `x-accounting-internal-api-key` convention.
 */
export const SEARCH_RELEVANCE_INTERNAL_API_KEY_HEADER = 'x-analytics-internal-api-key';

/**
 * `SearchRelevanceController` — compute surfaces for the nightly
 * search-relevance marts (TS-217-prep-3b, PRD §10.1 + PDD §23.1/§23.2).
 * Mirrors `SaasMetricsController` (TS-260) one-for-one:
 *
 *   - `POST /api/v1/internal/analytics/search-relevance/compute` — called by
 *     the `analytics-aggregator` worker nightly. Shared-secret pinned (the
 *     worker is a trusted internal principal; there is no end-user actor).
 *     The worker supplies an `asOf` inside the PREVIOUS complete UTC day so a
 *     full 24h window is aggregated.
 *
 *   - `POST /api/v1/admin/analytics/search-relevance/compute` — operator
 *     trigger for back-fills + same-day re-runs (e.g. recompute 2026-06-07
 *     after a missed nightly tick). `AccessTokenGuard`. Per-permission
 *     gating (`analytics:read` / an admin role) is the twin of the
 *     SaaS-metrics admin-compute follow-up — carved TS-217-prep-3b-followup-2.
 *
 * Both carry `@Idempotent()` — the compute is a write endpoint (CLAUDE.md
 * §17.5). The decorator dedups true client retries presenting the same
 * `Idempotency-Key`; the computation is additionally idempotent at the DB
 * layer (per-date delete-and-reinsert of the marts), so a same-day re-run
 * with a FRESH key correctly recomputes against current raw state.
 *
 * Tenant-scoping. The internal endpoint authenticates via the shared secret
 * (not `AccessTokenGuard`), so the `TenantContextInterceptor` cannot seed a
 * scoped frame; its handler body wraps in
 * `runWithoutTenantContext(..., 'internal-search-relevance-compute', ...)` so
 * every Prisma operation sees an explicit `exempt` frame under the `enforce`
 * posture. The admin endpoint sits behind `AccessTokenGuard`, which seeds a
 * scoped frame from the access-token claims — no wrap needed (mirrors
 * `SaasMetricsController`).
 */
@Controller()
export class SearchRelevanceController {
  private readonly logger = new Logger(SearchRelevanceController.name);

  constructor(
    private readonly service: SearchRelevanceService,
    @Inject(ENV_TOKEN) private readonly env: Env,
    @Inject(TENANT_CONTEXT_STORE_TOKEN)
    private readonly tenantStore: TenantContextStore,
  ) {}

  /**
   * System-driven nightly compute. Shared-secret pinned; wrapped in an
   * explicit exempt tenant frame.
   */
  @Post('api/v1/internal/analytics/search-relevance/compute')
  @HttpCode(HttpStatus.OK)
  @Idempotent()
  @UsePipes(new ZodValidationPipe(ComputeSearchRelevanceMetricsRequestSchema))
  async computeInternal(
    @Body() body: ComputeSearchRelevanceMetricsRequest,
    @Req() request: Request,
  ): Promise<ComputeSearchRelevanceMetricsResponse> {
    return runWithoutTenantContext(
      this.tenantStore,
      'internal-search-relevance-compute',
      async () => {
        this.requireInternalSharedSecret(request);
        return this.compute(body, 'internal');
      },
    );
  }

  /**
   * Admin-driven compute (back-fill / same-day re-run). `AccessTokenGuard`
   * seeds the scoped frame.
   */
  @Post('api/v1/admin/analytics/search-relevance/compute')
  @HttpCode(HttpStatus.OK)
  @UseGuards(AccessTokenGuard)
  @Idempotent()
  @UsePipes(new ZodValidationPipe(ComputeSearchRelevanceMetricsRequestSchema))
  async computeAdmin(
    @Body() body: ComputeSearchRelevanceMetricsRequest,
    @Req() request: RequestWithContext,
  ): Promise<ComputeSearchRelevanceMetricsResponse> {
    const actorId = requireActor(request);
    this.logger.warn(
      { actorId, asOf: body.asOf ?? '(now)' },
      'search-relevance.compute.admin-triggered',
    );
    return this.compute(body, 'admin');
  }

  private async compute(
    body: ComputeSearchRelevanceMetricsRequest,
    trigger: 'internal' | 'admin',
  ): Promise<ComputeSearchRelevanceMetricsResponse> {
    const asOf = body.asOf !== undefined ? new Date(body.asOf) : new Date();
    const result = await this.service.computeForDate(asOf);
    this.logger.log(
      {
        trigger,
        metricDate: result.metricDate,
        totalSearches: result.totalSearches,
        bookingsCreated: result.bookingsCreated,
        attributedBookings: result.attributedBookings,
      },
      'search-relevance.compute.completed',
    );
    return result;
  }

  private requireInternalSharedSecret(request: Request): void {
    const presented = request.header(SEARCH_RELEVANCE_INTERNAL_API_KEY_HEADER);
    if (!isSharedSecretValid(presented, this.env.INTERNAL_AGGREGATION_API_KEY)) {
      throw new UnauthorizedException({
        type: 'about:blank',
        title: 'Unauthorized',
        status: 401,
        detail: 'Internal dispatch authentication failed.',
      });
    }
  }
}

function requireActor(request: RequestWithContext): string {
  const ctx = request.requestContext;
  if (ctx === undefined || ctx.userId === undefined) {
    throw new UnauthorizedException({
      type: 'about:blank',
      title: 'Unauthorized',
      status: 401,
      detail: 'Authentication required.',
    });
  }
  return ctx.userId;
}

function isSharedSecretValid(presented: string | undefined, expected: string): boolean {
  if (presented === undefined) return false;
  const a = Buffer.from(presented, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
