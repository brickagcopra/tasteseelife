import {
  Body,
  ConflictException,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Param,
  Post,
  Query,
  Req,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import {
  ADMIN_USERS_USER_ID_MAX_LENGTH,
  AdminUserDetailResponseSchema,
  AdminUserActionResponseSchema,
  AdminUsersListQuerySchema,
  AdminUsersListResponseSchema,
  ReinstateUserRequestSchema,
  SuspendUserRequestSchema,
  UnlockUserRequestSchema,
  type AdminUserActionResponse,
  type AdminUserDetailResponse,
  type AdminUsersListQuery,
  type AdminUsersListResponse,
  type ReinstateUserRequest,
  type SuspendUserRequest,
  type UnlockUserRequest,
} from '@taste-and-see/contracts';
import { AccessTokenGuard, type RequestWithContext } from '@taste-and-see/nest-auth';
import { ZodValidationPipe } from '@taste-and-see/nest-common';
import { Idempotent } from '@taste-and-see/nest-idempotency';

import { SuperAdminRoleGuard } from '../../../common/guards/admin-role.guard';
import { actionResultToDto, detailRowToDto, summaryRowToDto } from '../mappers/admin-user.mapper';
import {
  AdminUserActionsService,
  type AdminUserActionResult,
} from '../services/admin-user-actions.service';
import { AdminUsersService } from '../services/admin-users.service';

/**
 * Admin users management HTTP boundary
 * (TS-126 Slice 1 + TS-126-followup-1; PRD §10.2).
 *
 *   GET /api/v1/admin/users
 *     Cursor-paginated search across the identity service's `users`
 *     table. See `AdminUsersListQuerySchema` for the filter shape.
 *     Response: AdminUsersListResponse (rows + nextCursor).
 *
 *   GET /api/v1/admin/users/:id
 *     Full account-detail view including active role assignments,
 *     confirmed MFA methods, the most-recent KYC summary, and
 *     lockout state. 404 when the id does not resolve.
 *
 *   POST /api/v1/admin/users/:id/suspend
 *     Transitions `users.status` `active → suspended`. Returns 409
 *     when the current status is not `active`; 404 when the id does
 *     not resolve or the row is soft-deleted.
 *
 *   POST /api/v1/admin/users/:id/reinstate
 *     Transitions `users.status` `suspended → active`. Returns 409
 *     when the current status is not `suspended`; 404 when the id
 *     does not resolve or the row is soft-deleted. Does NOT
 *     reinstate from `deactivated` — permanent close requires a
 *     separate restore endpoint (out of scope for Slice 1).
 *
 *   POST /api/v1/admin/users/:id/unlock
 *     Clears `lockedUntil`, `failedLoginCount`, `lastFailedLoginAt`.
 *     Naturally idempotent (no-op success on an already-clear
 *     account). 404 when the id does not resolve or the row is
 *     soft-deleted. Does NOT mutate `users.status`.
 *
 * **Slice 1 + TS-126-followup-1 scope.** Read + the three mutations
 * named in TS-025-followup-2. Impersonation (TS-126-followup-2),
 * KYC document review (TS-126-followup-3), background-check
 * surface (TS-126-followup-4), and audit-event emission via
 * `service-audit` (TS-126-followup-5) arrive in later follow-ups.
 *
 * **Authorisation.** All endpoints sit behind `AccessTokenGuard`
 * (bearer-token verification) followed by `SuperAdminRoleGuard`
 * (active super_admin role required). The gateway-side proxy
 * enforces the same gate at the edge for defence-in-depth. Per-
 * permission gating replaces the hard-wired `super_admin` check
 * with TS-126-followup-10 once `PermissionGuard` lifts.
 *
 * **Audit emission.** Admin reads do NOT emit audit events today.
 * Mutations emit structured `logger.log` lines via the
 * `AdminUserActionsService` as a forward-compat scaffold for the
 * audit pipe (TS-126-followup-5); once TS-100 audit-svc is up the
 * service-layer log emission is replaced by an outbox event with
 * the same payload shape.
 *
 * **Idempotency.** GET endpoints are naturally idempotent — no
 * `@Idempotent()`. Each POST mutation wears `@Idempotent()` so a
 * retried admin click replays the cached response without re-
 * firing the underlying transition. The interceptor caches on
 * `Idempotency-Key` + actor + body hash; mismatched-key + same-body
 * → 409 (client bug); same-key + different-body → 409 (also a
 * client bug). The gateway proxy forwards the inbound
 * Idempotency-Key header through.
 */
@Controller()
@UseGuards(AccessTokenGuard, SuperAdminRoleGuard)
export class AdminUsersController {
  constructor(
    private readonly users: AdminUsersService,
    private readonly actions: AdminUserActionsService,
  ) {}

  @Get('api/v1/admin/users')
  @HttpCode(HttpStatus.OK)
  async list(
    @Query(new ZodValidationPipe(AdminUsersListQuerySchema))
    query: AdminUsersListQuery,
  ): Promise<AdminUsersListResponse> {
    const page = await this.users.list({
      ...(query.q !== undefined ? { q: query.q } : {}),
      ...(query.status !== undefined ? { status: query.status } : {}),
      ...(query.roleName !== undefined ? { roleName: query.roleName } : {}),
      ...(query.cursor !== undefined ? { cursor: query.cursor } : {}),
      limit: query.limit,
    });

    const response: AdminUsersListResponse = {
      users: page.users.map(summaryRowToDto),
      nextCursor: page.nextCursor,
    };
    // Parse-validate before returning so a future drift between the
    // service shape and the contract surfaces at the boundary
    // rather than in the consumer.
    return AdminUsersListResponseSchema.parse(response);
  }

  @Get('api/v1/admin/users/:id')
  @HttpCode(HttpStatus.OK)
  async getById(@Param('id') id: string): Promise<AdminUserDetailResponse> {
    if (id.length === 0 || id.length > ADMIN_USERS_USER_ID_MAX_LENGTH) {
      throw new NotFoundException(notFoundBody(id));
    }

    const row = await this.users.getById({ userId: id });
    if (row === null) {
      throw new NotFoundException(notFoundBody(id));
    }

    const response: AdminUserDetailResponse = { user: detailRowToDto(row) };
    return AdminUserDetailResponseSchema.parse(response);
  }

  @Post('api/v1/admin/users/:id/suspend')
  @HttpCode(HttpStatus.OK)
  @Idempotent()
  async suspend(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(SuspendUserRequestSchema)) body: SuspendUserRequest,
    @Req() request: RequestWithContext,
  ): Promise<AdminUserActionResponse> {
    if (id.length === 0 || id.length > ADMIN_USERS_USER_ID_MAX_LENGTH) {
      throw new NotFoundException(notFoundBody(id));
    }
    const actorUserId = requireActor(request);

    const result = await this.actions.suspend({
      userId: id,
      actorUserId,
      reason: body.reason,
      note: body.note ?? null,
    });
    return mapActionResult(result, 'suspend', id, body.reason, body.note ?? null, actorUserId);
  }

  @Post('api/v1/admin/users/:id/reinstate')
  @HttpCode(HttpStatus.OK)
  @Idempotent()
  async reinstate(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(ReinstateUserRequestSchema)) body: ReinstateUserRequest,
    @Req() request: RequestWithContext,
  ): Promise<AdminUserActionResponse> {
    if (id.length === 0 || id.length > ADMIN_USERS_USER_ID_MAX_LENGTH) {
      throw new NotFoundException(notFoundBody(id));
    }
    const actorUserId = requireActor(request);

    const result = await this.actions.reinstate({
      userId: id,
      actorUserId,
      reason: body.reason,
      note: body.note ?? null,
    });
    return mapActionResult(result, 'reinstate', id, body.reason, body.note ?? null, actorUserId);
  }

  @Post('api/v1/admin/users/:id/unlock')
  @HttpCode(HttpStatus.OK)
  @Idempotent()
  async unlock(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(UnlockUserRequestSchema)) body: UnlockUserRequest,
    @Req() request: RequestWithContext,
  ): Promise<AdminUserActionResponse> {
    if (id.length === 0 || id.length > ADMIN_USERS_USER_ID_MAX_LENGTH) {
      throw new NotFoundException(notFoundBody(id));
    }
    const actorUserId = requireActor(request);

    const result = await this.actions.unlock({
      userId: id,
      actorUserId,
      note: body.note ?? null,
    });
    return mapActionResult(result, 'unlock', id, null, body.note ?? null, actorUserId);
  }
}

