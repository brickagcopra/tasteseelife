import { Injectable, Logger } from '@nestjs/common';
import {
  PROVIDER_AVAILABILITY_WEEKDAY_VALUES,
  PROVIDER_AVAILABILITY_UPDATED,
  type ProviderAvailabilityException,
  type ProviderAvailabilityRecord,
  type ProviderAvailabilityWeekday,
  type ProviderAvailabilityWindow,
} from '@taste-and-see/contracts';
import { OutboxService, type OutboxRawExecutor } from '@taste-and-see/nest-outbox';

import { PrismaService, type PrismaTransactionClient } from '../../../prisma/prisma.service';

import { err, ok, type Result } from './result';

/**
 * Local mirror of the Prisma-generated `providers` row shape — same
 * TS-021-followup-2 / TS-021-followup-3 rationale that the sibling
 * profile + discovery services use.
 */
interface ProviderRow {
  readonly id: string;
  readonly userId: string;
  readonly timeZone: string;
  readonly deletedAt: Date | null;
}

interface WindowRow {
  readonly weekday: ProviderAvailabilityWeekday;
  readonly startTime: Date;
  readonly endTime: Date;
  readonly updatedAt: Date;
}

interface ExceptionRow {
  readonly exceptionDate: Date;
  readonly createdAt: Date;
}

export interface ProviderAvailabilitySnapshot {
  readonly providerId: string;
  readonly timeZone: string;
  readonly windows: readonly ProviderAvailabilityWindow[];
  readonly exceptions: readonly ProviderAvailabilityException[];
  /**
   * Composite "most-recent activity" timestamp — the max of the
   * provider row's updatedAt, the windows' updatedAt, and the
   * exceptions' createdAt. Falls back to the parent row's
   * updatedAt when no windows or exceptions exist.
   */
  readonly updatedAt: Date;
}

export interface UpdateAvailabilityInput {
  /** Authoritative provider row id — set from the route param. */
  readonly providerId: string;
  /** The authenticated user attempting the edit. */
  readonly actorUserId: string;
  readonly windows: readonly ProviderAvailabilityWindow[];
  readonly exceptions: readonly ProviderAvailabilityException[];
}

export interface DeleteAvailabilityInput {
  readonly providerId: string;
  readonly actorUserId: string;
}

export type ProviderAvailabilityFailure =
  | { readonly reason: 'invalid_request'; readonly message: string }
  | { readonly reason: 'not_found'; readonly providerId: string }
  | { readonly reason: 'forbidden'; readonly providerId: string }
  | {
      readonly reason: 'outbox_validation_failed';
      readonly eventName: string;
      readonly message: string;
    };

export interface DeleteAvailabilityOutcome {
  readonly providerId: string;
  readonly deletedWindowCount: number;
  readonly deletedExceptionCount: number;
}

/**
 * Internal exception thrown inside `prisma.$transaction` when the
 * outbox SDK rejects the payload. Caught by the outer service so the
 * surrounding transaction rolls back atomically and we surface a
 * typed failure rather than a 500. Same shape as the sibling
 * profile + certifications services.
 */
class OutboxValidationFailedError extends Error {
  constructor(
    public readonly eventName: string,
    public readonly issues: ReadonlyArray<{
      readonly path: ReadonlyArray<string | number>;
      readonly message: string;
    }>,
  ) {
    super(`outbox.append validation failed for ${eventName}`);
    this.name = 'OutboxValidationFailedError';
  }
}

