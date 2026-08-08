import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  SUBSCRIPTION_DUNNING_EXHAUSTED,
  SUBSCRIPTION_PAUSED,
  SUBSCRIPTION_PAYMENT_FAILED,
  SUBSCRIPTION_PAYMENT_SUCCEEDED,
  SUBSCRIPTION_RESUMED,
} from '@taste-and-see/contracts';
import type {
  BillingInterval,
  PlanCustomerGroup,
  SubscriptionCancelReason,
  SubscriptionResponse,
  SubscriptionStatus,
} from '@taste-and-see/contracts';
import { OutboxService, type OutboxRawExecutor } from '@taste-and-see/nest-outbox';
import { withSpan } from '@taste-and-see/tracing';
import Decimal from 'decimal.js';
import type Stripe from 'stripe';

import { ENV_TOKEN } from '../../../config/config.module';
import type { Env } from '../../../config/env';
import { PrismaService, type PrismaTransactionClient } from '../../../prisma/prisma.service';
import { STRIPE_SDK_TOKEN } from '../../stripe/stripe.constants';
import { mapStripeStatus } from '../mappers/stripe-status.mapper';
import { toSubscriptionResponse, type SubscriptionDtoSource } from '../mappers/subscription.mapper';
import { err, ok, type Result } from '../result';
import { DunningMetrics, type DunningOutcome, dunningFailureOutcome } from './dunning-metrics';

/**
 * Failure shapes returned by the DunningService. Same Result-shape
 * discipline as SubscriptionsService — every cross-boundary failure
 * (Stripe, DB, validation) is explicit (CLAUDE.md §2.1).
 */
export type DunningFailure =
  | { readonly reason: 'subscription_not_found'; readonly subscriptionId: string }
  | {
      readonly reason: 'invalid_state';
      readonly subscriptionId: string;
      readonly currentStatus: SubscriptionStatus;
      readonly expected: readonly SubscriptionStatus[];
    }
  | {
      readonly reason: 'grace_not_expired';
      readonly subscriptionId: string;
      readonly graceUntil: Date;
    }
  | { readonly reason: 'invalid_request'; readonly message: string }
  | { readonly reason: 'stripe_unavailable'; readonly cause: unknown }
  /**
   * TS-042-followup-3 — the outbox SDK rejected the lifecycle event payload
   * against its registry schema, so the surrounding transaction was rolled
   * back. Mirrors `SubscriptionsService`'s `outbox_validation_failed`: a
   * state change nobody can be told about is not a state change we keep
   * (CLAUDE.md §5.3).
   */
  | {
      readonly reason: 'outbox_validation_failed';
      readonly eventName: string;
      readonly message: string;
    };

/** Inputs shared by every dunning entry point. */
export interface RecordPaymentFailureInput {
  readonly subscriptionId: string;
  /**
   * Stripe `event.id` (or other source identifier) for the failure. Used
   * as the audit-history `source` so a downstream replay against the same
   * event_id is traceable.
   *
   * The service also deduplicates locally: a call whose `attemptedAt`
   * already matches the row's `dunning_last_attempt_at` (and whose
   * `dunning_attempts` is non-zero) returns the current row untouched.
   * That is a belt-and-braces guard against double-counting — the outbox
   * `event_id` PK stops a duplicate EVENT, but it does so silently and
   * only after this row has already been incremented (TS-042-followup-3c).
   */
  readonly sourceEventId: string;
  /** Wall-clock instant of the Stripe failure event. Defaults to `now()`. */
  readonly attemptedAt?: Date;
  /** Actor that initiated the record (defaults to `system`). */
  readonly actorKind?: 'system' | 'admin';
  readonly actorUserId?: string;
}

export interface RecordPaymentSuccessInput {
  readonly subscriptionId: string;
  readonly sourceEventId: string;
  readonly succeededAt?: Date;
  readonly actorKind?: 'system' | 'admin';
  readonly actorUserId?: string;
}

export interface ApplyDunningExhaustionInput {
  readonly subscriptionId: string;
  readonly sourceEventId: string;
  /** Wall-clock instant to compare against `dunningGraceUntil`. Defaults to `now()`. */
  readonly now?: Date;
}

export interface PauseSubscriptionInput {
  readonly subscriptionId: string;
  readonly requesterUserId: string;
  /** Optional ISO instant Stripe should auto-resume at. */
  readonly resumesAt?: Date;
  readonly reason?: string;
  readonly idempotencyKey?: string;
}

export interface ResumeSubscriptionInput {
  readonly subscriptionId: string;
  readonly requesterUserId: string;
  readonly note?: string;
  readonly idempotencyKey?: string;
}

/**
 * Internal return of `runRecordPaymentSuccess` — the public DTO plus the
 * `recovered` flag the metric layer needs (a payment that rescued a
 * `past_due` / `unpaid` subscription vs a routine renewal). The public
 * `recordPaymentSuccess` projects this back to a plain
 * `Result<SubscriptionResponse, DunningFailure>` so callers are unaffected.
 */
interface RecordPaymentSuccessOutcome {
  readonly response: SubscriptionResponse;
  readonly recovered: boolean;
}

/**
 * Slim Plan projection the DTO mapper needs — identical to the
 * SubscriptionsService's `PlanRowSlice`, hoisted here to keep the service
 * file self-contained.
 */
interface PlanRowSlice {
  readonly id: string;
  readonly code: string;
  readonly currency: string;
  readonly monthlyPrice: Decimal;
  readonly annualPrice: Decimal;
}

