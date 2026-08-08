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
import { Idempotent } from '@taste-and-see/nest-idempotency';
import {
  ComputeSaasMetricsRequestSchema,
  type ComputeSaasMetricsRequest,
  type ComputeSaasMetricsResponse,
} from '@taste-and-see/contracts';
import { AccessTokenGuard, type RequestWithContext } from '@taste-and-see/nest-auth';
import { ZodValidationPipe } from '@taste-and-see/nest-common';
import {
  TENANT_CONTEXT_STORE_TOKEN,
  type TenantContextStore,
  runWithoutTenantContext,
} from '@taste-and-see/nest-prisma-tenant-scope';
import type { Request } from 'express';

import { ENV_TOKEN } from '../../../config/config.module';
import type { Env } from '../../../config/env';
import { SaasMetricsService } from '../services/saas-metrics.service';

/**
 * Shared header carrying the internal-dispatch shared secret. Reuses
 * `INTERNAL_POST_JOURNAL_API_KEY` — the single trust principal for every
 * `/api/v1/internal/*` endpoint on the accounting service (the same
 * convention `RevenueRecognitionController` follows for the
 * subscription-activation + cancellation internal posts).
 */
export const SAAS_METRICS_INTERNAL_API_KEY_HEADER = 'x-accounting-internal-api-key';

/**
 * `SaasMetricsController` — compute surfaces for the daily SaaS-metrics
 * snapshot (TS-260, PDD §11.2 + §23.2).
 *
 *   - `POST /api/v1/internal/accounting/saas-metrics/compute` — called by
 *     the `accounting-metrics` worker nightly. Shared-secret pinned (the
 *     worker is a trusted internal principal; there is no end-user
 *     actor). `asOf` defaults to "now" on the server.
 *
 *   - `POST /api/v1/admin/accounting/saas-metrics/compute` — operator
 *     trigger for back-fills + same-day re-runs (e.g. recompute
 *     2026-05-15 after a missed nightly tick). `AccessTokenGuard`.
 *     Mirrors the `recognize-daily` admin-trigger precedent (TS-082).
 *
 * Both carry `@Idempotent()` — the compute is a write endpoint
 * (CLAUDE.md §17.5). The decorator dedups true client retries that
 * present the same `Idempotency-Key`; the computation is additionally
 * idempotent at the DB layer (the `saas_metrics_daily.metric_date`
 * UNIQUE upsert + the per-date snapshot delete-and-reinsert), so a
 * same-day re-run with a FRESH key correctly recomputes against current
 * ledger state.
 *
 * Tenant-scoping (TS-020-followup-2b-platform-rollout). The internal
 * endpoint authenticates via the shared secret rather than
 * `AccessTokenGuard`, so the `TenantContextInterceptor` cannot seed a
 * scoped frame; its handler body wraps in
 * `runWithoutTenantContext(..., 'internal-saas-metrics-compute', ...)` so
 * every Prisma operation sees an explicit `exempt` frame under the
 * `enforce` posture. The admin endpoint sits behind `AccessTokenGuard`,
 * which seeds a scoped frame from the access-token claims — no wrap
 * needed (mirrors `RevenueRecognitionController.recognizeDaily`).
 */
@Controller()
export class SaasMetricsController {
  private readonly logger = new Logger(SaasMetricsController.name);

  constructor(
    private readonly metrics: SaasMetricsService,
    @Inject(ENV_TOKEN) private readonly env: Env,
    @Inject(TENANT_CONTEXT_STORE_TOKEN)
    private readonly tenantStore: TenantContextStore,
  ) {}

  /**
   * System-driven nightly compute. Shared-secret pinned; wrapped in an
   * explicit exempt tenant frame.
   */
  @Post('api/v1/internal/accounting/saas-metrics/compute')
  @HttpCode(HttpStatus.OK)
  @Idempotent()
  @UsePipes(new ZodValidationPipe(ComputeSaasMetricsRequestSchema))
  async computeInternal(
    @Body() body: ComputeSaasMetricsRequest,
    @Req() request: Request,
  ): Promise<ComputeSaasMetricsResponse> {
    return runWithoutTenantContext(this.tenantStore, 'internal-saas-metrics-compute', async () => {
      this.requireInternalSharedSecret(request);
      return this.compute(body, 'internal');
    });
  }

  /**
   * Admin-driven compute (back-fill / same-day re-run). `AccessTokenGuard`
   * seeds the scoped frame.
   */
  @Post('api/v1/admin/accounting/saas-metrics/compute')
  @HttpCode(HttpStatus.OK)
  @UseGuards(AccessTokenGuard)
  @Idempotent()
  @UsePipes(new ZodValidationPipe(ComputeSaasMetricsRequestSchema))
  async computeAdmin(
    @Body() body: ComputeSaasMetricsRequest,
    @Req() request: RequestWithContext,
  ): Promise<ComputeSaasMetricsResponse> {
    const actorId = requireActor(request);
    this.logger.warn(
      { actorId, asOf: body.asOf ?? '(now)' },
      'saas-metrics.compute.admin-triggered',
    );
    return this.compute(body, 'admin');
  }

  private async compute(
    body: ComputeSaasMetricsRequest,
    trigger: 'internal' | 'admin',
  ): Promise<ComputeSaasMetricsResponse> {
    const asOf = body.asOf !== undefined ? new Date(body.asOf) : new Date();
    const result = await this.metrics.computeForDate(asOf);
    this.logger.log(
      {
        trigger,
        metricDate: result.metrics.metricDate,
        subscriptionsSnapshotted: result.subscriptionsSnapshotted,
      },
      'saas-metrics.compute.completed',
    );
    return result;
  }

  private requireInternalSharedSecret(request: Request): void {
    const presented = request.header(SAAS_METRICS_INTERNAL_API_KEY_HEADER);
    if (!isSharedSecretValid(presented, this.env.INTERNAL_POST_JOURNAL_API_KEY)) {
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
