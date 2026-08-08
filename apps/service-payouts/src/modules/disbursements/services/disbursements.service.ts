import { Injectable, Logger } from '@nestjs/common';
import type { PayoutDisbursementStatus } from '@taste-and-see/contracts';

import { PrismaService, type PrismaTransactionClient } from '../../../prisma/prisma.service';
import { PayoutAccountsService } from '../../connect/services/payout-accounts.service';

import { StripeTransfersService } from './stripe-transfers.service';

/**
 * Service-layer view of a `payout_disbursements` row. The DB column is
 * `BIGINT amount_minor`; we narrow to `number` at the service boundary
 * because Phase 1 caps amounts at $1,000,000,000 (DISBURSEMENT_AMOUNT
 * _MINOR_MAX from the contract) which fits in a safe Number range.
 *
 * The contract layer enforces the cap; the service layer trusts it.
 * A future expansion past Number.MAX_SAFE_INTEGER would lift this to
 * a string-based representation.
 */
export interface DisbursementRecord {
  readonly id: string;
  readonly providerId: string;
  readonly stripeAccountId: string;
  readonly stripeTransferId: string | null;
  readonly currency: string;
  readonly amountMinor: number;
  readonly idempotencyKey: string;
  readonly sourceEventId: string;
  readonly scheduledFor: Date;
  readonly heldUntil: Date;
  readonly initiatedAt: Date | null;
  readonly paidAt: Date | null;
  readonly failedAt: Date | null;
  readonly failureReason: string | null;
  readonly memo: string | null;
  readonly status: PayoutDisbursementStatus;
  readonly liveMode: boolean;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface ScheduleDisbursementInput {
  readonly providerId: string;
  readonly amountMinor: number;
  readonly currency: string;
  readonly idempotencyKey: string;
  /** Defaults to `payout:disbursement:<id>` when omitted. */
  readonly sourceEventId?: string;
  readonly memo?: string;
  readonly scheduledFor: Date;
  /**
   * Calendar-day hold window. Used to compute `held_until = scheduled_for
   * (start of day UTC) + holdDays`. Defaults to env `PAYOUT_HOLD_DAYS`
   * via the scheduler; manual disbursements typically pass 0 here.
   */
  readonly holdDays: number;
  readonly liveMode?: boolean;
}

export type ScheduleDisbursementResult =
  | { readonly outcome: 'created'; readonly disbursement: DisbursementRecord }
  | { readonly outcome: 'existing'; readonly disbursement: DisbursementRecord }
  | { readonly outcome: 'account_not_found' }
  | { readonly outcome: 'account_not_active'; readonly status: string };

export interface ExecuteDisbursementResult {
  readonly disbursement: DisbursementRecord;
  readonly outcome: 'initiated' | 'already_initiated' | 'not_initiable';
}

export interface ApplyTransferEventInput {
  readonly stripeTransferId: string;
  readonly outcome: 'paid' | 'failed';
  readonly occurredAt: Date;
  readonly failureReason?: string;
}

export type ApplyTransferEventResult =
  | { readonly outcome: 'applied'; readonly disbursement: DisbursementRecord }
  | { readonly outcome: 'replayed'; readonly disbursement: DisbursementRecord }
  | { readonly outcome: 'ignored'; readonly disbursement: null };

export interface ListDisbursementsInput {
  readonly limit: number;
  readonly cursor?: string;
  readonly providerId?: string;
  readonly status?: PayoutDisbursementStatus;
  readonly scheduledOnOrAfter?: Date;
  readonly scheduledOnOrBefore?: Date;
}

export interface DisbursementsListResult {
  readonly rows: readonly DisbursementRecord[];
  readonly nextCursor: string | null;
}

/**
 * `DisbursementsService` — TS-091 receiver-side of the platform's
 * post-onboarding payouts surface.
 *
 * **Responsibilities.**
 *
 *   1. **Schedule** — `scheduleDisbursement(input)` creates a `pending`
 *      row idempotently keyed on `idempotencyKey`. The (provider,
 *      account-active, currency) gates are enforced here; the holdUntil
 *      timestamp is computed from `scheduledFor + holdDays`. A retry
 *      with the same `idempotencyKey` returns the existing row as
 *      `existing` (no mutation).
 *
 *   2. **Execute** — `executeDisbursement(disbursementId, asOf)` calls
 *      Stripe Transfer (or its stub) for a `pending` row whose hold
 *      window has cleared. Persists the resulting `stripe_transfer_id`
 *      and flips the row to `in_transit`. Idempotent on subsequent calls
 *      (an `in_transit`/`paid`/`failed` row returns `already_initiated`).
 *
 *   3. **Apply transfer event** — `applyTransferEvent(input)` flips the
 *      row to `paid` or `failed` based on the Stripe webhook outcome.
 *      Idempotent on the stripeTransferId-status combination: re-applying
 *      `paid` to an already-paid row is a no-op (`replayed`); applying
 *      `failed` to an unknown transfer id is `ignored`.
 *
 *   4. **Cancel** — `cancelDisbursement(id, reason)` flips a `pending`
 *      row to `canceled`. `in_transit` rows cannot be canceled locally
 *      (Stripe's transfer-cancellation API is the path forward, deferred
 *      to a follow-up).
 *
 * **Idempotency contract.**
 *
 *   - `idempotency_key` UNIQUE → schedule retries collapse here.
 *   - `source_event_id` UNIQUE → cross-service accounting postback
 *     dedup once TS-091-followup-3 lands.
 *   - `stripe_transfer_id` UNIQUE → transfer-event ingest cannot link a
 *     paid/failed event to two different disbursements.
 *
 * **Cross-service boundaries.** This service does NOT post to service-
 * accounting on disbursement success. That postback (DR Provider Payable
 * / CR Cash + balance decrement) lands as TS-091-followup-3 — captured
 * up-front so the integration point has a named owner. Today the
 * `paid` transition emits a log line tagged `[accounting-postback-pending]`.
 */
@Injectable()
export class DisbursementsService {
  private readonly logger = new Logger(DisbursementsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly accounts: PayoutAccountsService,
    private readonly transfers: StripeTransfersService,
  ) {}