/**
 * `DunningService` — TS-042 dunning + grace + pause/resume.
 *
 * Five surfaces:
 *
 *   1. `recordPaymentFailure({subscriptionId, sourceEventId, attemptedAt})`
 *      Transitions the subscription into `past_due`, increments
 *      `dunningAttempts`, sets `dunningLastAttemptAt`, and stamps
 *      `dunningGraceUntil = firstFailureAt + DUNNING_GRACE_DAYS` ONLY on
 *      the first failure of a cycle (so the grace window is absolute,
 *      not retry-relative). Writes a `status_changed` history row.
 *      Designed to be driven by the future TS-041b-followup-3 webhook
 *      handler for `invoice.payment_failed`; safe to call repeatedly
 *      (replays land on the same row with monotonic attempt count).
 *
 *   2. `recordPaymentSuccess({subscriptionId, sourceEventId})`
 *      Resets all dunning counters to zero, transitions the row back to
 *      `active` (or `trialing` if still within trial). Writes a
 *      `reactivated` history row if the prior status was `past_due` /
 *      `unpaid`, otherwise `status_changed`.
 *
 *   3. `applyDunningExhaustion({subscriptionId, now})`
 *      Sweeper entry point. If `status = 'past_due'` AND
 *      `dunningGraceUntil < now`, transitions to `unpaid` and writes a
 *      `status_changed` history row. Does NOT auto-cancel — the cancel
 *      decision lives with TS-127 admin tooling or a sibling auto-cancel
 *      worker (captured as TS-042-followup-3).
 *
 *   4. `pauseSubscription({subscriptionId, requesterUserId, resumesAt?, reason?})`
 *      Calls Stripe `subscriptions.update({pause_collection: {behavior:
 *      'void', resumes_at?}})`, transitions our row to `paused`, sets
 *      `pauseCollectionStartedAt`/`pauseCollectionResumesAt`/`pauseReason`.
 *      Writes a `paused` history row.
 *
 *   5. `resumeSubscription({subscriptionId, requesterUserId, note?})`
 *      Clears Stripe's `pause_collection` (empty string per Stripe's
 *      `Emptyable<T>` convention), transitions our row back to whatever
 *      status Stripe reports (typically `active` or `trialing`), clears
 *      the three pause columns. Writes a `resumed` history row.
 *
 * **Money math** — none here; this service never touches a price field.
 *
 * **Idempotency** — pause/resume forward the optional `idempotencyKey` to
 * Stripe with `:pause` / `:resume` phase suffixes so a retry de-dups
 * within Stripe's 24h window. The local replay cache (the @Idempotent
 * interceptor) wraps the controller-side surface.
 *
 * **Authorization** — same posture as SubscriptionsService: the
 * AccessTokenGuard at the controller boundary enforces authentication;
 * row-level authorization (a family-payer can only pause their own
 * household's subscription; ops staff need the `subscription:pause`
 * permission) arrives with TS-141 tenant scoping + TS-052-followup-11's
 * shared PermissionGuard lift to `packages/nest-auth`.
 *
 * **Observability (TS-042-followup-8; CLAUDE.md §10).** All five surfaces
 * run inside an OTel logical span (`dunning.record_payment_failure` /
 * `dunning.record_payment_success` / `dunning.apply_exhaustion` /
 * `dunning.pause` / `dunning.resume`) so each operation shows up as a named
 * parent in traces, with the auto-instrumented Stripe SDK call (HTTP, on
 * pause/resume) and the Prisma writes (pg) stitched on as child spans. Six
 * Prometheus instruments ride on the service `/metrics` endpoint via
 * {@link DunningMetrics}: a counter per surface
 * (`dunning_payment_failure_total{outcome}`,
 * `dunning_payment_success_total{outcome,recovered}`,
 * `dunning_exhaustion_total{outcome}`, `dunning_pause_total{outcome}`,
 * `dunning_resume_total{outcome}`) plus the shared
 * `dunning_operation_duration_seconds{operation,outcome}` latency
 * histogram. Each public method delegates its body to a private `run*`
 * method and records outcome + latency in a `finally`; the outcome defaults
 * to `error` so an unexpected throw still lands a bounded sample rather
 * than leaving the metric silent. Labels are bounded string-literal unions
 * — never a subscription id, customer id, or Stripe id.
 */
@Injectable()
export class DunningService {
  private readonly logger = new Logger(DunningService.name);
  private readonly graceDays: number;

  constructor(
    private readonly prisma: PrismaService,
    @Inject(STRIPE_SDK_TOKEN) private readonly stripe: Stripe,
    @Inject(ENV_TOKEN) env: Env,
    /**
     * TS-042-followup-3 — producer-side outbox SDK. Every dunning lifecycle
     * event is appended inside the same Prisma transaction as the status
     * write (the outbox invariant, PDD §7.3 / CLAUDE.md §5.3). Provided by
     * the global `OutboxModule` wired in `app.module.ts`.
     *
     * Required (not optional like `metrics` below) on purpose: an optional
     * outbox would let a call site silently construct a DunningService that
     * changes billing state and tells nobody, which is the exact defect this
     * task exists to close.
     */
    private readonly outbox: OutboxService,
    // Optional so direct `new DunningService(...)` unit-test call sites keep
    // working; in the Nest DI graph the registered `DunningMetrics` provider
    // is injected. Instruments are no-ops until `initMetrics` runs, so the
    // default instance is harmless in tests (KycMetrics / WebhookMetrics
    // precedent).
    private readonly metrics: DunningMetrics = new DunningMetrics(),
  ) {
    this.graceDays = env.DUNNING_GRACE_DAYS;
  }

