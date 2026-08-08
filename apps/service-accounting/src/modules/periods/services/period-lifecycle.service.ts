import { Injectable, Logger } from '@nestjs/common';

import { PrismaService, type PrismaTransactionClient } from '../../../prisma/prisma.service';
import {
  toLifecycleEventResponse,
  toPeriodResponse,
  type PersistedLifecycleEvent,
  type PersistedPeriod,
} from '../mappers/period.mapper';

import type { PeriodLifecycleEventResponse, PeriodResponse } from '@taste-and-see/contracts';

/**
 * Failure variants from `PeriodLifecycleService.close` /
 * `PeriodLifecycleService.reopen`.
 *
 * Each variant maps to a controller-side HTTP status:
 *
 * - `period_not_found`          → 404
 * - `period_already_closed`     → 409 (close only)
 * - `period_not_closed`         → 409 (reopen only)
 * - `idempotency_payload_drift` → 409 (UNIQUE on source_event_id matched
 *                                  a prior event whose period / kind /
 *                                  actor / reason doesn't match the new
 *                                  request — caller should not reuse the
 *                                  same sourceEventId for a different
 *                                  action)
 */
export type PeriodLifecycleFailure =
  | { readonly kind: 'period_not_found'; readonly periodName: string }
  | {
      readonly kind: 'period_already_closed';
      readonly periodId: string;
      readonly periodName: string;
    }
  | {
      readonly kind: 'period_not_closed';
      readonly periodId: string;
      readonly periodName: string;
    }
  | {
      readonly kind: 'idempotency_payload_drift';
      readonly sourceEventId: string;
      readonly storedKind: 'close' | 'reopen';
      readonly storedPeriodId: string;
    };

export type Result<T, E> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly failure: E };

const ok = <T>(value: T): Result<T, never> => ({ ok: true, value });
const fail = <E>(failure: E): Result<never, E> => ({ ok: false, failure });

/**
 * Output shape for a successful close / reopen.
 */
export interface PeriodLifecycleSuccess {
  readonly period: PeriodResponse;
  readonly event: PeriodLifecycleEventResponse;
  readonly result: 'closed' | 'reopened' | 'idempotent_replay';
}

/**
 * Input parameters for the close + reopen flows.
 *
 * `occurredAt` defaults to the service's `now()` at the controller
 * layer when the client omits it; the service receives a concrete Date
 * either way.
 */
export interface PeriodLifecycleRequest {
  readonly periodName: string;
  readonly actorUserId: string;
  readonly sourceEventId: string;
  readonly reasonCode: string;
  readonly description: string | null;
  readonly occurredAt: Date;
}

/**
 * `PeriodLifecycleService` — flips `AccountingPeriod.status` between
 * `open` and `closed` and records the transition in
 * `period_lifecycle_events`.
 *
 * Every transition runs inside a single `prisma.$transaction` so the
 * status flip + the audit row are atomic. A failure on either rolls
 * back both. The `source_event_id` UNIQUE constraint is the
 * idempotency primitive: a redelivery of the same lifecycle action
 * surfaces the existing audit row + the current period state as the
 * `idempotent_replay` result, without writing a second audit row.
 *
 * **Why we don't post a `period_close` journal here.** The
 * `JournalKind.period_close` enum variant is reserved for the
 * period-rollover envelope entries (closing temporary revenue +
 * expense accounts to retained earnings) that land with TS-260 (full
 * SaaS metrics + reconciliation). TS-085's close workflow is a status
 * gate — once closed, posts require `finance:adjust` + an explicit
 * reopen; the gate itself doesn't move money.
 *
 * **Role gating** (`finance:adjust`) is captured at the controller
 * layer via `AccessTokenGuard` + a permission-string check that lands
 * once the shared `packages/nest-auth` package arrives
 * (TS-052-followup-11). Until then the audit row records the actor
 * for review.
 */
