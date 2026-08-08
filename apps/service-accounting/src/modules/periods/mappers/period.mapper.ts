import type { PeriodLifecycleEventResponse, PeriodResponse } from '@taste-and-see/contracts';

/**
 * Slim projection of an `accounting_periods` row carrying everything
 * the public wire shape needs. Hand-typed for the same reasons as the
 * journal-posting mapper — the Prisma namespace value-side resolves
 * inconsistently under our `verbatimModuleSyntax: false` /
 * `isolatedModules: true` tsconfig; TS-021-followup-2 captures the
 * cleanup once Prisma 5.23 / 6.x normalises that.
 */
export interface PersistedPeriod {
  readonly id: string;
  readonly name: string;
  readonly startDate: Date;
  readonly endDate: Date;
  readonly status: 'open' | 'closed';
  readonly closedAt: Date | null;
  readonly closedByUserId: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/**
 * Slim projection of a `period_lifecycle_events` row joined to its
 * parent period's `name` field. The audit response carries the
 * `periodName` denormalised so consumers can render the row without
 * a follow-up GET.
 */
export interface PersistedLifecycleEvent {
  readonly id: string;
  readonly periodId: string;
  readonly kind: 'close' | 'reopen';
  readonly actorUserId: string;
  readonly sourceEventId: string;
  readonly reasonCode: string;
  readonly description: string | null;
  readonly occurredAt: Date;
  readonly createdAt: Date;
  readonly period: { readonly name: string };
}

/**
 * `PersistedPeriod` → `PeriodResponse` wire shape.
 *
 * - `startDate` / `endDate` are `@db.Date` columns — convert to
 *   `YYYY-MM-DD` strings (the contract is explicit about the wire
 *   shape).
 * - `closedAt` is `@db.Timestamptz(6)` — ISO-8601 datetime when set,
 *   `null` when never closed.
 */
export function toPeriodResponse(persisted: PersistedPeriod): PeriodResponse {
  return {
    id: persisted.id,
    name: persisted.name,
    startDate: toDateOnly(persisted.startDate),
    endDate: toDateOnly(persisted.endDate),
    status: persisted.status,
    closedAt: persisted.closedAt === null ? null : persisted.closedAt.toISOString(),
    closedByUserId: persisted.closedByUserId,
    createdAt: persisted.createdAt.toISOString(),
    updatedAt: persisted.updatedAt.toISOString(),
  };
}

/**
 * `PersistedLifecycleEvent` → `PeriodLifecycleEventResponse` wire shape.
 *
 * The denormalised `periodName` comes from the joined `period` projection
 * so the audit row carries everything an admin viewer needs without a
 * follow-up GET.
 */
export function toLifecycleEventResponse(
  persisted: PersistedLifecycleEvent,
): PeriodLifecycleEventResponse {
  return {
    id: persisted.id,
    periodId: persisted.periodId,
    periodName: persisted.period.name,
    kind: persisted.kind,
    actorUserId: persisted.actorUserId,
    sourceEventId: persisted.sourceEventId,
    reasonCode: persisted.reasonCode,
    description: persisted.description,
    occurredAt: persisted.occurredAt.toISOString(),
    createdAt: persisted.createdAt.toISOString(),
  };
}

/**
 * Render a `@db.Date` column value as `YYYY-MM-DD` in UTC. Prisma
 * surfaces a JS `Date` whose UTC midnight corresponds to the calendar
 * date stored in Postgres — we slice the ISO-8601 string to keep only
 * the date portion. Doing it via `Date.prototype.toISOString` keeps the
 * conversion locale-independent (no surprises in test environments
 * running under a non-UTC TZ).
 */
function toDateOnly(value: Date): string {
  return value.toISOString().slice(0, 10);
}
