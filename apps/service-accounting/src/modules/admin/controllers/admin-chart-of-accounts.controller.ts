import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  InternalServerErrorException,
  NotFoundException,
  Param,
  Patch,
  Req,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import {
  ADMIN_ACCOUNTING_ID_MAX_LENGTH,
  UpdateAccountActiveRequestSchema,
  UpdateAccountActiveResponseSchema,
  type UpdateAccountActiveRequest,
  type UpdateAccountActiveResponse,
} from '@taste-and-see/contracts';
import { AccessTokenGuard, type RequestWithContext } from '@taste-and-see/nest-auth';
import { ZodValidationPipe } from '@taste-and-see/nest-common';
import { Idempotent } from '@taste-and-see/nest-idempotency';

import { SuperAdminRoleGuard } from '../../../common/guards/admin-role.guard';
import { toAdminAccountDto } from '../mappers/admin-accounting.mapper';
import {
  AdminChartOfAccountsService,
  type AdminAccountSetActiveResult,
} from '../services/admin-chart-of-accounts.service';

/**
 * Admin chart-of-accounts mutation endpoint
 * (TS-129-followup-1; PRD §10.8, PDD §11.2, CLAUDE.md §6).
 *
 *   PATCH /api/v1/admin/accounts/:id
 *     Flip an account's `active` flag (retire / activate). 404 when
 *     the id does not resolve.
 *
 * **Authorisation.** Behind `AccessTokenGuard` → `SuperAdminRoleGuard`.
 * The api-gateway proxy enforces the same gate at the edge for
 * defence-in-depth.
 *
 * **Idempotency.** Wears `@Idempotent()` so a retried admin click
 * replays the cached response without re-firing the underlying
 * transition. The interceptor caches on `Idempotency-Key` + actor +
 * body hash; mismatched-key + same-body → 409 (client bug);
 * same-key + different-body → 409 (also a client bug).
 *
 * **Why not POST?** The mutation flips a single boolean column on a
 * row — PATCH is the resource-oriented verb for partial update.
 * Mirrors `PUT/PATCH` patterns elsewhere on the platform (e.g.
 * service-household's intake upsert).
 */
@Controller()
@UseGuards(AccessTokenGuard, SuperAdminRoleGuard)
export class AdminChartOfAccountsController {
  constructor(private readonly accounts: AdminChartOfAccountsService) {}

  @Patch('api/v1/admin/accounts/:id')
  @HttpCode(HttpStatus.OK)
  @Idempotent()
  async setActive(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(UpdateAccountActiveRequestSchema))
    body: UpdateAccountActiveRequest,
    @Req() request: RequestWithContext,
  ): Promise<UpdateAccountActiveResponse> {
    if (id.length === 0 || id.length > ADMIN_ACCOUNTING_ID_MAX_LENGTH) {
      throw new NotFoundException(notFoundBody(id));
    }
    const actorUserId = requireActor(request);

    const result = await this.accounts.setActive({
      accountId: id,
      active: body.active,
      reason: body.reason,
      note: body.note ?? null,
      actorUserId,
    });
    return mapResult(result, id, body, actorUserId);
  }
}

function mapResult(
  result: AdminAccountSetActiveResult,
  accountId: string,
  body: UpdateAccountActiveRequest,
  performedByUserId: string,
): UpdateAccountActiveResponse {
  if (!result.ok) {
    switch (result.failure.kind) {
      case 'account_not_found':
        throw new NotFoundException(notFoundBody(accountId));
      case 'unsupported_currency':
        // The persisted row carries a currency the contract does not
        // accept. This is a server-side data-integrity issue, not a
        // request issue; the controller returns 500 with a redacted
        // body so the admin tool can surface a recovery prompt.
        throw new InternalServerErrorException(unsupportedCurrencyBody(accountId));
    }
  }

  const response: UpdateAccountActiveResponse = {
    account: toAdminAccountDto(result.value.account),
    performedAt: result.value.performedAt.toISOString(),
    performedByUserId,
    before: { active: result.value.before.active },
    after: { active: result.value.after.active },
    reason: body.reason,
    note: body.note ?? null,
  };
  return UpdateAccountActiveResponseSchema.parse(response);
}

function requireActor(request: RequestWithContext): string {
  const ctx = request.requestContext;
  if (ctx === undefined) {
    // Defence in depth: the upstream AccessTokenGuard already attached
    // the context. If we reach here without one, something is
    // misconfigured — refuse rather than treat the call as anonymous.
    throw new UnauthorizedException({
      type: 'about:blank',
      title: 'Unauthorized',
      status: HttpStatus.UNAUTHORIZED,
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
    status: HttpStatus.NOT_FOUND as 404,
    detail: `Account ${truncateForError(id)} not found.`,
  };
}

function unsupportedCurrencyBody(id: string): {
  readonly type: 'about:blank';
  readonly title: 'Internal Server Error';
  readonly status: 500;
  readonly detail: string;
} {
  return {
    type: 'about:blank',
    title: 'Internal Server Error',
    status: HttpStatus.INTERNAL_SERVER_ERROR as 500,
    detail: `Account ${truncateForError(id)} carries an unsupported currency.`,
  };
}

function truncateForError(value: string): string {
  if (value.length <= 32) return value;
  return `${value.slice(0, 29)}...`;
}