/**
 * `AvailabilityService` — owns the self-service availability surface
 * (TS-203).
 *
 * Three surfaces:
 *
 *   - `getAvailability(providerId)` — returns the materialised
 *     snapshot. Returns null when the provider has no windows or
 *     exceptions on file (the editor renders an empty-state
 *     placeholder for new providers).
 *
 *   - `updateAvailability({ providerId, actorUserId, windows,
 *     exceptions })` — atomic full-set replace via `prisma.
 *     $transaction`:
 *       1. Loads + locks the provider row (404 if missing / soft-
 *          deleted).
 *       2. Verifies the row's `user_id` matches `actorUserId` (403
 *          otherwise; admin override is TS-203-followup-2).
 *       3. DELETEs every existing window + exception row for the
 *          provider, then bulk-inserts the new set.
 *       4. Appends `provider.availability_updated` via the shared
 *          outbox SDK. Rolls back atomically on validation failure.
 *       5. Re-reads the materialised snapshot for the response.
 *
 *   - `deleteAvailability({ providerId, actorUserId })` —
 *     transactional full-clear (same ownership check, same outbox
 *     emission). Returns the count of rows actually removed so the
 *     caller can render "no schedule was saved" hints.
 *
 * **Tenant scoping** (CLAUDE.md §3.2). Self-service-first: the
 * authenticated user must own the provider row. Admin override
 * lands when `PermissionGuard` lifts to `packages/nest-auth` via
 * TS-052-followup-11 — captured as TS-203-followup-2.
 *
 * **Outbox emission**. `provider.availability_updated` carries the
 * post-write window + exception counts; the search-indexer treats
 * the event as a "re-fetch + re-project" trigger via the discovery-
 * snapshot endpoint so the event stays tiny and the projection
 * stays single-source-of-truth.
 *
 * **No-op short-circuit**. When the requested state exactly matches
 * the persisted state, the service still rewrites the rows + emits
 * the event (today's behaviour) — the wire shape is intentionally
 * write-on-PUT to keep the controller-side logic simple. A future
 * follow-up can skip the rewrite when nothing changed.
 */
@Injectable()
export class AvailabilityService {
  private readonly logger = new Logger(AvailabilityService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly outbox: OutboxService,
  ) {}

  /**
   * Fetch the materialised availability snapshot for a provider.
   * Returns `null` when the provider row is missing or soft-deleted.
   * A live provider with no windows + no exceptions returns a
   * record carrying empty arrays.
   */
  async getAvailability(providerId: string): Promise<ProviderAvailabilitySnapshot | null> {
    if (providerId.length === 0) return null;

    const provider = (await this.prisma.provider.findUnique({
      where: { id: providerId },
      select: {
        id: true,
        userId: true,
        timeZone: true,
        updatedAt: true,
        deletedAt: true,
      },
    })) as (ProviderRow & { readonly updatedAt: Date }) | null;

    if (provider === null || provider.deletedAt !== null) return null;

    const [windowRows, exceptionRows] = await Promise.all([
      this.prisma.providerAvailabilityWindow.findMany({
        where: { providerId: provider.id },
        select: { weekday: true, startTime: true, endTime: true, updatedAt: true },
      }) as Promise<readonly WindowRow[]>,
      this.prisma.providerAvailabilityException.findMany({
        where: { providerId: provider.id },
        select: { exceptionDate: true, createdAt: true },
      }) as Promise<readonly ExceptionRow[]>,
    ]);

    return this.composeSnapshot({
      providerId: provider.id,
      timeZone: provider.timeZone,
      parentUpdatedAt: provider.updatedAt,
      windowRows,
      exceptionRows,
    });
  }

  /**
   * Same as `getAvailability` but keyed by the parent provider's
   * `user_id`. Returns null when the user has no provider row yet
   * (they haven't completed the application).
   */
  async getAvailabilityByUserId(userId: string): Promise<ProviderAvailabilitySnapshot | null> {
    if (userId.length === 0) return null;

    const provider = (await this.prisma.provider.findUnique({
      where: { userId },
      select: {
        id: true,
        userId: true,
        timeZone: true,
        updatedAt: true,
        deletedAt: true,
      },
    })) as (ProviderRow & { readonly updatedAt: Date }) | null;

    if (provider === null || provider.deletedAt !== null) return null;

    const [windowRows, exceptionRows] = await Promise.all([
      this.prisma.providerAvailabilityWindow.findMany({
        where: { providerId: provider.id },
        select: { weekday: true, startTime: true, endTime: true, updatedAt: true },
      }) as Promise<readonly WindowRow[]>,
      this.prisma.providerAvailabilityException.findMany({
        where: { providerId: provider.id },
        select: { exceptionDate: true, createdAt: true },
      }) as Promise<readonly ExceptionRow[]>,
    ]);

    return this.composeSnapshot({
      providerId: provider.id,
      timeZone: provider.timeZone,
      parentUpdatedAt: provider.updatedAt,
      windowRows,
      exceptionRows,
    });
  }

