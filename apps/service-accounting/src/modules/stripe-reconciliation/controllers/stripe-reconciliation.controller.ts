import { timingSafeEqual } from 'node:crypto';

import {
  Body,
  ConflictException,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Logger,
  NotFoundException,
  Param,
  Post,
  Query,
  Req,
  UnauthorizedException,
  UseGuards,
  UsePipes,
} from '@nestjs/common';
import {
  ListStripeReconciliationChecksQuerySchema,
  ListStripeReconciliationChecksResponseSchema,
  ResolveStripeReconciliationCheckRequestSchema,
  ResolveStripeReconciliationCheckResponseSchema,
  RunStripeReconciliationRequestSchema,
  RunStripeReconciliationResponseSchema,
  type ListStripeReconciliationChecksQuery,
  type ListStripeReconciliationChecksResponse,
  type ResolveStripeReconciliationCheckRequest,
  type ResolveStripeReconciliationCheckResponse,
  type RunStripeReconciliationRequest,
  type RunStripeReconciliationResponse,
} from '@taste-and-see/contracts';
import { Idempotent } from '@taste-and-see/nest-idempotency';
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
import { SuperAdminRoleGuard } from '../../../common/guards/admin-role.guard';
import { StripeReconciliationService } from '../services/stripe-reconciliation.service';

/**
 * Header carrying the internal-dispatch shared secret. Reuses
 * `INTERNAL_POST_JOURNAL_API_KEY` — the single trust principal for every
 * `/api/v1/internal/*` endpoint on the accounting service (same header the
 * `SaasMetricsController` uses).
 */
export const STRIPE_RECONCILIATION_INTERNAL_API_KEY_HEADER = 'x-accounting-internal-api-key';

/**
 * `StripeReconciliationController` — surfaces for the daily Stripe → ledger
 * reconciliation (TS-261, PRD §10.3, PDD §11.2, CLAUDE.md §6).
 *
 *   - `POST /api/v1/internal/accounting/stripe-reconciliation/run` — called
 *     by the `stripe-reconciliation` worker nightly. Shared-secret pinned
 *     (no end-user actor); handler wraps in `runWithoutTenantContext` so
 *     every Prisma op sees an explicit exempt frame under the `enforce`
 *     posture.
 *   - `POST /api/v1/admin/accounting/stripe-reconciliation/run` — operator
 *     back-fill / same-day re-run. `AccessTokenGuard` + `SuperAdminRoleGuard`.
 *   - `GET /api/v1/admin/accounting/stripe-reconciliation/checks` — the ops
 *     queue read (filter by status + date range).
 *   - `POST /api/v1/admin/accounting/stripe-reconciliation/checks/:id/resolve`
 *     — operator resolution of a `mismatch_open` ticket.
 *
 * Both write endpoints carry `@Idempotent()` (CLAUDE.md §17.5). The run is
 * additionally idempotent at the DB layer (the
 * `(reconciliation_date, category)` UNIQUE upsert), so a same-day re-run
 * with a fresh key correctly recomputes against current Stripe + ledger
 * state. Mirrors the `SaasMetricsController` posture.
 */
@Controller()
export class StripeReconciliationController {
  private readonly logger = new Logger(StripeReconciliationController.name);

  constructor(
    private readonly reconciliation: StripeReconciliationService,
    @Inject(ENV_TOKEN) private readonly env: Env,
    @Inject(TENANT_CONTEXT_STORE_TOKEN)
    private readonly tenantStore: TenantContextStore,
  ) {}

  @Post('api/v1/internal/accounting/stripe-reconciliation/run')
  @HttpCode(HttpStatus.OK)
  @Idempotent()
  @UsePipes(new ZodValidationPipe(RunStripeReconciliationRequestSchema))
  async runInternal(
    @Body() body: RunStripeReconciliationRequest,
    @Req() request: Request,
  ): Promise<RunStripeReconciliationResponse> {
    return runWithoutTenantContext(
      this.tenantStore,
      'internal-stripe-reconciliation-run',
      async () => {
        this.requireInternalSharedSecret(request);
        return this.run(body, 'internal');
      },
    );
  }

