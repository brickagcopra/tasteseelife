import { Controller, Get, HttpCode, HttpStatus, Query, UseGuards } from '@nestjs/common';
import {
  AdminPausedDeferredRevenueQuerySchema,
  AdminPausedDeferredRevenueResponseSchema,
  type AdminPausedDeferredRevenueQuery,
  type AdminPausedDeferredRevenueResponse,
} from '@taste-and-see/contracts';
import { AccessTokenGuard } from '@taste-and-see/nest-auth';
import { ZodValidationPipe } from '@taste-and-see/nest-common';

import { SuperAdminRoleGuard } from '../../../common/guards/admin-role.guard';
import { toAdminPausedDeferredRevenueResponse } from '../mappers/admin-accounting.mapper';
import { AdminDeferredRevenueService } from '../services/admin-deferred-revenue.service';

/**
 * Paused deferred-revenue queue (TS-042-followup-3b2-followup-2a;
 * PRD §10.8, PDD §11.2, CLAUDE.md §10).
 *
 *   GET /api/v1/admin/deferred-revenue/paused?limit=&asOf=
 *
 * The stock measure behind `accounting_recognition_pause_total`: which
 * balances have stopped amortising, for how long, and how much revenue is
 * suspended in them. See `AdminDeferredRevenueService` for why the counts
 * and the enumeration are separate queries.
 *
 * **Authorisation** matches every other surface on this module —
 * `AccessTokenGuard` → `SuperAdminRoleGuard`, with the gateway proxy
 * enforcing the same gate at the edge. Deliberately NOT a new
 * `accounting:read` permission: the accounting service has no
 * per-permission gating anywhere yet, and introducing it on one read
 * endpoint would leave the finance role able to see stranded revenue but
 * not the trial balance it reconciles against. That lift belongs to
 * TS-052-followup-11 / TS-129-followup-N, whole-module, in one step.
 *
 * **Read-only, no idempotency key** — `@Idempotent()` covers writes.
 */
@Controller()
@UseGuards(AccessTokenGuard, SuperAdminRoleGuard)
export class AdminDeferredRevenueController {
  constructor(private readonly deferredRevenue: AdminDeferredRevenueService) {}

  @Get('api/v1/admin/deferred-revenue/paused')
  @HttpCode(HttpStatus.OK)
  async listPaused(
    @Query(new ZodValidationPipe(AdminPausedDeferredRevenueQuerySchema))
    query: AdminPausedDeferredRevenueQuery,
  ): Promise<AdminPausedDeferredRevenueResponse> {
    const view = await this.deferredRevenue.listPaused({
      // `asOf` is an operator affordance for reproducing a report, not a
      // filter: it moves the instant every age is measured against, and
      // the default is simply now.
      asOf: query.asOf !== undefined ? new Date(query.asOf) : new Date(),
      limit: query.limit,
    });

    return AdminPausedDeferredRevenueResponseSchema.parse(
      toAdminPausedDeferredRevenueResponse(view),
    );
  }
}
