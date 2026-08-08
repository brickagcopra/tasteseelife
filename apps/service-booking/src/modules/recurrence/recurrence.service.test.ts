import type { Logger } from '@nestjs/common';
import type { CreateRecurringBookingRequest } from '@taste-and-see/contracts';
import type { OutboxRawExecutor } from '@taste-and-see/nest-outbox';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { BookingMetrics } from '../../observability/booking-metrics';
import type { PrismaService, PrismaTransactionClient } from '../../prisma/prisma.service';
import {
  RecurrenceService,
  type CreateRecurringSeriesInput,
  type PersistedBookingRecurrence,
} from './recurrence.service';
import type { BookingRecord } from '../bookings/services/bookings.service';
import type {
  ActiveSubjectHold,
  SubjectHoldsService,
} from '../subject-holds/services/subject-holds.service';

/**
 * RecurrenceService unit suite (TS-061).
 *
 * The service explodes an RRULE into a finite list of `bookings`
 * rows + a single `booking_recurrence` row inside one Prisma
 * `$transaction` + one `booking.created` outbox event per child. The
 * tests use an in-memory FakePrisma + FakeOutbox (mirroring the
 * BookingsService test pattern) so we can deterministically assert:
 *
 *   - Every materialised occurrence carries the same `seriesId`.
 *   - `seriesIndex` is the 0-based chronological position.
 *   - The recurrence row's `occurrenceCount` matches the materialised
 *     bookings count.
 *   - `endDate` / `count` are populated correctly from the parsed RRULE.
 *   - Money fields cross from minor-units → Decimal strings correctly.
 *   - Visit duration is preserved across every occurrence.
 *   - One outbox `booking.created` event lands per child, in order.
 *   - RRULE parse failures surface as `invalid_rrule` with the right
 *     expander failure variant.
 *   - Empty series (dtstart > UNTIL) surfaces as `empty_series`.
 *   - Outbox validation failure surfaces as `outbox_validation_failed`
 *     and the transaction does NOT continue past the failing append.
 */

interface FakeBookingRow extends BookingRecord {
  basePrice: { toString(): string };
  commissionRate: { toString(): string };
  commissionAmount: { toString(): string };
  finalPrice: { toString(): string };
  seriesId?: string | null;
  seriesIndex?: number | null;
}

class FakePrisma {
  public bookings: FakeBookingRow[] = [];
  public recurrences: PersistedBookingRecurrence[] = [];
  private bookingIdCounter = 0;

  booking = {
    create: vi.fn(async (args: { data: Record<string, unknown> }): Promise<FakeBookingRow> => {
      this.bookingIdCounter += 1;
      const data = args.data;
      const row: FakeBookingRow = {
        id: (data['id'] as string) ?? `bkg_fake_${this.bookingIdCounter}`,
        householdId: data['householdId'] as string,
        seniorId: data['seniorId'] as string,
        providerId: data['providerId'] as string,
        serviceKind: data['serviceKind'] as FakeBookingRow['serviceKind'],
        status: 'pending',
        scheduledStart: data['scheduledStart'] as Date,
        scheduledEnd: data['scheduledEnd'] as Date,
        currency: data['currency'] as string,
        basePrice: wrapDecimal(data['basePrice'] as string),
        commissionRate: wrapDecimal(data['commissionRate'] as string),
        commissionAmount: wrapDecimal(data['commissionAmount'] as string),
        finalPrice: wrapDecimal(data['finalPrice'] as string),
        bookingNotes: (data['bookingNotes'] as string | undefined) ?? null,
        completedAt: null,
        canceledAt: null,
        cancellationReason: null,
        cancellationReasonText: null,
        acceptWindowExpiresAt: (data['acceptWindowExpiresAt'] as Date | undefined) ?? null,
        declinedAt: null,
        declineKind: null,
        declineReason: null,
        declineReasonText: null,
        declinedByUserId: null,
        heldByIncidentId: null,
        createdAt: new Date('2026-05-13T12:00:00.000Z'),
        updatedAt: new Date('2026-05-13T12:00:00.000Z'),
        seriesId: (data['seriesId'] as string | undefined) ?? null,
        seriesIndex: (data['seriesIndex'] as number | undefined) ?? null,
      };
      this.bookings.push(row);
      return row;
    }),
  };

