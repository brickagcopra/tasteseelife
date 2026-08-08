import { Controller, Get, HttpCode, HttpStatus, Query, UseGuards } from '@nestjs/common';
import {
  AdminTrialBalanceQuerySchema,
  AdminTrialBalanceResponseSchema,
  type AdminTrialBalanceQuery,
  type AdminTrialBalanceResponse,
} from '@taste-and-see/contracts';
import { AccessTokenGuard } from '@taste-and-see/nest-auth';
import { ZodValidationPipe } from '@taste-and-see/nest-common';

import { SuperAdminRoleGuard } from '../../../common/guards/admin-role.guard';
import { toAdminTrialBalanceResponse } from '../mappers/admin-accounting.mapper';
import { TrialBalanceService } from '../services/trial-balance.service';

/**
 * Trial-balance read endpoint (TS-129 Slice 1; PRD §10.8, PDD §11.2).
 *
 *   GET /api/v1/admin/trial-balance?periodId=&periodName=&currency=
 *
 * Computes per-account aggregates across `journal_lines` (gross debit
 * total + gross credit total + signed net) and returns one row per
 * account. The footer carries the grand-total + an `imbalanceMinor`
 * diagnostic which is zero for a balanced ledger (and the most
 * important read on the trial-balance view if it's non-zero).
 *
 * Period scope:
 *   - `periodId` exact-match;
 *   - `periodName` (`YYYY-MM`) resolves to id; unknown → empty rows;
 *   - both → `periodId` wins;
 *   - neither → all-time aggregate.
 *
 * Currency defaults to USD (Phase-1 single currency).
 *
 * Authorisation + audit + idempotency posture mirrors
 * `AdminJournalsController`.
 */
@Controller()
@UseGuards(AccessTokenGuard, SuperAdminRoleGuard)
export class AdminTrialBalanceController {
  constructor(private readonly trialBalance: TrialBalanceService) {}

  @Get('api/v1/admin/trial-balance')
  @HttpCode(HttpStatus.OK)
  async compute(
    @Query(new ZodValidationPipe(AdminTrialBalanceQuerySchema))
    query: AdminTrialBalanceQuery,
  ): Promise<AdminTrialBalanceResponse> {
    const computed = await this.trialBalance.compute({
      ...(query.periodId !== undefined ? { periodId: query.periodId } : {}),
      ...(query.periodName !== undefined ? { periodName: query.periodName } : {}),
      ...(query.currency !== undefined ? { currency: query.currency } : {}),
    });
    const response = toAdminTrialBalanceResponse(computed);
    return AdminTrialBalanceResponseSchema.parse(response);
  }
}