/**
 * Project a service-layer `AdminUserActionResult` onto the wire DTO.
 * Failure variants become typed HttpExceptions; the success path
 * runs through the mapper + parse-validate so a future drift between
 * the service shape and the contract surfaces at the boundary.
 */
function mapActionResult(
  result: AdminUserActionResult,
  action: 'suspend' | 'reinstate' | 'unlock',
  userId: string,
  reason: string | null,
  note: string | null,
  performedByUserId: string,
): AdminUserActionResponse {
  if (!result.ok) {
    switch (result.failure.kind) {
      case 'user_not_found':
        throw new NotFoundException(notFoundBody(userId));
      case 'illegal_transition':
        throw new ConflictException(
          illegalTransitionBody(result.failure.currentStatus, result.failure.attempted),
        );
    }
  }

  const response: AdminUserActionResponse = actionResultToDto({
    success: result.value,
    action,
    reason,
    note,
    performedByUserId,
  });
  return AdminUserActionResponseSchema.parse(response);
}

function requireActor(request: RequestWithContext): string {
  const ctx = request.requestContext;
  if (ctx === undefined) {
    // Defence in depth: the upstream AccessTokenGuard already
    // attached the context. If we reach here without one,
    // something is misconfigured — refuse rather than treat the
    // call as anonymous.
    throw new UnauthorizedException({
      type: 'about:blank',
      title: 'Unauthorized',
      status: 401,
      detail: 'Authentication required.',
    });
  }
  return ctx.userId;
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
    detail: `User ${truncateForError(id)} not found.`,
  };
}

function illegalTransitionBody(
  currentStatus: string,
  attempted: 'suspend' | 'reinstate',
): {
  readonly type: 'about:blank';
  readonly title: 'Conflict';
  readonly status: 409;
  readonly detail: string;
  readonly currentStatus: string;
  readonly attempted: string;
} {
  const required = attempted === 'suspend' ? 'active' : 'suspended';
  return {
    type: 'about:blank',
    title: 'Conflict',
    status: 409,
    detail: `Cannot ${attempted}: current status is "${currentStatus}", expected "${required}".`,
    currentStatus,
    attempted,
  };
}

function truncateForError(value: string): string {
  if (value.length <= 32) return value;
  return `${value.slice(0, 29)}...`;
}
