import {
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Param,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ADMIN_ACCOUNTING_ID_MAX_LENGTH,
  AdminJournalDetailResponseSchema,
  AdminJournalsListQuerySchema,
  AdminJournalsListResponseSchema,
  type AdminJournalDetailResponse,
  type AdminJournalsListQuery,
  type AdminJournalsListResponse,
} from '@taste-and-see/contracts';
import { AccessTokenGuard } from '@taste-and-see/nest-auth';
import { ZodValidationPipe } from '@taste-and-see/nest-common';

import { SuperAdminRoleGuard } from '../../../common/guards/admin-role.guard';
import { toAdminJournalDetail, toAdminJournalSummary } from '../mappers/admin-accounting.mapper';
import { AdminJournalsService } from '../services/admin-journals.service';

/**
 * Admin journals browser (TS-129 Slice 1; PRD §10.8, PDD §11.2,
 * closes TS-081-followup-7).
 *
 *   GET /api/v1/admin/journals
 *     Cursor-paginated journals browser. Filters: periodId, periodName,
 *     kind. Default page size 25, max 100.
 *
 *   GET /api/v1/admin/journals/:id
 *     Full journal detail (envelope + lines + context).
 *
 * **Authorisation.** Both endpoints sit behind `AccessTokenGuard`
 * (bearer-token verification) followed by `SuperAdminRoleGuard` (active
 * super_admin role required). The gateway-side proxy enforces the same
 * gate at the edge.
 *
 * **Slice 1 scope.** Read-only. PRD §10.8 covers a much larger surface
 * (full SaaS metrics, period-close UI, multi-currency, Stripe
 * reconciliation, NetSuite/QuickBooks exports) — all deferred to
 * TS-129-followup tasks.
 *
 * **Audit emission.** Admin reads do NOT emit audit events today —
 * Slice 1 has no mutations. Read-event auditing arrives with TS-100
 * audit-svc.
 *
 * **Idempotency.** Both endpoints are GET — `@Idempotent()` is the
 * write-endpoint surface and does not apply here.
 */
@Controller()
@UseGuards(AccessTokenGuard, SuperAdminRoleGuard)
export class AdminJournalsController {
  constructor(private readonly journals: AdminJournalsService) {}

  @Get('api/v1/admin/journals')
  @HttpCode(HttpStatus.OK)
  async list(
    @Query(new ZodValidationPipe(AdminJournalsListQuerySchema))
    query: AdminJournalsListQuery,
  ): Promise<AdminJournalsListResponse> {
    const page = await this.journals.list({
      ...(query.periodId !== undefined ? { periodId: query.periodId } : {}),
      ...(query.periodName !== undefined ? { periodName: query.periodName } : {}),
      ...(query.kind !== undefined ? { kind: query.kind } : {}),
      ...(query.cursor !== undefined ? { cursor: query.cursor } : {}),
      limit: query.limit,
    });

    const response: AdminJournalsListResponse = {
      journals: page.journals.map(toAdminJournalSummary),
      nextCursor: page.nextCursor,
    };
    return AdminJournalsListResponseSchema.parse(response);
  }

  @Get('api/v1/admin/journals/:id')
  @HttpCode(HttpStatus.OK)
  async getById(@Param('id') id: string): Promise<AdminJournalDetailResponse> {
    if (id.length === 0 || id.length > ADMIN_ACCOUNTING_ID_MAX_LENGTH) {
      throw new NotFoundException(notFoundBody(id));
    }

    const row = await this.journals.getById(id);
    if (row === null) {
      throw new NotFoundException(notFoundBody(id));
    }

    const response: AdminJournalDetailResponse = {
      journal: toAdminJournalDetail(row),
    };
    return AdminJournalDetailResponseSchema.parse(response);
  }
}

function notFoundBody(id: string): {
  readonly type: 'about:blank';
  readonly title: 'Not Found';
  readonly status: 404;
  readonly detail: string;
} {
  return {
    type: 'about:blank',
    title: 'Not Found',
    status: 404,
    detail: `Journal ${truncateForError(id)} not found.`,
  };
}

function truncateForError(value: string): string {
  if (value.length <= 32) return value;
  return `${value.slice(0, 29)}...`;
}
