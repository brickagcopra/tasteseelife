import {
  Body,
  ConflictException,
  Controller,
  ForbiddenException,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Param,
  Post,
  Req,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import {
  ADMIN_USERS_USER_ID_MAX_LENGTH,
  EndImpersonationRequestSchema,
  EndImpersonationResponseSchema,
  ImpersonateUserRequestSchema,
  ImpersonateUserResponseSchema,
  type EndImpersonationRequest,
  type EndImpersonationResponse,
  type ImpersonateUserRequest,
  type ImpersonateUserResponse,
} from '@taste-and-see/contracts';
import {
  AccessTokenGuard,
  PermissionGuard,
  RequirePermissions,
  type RequestWithContext,
} from '@taste-and-see/nest-auth';
import { ZodValidationPipe } from '@taste-and-see/nest-common';
import { Idempotent } from '@taste-and-see/nest-idempotency';

import { AdminImpersonationService } from '../services/admin-impersonation.service';
import type { AuditActorContext } from '@taste-and-see/nest-audit';
import { buildAuditActorContext } from '@taste-and-see/nest-audit';

/**
 * Admin impersonation HTTP boundary (TS-297; PRD §10.2; CLAUDE.md §3.6).
 *
 *   POST /api/v1/admin/users/:id/impersonate   (user:impersonate)
 *     Mint a short-lived diagnostic session in the target user's name.
 *     403 for self-impersonation and admin-staff targets, 404 for
 *     unknown / soft-deleted targets, 409 for deactivated accounts.
 *
 *   POST /api/v1/admin/impersonation/end        (user:impersonate)
 *     Revoke an impersonation session family. Idempotent — an already-
 *     ended family reports `ended: false`. 404 for unknown families,
 *     409 when the family is not an impersonation session (ordinary
 *     sessions are out of this surface's blast radius by design).
 *
 * **Authorisation.** `AccessTokenGuard` → `PermissionGuard` with
 * `user:impersonate` — granted to super_admin ONLY in Phase 1 (the
 * seed catalog change ships with this controller; the gate goes live
 * on the next `pnpm seed:rbac` run). The gateway proxy re-enforces
 * the same permission at the edge (defence-in-depth).
 *
 * **Audit.** Start and end both emit `audit.action_recorded`
 * atomically with the session write (TS-295 invariant) — actor is the
 * OPERATOR, resource is the impersonated user, and the payload carries
 * both ids plus the session family (CLAUDE.md §3.6: operator identity
 * preserved alongside the impersonated user).
 *
 * **Token hygiene.** The response body carries the raw session tokens
 * (TLS-only admin surface); they are never logged — success logs carry
 * only the family id.
 */
@Controller()
@UseGuards(AccessTokenGuard, PermissionGuard)
export class AdminImpersonationController {
  constructor(private readonly impersonation: AdminImpersonationService) {}

  @Post('api/v1/admin/users/:id/impersonate')
  @HttpCode(HttpStatus.CREATED)
  @RequirePermissions('user:impersonate')
  @Idempotent()
  async impersonate(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(ImpersonateUserRequestSchema)) body: ImpersonateUserRequest,
    @Req() request: RequestWithContext,
  ): Promise<ImpersonateUserResponse> {
    if (id.length === 0 || id.length > ADMIN_USERS_USER_ID_MAX_LENGTH) {
      throw new NotFoundException(notFoundBody(id));
    }
    const actor = requireActor(request);

    const result = await this.impersonation.start({
      targetUserId: id,
      reason: body.reason,
      actor,
      operatorMfaVerified: request.requestContext?.mfaVerified ?? false,
    });

    if (!result.ok) {
      switch (result.failure.kind) {
        case 'target_not_found':
          throw new NotFoundException(notFoundBody(id));
        case 'self':
          throw new ForbiddenException(
            problem(403, 'Forbidden', 'You cannot impersonate your own account.'),
          );
        case 'admin_target':
          throw new ForbiddenException(
            problem(403, 'Forbidden', 'Accounts holding admin-staff roles cannot be impersonated.'),
          );
        case 'deactivated':
          throw new ConflictException(
            problem(409, 'Conflict', 'Deactivated accounts cannot be impersonated.'),
          );
      }
    }

    const response: ImpersonateUserResponse = {
      accessToken: result.value.accessToken,
      tokenType: 'Bearer',
      expiresIn: result.value.expiresIn,
      refreshToken: result.value.refreshToken,
      sessionFamilyId: result.value.sessionFamilyId,
      sessionExpiresAt: result.value.sessionExpiresAt.toISOString(),
      operatorUserId: result.value.operatorUserId,
      user: result.value.user,
    };
    return ImpersonateUserResponseSchema.parse(response);
  }

  @Post('api/v1/admin/impersonation/end')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('user:impersonate')
  @Idempotent()
  async end(
    @Body(new ZodValidationPipe(EndImpersonationRequestSchema)) body: EndImpersonationRequest,
    @Req() request: RequestWithContext,
  ): Promise<EndImpersonationResponse> {
    const actor = requireActor(request);

    const result = await this.impersonation.end({
      sessionFamilyId: body.sessionFamilyId,
      actor,
    });

    if (!result.ok) {
      switch (result.failure.kind) {
        case 'family_not_found':
          throw new NotFoundException(
            problem(404, 'Not Found', 'No session found for that family id.'),
          );
        case 'not_impersonation':
          throw new ConflictException(
            problem(
              409,
              'Conflict',
              'That session is not an impersonation session. Ordinary sessions are managed through the session-management surface.',
            ),
          );
      }
    }

    const response: EndImpersonationResponse = {
      sessionFamilyId: result.value.sessionFamilyId,
      ended: result.value.ended,
      endedAt: result.value.endedAt.toISOString(),
    };
    return EndImpersonationResponseSchema.parse(response);
  }
}

function requireActor(request: RequestWithContext): AuditActorContext {
  const ctx = request.requestContext;
  if (ctx === undefined) {
    // Defence in depth — AccessTokenGuard attaches the context; if the
    // binding broke, refuse rather than act anonymously.
    throw new UnauthorizedException(problem(401, 'Unauthorized', 'Authentication required.'));
  }
  return buildAuditActorContext(ctx, request);
}

function problem(
  status: number,
  title: string,
  detail: string,
): {
  readonly type: 'about:blank';
  readonly title: string;
  readonly status: number;
  readonly detail: string;
} {
  return { type: 'about:blank', title, status, detail };
}

function notFoundBody(id: string): ReturnType<typeof problem> {
  const shown = id.length <= 32 ? id : `${id.slice(0, 29)}...`;
  return problem(404, 'Not Found', `User ${shown} not found.`);
}