  /**
   * Run `body` in a Prisma transaction, translating an outbox validation
   * failure raised inside it into the typed `outbox_validation_failed`
   * result. Extracted because all five dunning surfaces need byte-identical
   * handling and a copy that forgot the `instanceof` check would surface a
   * contract error as an unhandled 500.
   *
   * The throw is what rolls the transaction back — returning an `err` from
   * inside the callback would commit the status change and drop the event.
   */
  private async transactionWithOutbox<T>(
    operation: string,
    body: (tx: PrismaTransactionClient) => Promise<T>,
  ): Promise<Result<T, DunningFailure>> {
    try {
      return ok(await this.prisma.$transaction(body));
    } catch (e) {
      if (e instanceof OutboxValidationFailedError) {
        this.logger.error(
          { eventName: e.eventName, issues: e.issues, operation },
          `dunning.${operation} outbox validation failed; tx rolled back`,
        );
        return err({
          reason: 'outbox_validation_failed',
          eventName: e.eventName,
          message: `event ${e.eventName} payload failed validation`,
        });
      }
      throw e;
    }
  }

  // ─────────────────────────────────────────────────────────────────────
  // recordPaymentFailure
  // ─────────────────────────────────────────────────────────────────────

  async recordPaymentFailure(
    input: RecordPaymentFailureInput,
  ): Promise<Result<SubscriptionResponse, DunningFailure>> {
    return withSpan('dunning.record_payment_failure', async (span) => {
      const startNs = process.hrtime.bigint();
      let outcome: DunningOutcome = 'error';
      try {
        const result = await this.runRecordPaymentFailure(input);
        outcome = result.ok ? 'ok' : dunningFailureOutcome(result.error);
        return result;
      } finally {
        span.setAttribute('dunning.outcome', outcome);
        this.metrics.recordPaymentFailure(outcome, elapsedSeconds(startNs));
      }
    });
  }

  private async runRecordPaymentFailure(
    input: RecordPaymentFailureInput,
  ): Promise<Result<SubscriptionResponse, DunningFailure>> {
    if (input.subscriptionId.trim().length === 0) {
      return err({ reason: 'invalid_request', message: 'subscriptionId is required' });
    }
    if (input.sourceEventId.trim().length === 0) {
      return err({ reason: 'invalid_request', message: 'sourceEventId is required' });
    }

    const existing = await this.prisma.subscription.findUnique({
      where: { id: input.subscriptionId },
      include: { plan: true },
    });
    if (existing === null) {
      return err({ reason: 'subscription_not_found', subscriptionId: input.subscriptionId });
    }

    const allowedStates: readonly SubscriptionStatus[] = [
      'active',
      'trialing',
      'past_due',
      'paused',
    ];
    if (!allowedStates.includes(existing.status as SubscriptionStatus)) {
      return err({
        reason: 'invalid_state',
        subscriptionId: existing.id,
        currentStatus: existing.status as SubscriptionStatus,
        expected: allowedStates,
      });
    }

    const attemptedAt = input.attemptedAt ?? new Date();

    // TS-042-followup-3c — the local double-count guard this input's
    // doc-comment has always promised and never had.
    //
    // **What was actually unguarded.** The outbox's `event_id` PK does
    // swallow a re-emitted `subscription.payment_failed`, so a redelivery
    // never reaches the ladder twice — but `OutboxService.append` swallows
    // it *silently* and still returns `appended`, and by then this method
    // has already incremented `dunningAttempts` and written a second
    // history row. The count is what selects the ladder's rung
    // (TS-042-followup-3a3), so an inflated one walks a family to a
    // harsher email a rung early, and the NEXT genuine failure carries the
    // inflated number out on the event. The grace window itself survives
    // (`isFirstFailureInCycle` is already false on a replay), which is why
    // this stayed invisible.
    //
    // **Why the attempt instant is the key.** `attemptedAt` comes from the
    // Stripe event's own clock (TS-042-followup-4 — that IS the dedup
    // key), so a redelivery of one attempt carries an instant identical to
    // the one already on the row. Two DISTINCT failures for one
    // subscription inside the same second is not a thing Stripe's retry
    // schedule produces, and if it ever were, collapsing them is the
    // benign direction: one payment-problem moment, counted once.
    //
    // `dunningAttempts > 0` is required as well so the guard can only fire
    // on a row that has actually recorded a failure — never on a first
    // call whose `dunningLastAttemptAt` happens to be set by other means.
    if (
      existing.dunningAttempts > 0 &&
      existing.dunningLastAttemptAt !== null &&
      existing.dunningLastAttemptAt.getTime() === attemptedAt.getTime()
    ) {
      this.logger.log(
        {
          subscriptionId: existing.id,
          sourceEventId: input.sourceEventId,
          attempts: existing.dunningAttempts,
          attemptedAt: attemptedAt.toISOString(),
        },
        'dunning.recordPaymentFailure replay',
      );
      return ok(toSubscriptionResponse(toDtoSource(existing, existing.plan as PlanRowSlice)));
    }

    const isFirstFailureInCycle =
      existing.dunningAttempts === 0 || existing.dunningGraceUntil === null;
    const nextGraceUntil = isFirstFailureInCycle
      ? addDays(attemptedAt, this.graceDays)
      : existing.dunningGraceUntil;
    const nextAttempts = existing.dunningAttempts + 1;
    const fromStatus = existing.status as SubscriptionStatus;
    const toStatus: SubscriptionStatus = 'past_due';

    const persistedResult = await this.transactionWithOutbox(
      'recordPaymentFailure',
      async (tx: PrismaTransactionClient) => {
        const next = await tx.subscription.update({
          where: { id: existing.id },
          data: {
            status: toStatus,
            dunningAttempts: nextAttempts,
            dunningLastAttemptAt: attemptedAt,
            dunningGraceUntil: nextGraceUntil,
          },
        });

        await tx.subscriptionHistory.create({
          data: {
            subscriptionId: next.id,
            event: 'status_changed',
            fromStatus,
            toStatus,
            context: {
              kind: 'payment_failure',
              attemptedAt: attemptedAt.toISOString(),
              attempts: nextAttempts,
              graceUntil: nextGraceUntil?.toISOString() ?? null,
            },
            actorUserId: input.actorUserId ?? null,
            actorKind: input.actorKind ?? 'system',
            source: input.sourceEventId,
          },
        });

        // TS-042-followup-3 — `subscription.payment_failed`, in-transaction.
        //
        // The event id is keyed to the SOURCE event, not the subscription: a
        // subscription legitimately fails payment many times (that is what
        // `attemptCount` counts), so a subscription-scoped id would collapse
        // every attempt after the first onto the outbox's `event_id` PK and
        // the dunning ladder would emit exactly one rung. Keying on
        // `sourceEventId` keeps distinct Stripe attempts distinct while a
        // redelivery of the SAME attempt still collapses — the domain-level
        // guard behind the consumer SDK's dedup table.
        const eventId = `${next.id}.payment_failed.${input.sourceEventId}`;
        const appended = await this.outbox.append(tx as unknown as OutboxRawExecutor, {
          eventName: SUBSCRIPTION_PAYMENT_FAILED,
          eventId,
          occurredAt: attemptedAt,
          payload: {
            eventId,
            occurredAt: attemptedAt.toISOString(),
            subscriptionId: next.id,
            customerId: next.customerId,
            customerGroup: next.customerGroup,
            attemptCount: nextAttempts,
            attemptedAt: attemptedAt.toISOString(),
            graceUntil: nextGraceUntil?.toISOString() ?? null,
            fromStatus,
          },
        });
        if (appended.kind !== 'appended') {
          throw new OutboxValidationFailedError(appended.eventName, appended.issues);
        }

        return next;
      },
    );
    if (!persistedResult.ok) {
      return err(persistedResult.error);
    }
    const persisted = persistedResult.value;

    this.logger.warn(
      {
        subscriptionId: persisted.id,
        attempts: nextAttempts,
        graceUntil: nextGraceUntil?.toISOString() ?? null,
      },
      'dunning.recordPaymentFailure ok',
    );

    return ok(toSubscriptionResponse(toDtoSource(persisted, existing.plan as PlanRowSlice)));
  }

