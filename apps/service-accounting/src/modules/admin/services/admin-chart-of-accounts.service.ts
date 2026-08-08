import { Injectable, Logger } from '@nestjs/common';
import type {
  AccountCurrency,
  AccountNormalBalance,
  AccountType,
  AdminAccountActiveReason,
} from '@taste-and-see/contracts';

import { PrismaService } from '../../../prisma/prisma.service';

/**
 * Slim Prisma projection of the columns we need on the `set-active`
 * round-trip. Keeping the projection narrow defends against a future
 * schema column leaking onto the response (CLAUDE.md §3.3 — no raw
 * Prisma objects to clients) and makes the SQL `SELECT` cost stable.
 *
 * Mirrors `ACCOUNT_PUBLIC_SELECT` in `chart-of-accounts.service.ts`
 * one-to-one; the read-only public endpoint and the admin mutation
 * endpoint return the same shape.
 */
const ACCOUNT_ADMIN_SELECT = {
  id: true,
  code: true,
  name: true,
  description: true,
  type: true,
  parentId: true,
  normalBalance: true,
  currency: true,
  active: true,
  createdAt: true,
  updatedAt: true,
} as const;

/**
 * Slim Prisma projection of the columns we need to assert + emit a
 * before/after snapshot. The mutation path only flips `active`; the
 * snapshot shape is therefore just the `active` boolean. The wider
 * `ACCOUNT_ADMIN_SELECT` projection is used after the write to
 * project the full row onto the response.
 */
const ACCOUNT_BEFORE_SELECT = {
  id: true,
  active: true,
} as const;

/**
 * Service-layer Account row, mirroring the contract-side `AccountDto`.
 * The controller's mapper converts the Date columns to ISO-8601
 * strings; the service keeps the Postgres-shaped Dates so callers can
 * still inspect timestamps without a string-parse round-trip.
 */
export interface AdminAccountRow {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly description: string | null;
  readonly type: AccountType;
  readonly parentId: string | null;
  readonly normalBalance: AccountNormalBalance;
  readonly currency: AccountCurrency;
  readonly active: boolean;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface AdminAccountActiveStateRow {
  readonly active: boolean;
}

export interface AdminAccountSetActiveSuccess {
  readonly accountId: string;
  readonly before: AdminAccountActiveStateRow;
  readonly after: AdminAccountActiveStateRow;
  readonly account: AdminAccountRow;
  readonly performedAt: Date;
}

/**
 * Failure variants — Result-shape per CLAUDE.md §2.1. The service
 * does NOT throw HttpExceptions; the controller maps these into
 * RFC 7807 problem details (404 for `account_not_found`, 500 for the
 * narrow `unsupported_currency`) so the service stays HTTP-agnostic
 * and easy to unit-test.
 */
export type AdminAccountSetActiveFailure =
  | { readonly kind: 'account_not_found' }
  | { readonly kind: 'unsupported_currency'; readonly currency: string };

export type AdminAccountSetActiveResult =
  | { readonly ok: true; readonly value: AdminAccountSetActiveSuccess }
  | { readonly ok: false; readonly failure: AdminAccountSetActiveFailure };

export interface SetActiveInput {
  readonly accountId: string;
  readonly active: boolean;
  readonly reason: AdminAccountActiveReason;
  readonly note: string | null;
  readonly actorUserId: string;
  readonly now?: Date | undefined;
}

/**
 * Admin chart-of-accounts mutations service (TS-129-followup-1;
 * PRD §10.8; CLAUDE.md §6).
 *
 * Owns the single mutation that lives on the chart-of-accounts row:
 *
 *   - `setActive` — flip `chart_of_accounts.active`. Retire when
 *                   transitioning `true → false`; activate when
 *                   transitioning `false → true`.
 *
 * CLAUDE.md §6 explicitly forbids deleting a chart-of-accounts row —
 * historical journals point at it forever — so retirement is the
 * closest "delete" gesture available. Re-activation is the inverse.
 *
 * The action runs inside a `$transaction` that reads the current row,
 * captures the before snapshot, writes the new state, and re-reads
 * the projected row onto an `AdminAccountRow`. Toggling to the
 * current state is a no-op success (the write still runs so the
 * audit log records the action; observably the row's `updated_at`
 * advances but no business-meaningful state changes).
 *
 * **Audit pipe.** Slice 1 emits structured `logger.log` lines on
 * every transition as a forward-compat scaffold; the real
 * `service-audit` outbox event lands with TS-129-followup-3 once
 * TS-100 audit-svc is up. The log shape matches the eventual outbox
 * payload so the wire-up is mechanical.
 *
 * **Authorisation.** The controller layer enforces
 * `AccessTokenGuard` → `SuperAdminRoleGuard`. This service does NOT
 * re-check authority — it trusts the controller to have done so.
 *
 * **Idempotency.** The controller wraps the endpoint with
 * `@Idempotent()` so a retried admin click replays the cached
 * response. At the service layer, `setActive` is also naturally
 * idempotent at the business level — calling with the same `active`
 * value the row already carries is a no-op success.
 */
@Injectable()
export class AdminChartOfAccountsService {
  private readonly logger = new Logger(AdminChartOfAccountsService.name);