  /**
   * Idempotently create a `pending` disbursement row.
   *
   * Pre-flight gates: payout account exists + status is `active` (or
   * overridden by operator path with explicit allowance — that surface
   * doesn't exist yet, so we return a typed result variant the caller
   * decides about).
   */
  async scheduleDisbursement(
    input: ScheduleDisbursementInput,
  ): Promise<ScheduleDisbursementResult> {
    // Idempotency lookup BEFORE the account check so a replayed call
    // doesn't surface "account not active" when the original create
    // succeeded.
    const existing = await this.prisma.payoutDisbursement.findUnique({
      where: { idempotencyKey: input.idempotencyKey },
    });
    if (existing !== null) {
      return { outcome: 'existing', disbursement: rowToRecord(existing) };
    }

    const account = await this.accounts.getByProvider(input.providerId);
    if (account === null) {
      return { outcome: 'account_not_found' };
    }
    if (account.status !== 'active') {
      return { outcome: 'account_not_active', status: account.status };
    }

    const heldUntil = computeHeldUntil(input.scheduledFor, input.holdDays);

    try {
      const row = await this.prisma.payoutDisbursement.create({
        data: {
          providerId: input.providerId,
          stripeAccountId: account.stripeAccountId,
          currency: input.currency,
          amountMinor: BigInt(input.amountMinor),
          idempotencyKey: input.idempotencyKey,
          // Default source-event-id includes the row's surrogate id; the
          // initial INSERT cannot reference its own id, so we generate
          // here via a two-step approach: insert with a placeholder,
          // then immediately update to the canonical form. To avoid the
          // double-trip, we accept the supplied sourceEventId or fall
          // back to a `payout:idempotency:<key>` form which is stable
          // and unique per scheduling intent.
          sourceEventId: input.sourceEventId ?? `payout:idempotency:${input.idempotencyKey}`,
          scheduledFor: stripTimeToCalendarDate(input.scheduledFor),
          heldUntil,
          memo: input.memo ?? null,
          status: 'pending',
          liveMode: input.liveMode ?? false,
        },
      });

      this.logger.log(
        `scheduled disbursement id=${row.id} providerId=${row.providerId} ` +
          `amountMinor=${row.amountMinor.toString()} currency=${row.currency} ` +
          `idempotencyKey=${row.idempotencyKey} heldUntil=${row.heldUntil.toISOString()}`,
      );

      return { outcome: 'created', disbursement: rowToRecord(row) };
    } catch (err) {
      // P2002 — concurrent create raced past the findUnique. The race
      // can hit on `idempotency_key` (returns the winner as `existing`)
      // OR on `source_event_id` (a third party already used the
      // sourceEventId we tried to mint — surface as a typed error;
      // caller can decide to retry with a different sourceEventId).
      if (isUniqueViolation(err)) {
        const winner = await this.prisma.payoutDisbursement.findUnique({
          where: { idempotencyKey: input.idempotencyKey },
        });
        if (winner !== null) {
          this.logger.warn(
            `concurrent-create race resolved idempotencyKey=${input.idempotencyKey} winner=${winner.id}`,
          );
          return { outcome: 'existing', disbursement: rowToRecord(winner) };
        }
      }
      throw err;
    }
  }