  // ─────────────────────────────────────────────────────────────────────
  // recordPaymentSuccess
  // ─────────────────────────────────────────────────────────────────────

  async recordPaymentSuccess(
    input: RecordPaymentSuccessInput,
  ): Promise<Result<SubscriptionResponse, DunningFailure>> {
    return withSpan('dunning.record_payment_success', async (span) => {
      const startNs = process.hrtime.bigint();
      let outcome: DunningOutcome = 'error';
      let recovered = false;
      try {
        const result = await this.runRecordPaymentSuccess(input);
        if (result.ok) {
          outcome = 'ok';
          recovered = result.value.recovered;
          return ok(result.value.response);
        }
        outcome = dunningFailureOutcome(result.error);
        return err(result.error);
      } finally {
        span.setAttribute('dunning.outcome', outcome);
        span.setAttribute('dunning.recovered', recovered);
        this.metrics.recordPaymentSuccess(outcome, recovered, elapsedSeconds(startNs));
      }
    });
  }

  private async runRecordPaymentSuccess(
    input: RecordPaymentSuccessInput,
  ): Promise<Result<RecordPaymentSuccessOutcome, DunningFailure>> {
    if (input.subscriptionId.trim().length === 0) {
      return err({ reason: 'invalid_request', message: 'subscriptionId is required' });
    }
    if (input.sourceEventId.trim().length === 0) {
      return err({ reason: 'invalid_request', message: 'sourceEventId is required' });
    }

    const existing = await this.prisma.subscription.findUnique({
      where: { id: input.subscriptionId },
      include: { plan: true },
    });
    if (existing === null) {
      return err({ reason: 'subscription_not_found', subscriptionId: input.subscriptionId });
    }

    const allowedStates: readonly SubscriptionStatus[] = [
      'active',
      'trialing',
      'past_due',
      'unpaid',
      'paused',
      'incomplete',
    ];
    if (!allowedStates.includes(existing.status as SubscriptionStatus)) {
      return err({
        reason: 'invalid_state',
        subscriptionId: existing.id,
        currentStatus: existing.status as SubscriptionStatus,
        expected: allowedStates,
      });
    }

    const succeededAt = input.succeededAt ?? new Date();
    const fromStatus = existing.status as SubscriptionStatus;
    // Land on `trialing` if still inside trial window, else `active`.
    const toStatus: SubscriptionStatus =
      existing.trialEnd !== null && existing.trialEnd > succeededAt ? 'trialing' : 'active';
    const isRecovery: boolean = fromStatus === 'past_due' || fromStatus === 'unpaid';

    const persistedResult = await this.transactionWithOutbox(
      'recordPaymentSuccess',
      async (tx: PrismaTransactionClient) => {
        const next = await tx.subscription.update({
          where: { id: existing.id },
          data: {
            status: toStatus,
            dunningAttempts: 0,
            dunningLastAttemptAt: null,
            dunningGraceUntil: null,
          },
        });

        await tx.subscriptionHistory.create({
          data: {
            subscriptionId: next.id,
            event: isRecovery ? 'reactivated' : 'status_changed',
            fromStatus,
            toStatus,
            context: {
              kind: 'payment_success',
              succeededAt: succeededAt.toISOString(),
              recovered: isRecovery,
            },
            actorUserId: input.actorUserId ?? null,
            actorKind: input.actorKind ?? 'system',
            source: input.sourceEventId,
          },
        });

        // TS-042-followup-3 — `subscription.payment_succeeded`, in-transaction.
        // Source-keyed for the same reason as the failure event: a renewal
        // succeeds every billing period.
        //
        // `attemptsCleared` is read from `existing`, not `next` — `next` has
        // already been zeroed by the update above, so reading it there would
        // report every recovery as clearing nothing.
        const eventId = `${next.id}.payment_succeeded.${input.sourceEventId}`;
        const appended = await this.outbox.append(tx as unknown as OutboxRawExecutor, {
          eventName: SUBSCRIPTION_PAYMENT_SUCCEEDED,
          eventId,
          occurredAt: succeededAt,
          payload: {
            eventId,
            occurredAt: succeededAt.toISOString(),
            subscriptionId: next.id,
            customerId: next.customerId,
            customerGroup: next.customerGroup,
            succeededAt: succeededAt.toISOString(),
            recovered: isRecovery,
            fromStatus,
            toStatus,
            attemptsCleared: existing.dunningAttempts,
          },
        });
        if (appended.kind !== 'appended') {
          throw new OutboxValidationFailedError(appended.eventName, appended.issues);
        }

        return next;
      },
    );
    if (!persistedResult.ok) {
      return err(persistedResult.error);
    }
    const persisted = persistedResult.value;

    this.logger.log(
      {
        subscriptionId: persisted.id,
        fromStatus,
        toStatus,
        recovered: isRecovery,
      },
      'dunning.recordPaymentSuccess ok',
    );

    return ok({
      response: toSubscriptionResponse(toDtoSource(persisted, existing.plan as PlanRowSlice)),
      recovered: isRecovery,
    });
  }

