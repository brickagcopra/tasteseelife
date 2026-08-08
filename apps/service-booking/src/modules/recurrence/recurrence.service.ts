import { randomUUID } from 'node:crypto';

import { Injectable, Logger } from '@nestjs/common';
import {
  BOOKING_CREATED,
  type BookingServiceKind,
  type CreateRecurringBookingRequest,
  RECURRENCE_MAX_OCCURRENCES,
} from '@taste-and-see/contracts';
import { OutboxService, type OutboxRawExecutor } from '@taste-and-see/nest-outbox';

import { computeCommissionMinor, minorToDecimalString, ratioFromBps } from '../../common/money';
import { err, ok, type Result } from '../../common/result';
import { BookingMetrics } from '../../observability/booking-metrics';
import { PrismaService, type PrismaTransactionClient } from '../../prisma/prisma.service';
import type { BookingRecord } from '../bookings/services/bookings.service';
import { SubjectHoldsService } from '../subject-holds/services/subject-holds.service';
import type { BookingSubjectHoldKind } from '../subject-holds/subject-hold-kinds';
import {
  expandRrule,
  parseRrule,
  type RruleExpanderFailure,
  type RruleExpansionWarning,
} from './rrule-expander';

/**
 * Recurrence orchestration (TS-061; PRD §6.3).
 *
 * Exposes one entry point: `createRecurringSeries`. The service:
 *
 *   1. Parses the RRULE through the pure expander (validates the
 *      Phase-1 subset — FREQ=WEEKLY|MONTHLY + INTERVAL + COUNT|UNTIL).
 *
 *   2. Expands the RRULE anchored on `scheduledStart` into a list of
 *      occurrence start dates. The expander caps the series at
 *      `RECURRENCE_MAX_OCCURRENCES = 52` and emits warnings for
 *      monthly-day-overflow + cap-hit which the service logs.
 *
 *   3. Inserts every materialised child `bookings` row + the single
 *      `booking_recurrence` row inside ONE Prisma `$transaction` so
 *      partial series never reach the database (atomic explode).
 *      Every child carries the same `seriesId`; `seriesIndex` is the
 *      0-based position in chronological order.
 *
 *   4. Emits one `booking.created` outbox event per child inside the
 *      same transaction so consumers see every materialised
 *      occurrence exactly once (outbox invariant per PDD §7.3).
 *
 * **Why one bookings row per planned visit.** The lifecycle state
 * machine (TS-060) operates per visit — a senior may cancel the
 * Tuesday visit without disrupting the rest of the series. PRD §6.3
 * explicitly says "Recurring bookings (weekly, biweekly, monthly)"
 * which maps cleanly to the per-visit granularity model. The
 * recurrence row is the planning intent that drives future
 * "edit the series" UX (TS-061-followup).
 *
 * **Tier gating + row-level access.** Both checks are inherited from
 * `BookingsService` semantics — the controller-supplied
 * `actorUserId` flows through, and the cross-service membership
 * gates land with TS-141 / TS-064 (same gap captured on the per-
 * booking surface). The service trusts the controller's
 * authenticated user id today.
 *
 * **Money math.** Money fields cross from the request as integer
 * minor units (cents), are converted to `Decimal(12,2)` exactly once
 * at the persistence boundary (CLAUDE.md §6 / §17.6). Every
 * occurrence gets the same money fields — Phase-1 product decision
 * since the recurrence pattern itself doesn't price-discriminate
 * across positions. A future per-occurrence pricing override surface
 * can land additively.
 */

export interface CreateRecurringSeriesInput {
  readonly actorUserId: string;
  readonly request: CreateRecurringBookingRequest;
}

export interface CreateRecurringSeriesResult {
  readonly seriesId: string;
  readonly bookings: ReadonlyArray<BookingRecord>;
  readonly recurrence: PersistedBookingRecurrence;
}

/**
 * Local mirror of the Prisma-generated `BookingRecurrence` row. Same
 * TS-021-followup-2 root cause documented across the codebase — TS-061-
 * followup-9 drops this mirror when Prisma 5.23 / 6.x resolves the
 * namespace value-side cleanly. The mapper layer converts to the
 * public `BookingRecurrenceRecord` contract.
 */
export interface PersistedBookingRecurrence {
  readonly seriesId: string;
  readonly rrule: string;
  readonly endDate: Date | null;
  readonly count: number | null;
  readonly occurrenceCount: number;
  readonly householdId: string;
  readonly seniorId: string;
  readonly providerId: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export type RecurrenceServiceFailure =
  | { readonly reason: 'invalid_request'; readonly message: string }
  | {
      readonly reason: 'invalid_rrule';
      readonly detail: RruleExpanderFailure;
    }
  | { readonly reason: 'empty_series'; readonly message: string }
  | { readonly reason: 'outbox_validation_failed'; readonly message: string }
  /**
   * A trust & safety hold covers the series' provider, senior, or household
   * (TS-304; PRD §10.14; CLAUDE.md §12). Screened ONCE for the whole series
   * rather than per occurrence: the subjects are identical across every
   * child, and a held subject must not get 52 materialised visits queued
   * behind a review that has not happened yet.
   *
   * Same shape and the same disclosure discipline as
   * `BookingsServiceFailure['subject_on_hold']` — ids only, no category and
   * no free text, because this failure is rendered to a family member.
   */
  | {
      readonly reason: 'subject_on_hold';
      readonly incidentId: string;
      readonly subjectKind: BookingSubjectHoldKind;
    };

@Injectable()
export class RecurrenceService {
  private readonly logger = new Logger(RecurrenceService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly outbox: OutboxService,
    private readonly metrics: BookingMetrics,
    // TS-304 — the trust & safety hold screen, consulted once per series.
    private readonly subjectHolds: SubjectHoldsService,
  ) {}