  bookingRecurrence = {
    create: vi.fn(
      async (args: { data: Record<string, unknown> }): Promise<PersistedBookingRecurrence> => {
        const data = args.data;
        const row: PersistedBookingRecurrence = {
          seriesId: data['seriesId'] as string,
          rrule: data['rrule'] as string,
          endDate: (data['endDate'] as Date | undefined) ?? null,
          count: (data['count'] as number | undefined) ?? null,
          occurrenceCount: data['occurrenceCount'] as number,
          householdId: data['householdId'] as string,
          seniorId: data['seniorId'] as string,
          providerId: data['providerId'] as string,
          createdAt: new Date('2026-05-13T12:00:00.000Z'),
          updatedAt: new Date('2026-05-13T12:00:00.000Z'),
        };
        this.recurrences.push(row);
        return row;
      },
    ),
  };

  $transaction = vi.fn(async <T>(fn: (tx: PrismaTransactionClient) => Promise<T>): Promise<T> => {
    return fn(this as unknown as PrismaTransactionClient);
  });

  public executeRawCalls: Array<{ segments: readonly string[]; values: readonly unknown[] }> = [];
  $executeRaw = vi.fn(
    async (strings: TemplateStringsArray, ...values: unknown[]): Promise<number> => {
      this.executeRawCalls.push({ segments: [...strings], values });
      return 1;
    },
  );
}

function wrapDecimal(value: string): { toString(): string } {
  return { toString: () => value };
}

class FakeOutboxService {
  public appendCalls: Array<{
    tx: OutboxRawExecutor;
    args: { eventName: string; payload: unknown };
  }> = [];
  public nextResultOverride: 'validation_failed' | null = null;

  append = vi.fn(
    async (
      tx: OutboxRawExecutor,
      args: { eventName: string; payload: unknown },
    ): Promise<
      | { kind: 'appended'; eventId: string; eventName: string; occurredAt: Date }
      | {
          kind: 'validation_failed';
          eventName: string;
          issues: ReadonlyArray<{ path: ReadonlyArray<string | number>; message: string }>;
        }
    > => {
      this.appendCalls.push({ tx, args });
      if (this.nextResultOverride === 'validation_failed') {
        this.nextResultOverride = null;
        return {
          kind: 'validation_failed',
          eventName: args.eventName,
          issues: [{ path: ['payload'], message: 'forced failure' }],
        };
      }
      return {
        kind: 'appended',
        eventId: `evt_${args.eventName}_fake`,
        eventName: args.eventName,
        occurredAt: new Date('2026-05-13T12:00:00.000Z'),
      };
    },
  );
}

function buildSvc(): {
  service: RecurrenceService;
  prisma: FakePrisma;
  outbox: FakeOutboxService;
  metrics: BookingMetrics;
  subjectHolds: FakeSubjectHoldsService;
} {
  const prisma = new FakePrisma();
  const outbox = new FakeOutboxService();
  // Real `BookingMetrics` (no-op meter; serialization proven in
  // booking-metrics.test.ts), spied so the per-child fan + failure arms can
  // be asserted by call count + outcome label.
  const metrics = new BookingMetrics();
  vi.spyOn(metrics, 'recordCreated');
  const subjectHolds = new FakeSubjectHoldsService();
  const service = new RecurrenceService(
    prisma as unknown as PrismaService,
    outbox as unknown as import('@taste-and-see/nest-outbox').OutboxService,
    metrics,
    subjectHolds as unknown as SubjectHoldsService,
  );
  const log = (service as unknown as { logger: Logger }).logger;
  log.log = vi.fn();
  log.warn = vi.fn();
  log.error = vi.fn();
  log.debug = vi.fn();
  return { service, prisma, outbox, metrics, subjectHolds };
}

/**
 * Fake hold screen (TS-304). Empty by default — the vast majority of
 * bookings are unheld, so the default keeps every pre-existing assertion
 * meaningful. Push an `ActiveSubjectHold` to exercise the refusal.
 */
class FakeSubjectHoldsService {
  holds: ActiveSubjectHold[] = [];
  readonly screened: Array<{
    providerId: string | null;
    seniorId: string | null;
    householdId: string | null;
  }> = [];

  screenSubjects = async (subjects: {
    providerId: string | null;
    seniorId: string | null;
    householdId: string | null;
  }): Promise<ActiveSubjectHold[]> => {
    this.screened.push(subjects);
    return this.holds;
  };
}

const ACTIVE_HOLD: ActiveSubjectHold = {
  incidentId: 'inc_hold_1',
  subjectKind: 'provider',
  subjectId: 'prv_1',
  severity: 'critical',
  category: 'safety',
  heldAt: new Date('2026-07-26T09:00:00.000Z'),
};

