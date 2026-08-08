import { timingSafeEqual } from 'node:crypto';

import {
  Body,
  ConflictException,
  Controller,
  HttpCode,
  HttpStatus,
  Inject,
  Logger,
  NotFoundException,
  Param,
  Post,
  Req,
  UnauthorizedException,
  UnprocessableEntityException,
  UseGuards,
  UsePipes,
} from '@nestjs/common';
import { Idempotent } from '@taste-and-see/nest-idempotency';
import {
  ManualAdjustmentRequestSchema,
  PostJournalRequestSchema,
  ReverseJournalRequestSchema,
  type JournalResponse,
  type ManualAdjustmentRequest,
  type PostJournalRequest,
  type ReverseJournalRequest,
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
import {
  JournalPostingService,
  type PostJournalFailure,
  type ReverseJournalFailure,
} from '../services/journal-posting.service';

/**
 * Shared header name carrying the internal-dispatch shared secret.
 * Mirrors the convention from service-identity's KYC dispatch
 * (`x-kyc-internal-api-key`). The matching env var
 * (`INTERNAL_POST_JOURNAL_API_KEY`) is set per environment in
 * secrets manager; service-to-service callers (the TS-142 outbox
 * relay, once it lands) read the same value from their own env.
 */
export const JOURNAL_INTERNAL_API_KEY_HEADER = 'x-accounting-internal-api-key';

/**
 * `JournalsController` — write surfaces for the journal-posting
 * service.
 *
 * - `POST /api/v1/internal/journals` — system-driven journal post.
 *   Shared-secret pinned via `JOURNAL_INTERNAL_API_KEY_HEADER`.
 *   No `AccessTokenGuard` because the caller is the outbox relay
 *   (not a user-bearing request). Replaced by a relay subscription
 *   once TS-142 lands; the shared-secret HTTP scaffold is the same
 *   transport the KYC + Checkr dispatchers use today.
 *
 * - `POST /api/v1/admin/journals/manual-adjustment` — admin
 *   finance:adjust override. Authenticated via `AccessTokenGuard`;
 *   permission-string gating (`@RequirePermissions('accounting:adjust')`)
 *   lands once the shared `packages/nest-auth` package arrives
 *   (TS-052-followup-11). Until then the journal records the
 *   posting user id so audit reports can attribute manual posts.
 *
 * - `POST /api/v1/admin/journals/:journalId/reverse` — admin
 *   reversal. Authenticated; same permission-gating posture as
 *   the manual-adjustment endpoint.
 *
 * Every write endpoint carries `@Idempotent()` so a client retry
 * against the same `Idempotency-Key` header replays the cached
 * response (CLAUDE.md §3.3). The service-layer idempotency on
 * `source_event_id` is the second line of defence — even if a
 * caller forgets the header, a replayed journal collapses to
 * exactly-once at the DB layer.
 *
 * Tenant-scoping (TS-020-followup-2b-platform-rollout). The
 * shared-secret-pinned internal endpoint (`postSystemJournal`)
 * authenticates via the `JOURNAL_INTERNAL_API_KEY_HEADER` rather than
 * the `AccessTokenGuard`, so the `TenantContextInterceptor` cannot seed
 * a scoped frame from a `request.requestContext` that does not exist.
 * The handler body wraps in `runWithoutTenantContext(...,
 * 'internal-journals-post', ...)` so every Prisma operation downstream
 * (the chart-of-accounts lookup + the period-membership check + the
 * journal + journal-lines insert) sees an explicit `exempt` frame
 * rather than failing with `MissingRequestContextError` under the
 * `enforcement: 'enforce'` posture wired in `AppModule`.
 *
 * The two admin endpoints (`postManualAdjustment` + `reverseJournal`)
 * sit behind `AccessTokenGuard` so the `TenantContextInterceptor`
 * seeds a scoped frame from the access-token claims — no wrap needed.
 */
@Controller()
export class JournalsController {
  private readonly logger = new Logger(JournalsController.name);

  constructor(
    private readonly journals: JournalPostingService,
    @Inject(ENV_TOKEN) private readonly env: Env,
    @Inject(TENANT_CONTEXT_STORE_TOKEN)
    private readonly tenantStore: TenantContextStore,
  ) {}

  /**
   * Internal-only system-driven post. Called by the outbox relay
   * (synchronous HTTP scaffold pre-TS-142; relay subscription
   * post-TS-142). Shared-secret pinned.
   */
  @Post('api/v1/internal/journals')
  @HttpCode(HttpStatus.CREATED)
  @Idempotent()
  @UsePipes(new ZodValidationPipe(PostJournalRequestSchema))
  async postSystemJournal(
    @Body() body: PostJournalRequest,
    @Req() request: Request,
  ): Promise<JournalResponse> {
    return runWithoutTenantContext(this.tenantStore, 'internal-journals-post', async () => {
      this.requireInternalSharedSecret(request);
      const result = await this.journals.post(body, null);
      if (result.ok) {
        return result.value;
      }
      throw mapPostFailureToHttp(result.failure);
    });
  }

  /**
   * Admin manual adjustment. The kind is locked to
   * `manual_adjustment` at the contract layer; the reason code is
   * woven into the persisted journal's `context` jsonb column for
   * finance audit reporting.
   */
  @Post('api/v1/admin/journals/manual-adjustment')
  @HttpCode(HttpStatus.CREATED)
  @UseGuards(AccessTokenGuard)
  @Idempotent()
  @UsePipes(new ZodValidationPipe(ManualAdjustmentRequestSchema))
  async postManualAdjustment(
    @Body() body: ManualAdjustmentRequest,
    @Req() request: RequestWithContext,
  ): Promise<JournalResponse> {
    const actorId = requireActor(request);
    const result = await this.journals.postManualAdjustment(body, actorId);
    if (result.ok) {
      this.logger.warn(
        {
          journalId: result.value.id,
          actorId,
          reasonCode: body.reasonCode,
        },
        'journal.manual_adjustment.posted',
      );
      return result.value;
    }
    throw mapPostFailureToHttp(result.failure);
  }

  /**
   * Admin reversal. Creates a `kind = 'reversal'` journal whose
   * lines mirror the original's with debit↔credit swapped; the
   * original's `reversedByJournalId` back-pointer is set in the
   * same transaction (the only mutation accepted on a posted
   * journal — the mutation IS the audit record per CLAUDE.md §6).
   */
  @Post('api/v1/admin/journals/:journalId/reverse')
  @HttpCode(HttpStatus.CREATED)
  @UseGuards(AccessTokenGuard)
  @Idempotent()
  async reverseJournal(
    @Param('journalId') journalId: string,
    @Body(new ZodValidationPipe(ReverseJournalRequestSchema)) body: ReverseJournalRequest,
    @Req() request: RequestWithContext,
  ): Promise<JournalResponse> {
    const actorId = requireActor(request);
    const result = await this.journals.reverse(journalId, body, actorId);
    if (result.ok) {
      this.logger.warn(
        {
          reversalJournalId: result.value.id,
          originalJournalId: journalId,
          actorId,
          reasonCode: body.reasonCode,
        },
        'journal.reversal.posted',
      );
      return result.value;
    }
    throw mapReversalFailureToHttp(result.failure);
  }

  private requireInternalSharedSecret(request: Request): void {
    const presented = request.header(JOURNAL_INTERNAL_API_KEY_HEADER);
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

function mapPostFailureToHttp(failure: PostJournalFailure): never {
  switch (failure.kind) {
    case 'account_not_found':
      throw new NotFoundException({
        type: 'about:blank',
        title: 'Not Found',
        status: 404,
        detail: `Chart-of-accounts entry not found for code "${failure.accountCode}".`,
        failureReason: failure.kind,
        accountCode: failure.accountCode,
      });
    case 'account_inactive':
      throw new UnprocessableEntityException({
        type: 'about:blank',
        title: 'Unprocessable Entity',
        status: 422,
        detail: `Chart-of-accounts entry "${failure.accountCode}" is inactive and cannot accept new journal lines.`,
        failureReason: failure.kind,
        accountCode: failure.accountCode,
      });
    case 'journal_unbalanced':
      throw new UnprocessableEntityException({
        type: 'about:blank',
        title: 'Unprocessable Entity',
        status: 422,
        detail: 'Journal lines are unbalanced — sum of debits must equal sum of credits.',
        failureReason: failure.kind,
        debitTotalMinor: failure.debitTotalMinor,
        creditTotalMinor: failure.creditTotalMinor,
      });
    case 'mixed_currency':
      throw new UnprocessableEntityException({
        type: 'about:blank',
        title: 'Unprocessable Entity',
        status: 422,
        detail: 'Journal lines must share a single currency.',
        failureReason: failure.kind,
        currencies: failure.currencies,
      });
    case 'period_closed':
      throw new UnprocessableEntityException({
        type: 'about:blank',
        title: 'Unprocessable Entity',
        status: 422,
        detail: `Accounting period ${failure.periodName} is closed; posts require finance:adjust + explicit reopen.`,
        failureReason: failure.kind,
        periodId: failure.periodId,
        periodName: failure.periodName,
      });
  }
}

function mapReversalFailureToHttp(failure: ReverseJournalFailure | PostJournalFailure): never {
  switch (failure.kind) {
    case 'journal_not_found':
      throw new NotFoundException({
        type: 'about:blank',
        title: 'Not Found',
        status: 404,
        detail: 'Journal not found.',
        failureReason: failure.kind,
        journalId: failure.journalId,
      });
    case 'already_reversed':
      throw new ConflictException({
        type: 'about:blank',
        title: 'Conflict',
        status: 409,
        detail: 'Journal has already been reversed.',
        failureReason: failure.kind,
        journalId: failure.journalId,
        reversedByJournalId: failure.reversedByJournalId,
      });
    default:
      mapPostFailureToHttp(failure as PostJournalFailure);
  }
}

function isSharedSecretValid(presented: string | undefined, expected: string): boolean {
  if (presented === undefined) return false;
  const a = Buffer.from(presented, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