  async createRecurringSeries(
    input: CreateRecurringSeriesInput,
  ): Promise<Result<CreateRecurringSeriesResult, RecurrenceServiceFailure>> {
    // TS-060-followup-4a — every materialised child fans
    // `booking_created_total{outcome=created}` once (see the success path
    // below) so the create funnel reads total volume (single + recurring
    // children). The series-level input failures (`invalid_rrule`,
    // `empty_series`) fold onto the shared `invalid_request` outcome here —
    // the recurrence-specific failure taxonomy is the dedicated
    // `recurrence_series_created_total` counter in TS-061-followup-5.
    if (input.actorUserId.length === 0) {
      this.metrics.recordCreated('invalid_request');
      return err({ reason: 'invalid_request', message: 'actorUserId is required' });
    }
    const req = input.request;

    // TS-304 — trust & safety hold screen (PRD §10.14; CLAUDE.md §12).
    // Before the RRULE is even parsed: expanding a 52-occurrence series for
    // a subject under review is wasted work at best, and the failure the
    // caller deserves is "this subject is on hold", not "your RRULE has an
    // unsupported clause". One screen covers the whole series — every child
    // shares the same three subjects.
    const holds = await this.subjectHolds.screenSubjects({
      providerId: req.providerId,
      seniorId: req.seniorId,
      householdId: req.householdId,
    });
    const blockingHold = holds[0];
    if (blockingHold !== undefined) {
      this.metrics.recordCreated('subject_on_hold');
      this.logger.warn(
        `recurrence.create refused — subject_on_hold actorUserId=${input.actorUserId} incidentId=${blockingHold.incidentId} subjectKind=${blockingHold.subjectKind} household=${req.householdId} provider=${req.providerId}`,
      );
      return err({
        reason: 'subject_on_hold',
        incidentId: blockingHold.incidentId,
        subjectKind: blockingHold.subjectKind,
      });
    }

    // 1. Parse the RRULE.
    const parsed = parseRrule(req.recurrence.rrule);
    if (!parsed.ok) {
      this.metrics.recordCreated('invalid_request');
      return err({ reason: 'invalid_rrule', detail: parsed.error });
    }

    // 2. Expand against the anchor.
    const dtstart = new Date(req.scheduledStart);
    const dtend = new Date(req.scheduledEnd);
    const visitDurationMs = dtend.getTime() - dtstart.getTime();
    const expansion = expandRrule(parsed.value, dtstart);
    if (expansion.occurrences.length === 0) {
      this.metrics.recordCreated('invalid_request');
      return err({
        reason: 'empty_series',
        message: 'RRULE produced zero occurrences (likely dtstart > UNTIL)',
      });
    }

    // Log expander warnings — telemetry for the monthly-day-overflow
    // skip and the global-cap truncation. Both are non-fatal but
    // worth surfacing so ops can spot mis-configured series.
    for (const w of expansion.warnings) {
      this.logExpanderWarning(w);
    }

    const basePriceMinor = req.basePriceMinor;
    const commissionRateBps = req.commissionRateBps;
    const commissionAmountMinor = computeCommissionMinor(basePriceMinor, commissionRateBps);
    const finalPriceMinor = basePriceMinor;

    const seriesId = `srs_${randomUUID().replace(/-/g, '').slice(0, 24)}`;
    const now = new Date();

    try {
      const persisted = await this.prisma.$transaction(async (tx: PrismaTransactionClient) => {
        // 3a. Insert the recurrence row first so the FK invariant (every
        //     child carries a series_id matching an extant recurrence
        //     row) is satisfied at every intermediate state. The DB does
        //     NOT have a hard FK (recurrence ↔ bookings) but the
        //     ordering keeps the invariant readable.
        const recurrenceRow = (await tx.bookingRecurrence.create({
          data: {
            seriesId,
            rrule: req.recurrence.rrule,
            ...(parsed.value.until !== null && { endDate: parsed.value.until }),
            ...(parsed.value.count !== null && { count: parsed.value.count }),
            occurrenceCount: expansion.occurrences.length,
            householdId: req.householdId,
            seniorId: req.seniorId,
            providerId: req.providerId,
          },
        })) as PersistedBookingRecurrence;

        // 3b. Materialise every child booking + emit the matching
        //     outbox event in the same transaction. Sequential by
        //     design — `series_index` is the position in the
        //     occurrence list and must reflect chronological order;
        //     parallel insert would not guarantee that.
        const created: BookingRecord[] = [];
        for (let i = 0; i < expansion.occurrences.length; i += 1) {
          const occurrenceStart = expansion.occurrences[i];
          if (occurrenceStart === undefined) {
            // Unreachable — bounded loop over a finite array — but
            // TS narrowing wants the guard.
            continue;
          }
          const occurrenceEnd = new Date(occurrenceStart.getTime() + visitDurationMs);
          const bookingId = `bkg_${randomUUID().replace(/-/g, '').slice(0, 24)}`;

          const row = (await tx.booking.create({
            data: {
              id: bookingId,
              householdId: req.householdId,
              seniorId: req.seniorId,
              providerId: req.providerId,
              serviceKind: req.serviceKind,
              status: 'pending',
              scheduledStart: occurrenceStart,
              scheduledEnd: occurrenceEnd,
              currency: req.currency,
              basePrice: minorToDecimalString(basePriceMinor),
              commissionRate: ratioFromBps(commissionRateBps),
              commissionAmount: minorToDecimalString(commissionAmountMinor),
              finalPrice: minorToDecimalString(finalPriceMinor),
              ...(req.bookingNotes !== undefined && { bookingNotes: req.bookingNotes }),
              seriesId,
              seriesIndex: i,
            },
          })) as BookingRecord;
          created.push(row);

          // TS-305d-followup-2b1b — `eventId` must be passed at the TOP LEVEL of
          // `append()`, not only inside `payload`. `OutboxService` writes
          // `args.eventId ?? this.options.idGenerator()` into the `event_id`
          // column, the relay publishes THAT id onto the stream, and consumers
          // dedup on it. With the booking id only in the payload the column held
          // a random value, so the `ON CONFLICT (event_id) DO NOTHING` guard the
          // sibling call site's comment claims ("keeps create+event 1:1") was not
          // in force for `booking.created`. The payload field stays — the event
          // envelope schema requires it — and the two now agree.
          const appendResult = await this.outbox.append(tx as unknown as OutboxRawExecutor, {
            eventName: BOOKING_CREATED,
            eventId: bookingId,
            payload: {
              eventId: bookingId,
              occurredAt: now.toISOString(),
              bookingId: row.id,
              householdId: row.householdId,
              seniorId: row.seniorId,
              providerId: row.providerId,
              serviceKind: row.serviceKind as BookingServiceKind,
              scheduledStart: row.scheduledStart.toISOString(),
              scheduledEnd: row.scheduledEnd.toISOString(),
              currency: row.currency,
              basePriceMinor,
              commissionRateBps,
              commissionAmountMinor,
              finalPriceMinor,
            },
          });
          if (appendResult.kind !== 'appended') {
            throw new OutboxValidationFailedError(appendResult.eventName, appendResult.issues);
          }
        }

        return { recurrence: recurrenceRow, bookings: created };
      });

      // Fan `booking_created_total{outcome=created}` once per materialised
      // child AFTER the transaction commits — never inside it, so a rolled-
      // back partial series (e.g. an outbox failure on child 3 of 5) does not
      // leave phantom increments (TS-060-followup-4a).
      for (let i = 0; i < persisted.bookings.length; i += 1) {
        this.metrics.recordCreated('created');
      }
      this.logger.log(
        `booking.recurring_series_created seriesId=${seriesId} householdId=${req.householdId} ` +
          `providerId=${req.providerId} occurrences=${persisted.bookings.length}`,
      );
      return ok({
        seriesId,
        bookings: persisted.bookings,
        recurrence: persisted.recurrence,
      });
    } catch (e) {
      if (e instanceof OutboxValidationFailedError) {
        this.metrics.recordCreated('outbox_validation_failed');
        this.logger.error(
          `booking.recurring_series_create outbox validation failed event=${e.eventName}`,
        );
        return err({
          reason: 'outbox_validation_failed',
          message: `event ${e.eventName} payload failed validation`,
        });
      }
      throw e;
    }
  }

  private logExpanderWarning(w: RruleExpansionWarning): void {
    switch (w.kind) {
      case 'monthly_day_overflow':
        this.logger.warn(`recurrence.monthly_day_overflow skippedAt=${w.skippedAt.toISOString()}`);
        break;
      case 'occurrence_cap_reached':
        this.logger.warn(`recurrence.occurrence_cap_reached cap=${RECURRENCE_MAX_OCCURRENCES}`);
        break;
    }
  }
}

class OutboxValidationFailedError extends Error {
  constructor(
    readonly eventName: string,
    readonly issues: ReadonlyArray<{
      readonly path: ReadonlyArray<string | number>;
      readonly message: string;
    }>,
  ) {
    super(
      `outbox.append validation failed for ${eventName}: ${issues.map((i) => i.message).join('; ')}`,
    );
    this.name = 'OutboxValidationFailedError';
  }
}