  /**
   * Stripe-Transfer-call a `pending` disbursement.
   *
   * Gates:
   *   - row must be `pending`. Other statuses return `already_initiated`
   *     (in_transit / paid / failed) or `not_initiable` (canceled).
   *   - now (`asOf`) must be ≥ heldUntil. Otherwise `not_initiable`.
   *
   * On success, the row flips to `in_transit` with the Stripe transfer
   * id persisted. The immutability trigger on the column makes the
   * assignment one-way: a subsequent execute call returns
   * `already_initiated` without re-attempting Stripe.
   */
  async executeDisbursement(args: {
    readonly disbursementId: string;
    readonly asOf: Date;
  }): Promise<ExecuteDisbursementResult | null> {
    const row = await this.prisma.payoutDisbursement.findUnique({
      where: { id: args.disbursementId },
    });
    if (row === null) return null;

    if (row.status !== 'pending') {
      if (row.status === 'canceled') {
        return { disbursement: rowToRecord(row), outcome: 'not_initiable' };
      }
      return { disbursement: rowToRecord(row), outcome: 'already_initiated' };
    }

    if (args.asOf.getTime() < row.heldUntil.getTime()) {
      return { disbursement: rowToRecord(row), outcome: 'not_initiable' };
    }

    const transfer = await this.transfers.createTransfer({
      disbursementId: row.id,
      destinationStripeAccountId: row.stripeAccountId,
      amountMinor: Number(row.amountMinor),
      currency: row.currency,
      transferGroup: `payout:${row.id}`,
      idempotencyKey: `tr:${row.id}`,
    });

    const initiatedAt = new Date();
    const updated = await this.prisma.payoutDisbursement.update({
      where: { id: row.id },
      data: {
        stripeTransferId: transfer.stripeTransferId,
        status: 'in_transit',
        initiatedAt,
        liveMode: transfer.liveMode,
      },
    });

    this.logger.log(
      `executed disbursement id=${updated.id} stripeTransferId=${transfer.stripeTransferId} ` +
        `liveMode=${transfer.liveMode}`,
    );

    return { disbursement: rowToRecord(updated), outcome: 'initiated' };
  }