  // ─────────────────────────────────────────────────────────────────────
  // applyDunningExhaustion
  // ─────────────────────────────────────────────────────────────────────

  async applyDunningExhaustion(
    input: ApplyDunningExhaustionInput,
  ): Promise<Result<SubscriptionResponse, DunningFailure>> {
    return withSpan('dunning.apply_exhaustion', async (span) => {
      const startNs = process.hrtime.bigint();
      let outcome: DunningOutcome = 'error';
      try {
        const result = await this.runApplyDunningExhaustion(input);
        outcome = result.ok ? 'ok' : dunningFailureOutcome(result.error);
        return result;
      } finally {
        span.setAttribute('dunning.outcome', outcome);
        this.metrics.recordExhaustion(outcome, elapsedSeconds(startNs));
      }
    });
  }

  private async runApplyDunningExhaustion(
    input: ApplyDunningExhaustionInput,
  ): Promise<Result<SubscriptionResponse, DunningFailure>> {
    if (input.subscriptionId.trim().length === 0) {
      return err({ reason: 'invalid_request', message: 'subscriptionId is required' });
    }
    if (input.sourceEventId.trim().length === 0) {
      return err({ reason: 'invalid_request', message: 'sourceEventId is required' });
    }

    const existing = await this.prisma.subscription.findUnique({
      where: { id: input.subscriptionId },
      include: { plan: true },
    });
    if (existing === null) {
      return err({ reason: 'subscription_not_found', subscriptionId: input.subscriptionId });
    }

    if (existing.status !== 'past_due') {
      return err({
        reason: 'invalid_state',
        subscriptionId: existing.id,
        currentStatus: existing.status as SubscriptionStatus,
        expected: ['past_due'],
      });
    }

    if (existing.dunningGraceUntil === null) {
      return err({
        reason: 'invalid_request',
        message: 'subscription is past_due but has no dunningGraceUntil — record a failure first',
      });
    }

    // Hoisted out of `existing` so the non-null narrowing established by
    // the guard above survives into the `$transaction` callback below.
    // Property narrowing on a mutable object field is discarded at a
    // function boundary, so `existing.dunningGraceUntil` reads as
    // `Date | null` again inside the closure.
    const graceUntil: Date = existing.dunningGraceUntil;

    const now = input.now ?? new Date();
    if (graceUntil > now) {
      return err({
        reason: 'grace_not_expired',
        subscriptionId: existing.id,
        graceUntil,
      });
    }

    const fromStatus: SubscriptionStatus = 'past_due';
    const toStatus: SubscriptionStatus = 'unpaid';

    const persistedResult = await this.transactionWithOutbox(
      'applyDunningExhaustion',
      async (tx: PrismaTransactionClient) => {
        const next = await tx.subscription.update({
          where: { id: existing.id },
          data: {
            status: toStatus,
          },
        });

        await tx.subscriptionHistory.create({
          data: {
            subscriptionId: next.id,
            event: 'status_changed',
            fromStatus,
            toStatus,
            context: {
              kind: 'dunning_exhausted',
              attempts: existing.dunningAttempts,
              graceUntil: graceUntil.toISOString(),
              appliedAt: now.toISOString(),
            },
            actorUserId: null,
            actorKind: 'system',
            source: input.sourceEventId,
          },
        });

        // TS-042-followup-3 — `subscription.dunning_exhausted`, in-transaction.
        //
        // Keyed on the SUBSCRIPTION, not the source event, unlike the two
        // payment events above. Exhaustion happens at most once per dunning
        // cycle by construction (the guard above requires `past_due`, and
        // this transaction leaves the row `unpaid`), and the caller is the
        // hourly sweep — which passes a per-tick source id, so a source-keyed
        // event id would emit a fresh event on every tick if the status guard
        // were ever loosened. Subscription-keyed makes the once-per-cycle
        // property hold in the outbox itself.
        const eventId = `${next.id}.dunning_exhausted`;
        const appended = await this.outbox.append(tx as unknown as OutboxRawExecutor, {
          eventName: SUBSCRIPTION_DUNNING_EXHAUSTED,
          eventId,
          occurredAt: now,
          payload: {
            eventId,
            occurredAt: now.toISOString(),
            subscriptionId: next.id,
            customerId: next.customerId,
            customerGroup: next.customerGroup,
            exhaustedAt: now.toISOString(),
            graceUntil: graceUntil.toISOString(),
            attemptCount: existing.dunningAttempts,
          },
        });
        if (appended.kind !== 'appended') {
          throw new OutboxValidationFailedError(appended.eventName, appended.issues);
        }

        return next;
      },
    );
    if (!persistedResult.ok) {
      return err(persistedResult.error);
    }
    const persisted = persistedResult.value;

    this.logger.warn(
      {
        subscriptionId: persisted.id,
        attempts: existing.dunningAttempts,
      },
      'dunning.applyDunningExhaustion ok',
    );

    return ok(toSubscriptionResponse(toDtoSource(persisted, existing.plan as PlanRowSlice)));
  }