const VALID_WEEKLY_REQUEST: CreateRecurringBookingRequest = {
  householdId: 'hh_abc',
  seniorId: 'sr_abc',
  providerId: 'prv_abc',
  serviceKind: 'companion_dining',
  scheduledStart: '2026-05-14T18:00:00.000Z',
  scheduledEnd: '2026-05-14T20:00:00.000Z',
  currency: 'USD',
  basePriceMinor: 15_000,
  commissionRateBps: 3000,
  recurrence: { rrule: 'FREQ=WEEKLY;COUNT=4' },
};

const VALID_INPUT: CreateRecurringSeriesInput = {
  actorUserId: 'usr_owner',
  request: VALID_WEEKLY_REQUEST,
};

describe('RecurrenceService.createRecurringSeries', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('explodes a weekly RRULE into the expected child bookings inside one transaction', async () => {
    const { service, prisma, outbox } = buildSvc();

    const result = await service.createRecurringSeries(VALID_INPUT);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.bookings).toHaveLength(4);
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(prisma.booking.create).toHaveBeenCalledTimes(4);
    expect(prisma.bookingRecurrence.create).toHaveBeenCalledTimes(1);
    expect(outbox.append).toHaveBeenCalledTimes(4);
  });

  it('assigns the same seriesId to every child and a 0-based seriesIndex in chronological order', async () => {
    const { service, prisma } = buildSvc();

    const result = await service.createRecurringSeries(VALID_INPUT);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const seriesId = result.value.seriesId;
    expect(seriesId).toMatch(/^srs_/);
    for (let i = 0; i < prisma.bookings.length; i += 1) {
      const row = prisma.bookings[i]!;
      expect(row.seriesId).toBe(seriesId);
      expect(row.seriesIndex).toBe(i);
    }
    // Chronological order — Thursday May 14, May 21, May 28, June 4.
    expect(prisma.bookings.map((b) => b.scheduledStart.toISOString())).toEqual([
      '2026-05-14T18:00:00.000Z',
      '2026-05-21T18:00:00.000Z',
      '2026-05-28T18:00:00.000Z',
      '2026-06-04T18:00:00.000Z',
    ]);
  });

  it('preserves the per-occurrence visit duration across the series', async () => {
    const { service, prisma } = buildSvc();
    await service.createRecurringSeries(VALID_INPUT);
    // 2-hour visits — every child row should have scheduledEnd ===
    // scheduledStart + 2h.
    for (const row of prisma.bookings) {
      const duration = row.scheduledEnd.getTime() - row.scheduledStart.getTime();
      expect(duration).toBe(2 * 60 * 60 * 1000);
    }
  });

  it('persists the recurrence row with occurrenceCount + COUNT termination', async () => {
    const { service, prisma } = buildSvc();
    const result = await service.createRecurringSeries(VALID_INPUT);
    expect(result.ok).toBe(true);

    expect(prisma.recurrences).toHaveLength(1);
    const rec = prisma.recurrences[0]!;
    expect(rec.rrule).toBe('FREQ=WEEKLY;COUNT=4');
    expect(rec.count).toBe(4);
    expect(rec.endDate).toBeNull();
    expect(rec.occurrenceCount).toBe(4);
    expect(rec.householdId).toBe('hh_abc');
  });

  it('persists the recurrence row with endDate for an UNTIL termination', async () => {
    const { service, prisma } = buildSvc();

    const result = await service.createRecurringSeries({
      actorUserId: 'usr_owner',
      request: {
        ...VALID_WEEKLY_REQUEST,
        recurrence: { rrule: 'FREQ=WEEKLY;UNTIL=20260601T000000Z' },
      },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const rec = prisma.recurrences[0]!;
    expect(rec.count).toBeNull();
    expect(rec.endDate?.toISOString()).toBe('2026-06-01T00:00:00.000Z');
    // May 14, May 21, May 28 fit; Jun 4 18:00 > Jun 1 00:00 — three
    // occurrences.
    expect(rec.occurrenceCount).toBe(3);
    expect(result.value.bookings).toHaveLength(3);
  });

  it('converts minor-unit money fields into Decimal strings exactly once at the persistence boundary', async () => {
    const { service, prisma } = buildSvc();
    await service.createRecurringSeries(VALID_INPUT);
    // Every child gets the same money — Phase-1 product decision.
    for (const row of prisma.bookings) {
      expect(row.basePrice.toString()).toBe('150.00');
      expect(row.commissionRate.toString()).toBe('0.3000');
      expect(row.commissionAmount.toString()).toBe('45.00');
      expect(row.finalPrice.toString()).toBe('150.00');
    }
  });

  it('emits one booking.created event per child carrying the matching minor-unit payload', async () => {
    const { service, outbox } = buildSvc();
    await service.createRecurringSeries(VALID_INPUT);
    expect(outbox.appendCalls).toHaveLength(4);
    for (const call of outbox.appendCalls) {
      expect(call.args.eventName).toBe('booking.created');
      const payload = call.args.payload as Record<string, unknown>;
      expect(payload['basePriceMinor']).toBe(15_000);
      expect(payload['commissionAmountMinor']).toBe(4_500);
      expect(payload['finalPriceMinor']).toBe(15_000);
      expect(payload['currency']).toBe('USD');
    }
  });

  it('rejects an empty actorUserId with invalid_request', async () => {
    const { service } = buildSvc();
    const result = await service.createRecurringSeries({ ...VALID_INPUT, actorUserId: '' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.reason).toBe('invalid_request');
  });

  it('surfaces RRULE parse failures as invalid_rrule with the expander failure detail', async () => {
    const { service } = buildSvc();
    const result = await service.createRecurringSeries({
      actorUserId: 'usr_owner',
      request: {
        ...VALID_WEEKLY_REQUEST,
        recurrence: { rrule: 'FREQ=DAILY;COUNT=3' },
      },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.reason).toBe('invalid_rrule');
    if (result.error.reason === 'invalid_rrule') {
      expect(result.error.detail.reason).toBe('unsupported_frequency');
    }
  });

  it('surfaces an empty series (dtstart > UNTIL) as empty_series', async () => {
    const { service } = buildSvc();
    const result = await service.createRecurringSeries({
      actorUserId: 'usr_owner',
      request: {
        ...VALID_WEEKLY_REQUEST,
        recurrence: { rrule: 'FREQ=WEEKLY;UNTIL=20260101T000000Z' },
      },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.reason).toBe('empty_series');
  });

  it('rolls back when the outbox validation fails on the first child', async () => {
    const { service, outbox } = buildSvc();
    outbox.nextResultOverride = 'validation_failed';

    const result = await service.createRecurringSeries(VALID_INPUT);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.reason).toBe('outbox_validation_failed');
    // First append rejected — no further appends after the throw.
    expect(outbox.append).toHaveBeenCalledTimes(1);
  });

  it('honours INTERVAL=2 (biweekly) end-to-end', async () => {
    const { service, prisma } = buildSvc();
    const result = await service.createRecurringSeries({
      actorUserId: 'usr_owner',
      request: {
        ...VALID_WEEKLY_REQUEST,
        recurrence: { rrule: 'FREQ=WEEKLY;INTERVAL=2;COUNT=3' },
      },
    });
    expect(result.ok).toBe(true);
    expect(prisma.bookings.map((b) => b.scheduledStart.toISOString())).toEqual([
      '2026-05-14T18:00:00.000Z',
      '2026-05-28T18:00:00.000Z',
      '2026-06-11T18:00:00.000Z',
    ]);
  });

  it('handles MONTHLY series with day-of-month preserved', async () => {
    const { service, prisma } = buildSvc();
    const result = await service.createRecurringSeries({
      actorUserId: 'usr_owner',
      request: {
        ...VALID_WEEKLY_REQUEST,
        recurrence: { rrule: 'FREQ=MONTHLY;COUNT=3' },
      },
    });
    expect(result.ok).toBe(true);
    expect(prisma.bookings.map((b) => b.scheduledStart.toISOString())).toEqual([
      '2026-05-14T18:00:00.000Z',
      '2026-06-14T18:00:00.000Z',
      '2026-07-14T18:00:00.000Z',
    ]);
  });

  it('propagates bookingNotes verbatim to every child', async () => {
    const { service, prisma } = buildSvc();
    await service.createRecurringSeries({
      actorUserId: 'usr_owner',
      request: {
        ...VALID_WEEKLY_REQUEST,
        bookingNotes: 'Door code: 1234',
      },
    });
    for (const row of prisma.bookings) {
      expect(row.bookingNotes).toBe('Door code: 1234');
    }
  });
});

describe('RecurrenceService.createRecurringSeries domain metrics (TS-060-followup-4a)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('fans booking_created_total{outcome=created} once per materialised child', async () => {
    const { service, metrics } = buildSvc();

    await service.createRecurringSeries(VALID_INPUT); // FREQ=WEEKLY;COUNT=4

    expect(metrics.recordCreated).toHaveBeenCalledTimes(4);
    for (const call of vi.mocked(metrics.recordCreated).mock.calls) {
      expect(call[0]).toBe('created');
    }
  });

  it('records nothing under outcome=created when the series is rolled back', async () => {
    const { service, outbox, metrics } = buildSvc();
    outbox.nextResultOverride = 'validation_failed';

    await service.createRecurringSeries(VALID_INPUT);

    // The per-child fan runs only AFTER a successful commit, so a rolled-back
    // series leaves no phantom `created` increments — only the single
    // failure-arm increment lands.
    expect(metrics.recordCreated).toHaveBeenCalledTimes(1);
    expect(metrics.recordCreated).toHaveBeenCalledWith('outbox_validation_failed');
  });

  it('folds an invalid RRULE onto the invalid_request outcome (once)', async () => {
    const { service, metrics } = buildSvc();

    await service.createRecurringSeries({
      actorUserId: 'usr_owner',
      request: {
        ...VALID_WEEKLY_REQUEST,
        recurrence: { rrule: 'FREQ=DAILY;COUNT=3' },
      },
    });

    expect(metrics.recordCreated).toHaveBeenCalledTimes(1);
    expect(metrics.recordCreated).toHaveBeenCalledWith('invalid_request');
  });

  it('folds an empty series onto the invalid_request outcome (once)', async () => {
    const { service, metrics } = buildSvc();

    await service.createRecurringSeries({
      actorUserId: 'usr_owner',
      request: {
        ...VALID_WEEKLY_REQUEST,
        recurrence: { rrule: 'FREQ=WEEKLY;UNTIL=20260101T000000Z' },
      },
    });

    expect(metrics.recordCreated).toHaveBeenCalledTimes(1);
    expect(metrics.recordCreated).toHaveBeenCalledWith('invalid_request');
  });

  it('records invalid_request on an empty actorUserId', async () => {
    const { service, metrics } = buildSvc();

    await service.createRecurringSeries({ ...VALID_INPUT, actorUserId: '' });

    expect(metrics.recordCreated).toHaveBeenCalledTimes(1);
    expect(metrics.recordCreated).toHaveBeenCalledWith('invalid_request');
  });
});