  @Post('api/v1/admin/accounting/stripe-reconciliation/run')
  @HttpCode(HttpStatus.OK)
  @UseGuards(AccessTokenGuard, SuperAdminRoleGuard)
  @Idempotent()
  @UsePipes(new ZodValidationPipe(RunStripeReconciliationRequestSchema))
  async runAdmin(
    @Body() body: RunStripeReconciliationRequest,
    @Req() request: RequestWithContext,
  ): Promise<RunStripeReconciliationResponse> {
    const actorId = requireActor(request);
    this.logger.warn(
      { actorId, asOf: body.asOf ?? '(yesterday)' },
      'stripe-reconciliation.run.admin-triggered',
    );
    return this.run(body, 'admin');
  }

  @Get('api/v1/admin/accounting/stripe-reconciliation/checks')
  @HttpCode(HttpStatus.OK)
  @UseGuards(AccessTokenGuard, SuperAdminRoleGuard)
  async listChecks(
    @Query(new ZodValidationPipe(ListStripeReconciliationChecksQuerySchema))
    query: ListStripeReconciliationChecksQuery,
  ): Promise<ListStripeReconciliationChecksResponse> {
    const result = await this.reconciliation.listChecks({
      ...(query.status !== undefined ? { status: query.status } : {}),
      ...(query.from !== undefined ? { from: query.from } : {}),
      ...(query.to !== undefined ? { to: query.to } : {}),
    });
    return ListStripeReconciliationChecksResponseSchema.parse(result);
  }

  @Post('api/v1/admin/accounting/stripe-reconciliation/checks/:checkId/resolve')
  @HttpCode(HttpStatus.OK)
  @UseGuards(AccessTokenGuard, SuperAdminRoleGuard)
  @Idempotent()
  async resolveCheck(
    @Param('checkId') checkId: string,
    @Body(new ZodValidationPipe(ResolveStripeReconciliationCheckRequestSchema))
    body: ResolveStripeReconciliationCheckRequest,
    @Req() request: RequestWithContext,
  ): Promise<ResolveStripeReconciliationCheckResponse> {
    const actorId = requireActor(request);
    const result = await this.reconciliation.resolveCheck({
      checkId,
      actorUserId: actorId,
      resolutionNotes: body.resolutionNotes,
    });
    if (!result.ok) {
      if (result.reason === 'not_found') {
        throw new NotFoundException({
          type: 'about:blank',
          title: 'Not Found',
          status: 404,
          detail: 'Reconciliation check not found.',
        });
      }
      throw new ConflictException({
        type: 'about:blank',
        title: 'Conflict',
        status: 409,
        detail: 'Only an open mismatch can be resolved.',
      });
    }
    return ResolveStripeReconciliationCheckResponseSchema.parse({ check: result.check });
  }

  private async run(
    body: RunStripeReconciliationRequest,
    trigger: 'internal' | 'admin',
  ): Promise<RunStripeReconciliationResponse> {
    const result = await this.reconciliation.reconcile({
      ...(body.asOf !== undefined ? { asOf: new Date(body.asOf) } : {}),
    });
    this.logger.log(
      {
        trigger,
        reconciliationDate: result.reconciliationDate,
        mode: result.mode,
        openMismatchCount: result.openMismatchCount,
      },
      'stripe-reconciliation.run.completed',
    );
    return RunStripeReconciliationResponseSchema.parse({
      reconciliationDate: result.reconciliationDate,
      mode: result.mode,
      checks: result.checks,
      openMismatchCount: result.openMismatchCount,
    });
  }

  private requireInternalSharedSecret(request: Request): void {
    const presented = request.header(STRIPE_RECONCILIATION_INTERNAL_API_KEY_HEADER);
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