  /**
   * Apply a Stripe transfer-event (paid/failed) to the disbursement row
   * keyed by `stripeTransferId`.
   *
   * - Unknown transfer id → `ignored` (the event targets a transfer
   *   this service didn't mint). Common during dev/CI when the operator
   *   replays a stale webhook.
   *
   * - Already-paid row receiving `paid` → `replayed`.
   * - Already-failed row receiving `failed` → `replayed`.
   * - `canceled` row receiving any event → `ignored` (the cancel was
   *   recorded locally but Stripe didn't know — operator audit issue).
   *
   * - `pending` row receiving `paid` → terminal flip (in_transit was
   *   skipped — possible if the operator manually marked paid OR if
   *   Stripe delivered events out of order). We allow this jump.
   *
   * - `pending` row receiving `failed` → flip directly to failed with
   *   the supplied failureReason.
   */
  async applyTransferEvent(input: ApplyTransferEventInput): Promise<ApplyTransferEventResult> {
    const row = await this.prisma.payoutDisbursement.findUnique({
      where: { stripeTransferId: input.stripeTransferId },
    });
    if (row === null) {
      this.logger.warn(
        `ignoring transfer event for unknown stripeTransferId=${input.stripeTransferId}`,
      );
      return { outcome: 'ignored', disbursement: null };
    }

    if (row.status === 'canceled') {
      this.logger.warn(
        `ignoring transfer event for canceled disbursement id=${row.id} stripeTransferId=${input.stripeTransferId}`,
      );
      return { outcome: 'ignored', disbursement: null };
    }

    if (input.outcome === 'paid' && row.status === 'paid') {
      return { outcome: 'replayed', disbursement: rowToRecord(row) };
    }
    if (input.outcome === 'failed' && row.status === 'failed') {
      return { outcome: 'replayed', disbursement: rowToRecord(row) };
    }

    if (input.outcome === 'paid') {
      const updated = await this.prisma.payoutDisbursement.update({
        where: { id: row.id },
        data: {
          status: 'paid',
          paidAt: input.occurredAt,
          // Backfill initiatedAt if it's still null (paid arrived before in_transit).
          initiatedAt: row.initiatedAt ?? input.occurredAt,
        },
      });
      this.logger.log(
        `[accounting-postback-pending] disbursement paid id=${updated.id} ` +
          `providerId=${updated.providerId} amountMinor=${updated.amountMinor.toString()} ` +
          `currency=${updated.currency} — TS-091-followup-3 (postback) not yet shipped`,
      );
      return { outcome: 'applied', disbursement: rowToRecord(updated) };
    }

    // outcome === 'failed'
    if (input.failureReason === undefined) {
      // The contract requires failureReason on failed events; this
      // guard catches direct callers that bypassed the contract pipe.
      throw new Error('failureReason is required when outcome is "failed"');
    }
    const updated = await this.prisma.payoutDisbursement.update({
      where: { id: row.id },
      data: {
        status: 'failed',
        failedAt: input.occurredAt,
        failureReason: input.failureReason,
        // Backfill initiatedAt if it's still null.
        initiatedAt: row.initiatedAt ?? input.occurredAt,
      },
    });
    this.logger.warn(
      `disbursement failed id=${updated.id} providerId=${updated.providerId} reason=${input.failureReason}`,
    );
    return { outcome: 'applied', disbursement: rowToRecord(updated) };
  }

  /**
   * Cancel a `pending` disbursement. Other statuses surface as `not_cancelable`.
   */
  async cancelDisbursement(args: {
    readonly disbursementId: string;
    readonly reason?: string;
  }): Promise<CancelResult | null> {
    const row = await this.prisma.payoutDisbursement.findUnique({
      where: { id: args.disbursementId },
    });
    if (row === null) return null;

    if (row.status === 'canceled') {
      return { outcome: 'idempotent_canceled', disbursement: rowToRecord(row) };
    }
    if (row.status !== 'pending') {
      return { outcome: 'not_cancelable', disbursement: rowToRecord(row) };
    }

    const updated = await this.prisma.payoutDisbursement.update({
      where: { id: row.id },
      data: {
        status: 'canceled',
        memo: args.reason ?? row.memo ?? null,
      },
    });
    return { outcome: 'canceled', disbursement: rowToRecord(updated) };
  }

  async getById(id: string): Promise<DisbursementRecord | null> {
    const row = await this.prisma.payoutDisbursement.findUnique({ where: { id } });
    return row === null ? null : rowToRecord(row);
  }