/**
 * TS-304 — the trust & safety hold screen on the recurring-series create.
 *
 * The series path is the one where getting this wrong is most expensive: an
 * unscreened create materialises up to 52 visits for a subject under review.
 */
describe('RecurrenceService.createRecurringSeries — trust & safety holds (TS-304)', () => {
  it('screens the series subjects once', async () => {
    const { service, subjectHolds } = buildSvc();

    await service.createRecurringSeries(VALID_INPUT);

    expect(subjectHolds.screened).toEqual([
      { providerId: 'prv_abc', seniorId: 'sr_abc', householdId: 'hh_abc' },
    ]);
  });

  it('refuses the whole series when a hold covers a subject', async () => {
    const { service, subjectHolds } = buildSvc();
    subjectHolds.holds = [ACTIVE_HOLD];

    const result = await service.createRecurringSeries(VALID_INPUT);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toEqual({
        reason: 'subject_on_hold',
        incidentId: 'inc_hold_1',
        subjectKind: 'provider',
      });
    }
  });

  it('materialises NO occurrences and emits nothing when held', async () => {
    const { service, subjectHolds, prisma, outbox } = buildSvc();
    subjectHolds.holds = [ACTIVE_HOLD];

    await service.createRecurringSeries(VALID_INPUT);

    expect(prisma.bookings).toHaveLength(0);
    expect(outbox.appendCalls).toHaveLength(0);
  });

  it('refuses on the hold BEFORE the RRULE is parsed', async () => {
    // A held subject with a malformed RRULE gets the hold answer, not the
    // RRULE answer — otherwise the caller fixes their recurrence rule and
    // tries again, learning about the hold only on the second attempt.
    const { service, subjectHolds } = buildSvc();
    subjectHolds.holds = [ACTIVE_HOLD];

    const result = await service.createRecurringSeries({
      ...VALID_INPUT,
      request: { ...VALID_WEEKLY_REQUEST, recurrence: { rrule: 'FREQ=HOURLY;COUNT=4' } },
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.reason).toBe('subject_on_hold');
  });

  it('records the refusal on the create funnel', async () => {
    const { service, subjectHolds, metrics } = buildSvc();
    subjectHolds.holds = [ACTIVE_HOLD];

    await service.createRecurringSeries(VALID_INPUT);

    expect(metrics.recordCreated).toHaveBeenCalledWith('subject_on_hold');
  });

  it('creates the series normally when no hold applies', async () => {
    const { service, prisma } = buildSvc();

    const result = await service.createRecurringSeries(VALID_INPUT);

    expect(result.ok).toBe(true);
    expect(prisma.bookings).toHaveLength(4);
  });
});
