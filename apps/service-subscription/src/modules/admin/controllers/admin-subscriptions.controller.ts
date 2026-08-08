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
  ADMIN_SUBSCRIPTIONS_ID_MAX_LENGTH,
  AdminSubscriptionDetailResponseSchema,
  AdminSubscriptionsListQuerySchema,
  AdminSubscriptionsListResponseSchema,
  type AdminSubscriptionDetailResponse,
  type AdminSubscriptionsListQuery,
  type AdminSubscriptionsListResponse,
} from '@taste-and-see/contracts';
import { AccessTokenGuard } from '@taste-and-see/nest-auth';
import { ZodValidationPipe } from '@taste-and-see/nest-common';

import { SuperAdminRoleGuard } from '../../../common/guards/admin-role.guard';
import { detailRowToDto, summaryRowToDto } from '../mappers/admin-subscription.mapper';
import { AdminSubscriptionsService } from '../services/admin-subscriptions.service';

/**
 * Admin subscriptions management HTTP boundary (TS-127 Slice 1; PRD §10.3).
 *
 *   GET /api/v1/admin/subscriptions
 *     Cursor-paginated search across the subscription service's
 *     `subscriptions` table. See `AdminSubscriptionsListQuerySchema` for
 *     the filter shape (customerGroup / status / planId / customerId).
 *     Response: AdminSubscriptionsListResponse (rows + nextCursor).
 *
 *   GET /api/v1/admin/subscriptions/:id
 *     Full subscription-detail view including the denormalised plan
 *     summary, default payment-method summary, dunning state, pause
 *     state, cancellation state, and the chronological change-history
 *     audit trail (most-recent `ADMIN_SUBSCRIPTIONS_HISTORY_MAX` rows).
 *     404 when the id does not resolve.
 *
 * **Slice 1 scope.** Read-only. Mutations (comp / refund / extend-trial
 * / prorate — TS-127-followup-1), plan-catalog edit
 * (TS-127-followup-2), bulk cohort operations (TS-127-followup-3),
 * revenue-recognition reporting (TS-127-followup-4), manual dunning
 * recovery (TS-127-followup-5), audit-event emission
 * (TS-127-followup-6), Playwright E2E (TS-127-followup-7), OTel +
 * Prometheus (TS-127-followup-8), OpenAPI generator registration
 * (TS-127-followup-9), and the PermissionGuard lift
 * (TS-127-followup-10) arrive in subsequent TS-127 follow-ups.
 *
 * **Authorisation.** Both endpoints sit behind `AccessTokenGuard`
 * (bearer-token verification) followed by `SuperAdminRoleGuard` (active
 * super_admin role required). The gateway-side proxy enforces the same
 * gate at the edge.
 *
 * **Audit emission.** Admin reads do NOT emit audit events today —
 * Slice 1 has no mutations. The read-event audit pipe lands with
 * TS-127-followup-6 once the audit pipe is operational. Today the
 * service-layer emits a structured `logger.log` line per call as a
 * forward-compat scaffold.
 *
 * **Idempotency.** Both endpoints are GET — `@Idempotent()` is the
 * write-endpoint surface and does not apply here.
 */
@Controller()
@UseGuards(AccessTokenGuard, SuperAdminRoleGuard)
export class AdminSubscriptionsController {
  constructor(private readonly subscriptions: AdminSubscriptionsService) {}

  @Get('api/v1/admin/subscriptions')
  @HttpCode(HttpStatus.OK)
  async list(
    @Query(new ZodValidationPipe(AdminSubscriptionsListQuerySchema))
    query: AdminSubscriptionsListQuery,
  ): Promise<AdminSubscriptionsListResponse> {
    const page = await this.subscriptions.list({
      ...(query.customerGroup !== undefined ? { customerGroup: query.customerGroup } : {}),
      ...(query.status !== undefined ? { status: query.status } : {}),
      ...(query.planId !== undefined ? { planId: query.planId } : {}),
      ...(query.customerId !== undefined ? { customerId: query.customerId } : {}),
      ...(query.cursor !== undefined ? { cursor: query.cursor } : {}),
      limit: query.limit,
    });

    const response: AdminSubscriptionsListResponse = {
      subscriptions: page.subscriptions.map(summaryRowToDto),
      nextCursor: page.nextCursor,
    };
    // Parse-validate before returning so a future drift between the
    // service shape and the contract surfaces at the boundary rather
    // than in the consumer.
    return AdminSubscriptionsListResponseSchema.parse(response);
  }

  @Get('api/v1/admin/subscriptions/:id')
  @HttpCode(HttpStatus.OK)
  async getById(@Param('id') id: string): Promise<AdminSubscriptionDetailResponse> {
    if (id.length === 0 || id.length > ADMIN_SUBSCRIPTIONS_ID_MAX_LENGTH) {
      throw new NotFoundException(notFoundBody(id));
    }

    const row = await this.subscriptions.getById({ subscriptionId: id });
    if (row === null) {
      throw new NotFoundException(notFoundBody(id));
    }

    const response: AdminSubscriptionDetailResponse = {
      subscription: detailRowToDto(row),
    };
    return AdminSubscriptionDetailResponseSchema.parse(response);
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
    detail: `Subscription ${truncateForError(id)} not found.`,
  };
}

function truncateForError(value: string): string {
  if (value.length <= 32) return value;
  return `${value.slice(0, 29)}...`;
}