@Injectable()
export class PeriodLifecycleService {
  private readonly logger = new Logger(PeriodLifecycleService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Close an open period.
   *
   * - If the period is already closed, returns `period_already_closed`
   *   (UNLESS the request's `sourceEventId` matches an existing close
   *   event on this period — in which case it's an idempotent replay
   *   and we return the cached response).
   * - If the period doesn't exist, returns `period_not_found`.
   */
  async close(
    request: PeriodLifecycleRequest,
  ): Promise<Result<PeriodLifecycleSuccess, PeriodLifecycleFailure>> {
    return this.transition(request, 'close');
  }

  /**
   * Reopen a closed period.
   *
   * - If the period is already open, returns `period_not_closed`
   *   (UNLESS the request's `sourceEventId` matches an existing reopen
   *   event on this period — idempotent replay).
   * - If the period doesn't exist, returns `period_not_found`.
   *
   * **Reopen preserves the prior `closedAt` + `closedByUserId`** on
   * the `AccountingPeriod` row. The close happened; the audit record
   * stands. The status flips back to `open`; the lifecycle events
   * table captures the reopen separately.
   */
  async reopen(
    request: PeriodLifecycleRequest,
  ): Promise<Result<PeriodLifecycleSuccess, PeriodLifecycleFailure>> {
    return this.transition(request, 'reopen');
  }

  private async transition(
    request: PeriodLifecycleRequest,
    targetKind: 'close' | 'reopen',
  ): Promise<Result<PeriodLifecycleSuccess, PeriodLifecycleFailure>> {
    // Pre-flight: look up an existing event by source_event_id outside
    // of the transaction. If it matches the request's target period +
    // kind, return the cached response. If it matches a DIFFERENT
    // period or kind, the caller is reusing the same id for a
    // different action — reject with `idempotency_payload_drift`.
    const existingEvent = await this.prisma.periodLifecycleEvent.findUnique({
      where: { sourceEventId: request.sourceEventId },
      select: LIFECYCLE_EVENT_WITH_PERIOD_SELECT,
    });
    if (existingEvent !== null) {
      if (existingEvent.kind !== targetKind || existingEvent.period.name !== request.periodName) {
        return fail({
          kind: 'idempotency_payload_drift',
          sourceEventId: request.sourceEventId,
          storedKind: existingEvent.kind,
          storedPeriodId: existingEvent.periodId,
        });
      }
      // Idempotent replay — return the cached row.
      this.logger.log(
        {
          eventId: existingEvent.id,
          periodId: existingEvent.periodId,
          kind: existingEvent.kind,
          sourceEventId: request.sourceEventId,
        },
        'period-lifecycle.idempotent-replay',
      );
      return ok({
        period: toPeriodResponse(existingEvent.period as PersistedPeriod),
        event: toLifecycleEventResponse(existingEvent as PersistedLifecycleEvent),
        result: 'idempotent_replay',
      });
    }

    try {
      return await this.prisma.$transaction(async (tx: PrismaTransactionClient) => {
        const period = await tx.accountingPeriod.findUnique({
          where: { name: request.periodName },
          select: PERIOD_FULL_SELECT,
        });
        if (period === null) {
          throw new LifecycleError({
            kind: 'period_not_found',
            periodName: request.periodName,
          });
        }

        if (targetKind === 'close' && period.status === 'closed') {
          throw new LifecycleError({
            kind: 'period_already_closed',
            periodId: period.id,
            periodName: period.name,
          });
        }
        if (targetKind === 'reopen' && period.status === 'open') {
          throw new LifecycleError({
            kind: 'period_not_closed',
            periodId: period.id,
            periodName: period.name,
          });
        }

        // Insert the audit row first so a UNIQUE-violation race on the
        // source_event_id surfaces before we flip the period status.
        const event = await tx.periodLifecycleEvent.create({
          data: {
            periodId: period.id,
            kind: targetKind,
            actorUserId: request.actorUserId,
            sourceEventId: request.sourceEventId,
            reasonCode: request.reasonCode,
            description: request.description,
            occurredAt: request.occurredAt,
          },
          select: LIFECYCLE_EVENT_SELECT,
        });

        // Flip the period status. For a close we also stamp closedAt +
        // closedByUserId; for a reopen we preserve them (the close
        // record stands).
        const updatedPeriod = await tx.accountingPeriod.update({
          where: { id: period.id },
          data:
            targetKind === 'close'
              ? {
                  status: 'closed',
                  closedAt: request.occurredAt,
                  closedByUserId: request.actorUserId,
                }
              : {
                  status: 'open',
                },
          select: PERIOD_FULL_SELECT,
        });

        const periodResponse = toPeriodResponse(updatedPeriod as PersistedPeriod);
        const eventResponse = toLifecycleEventResponse({
          ...event,
          period: { name: updatedPeriod.name },
        } as PersistedLifecycleEvent);

        this.logger.warn(
          {
            eventId: event.id,
            periodId: period.id,
            periodName: period.name,
            kind: targetKind,
            actorId: request.actorUserId,
            reasonCode: request.reasonCode,
          },
          targetKind === 'close' ? 'period-lifecycle.closed' : 'period-lifecycle.reopened',
        );

        return ok({
          period: periodResponse,
          event: eventResponse,
          result: targetKind === 'close' ? 'closed' : 'reopened',
        }) as Result<PeriodLifecycleSuccess, PeriodLifecycleFailure>;
      });
    } catch (err) {
      if (err instanceof LifecycleError) {
        return fail(err.failure);
      }
      if (isUniqueViolationOn(err, 'source_event_id')) {
        // Race against a concurrent identical request. Refetch the
        // winning event from outside the now-rolled-back transaction
        // and surface it as idempotent_replay. The pre-flight check
        // above handles the dominant case; this branch defends against
        // the (rare) racing concurrent admin submit.
        const winner = await this.prisma.periodLifecycleEvent.findUnique({
          where: { sourceEventId: request.sourceEventId },
          select: LIFECYCLE_EVENT_WITH_PERIOD_SELECT,
        });
        if (winner !== null) {
          return ok({
            period: toPeriodResponse(winner.period as PersistedPeriod),
            event: toLifecycleEventResponse(winner as PersistedLifecycleEvent),
            result: 'idempotent_replay',
          });
        }
      }
      throw err;
    }
  }
}

const PERIOD_FULL_SELECT = {
  id: true,
  name: true,
  startDate: true,
  endDate: true,
  status: true,
  closedAt: true,
  closedByUserId: true,
  createdAt: true,
  updatedAt: true,
} as const;

const LIFECYCLE_EVENT_SELECT = {
  id: true,
  periodId: true,
  kind: true,
  actorUserId: true,
  sourceEventId: true,
  reasonCode: true,
  description: true,
  occurredAt: true,
  createdAt: true,
} as const;

const LIFECYCLE_EVENT_WITH_PERIOD_SELECT = {
  ...LIFECYCLE_EVENT_SELECT,
  period: {
    select: PERIOD_FULL_SELECT,
  },
} as const;

class LifecycleError extends Error {
  constructor(public readonly failure: PeriodLifecycleFailure) {
    super(`period lifecycle transition failed: ${JSON.stringify(failure)}`);
    this.name = 'LifecycleError';
  }
}

function isUniqueViolationOn(err: unknown, column: string): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const candidate = err as {
    code?: unknown;
    name?: unknown;
    meta?: { target?: unknown };
  };
  if (candidate.code !== 'P2002' || candidate.name !== 'PrismaClientKnownRequestError') {
    return false;
  }
  const target = candidate.meta?.target;
  if (Array.isArray(target)) {
    return target.includes(column);
  }
  if (typeof target === 'string') {
    return target.includes(column);
  }
  return false;
}