  // ─────────────────────────────────────────────────────────────────────
  // pauseSubscription
  // ─────────────────────────────────────────────────────────────────────

  async pauseSubscription(
    input: PauseSubscriptionInput,
  ): Promise<Result<SubscriptionResponse, DunningFailure>> {
    return withSpan('dunning.pause', async (span) => {
      const startNs = process.hrtime.bigint();
      let outcome: DunningOutcome = 'error';
      try {
        const result = await this.runPauseSubscription(input);
        outcome = result.ok ? 'ok' : dunningFailureOutcome(result.error);
        return result;
      } finally {
        span.setAttribute('dunning.outcome', outcome);
        this.metrics.recordPause(outcome, elapsedSeconds(startNs));
      }
    });
  }

  private async runPauseSubscription(
    input: PauseSubscriptionInput,
  ): Promise<Result<SubscriptionResponse, DunningFailure>> {
    if (input.subscriptionId.trim().length === 0) {
      return err({ reason: 'invalid_request', message: 'subscriptionId is required' });
    }
    if (input.requesterUserId.trim().length === 0) {
      return err({ reason: 'invalid_request', message: 'requesterUserId is required' });
    }

    const existing = await this.prisma.subscription.findUnique({
      where: { id: input.subscriptionId },
      include: { plan: true },
    });
    if (existing === null) {
      return err({ reason: 'subscription_not_found', subscriptionId: input.subscriptionId });
    }

    const allowedStates: readonly SubscriptionStatus[] = ['active', 'trialing', 'past_due'];
    if (!allowedStates.includes(existing.status as SubscriptionStatus)) {
      return err({
        reason: 'invalid_state',
        subscriptionId: existing.id,
        currentStatus: existing.status as SubscriptionStatus,
        expected: allowedStates,
      });
    }

    let stripeSubscription: Stripe.Subscription;
    try {
      stripeSubscription = await this.stripe.subscriptions.update(
        existing.stripeSubscriptionId,
        {
          pause_collection: {
            behavior: 'void',
            ...(input.resumesAt !== undefined && {
              resumes_at: Math.floor(input.resumesAt.getTime() / 1000),
            }),
          },
        },
        {
          ...(input.idempotencyKey !== undefined && {
            idempotencyKey: `${input.idempotencyKey}:pause`,
          }),
        },
      );
    } catch (cause) {
      this.logger.warn(
        {
          subscriptionId: existing.id,
          stripeSubscriptionId: existing.stripeSubscriptionId,
          err: stripeErrorMessage(cause),
        },
        'dunning.pauseSubscription stripe failure',
      );
      return err({ reason: 'stripe_unavailable', cause });
    }

    const pausedAt = new Date();
    const fromStatus = existing.status as SubscriptionStatus;
    const toStatus: SubscriptionStatus = 'paused';

    const persistedResult = await this.transactionWithOutbox(
      'pauseSubscription',
      async (tx: PrismaTransactionClient) => {
        const next = await tx.subscription.update({
          where: { id: existing.id },
          data: {
            status: toStatus,
            pauseCollectionStartedAt: pausedAt,
            pauseCollectionResumesAt: input.resumesAt ?? null,
            pauseReason: input.reason ?? null,
          },
        });

        const history = await tx.subscriptionHistory.create({
          data: {
            subscriptionId: next.id,
            event: 'paused',
            fromStatus,
            toStatus,
            context: {
              pausedAt: pausedAt.toISOString(),
              resumesAt: input.resumesAt?.toISOString() ?? null,
              reason: input.reason ?? null,
              stripeSubscriptionStatus: stripeSubscription.status,
            },
            actorUserId: input.requesterUserId,
            actorKind: 'user',
          },
        });

        // TS-042-followup-3 — `subscription.paused`, in-transaction.
        //
        // Keyed on the HISTORY ROW id, which is this transition's natural
        // identity — one row per pause, generated by the database.
        //
        // Neither obvious alternative works. A subscription-keyed id would
        // silently drop every pause after the first, and a family may pause,
        // resume, and pause again. A `pausedAt`-keyed id looks unique but is
        // only millisecond-resolution: two pauses in the same millisecond
        // collide, which a repeat-pause test caught doing exactly that. Unlike
        // the payment events below there is no source event to key on — a
        // pause is a person pressing a button, and each press is its own
        // event (HTTP-level replay is the @Idempotent interceptor's job).
        //
        // `input.reason` is deliberately absent from the payload — see
        // `SubscriptionPausedSchema`. It is free-form text about why a family
        // stepped away from care, and the event replicates far wider than the
        // column it was written to (CLAUDE.md §3.9, §12).
        const eventId = `${next.id}.paused.${history.id}`;
        const appended = await this.outbox.append(tx as unknown as OutboxRawExecutor, {
          eventName: SUBSCRIPTION_PAUSED,
          eventId,
          occurredAt: pausedAt,
          payload: {
            eventId,
            occurredAt: pausedAt.toISOString(),
            subscriptionId: next.id,
            customerId: next.customerId,
            pausedAt: pausedAt.toISOString(),
            resumesAt: input.resumesAt?.toISOString() ?? null,
            hasReason: input.reason !== undefined,
            requesterUserId: input.requesterUserId,
            fromStatus,
          },
        });
        if (appended.kind !== 'appended') {
          throw new OutboxValidationFailedError(appended.eventName, appended.issues);
        }

        return next;
      },
    );
    if (!persistedResult.ok) {
      return err(persistedResult.error);
    }
    const persisted = persistedResult.value;

    this.logger.log(
      {
        subscriptionId: persisted.id,
        resumesAt: input.resumesAt?.toISOString() ?? null,
      },
      'dunning.pauseSubscription ok',
    );

    return ok(toSubscriptionResponse(toDtoSource(persisted, existing.plan as PlanRowSlice)));
  }

