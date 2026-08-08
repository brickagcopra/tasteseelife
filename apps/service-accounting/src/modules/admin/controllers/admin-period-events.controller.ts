import {
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Param,
  Query,
  UnprocessableEntityException,
  UseGuards,
} from '@nestjs/common';
import {
  AdminPeriodEventsListQuerySchema,
  AdminPeriodEventsListResponseSchema,
  PeriodNameSchema,
  type AdminPeriodEventsListQuery,
  type AdminPeriodEventsListResponse,
} from '@taste-and-see/contracts';
import { AccessTokenGuard } from '@taste-and-see/nest-auth';
import { ZodValidationPipe } from '@taste-and-see/nest-common';

import { SuperAdminRoleGuard } from '../../../common/guards/admin-role.guard';
import { toAdminPeriodEvent } from '../mappers/admin-accounting.mapper';
import { AdminPeriodEventsService } from '../services/admin-period-events.service';

/**
 * Per-period lifecycle audit endpoint (TS-129 Slice 1; PRD §10.8,
 * closes TS-085-followup-7).
 *
 *   GET /api/v1/admin/periods/:periodName/events
 *
 * Cursor-paginated. Newest transitions first. 404 on unknown
 * periodName (the path is explicit about the target — empty-page
 * would be a worse UX than the standard not-found shape).
 * 422 on a malformed periodName at the path layer.
 *
 * Authorisation + audit + idempotency posture mirrors
 * `AdminJournalsController`.
 */
@Controller()
@UseGuards(AccessTokenGuard, SuperAdminRoleGuard)
export class AdminPeriodEventsController {
  constructor(private readonly events: AdminPeriodEventsService) {}

  @Get('api/v1/admin/periods/:periodName/events')
  @HttpCode(HttpStatus.OK)
  async list(
    @Param('periodName') periodName: string,
    @Query(new ZodValidationPipe(AdminPeriodEventsListQuerySchema))
    query: AdminPeriodEventsListQuery,
  ): Promise<AdminPeriodEventsListResponse> {
    validatePeriodName(periodName);

    const result = await this.events.listByPeriod({
      periodName,
      ...(query.cursor !== undefined ? { cursor: query.cursor } : {}),
      limit: query.limit,
    });

    if (result.kind === 'period_not_found') {
      throw new NotFoundException(periodNotFoundBody(periodName));
    }

    const response: AdminPeriodEventsListResponse = {
      events: result.page.events.map(toAdminPeriodEvent),
      nextCursor: result.page.nextCursor,
    };
    return AdminPeriodEventsListResponseSchema.parse(response);
  }
}

function validatePeriodName(periodName: string): void {
  const parsed = PeriodNameSchema.safeParse(periodName);
  if (!parsed.success) {
    throw new UnprocessableEntityException({
      type: 'about:blank',
      title: 'Unprocessable Entity',
      status: 422,
      detail: 'periodName path parameter must be YYYY-MM (e.g. "2026-05").',
      failureReason: 'malformed_period_name',
      periodName,
    });
  }
}

function periodNotFoundBody(periodName: string): {
  readonly type: 'about:blank';
  readonly title: 'Not Found';
  readonly status: 404;
  readonly detail: string;
} {
  return {
    type: 'about:blank',
    title: 'Not Found',
    status: 404,
    detail: `Accounting period "${periodName}" not found.`,
  };
}