  async list(input: ListDisbursementsInput): Promise<DisbursementsListResult> {
    const where: Record<string, unknown> = {};
    if (input.providerId !== undefined) where['providerId'] = input.providerId;
    if (input.status !== undefined) where['status'] = input.status;
    if (input.scheduledOnOrAfter !== undefined || input.scheduledOnOrBefore !== undefined) {
      const range: Record<string, Date> = {};
      if (input.scheduledOnOrAfter !== undefined) range['gte'] = input.scheduledOnOrAfter;
      if (input.scheduledOnOrBefore !== undefined) range['lte'] = input.scheduledOnOrBefore;
      where['scheduledFor'] = range;
    }

    const findArgs: Record<string, unknown> = {
      where,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: input.limit + 1,
    };
    if (input.cursor !== undefined) {
      findArgs['cursor'] = { id: input.cursor };
      findArgs['skip'] = 1;
    }

    const rows = await this.prisma.payoutDisbursement.findMany(findArgs as never);
    const hasMore = rows.length > input.limit;
    const page = hasMore ? rows.slice(0, input.limit) : rows;
    const nextCursor = hasMore ? (page[page.length - 1]?.id ?? null) : null;

    return {
      rows: page.map(rowToRecord),
      nextCursor,
    };
  }

  /**
   * Internal helper exposed for the scheduler so it can perform the
   * (create + apply liveMode + execute) sequence in one transaction
   * when needed. Kept as a separate path so unit tests of the
   * scheduler can decouple the flow from the rest of the service.
   */
  async runInTransaction<T>(fn: (tx: PrismaTransactionClient) => Promise<T>): Promise<T> {
    return this.prisma.$transaction(fn);
  }
}

export type CancelResult =
  | { readonly outcome: 'canceled'; readonly disbursement: DisbursementRecord }
  | { readonly outcome: 'idempotent_canceled'; readonly disbursement: DisbursementRecord }
  | { readonly outcome: 'not_cancelable'; readonly disbursement: DisbursementRecord };

interface PayoutDisbursementRowShape {
  readonly id: string;
  readonly providerId: string;
  readonly stripeAccountId: string;
  readonly stripeTransferId: string | null;
  readonly currency: string;
  readonly amountMinor: bigint;
  readonly idempotencyKey: string;
  readonly sourceEventId: string;
  readonly scheduledFor: Date;
  readonly heldUntil: Date;
  readonly initiatedAt: Date | null;
  readonly paidAt: Date | null;
  readonly failedAt: Date | null;
  readonly failureReason: string | null;
  readonly memo: string | null;
  readonly status: PayoutDisbursementStatus;
  readonly liveMode: boolean;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

function rowToRecord(row: PayoutDisbursementRowShape): DisbursementRecord {
  return {
    id: row.id,
    providerId: row.providerId,
    stripeAccountId: row.stripeAccountId,
    stripeTransferId: row.stripeTransferId,
    currency: row.currency,
    amountMinor: Number(row.amountMinor),
    idempotencyKey: row.idempotencyKey,
    sourceEventId: row.sourceEventId,
    scheduledFor: row.scheduledFor,
    heldUntil: row.heldUntil,
    initiatedAt: row.initiatedAt,
    paidAt: row.paidAt,
    failedAt: row.failedAt,
    failureReason: row.failureReason,
    memo: row.memo,
    status: row.status,
    liveMode: row.liveMode,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * Strip the time-of-day from a scheduling date so the DB column
 * (`DATE`) and the contract layer's `YYYY-MM-DD` strings stay aligned.
 *
 * UTC interpretation — Phase 1 single-region; Phase 3 multi-region
 * needs a tenant-aware time zone.
 */
function stripTimeToCalendarDate(date: Date): Date {
  return new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), 0, 0, 0, 0),
  );
}

/**
 * Compute the wall-clock cut-off when the disbursement may first be
 * initiated. The cut-off is `scheduled_for + holdDays` interpreted in
 * UTC. holdDays=0 means the disbursement is initiable the moment the
 * row is created (manual ops makegood path).
 */
function computeHeldUntil(scheduledFor: Date, holdDays: number): Date {
  const base = stripTimeToCalendarDate(scheduledFor);
  const oneDayMs = 24 * 60 * 60 * 1000;
  return new Date(base.getTime() + holdDays * oneDayMs);
}

function isUniqueViolation(err: unknown): boolean {
  if (err === null || typeof err !== 'object') return false;
  const r = err as Record<string, unknown>;
  return r['code'] === 'P2002';
}

export const __testing = { computeHeldUntil, stripTimeToCalendarDate, isUniqueViolation };