  // ─────────────────────────────────────────────────────────────────────
  // resumeSubscription
  // ─────────────────────────────────────────────────────────────────────

  async resumeSubscription(
    input: ResumeSubscriptionInput,
  ): Promise<Result<SubscriptionResponse, DunningFailure>> {
    return withSpan('dunning.resume', async (span) => {
      const startNs = process.hrtime.bigint();
      let outcome: DunningOutcome = 'error';
      try {
        const result = await this.runResumeSubscription(input);
        outcome = result.ok ? 'ok' : dunningFailureOutcome(result.error);
        return result;
      } finally {
        span.setAttribute('dunning.outcome', outcome);
        this.metrics.recordResume(outcome, elapsedSeconds(startNs));
      }
    });
  }

  private async runResumeSubscription(
    input: ResumeSubscriptionInput,
  ): Promise<Result<SubscriptionResponse, DunningFailure>> {
    if (input.subscriptionId.trim().length === 0) {
      return err({ reason: 'invalid_request', message: 'subscriptionId is required' });
    }
    if (input.requesterUserId.trim().length === 0) {
      return err({ reason: 'invalid_request', message: 'requesterUserId is required' });
    }

    const existing = await this.prisma.subscription.findUnique({
      where: { id: input.subscriptionId },
      include: { plan: true },
    });
    if (existing === null) {
      return err({ reason: 'subscription_not_found', subscriptionId: input.subscriptionId });
    }

    if (existing.status !== 'paused') {
      return err({
        reason: 'invalid_state',
        subscriptionId: existing.id,
        currentStatus: existing.status as SubscriptionStatus,
        expected: ['paused'],
      });
    }

    let stripeSubscription: Stripe.Subscription;
    try {
      // Stripe's `Emptyable<T>` convention: `''` (empty string) unsets
      // `pause_collection`. The SDK union accepts it as a member but
      // requires a definite value (not undefined) under our
      // `exactOptionalPropertyTypes: true` tsconfig, so we build the
      // params object inline rather than spreading a conditional key.
      const updateParams: Stripe.SubscriptionUpdateParams = { pause_collection: '' };
      stripeSubscription = await this.stripe.subscriptions.update(
        existing.stripeSubscriptionId,
        updateParams,
        {
          ...(input.idempotencyKey !== undefined && {
            idempotencyKey: `${input.idempotencyKey}:resume`,
          }),
        },
      );
    } catch (cause) {
      this.logger.warn(
        {
          subscriptionId: existing.id,
          stripeSubscriptionId: existing.stripeSubscriptionId,
          err: stripeErrorMessage(cause),
        },
        'dunning.resumeSubscription stripe failure',
      );
      return err({ reason: 'stripe_unavailable', cause });
    }

    const toStatus = mapStripeStatus(stripeSubscription.status);
    const fromStatus: SubscriptionStatus = 'paused';
    // Hoisted out of the history `context` (where it was an inline
    // `new Date()`) so the history row and the emitted event agree on when
    // the resume happened. Two calls to `new Date()` in one transaction can
    // straddle a millisecond, and this value is also the event's identity.
    const resumedAt = new Date();

    const persistedResult = await this.transactionWithOutbox(
      'resumeSubscription',
      async (tx: PrismaTransactionClient) => {
        const next = await tx.subscription.update({
          where: { id: existing.id },
          data: {
            status: toStatus,
            pauseCollectionStartedAt: null,
            pauseCollectionResumesAt: null,
            pauseReason: null,
          },
        });

        const history = await tx.subscriptionHistory.create({
          data: {
            subscriptionId: next.id,
            event: 'resumed',
            fromStatus,
            toStatus,
            context: {
              resumedAt: resumedAt.toISOString(),
              stripeSubscriptionStatus: stripeSubscription.status,
              ...(input.note !== undefined && { note: input.note }),
            },
            actorUserId: input.requesterUserId,
            actorKind: 'user',
          },
        });

        // TS-042-followup-3 — `subscription.resumed`, in-transaction. Keyed on
        // the history row id for the same reason as the pause event above.
        // `input.note` is withheld from the payload on the same free-text
        // grounds as the pause reason.
        const eventId = `${next.id}.resumed.${history.id}`;
        const appended = await this.outbox.append(tx as unknown as OutboxRawExecutor, {
          eventName: SUBSCRIPTION_RESUMED,
          eventId,
          occurredAt: resumedAt,
          payload: {
            eventId,
            occurredAt: resumedAt.toISOString(),
            subscriptionId: next.id,
            customerId: next.customerId,
            resumedAt: resumedAt.toISOString(),
            requesterUserId: input.requesterUserId,
            toStatus,
            hasNote: input.note !== undefined,
          },
        });
        if (appended.kind !== 'appended') {
          throw new OutboxValidationFailedError(appended.eventName, appended.issues);
        }

        return next;
      },
    );
    if (!persistedResult.ok) {
      return err(persistedResult.error);
    }
    const persisted = persistedResult.value;

    this.logger.log(
      {
        subscriptionId: persisted.id,
        toStatus,
      },
      'dunning.resumeSubscription ok',
    );

    return ok(toSubscriptionResponse(toDtoSource(persisted, existing.plan as PlanRowSlice)));
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Local helpers
// ─────────────────────────────────────────────────────────────────────────

/**
 * TS-042-followup-3 — carries an outbox validation failure out of the
 * `$transaction` callback so the throw rolls the status change back, then
 * gets translated to the typed `outbox_validation_failed` result by
 * {@link DunningService.transactionWithOutbox}. Same shape and rationale as
 * `SubscriptionsService`'s private class of the same name; kept local to
 * each service because the two carry different failure unions.
 */
class OutboxValidationFailedError extends Error {
  constructor(
    readonly eventName: string,
    readonly issues: readonly {
      readonly path: readonly (string | number)[];
      readonly message: string;
    }[],
  ) {
    super(
      `outbox.append validation failed for ${eventName}: ${issues
        .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
        .join('; ')}`,
    );
    this.name = 'OutboxValidationFailedError';
  }
}

function addDays(from: Date, days: number): Date {
  return new Date(from.getTime() + days * 24 * 60 * 60 * 1000);
}

/** Elapsed wall-clock seconds since `startNs` (a `process.hrtime.bigint()` mark). */
function elapsedSeconds(startNs: bigint): number {
  return Number(process.hrtime.bigint() - startNs) / 1e9;
}

function stripeErrorMessage(cause: unknown): string {
  if (typeof cause === 'object' && cause !== null && 'message' in cause) {
    const message = (cause as { message: unknown }).message;
    if (typeof message === 'string') return message;
  }
  return 'unknown stripe error';
}

/**
 * Shape we read from `subscription.findUnique({include: {plan: true}})`.
 * Mirrors the columns the DTO mapper consumes. Local mirror because of
 * the same TS-021-followup-2 / -3 tsconfig issue affecting other services.
 */
interface PersistedRow {
  readonly id: string;
  readonly stripeSubscriptionId: string;
  readonly stripeCustomerId: string;
  readonly customerId: string;
  readonly customerGroup: string;
  readonly planId: string;
  readonly status: string;
  readonly billingInterval: string;
  readonly currentPeriodStart: Date;
  readonly currentPeriodEnd: Date;
  readonly trialEnd: Date | null;
  readonly cancelAtPeriodEnd: boolean;
  readonly cancelReason: string | null;
  readonly canceledAt: Date | null;
  readonly dunningAttempts: number;
  readonly dunningLastAttemptAt: Date | null;
  readonly dunningGraceUntil: Date | null;
  readonly pauseCollectionStartedAt: Date | null;
  readonly pauseCollectionResumesAt: Date | null;
  readonly pauseReason: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

function toDtoSource(row: PersistedRow, plan: PlanRowSlice): SubscriptionDtoSource {
  const billingInterval = row.billingInterval as BillingInterval;
  const unitPriceDecimal = billingInterval === 'monthly' ? plan.monthlyPrice : plan.annualPrice;
  return {
    id: row.id,
    stripeSubscriptionId: row.stripeSubscriptionId,
    stripeCustomerId: row.stripeCustomerId,
    customerId: row.customerId,
    customerGroup: row.customerGroup as PlanCustomerGroup,
    planId: row.planId,
    planCode: plan.code,
    status: row.status as SubscriptionStatus,
    billingInterval,
    unitPriceDecimal,
    currency: plan.currency,
    currentPeriodStart: row.currentPeriodStart,
    currentPeriodEnd: row.currentPeriodEnd,
    trialEnd: row.trialEnd,
    cancelAtPeriodEnd: row.cancelAtPeriodEnd,
    cancelReason: row.cancelReason !== null ? (row.cancelReason as SubscriptionCancelReason) : null,
    canceledAt: row.canceledAt,
    dunningAttempts: row.dunningAttempts,
    dunningLastAttemptAt: row.dunningLastAttemptAt,
    dunningGraceUntil: row.dunningGraceUntil,
    pauseCollectionStartedAt: row.pauseCollectionStartedAt,
    pauseCollectionResumesAt: row.pauseCollectionResumesAt,
    pauseReason: row.pauseReason,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