  constructor(private readonly prisma: PrismaService) {}

  async setActive(input: SetActiveInput): Promise<AdminAccountSetActiveResult> {
    const now = input.now ?? new Date();

    type TxClient = {
      chartOfAccount: PrismaService['chartOfAccount'];
    };

    const result = await this.prisma.$transaction(async (tx: TxClient) => {
      const existing = (await tx.chartOfAccount.findUnique({
        where: { id: input.accountId },
        select: ACCOUNT_BEFORE_SELECT,
      })) as { readonly id: string; readonly active: boolean } | null;

      if (existing === null) {
        return { kind: 'not_found' as const };
      }

      const before: AdminAccountActiveStateRow = { active: existing.active };

      const updated = (await tx.chartOfAccount.update({
        where: { id: input.accountId },
        data: { active: input.active },
        select: ACCOUNT_ADMIN_SELECT,
      })) as PrismaAccountUpdateProjection;

      const narrowed = this.narrow(updated);
      if (narrowed.kind === 'unsupported_currency') {
        return { kind: 'unsupported_currency' as const, currency: narrowed.currency };
      }

      const after: AdminAccountActiveStateRow = { active: updated.active };
      return {
        kind: 'ok' as const,
        before,
        after,
        account: narrowed.account,
        performedAt: now,
      };
    });

    if (result.kind === 'not_found') {
      return { ok: false, failure: { kind: 'account_not_found' } };
    }
    if (result.kind === 'unsupported_currency') {
      return {
        ok: false,
        failure: { kind: 'unsupported_currency', currency: result.currency },
      };
    }

    this.logger.log(
      {
        actorId: input.actorUserId,
        action: 'admin.accounts.set_active',
        targetAccountId: input.accountId,
        accountCode: result.account.code,
        before: result.before,
        after: result.after,
        reason: input.reason,
        note: input.note,
      },
      'admin chart-of-accounts action',
    );

    return {
      ok: true,
      value: {
        accountId: input.accountId,
        before: result.before,
        after: result.after,
        account: result.account,
        performedAt: result.performedAt,
      },
    };
  }

  /**
   * Narrow the DB-side `currency CHAR(3)` to the contract enum (USD
   * only in Phase 1). A row carrying a future currency surfaces a
   * clean failure here rather than silently passing through unsupported
   * wire shape; the contract layer's downstream `.parse()` would
   * reject anyway, so this is defence-in-depth.
   *
   * Mirrors `ChartOfAccountsService.narrowCurrency` so the read and
   * mutation paths stay aligned. Returns a discriminated union so the
   * caller can produce a 500 (the data is malformed, not the request).
   */
  private narrow(
    row: PrismaAccountUpdateProjection,
  ):
    | { readonly kind: 'ok'; readonly account: AdminAccountRow }
    | { readonly kind: 'unsupported_currency'; readonly currency: string } {
    if (row.currency !== 'USD') {
      return { kind: 'unsupported_currency', currency: row.currency };
    }
    return {
      kind: 'ok',
      account: {
        id: row.id,
        code: row.code,
        name: row.name,
        description: row.description,
        type: row.type,
        parentId: row.parentId,
        normalBalance: row.normalBalance,
        currency: 'USD',
        active: row.active,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
      },
    };
  }
}

/**
 * Raw projection shape returned by Prisma against `ACCOUNT_ADMIN_SELECT`.
 * Hoisted to module scope so the narrower in `setActive` has a single
 * shape to assert against. Mirrors the in-service `AccountProjection`
 * in `chart-of-accounts.service.ts` — kept duck-typed (rather than
 * imported from `@prisma/client`) for the same TS-021-followup-3 root
 * cause documented elsewhere.
 */
interface PrismaAccountUpdateProjection {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly description: string | null;
  readonly type: AccountType;
  readonly parentId: string | null;
  readonly normalBalance: AccountNormalBalance;
  readonly currency: string;
  readonly active: boolean;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}