  async updateAvailability(
    input: UpdateAvailabilityInput,
  ): Promise<Result<ProviderAvailabilitySnapshot, ProviderAvailabilityFailure>> {
    if (input.providerId.length === 0) {
      return err({ reason: 'invalid_request', message: 'providerId is required' });
    }
    if (input.actorUserId.length === 0) {
      return err({ reason: 'invalid_request', message: 'actorUserId is required' });
    }

    const provider = (await this.prisma.provider.findUnique({
      where: { id: input.providerId },
      select: {
        id: true,
        userId: true,
        timeZone: true,
        updatedAt: true,
        deletedAt: true,
      },
    })) as (ProviderRow & { readonly updatedAt: Date }) | null;

    if (provider === null || provider.deletedAt !== null) {
      return err({ reason: 'not_found', providerId: input.providerId });
    }
    if (provider.userId !== input.actorUserId) {
      return err({ reason: 'forbidden', providerId: input.providerId });
    }

    const now = new Date();

    try {
      const snapshot = await this.prisma.$transaction(
        async (tx: PrismaTransactionClient): Promise<ProviderAvailabilitySnapshot> => {
          // 1. Replace the recurring-window set. The DELETE +
          //    createMany pair runs inside the transaction so
          //    consumers see the resulting set atomically from the
          //    outside.
          await tx.providerAvailabilityWindow.deleteMany({
            where: { providerId: input.providerId },
          });
          if (input.windows.length > 0) {
            await tx.providerAvailabilityWindow.createMany({
              data: input.windows.map((window) => ({
                providerId: input.providerId,
                weekday: window.weekday,
                startTime: timeOfDayToDate(window.startTime),
                endTime: timeOfDayToDate(window.endTime),
              })),
            });
          }

          // 2. Replace the exceptions set.
          await tx.providerAvailabilityException.deleteMany({
            where: { providerId: input.providerId },
          });
          if (input.exceptions.length > 0) {
            await tx.providerAvailabilityException.createMany({
              data: input.exceptions.map((exception) => ({
                providerId: input.providerId,
                exceptionDate: parseCalendarDate(exception.date),
              })),
            });
          }

          // 3. Outbox emission. The producer ALWAYS fires on a PUT —
          //    the schema-level no-op short-circuit (skip-emit when
          //    nothing changed) lands as a follow-up.
          const eventId = `${input.providerId}.availability_updated.${now.getTime()}`;
          const appended = await this.outbox.append(tx as unknown as OutboxRawExecutor, {
            eventName: PROVIDER_AVAILABILITY_UPDATED,
            eventId,
            occurredAt: now,
            payload: {
              eventId,
              occurredAt: now.toISOString(),
              providerId: input.providerId,
              windowCount: input.windows.length,
              exceptionCount: input.exceptions.length,
              actorUserId: input.actorUserId,
            },
          });
          if (appended.kind !== 'appended') {
            throw new OutboxValidationFailedError(appended.eventName, appended.issues);
          }

          // 4. Re-read the post-write rows for the response. Using
          //    the same tx ensures read-after-write consistency.
          const [writtenWindows, writtenExceptions] = await Promise.all([
            tx.providerAvailabilityWindow.findMany({
              where: { providerId: input.providerId },
              select: {
                weekday: true,
                startTime: true,
                endTime: true,
                updatedAt: true,
              },
            }) as Promise<readonly WindowRow[]>,
            tx.providerAvailabilityException.findMany({
              where: { providerId: input.providerId },
              select: { exceptionDate: true, createdAt: true },
            }) as Promise<readonly ExceptionRow[]>,
          ]);

          return this.composeSnapshot({
            providerId: provider.id,
            timeZone: provider.timeZone,
            parentUpdatedAt: provider.updatedAt,
            windowRows: writtenWindows,
            exceptionRows: writtenExceptions,
          });
        },
      );

      this.logger.log(
        {
          providerId: input.providerId,
          actorUserId: input.actorUserId,
          windowCount: input.windows.length,
          exceptionCount: input.exceptions.length,
        },
        'provider-availability.update ok',
      );

      return ok(snapshot);
    } catch (e) {
      if (e instanceof OutboxValidationFailedError) {
        this.logger.error(
          { eventName: e.eventName, issues: e.issues, providerId: input.providerId },
          'provider-availability.update outbox validation failed; tx rolled back',
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

  async deleteAvailability(
    input: DeleteAvailabilityInput,
  ): Promise<Result<DeleteAvailabilityOutcome, ProviderAvailabilityFailure>> {
    if (input.providerId.length === 0) {
      return err({ reason: 'invalid_request', message: 'providerId is required' });
    }
    if (input.actorUserId.length === 0) {
      return err({ reason: 'invalid_request', message: 'actorUserId is required' });
    }

    const provider = (await this.prisma.provider.findUnique({
      where: { id: input.providerId },
      select: { id: true, userId: true, deletedAt: true },
    })) as Pick<ProviderRow, 'id' | 'userId' | 'deletedAt'> | null;

    if (provider === null || provider.deletedAt !== null) {
      return err({ reason: 'not_found', providerId: input.providerId });
    }
    if (provider.userId !== input.actorUserId) {
      return err({ reason: 'forbidden', providerId: input.providerId });
    }

    const now = new Date();

    try {
      const outcome = await this.prisma.$transaction(
        async (tx: PrismaTransactionClient): Promise<DeleteAvailabilityOutcome> => {
          const [deletedWindows, deletedExceptions] = await Promise.all([
            tx.providerAvailabilityWindow.deleteMany({
              where: { providerId: input.providerId },
            }),
            tx.providerAvailabilityException.deleteMany({
              where: { providerId: input.providerId },
            }),
          ]);

          // Emit only when the delete actually removed something —
          // a delete on an already-empty schedule is a no-op success
          // with no domain change to broadcast.
          if (deletedWindows.count > 0 || deletedExceptions.count > 0) {
            const eventId = `${input.providerId}.availability_updated.${now.getTime()}`;
            const appended = await this.outbox.append(tx as unknown as OutboxRawExecutor, {
              eventName: PROVIDER_AVAILABILITY_UPDATED,
              eventId,
              occurredAt: now,
              payload: {
                eventId,
                occurredAt: now.toISOString(),
                providerId: input.providerId,
                windowCount: 0,
                exceptionCount: 0,
                actorUserId: input.actorUserId,
              },
            });
            if (appended.kind !== 'appended') {
              throw new OutboxValidationFailedError(appended.eventName, appended.issues);
            }
          }

          return {
            providerId: input.providerId,
            deletedWindowCount: deletedWindows.count,
            deletedExceptionCount: deletedExceptions.count,
          };
        },
      );

      this.logger.log(
        {
          providerId: input.providerId,
          actorUserId: input.actorUserId,
          deletedWindowCount: outcome.deletedWindowCount,
          deletedExceptionCount: outcome.deletedExceptionCount,
        },
        'provider-availability.delete ok',
      );

      return ok(outcome);
    } catch (e) {
      if (e instanceof OutboxValidationFailedError) {
        this.logger.error(
          { eventName: e.eventName, issues: e.issues, providerId: input.providerId },
          'provider-availability.delete outbox validation failed; tx rolled back',
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

  /**
   * Materialise the public-facing snapshot from the raw rows. Sorts
   * windows by `(weekday, startTime)` and exceptions by `date` so
   * the consumer-side rendering stays deterministic. `updatedAt` is
   * the max of the parent provider's updatedAt, each window's
   * updatedAt, and each exception's createdAt — the most-recent
   * activity timestamp clients can show as "last edited".
   */
  private composeSnapshot(input: {
    readonly providerId: string;
    readonly timeZone: string;
    readonly parentUpdatedAt: Date;
    readonly windowRows: readonly WindowRow[];
    readonly exceptionRows: readonly ExceptionRow[];
  }): ProviderAvailabilitySnapshot {
    const windows = [...input.windowRows]
      .sort((a, b) => {
        const aWeekday = weekdayOrder(a.weekday);
        const bWeekday = weekdayOrder(b.weekday);
        if (aWeekday !== bWeekday) return aWeekday - bWeekday;
        return dateTimeOfDayToString(a.startTime).localeCompare(dateTimeOfDayToString(b.startTime));
      })
      .map((row) => ({
        weekday: row.weekday,
        startTime: dateTimeOfDayToString(row.startTime),
        endTime: dateTimeOfDayToString(row.endTime),
      }));

    const exceptions = [...input.exceptionRows]
      .sort((a, b) =>
        calendarDateToString(a.exceptionDate).localeCompare(calendarDateToString(b.exceptionDate)),
      )
      .map((row) => ({
        date: calendarDateToString(row.exceptionDate),
      }));

    let updatedAt = input.parentUpdatedAt;
    for (const row of input.windowRows) {
      if (row.updatedAt > updatedAt) updatedAt = row.updatedAt;
    }
    for (const row of input.exceptionRows) {
      if (row.createdAt > updatedAt) updatedAt = row.createdAt;
    }

    return {
      providerId: input.providerId,
      timeZone: input.timeZone,
      windows,
      exceptions,
      updatedAt,
    };
  }
}

/**
 * Project a Prisma `@db.Time(0)` value (returned as a Date with a
 * 1970-01-01 anchor date) to the HH:MM string the contract carries.
 * Uses UTC accessors so the value matches what was inserted —
 * Prisma stores the time as UTC midnight + the time-of-day component
 * because `time(0)` is timezone-naive.
 */
function dateTimeOfDayToString(value: Date): string {
  const hours = String(value.getUTCHours()).padStart(2, '0');
  const minutes = String(value.getUTCMinutes()).padStart(2, '0');
  return `${hours}:${minutes}`;
}

/**
 * Project a Prisma `@db.Date` value to the YYYY-MM-DD string the
 * contract carries. Uses UTC accessors so the date matches what was
 * inserted — Prisma stores the date as UTC midnight on the calendar
 * day.
 */
function calendarDateToString(value: Date): string {
  const year = String(value.getUTCFullYear()).padStart(4, '0');
  const month = String(value.getUTCMonth() + 1).padStart(2, '0');
  const day = String(value.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * Parse an HH:MM string into a Date suitable for a Prisma
 * `@db.Time(0)` column write. Anchored at 1970-01-01 UTC so the
 * date component is irrelevant; Postgres extracts only the time-of-
 * day portion.
 */
function timeOfDayToDate(hhmm: string): Date {
  const colon = hhmm.indexOf(':');
  const hours = Number.parseInt(hhmm.slice(0, colon), 10);
  const minutes = Number.parseInt(hhmm.slice(colon + 1), 10);
  return new Date(Date.UTC(1970, 0, 1, hours, minutes, 0, 0));
}

/**
 * Parse a YYYY-MM-DD string into a Date suitable for a Prisma
 * `@db.Date` column write. Anchored at UTC midnight on the
 * specified calendar day so the date round-trips intact regardless
 * of the runtime's local timezone.
 */
function parseCalendarDate(yyyyMmDd: string): Date {
  const year = Number.parseInt(yyyyMmDd.slice(0, 4), 10);
  const month = Number.parseInt(yyyyMmDd.slice(5, 7), 10);
  const day = Number.parseInt(yyyyMmDd.slice(8, 10), 10);
  return new Date(Date.UTC(year, month - 1, day, 0, 0, 0, 0));
}

function weekdayOrder(weekday: ProviderAvailabilityWeekday): number {
  return PROVIDER_AVAILABILITY_WEEKDAY_VALUES.indexOf(weekday);
}

/**
 * One external busy interval (TS-206) the projection unions out of the
 * resolved availability. Absolute UTC instants pulled from the
 * provider's connected external calendar (Google free/busy).
 */
export interface ExternalBusyInterval {
  readonly startAt: Date;
  readonly endAt: Date;
}

/**
 * Materialise the next-7-days resolved availability summary. Walks
 * the calendar starting at `from` (in the provider's local timezone
 * sense — we use UTC date math because every comparison stays
 * timezone-naive), drops dates covered by an exclusion row, and
 * emits one entry per surviving recurring window.
 *
 * **External-calendar union (TS-206).** When `externalBusy` +
 * `timeZone` are supplied, a recurring window occurrence is dropped
 * when its real UTC interval overlaps ANY external busy interval —
 * the provider has a commitment that overlaps that slot. The window's
 * local `HH:MM` start/end are materialised into UTC instants using the
 * provider's IANA `timeZone` (via the `Intl`-offset technique — no
 * external tz library) before testing overlap. The union is
 * conservative at window granularity: any overlap drops the WHOLE
 * occurrence (a short external block shadows the surrounding window).
 * Sub-window splitting is TS-206-followup-7; this is the safe direction
 * for a "could be free this week" search signal. When the timezone
 * conversion fails (an unparseable zone), the entry is KEPT — we do not
 * over-block on a tz edge case.
 *
 * Exported as a pure helper so the discovery-snapshot service can
 * import it without taking a dependency on the full
 * `AvailabilityService` graph.
 */
export function resolveNextSevenDays(input: {
  readonly from: Date;
  readonly windows: readonly ProviderAvailabilityWindow[];
  readonly exceptions: readonly ProviderAvailabilityException[];
  readonly externalBusy?: readonly ExternalBusyInterval[];
  readonly timeZone?: string;
}): ReadonlyArray<{
  readonly date: string;
  readonly weekday: ProviderAvailabilityWeekday;
  readonly startTime: string;
  readonly endTime: string;
}> {
  if (input.windows.length === 0) return [];

  const blockedDates = new Set(input.exceptions.map((exception) => exception.date));
  const busy = input.externalBusy ?? [];
  const timeZone = input.timeZone;
  const applyExternal = busy.length > 0 && timeZone !== undefined;

  const entries: Array<{
    date: string;
    weekday: ProviderAvailabilityWeekday;
    startTime: string;
    endTime: string;
  }> = [];

  const cursor = new Date(
    Date.UTC(
      input.from.getUTCFullYear(),
      input.from.getUTCMonth(),
      input.from.getUTCDate(),
      0,
      0,
      0,
      0,
    ),
  );
  for (let i = 0; i < 7; i++) {
    const dateStr = calendarDateToString(cursor);
    if (!blockedDates.has(dateStr)) {
      const weekday = PROVIDER_AVAILABILITY_WEEKDAY_VALUES[cursor.getUTCDay()];
      if (weekday !== undefined) {
        for (const window of input.windows) {
          if (window.weekday !== weekday) continue;
          if (
            applyExternal &&
            timeZone !== undefined &&
            windowOccurrenceOverlapsBusy(dateStr, window.startTime, window.endTime, timeZone, busy)
          ) {
            continue;
          }
          entries.push({
            date: dateStr,
            weekday,
            startTime: window.startTime,
            endTime: window.endTime,
          });
        }
      }
    }
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }

  // Sort by (date, startTime) to keep the projection deterministic.
  return entries.sort((a, b) => {
    if (a.date !== b.date) return a.date.localeCompare(b.date);
    return a.startTime.localeCompare(b.startTime);
  });
}

/**
 * True when a recurring window occurrence (a local `date` + `HH:MM`
 * start/end in `timeZone`) overlaps any external busy interval. Returns
 * false (do not block) when the timezone conversion fails — we never
 * over-block on a tz edge case for the "could be free" search signal.
 *
 * Half-open overlap: `[s1, e1)` overlaps `[s2, e2)` iff `s1 < e2 &&
 * s2 < e1`.
 */
export function windowOccurrenceOverlapsBusy(
  date: string,
  startTime: string,
  endTime: string,
  timeZone: string,
  busy: readonly ExternalBusyInterval[],
): boolean {
  const startUtc = zonedWallClockToUtc(date, startTime, timeZone);
  const endUtc = zonedWallClockToUtc(date, endTime, timeZone);
  if (startUtc === null || endUtc === null) return false;
  const s1 = startUtc.getTime();
  const e1 = endUtc.getTime();
  for (const interval of busy) {
    if (s1 < interval.endAt.getTime() && interval.startAt.getTime() < e1) {
      return true;
    }
  }
  return false;
}

/**
 * Convert a local wall-clock (`YYYY-MM-DD` + `HH:MM`) in an IANA
 * `timeZone` into the real UTC instant — DST-correct, no external tz
 * library. Uses the standard two-pass `Intl`-offset technique: format a
 * UTC guess in the target zone to recover the zone's offset at that
 * instant, then refine once for the DST-boundary case. Returns null on
 * an unparseable date/time/zone.
 */
export function zonedWallClockToUtc(date: string, time: string, timeZone: string): Date | null {
  const year = Number.parseInt(date.slice(0, 4), 10);
  const month = Number.parseInt(date.slice(5, 7), 10);
  const day = Number.parseInt(date.slice(8, 10), 10);
  const colon = time.indexOf(':');
  const hours = Number.parseInt(time.slice(0, colon), 10);
  const minutes = Number.parseInt(time.slice(colon + 1), 10);
  if (
    !Number.isFinite(year) ||
    !Number.isFinite(month) ||
    !Number.isFinite(day) ||
    !Number.isFinite(hours) ||
    !Number.isFinite(minutes)
  ) {
    return null;
  }

  const wallClockAsUtc = Date.UTC(year, month - 1, day, hours, minutes, 0, 0);
  try {
    const offset1 = zoneOffsetMs(new Date(wallClockAsUtc), timeZone);
    let utcMs = wallClockAsUtc - offset1;
    const offset2 = zoneOffsetMs(new Date(utcMs), timeZone);
    if (offset2 !== offset1) {
      utcMs = wallClockAsUtc - offset2;
    }
    return new Date(utcMs);
  } catch {
    return null;
  }
}

/**
 * The offset (ms) of `timeZone` from UTC at the given instant —
 * `localWallClock - UTC`. Computed by formatting the instant in the
 * target zone and reading back the wall-clock components.
 */
function zoneOffsetMs(instant: Date, timeZone: string): number {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const parts = dtf.formatToParts(instant);
  const lookup: Record<string, number> = {};
  for (const part of parts) {
    if (part.type !== 'literal') {
      lookup[part.type] = Number.parseInt(part.value, 10);
    }
  }
  const asUtc = Date.UTC(
    lookup.year ?? 1970,
    (lookup.month ?? 1) - 1,
    lookup.day ?? 1,
    lookup.hour ?? 0,
    lookup.minute ?? 0,
    lookup.second ?? 0,
  );
  return asUtc - instant.getTime();
}

/**
 * Materialise a `ProviderAvailabilityRecord` DTO from a service
 * snapshot. Pulled out as a free function so the controller +
 * discovery service share one source of truth.
 */
export function toProviderAvailabilityRecord(
  snapshot: ProviderAvailabilitySnapshot,
): ProviderAvailabilityRecord {
  return {
    providerId: snapshot.providerId,
    timeZone: snapshot.timeZone,
    windows: snapshot.windows.map((window) => ({ ...window })),
    exceptions: snapshot.exceptions.map((exception) => ({ ...exception })),
    updatedAt: snapshot.updatedAt.toISOString(),
  };
}
