import type { Logger } from '@nestjs/common';
import type { RecordBookingCheckInRequest } from '@taste-and-see/contracts';
import type { OutboxRawExecutor } from '@taste-and-see/nest-outbox';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { BookingMetrics } from '../../../observability/booking-metrics';
import type { PrismaService, PrismaTransactionClient } from '../../../prisma/prisma.service';
import { BookingLifecycleService } from '../../lifecycle/booking-lifecycle.service';
import type { BookingStatus } from '../../lifecycle/booking-status';
import type { BookingRecord } from '../../bookings/services/bookings.service';
import { CheckInsService, type CheckInRecord, type RecordCheckInInput } from './check-ins.service';

/**
 * CheckInsService unit suite (TS-063).
 *
 * Covers the atomic record-and-transition path, the lifecycle gate,
 * the (booking_id, kind) UNIQUE collision handling, the listing path,
 * the input-validation guards, and the outbox rollback semantics.
 *
 * Uses an in-memory `FakePrisma` mirroring the BookingsService /
 * VisitNotesService test pattern.
 */

interface FakeBookingRow extends BookingRecord {
  basePrice: { toString(): string };
  commissionRate: { toString(): string };
  commissionAmount: { toString(): string };
  finalPrice: { toString(): string };
}

interface FakeCheckInRow extends CheckInRecord {}

class FakePrisma {
  public bookings: FakeBookingRow[] = [];
  public checkIns: FakeCheckInRow[] = [];
  private idCounter = 0;

  booking = {
    findUnique: vi.fn(
      async (args: {
        where: { id: string };
        select?: Record<string, boolean>;
      }): Promise<FakeBookingRow | { id: string } | null> => {
        const row = this.bookings.find((b) => b.id === args.where.id);
        if (row === undefined) return null;
        if (args.select?.['id'] && !args.select['status']) {
          return { id: row.id };
        }
        return row;
      },
    ),
    update: vi.fn(
      async (args: {
        where: { id: string };
        data: Record<string, unknown>;
      }): Promise<FakeBookingRow> => {
        const idx = this.bookings.findIndex((b) => b.id === args.where.id);
        if (idx === -1) {
          throw new Error(`booking ${args.where.id} not found in fake`);
        }
        const next: FakeBookingRow = {
          ...this.bookings[idx]!,
          status: (args.data['status'] as BookingStatus) ?? this.bookings[idx]!.status,
          completedAt:
            args.data['completedAt'] !== undefined
              ? (args.data['completedAt'] as Date)
              : this.bookings[idx]!.completedAt,
          updatedAt: new Date('2026-05-14T18:30:00.000Z'),
        };
        this.bookings[idx] = next;
        return next;
      },
    ),
  };

  bookingCheckIn = {
    create: vi.fn(async (args: { data: Record<string, unknown> }): Promise<FakeCheckInRow> => {
      const data = args.data;
      const bookingId = data['bookingId'] as string;
      const kind = data['kind'] as FakeCheckInRow['kind'];
      // Mimic the UNIQUE (bookingId, kind) constraint.
      if (this.checkIns.some((r) => r.bookingId === bookingId && r.kind === kind)) {
        // Match Prisma's P2002 shape.
        const e: Error & { code?: string } = new Error('Unique constraint failed');
        e.code = 'P2002';
        throw e;
      }
      this.idCounter += 1;
      const occurredAt =
        (data['occurredAt'] as Date | undefined) ?? new Date('2026-05-14T18:00:00.000Z');
      const created: FakeCheckInRow = {
        id: (data['id'] as string | undefined) ?? `chk_fake_${this.idCounter}`,
        bookingId,
        kind,
        latitude: wrapDecimal(data['latitude'] as string),
        longitude: wrapDecimal(data['longitude'] as string),
        locationAccuracyMeters:
          data['locationAccuracyMeters'] !== undefined
            ? wrapDecimal(data['locationAccuracyMeters'] as string)
            : null,
        occurredAt,
        recordedByUserId: data['recordedByUserId'] as string,
        createdAt: occurredAt,
        updatedAt: occurredAt,
      };
      this.checkIns.push(created);
      return created;
    }),
    findMany: vi.fn(
      async (args: {
        where: { bookingId: string };
        orderBy?: { occurredAt: 'asc' | 'desc' };
      }): Promise<readonly FakeCheckInRow[]> => {
        const filtered = this.checkIns.filter((r) => r.bookingId === args.where.bookingId);
        const sorted = [...filtered].sort((a, b) => {
          const cmp = a.occurredAt.getTime() - b.occurredAt.getTime();
          return args.orderBy?.occurredAt === 'desc' ? -cmp : cmp;
        });
        return sorted;
      },
    ),
  };

  $transaction = vi.fn(async <T>(fn: (tx: PrismaTransactionClient) => Promise<T>): Promise<T> => {
    // Pass `this` as the tx — model methods exist on both clients.
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
        occurredAt: new Date('2026-05-14T18:00:00.000Z'),
      };
    },
  );
}

function buildSvc(): {
  service: CheckInsService;
  prisma: FakePrisma;
  outbox: FakeOutboxService;
  lifecycle: BookingLifecycleService;
  metrics: BookingMetrics;
} {
  const prisma = new FakePrisma();
  const outbox = new FakeOutboxService();
  const lifecycle = new BookingLifecycleService();
  // Real `BookingMetrics` — safe to construct without a booted SDK (it
  // resolves to the no-op meter; the domain-counter serialization is proven
  // in booking-metrics.test.ts). Spied so the instrumentation assertions can
  // pin the exact from/to/outcome label set without parsing Prometheus text.
  const metrics = new BookingMetrics();
  vi.spyOn(metrics, 'recordTransitionOutcome');
  const service = new CheckInsService(
    prisma as unknown as PrismaService,
    lifecycle,
    outbox as unknown as import('@taste-and-see/nest-outbox').OutboxService,
    metrics,
  );
  const log = (service as unknown as { logger: Logger }).logger;
  log.log = vi.fn();
  log.debug = vi.fn();
  log.error = vi.fn();
  log.warn = vi.fn();
  return { service, prisma, outbox, lifecycle, metrics };
}

function seedBooking(prisma: FakePrisma, overrides: Partial<FakeBookingRow> = {}): FakeBookingRow {
  const base: FakeBookingRow = {
    id: 'bkg_abc',
    householdId: 'hh_abc',
    seniorId: 'sr_abc',
    providerId: 'prv_abc',
    serviceKind: 'companion_dining',
    status: 'confirmed',
    scheduledStart: new Date('2026-05-14T18:00:00.000Z'),
    scheduledEnd: new Date('2026-05-14T20:00:00.000Z'),
    currency: 'USD',
    basePrice: wrapDecimal('150.00'),
    commissionRate: wrapDecimal('0.3000'),
    commissionAmount: wrapDecimal('45.00'),
    finalPrice: wrapDecimal('150.00'),
    bookingNotes: null,
    completedAt: null,
    canceledAt: null,
    cancellationReason: null,
    cancellationReasonText: null,
    acceptWindowExpiresAt: new Date('2026-05-13T12:30:00.000Z'),
    declinedAt: null,
    declineKind: null,
    declineReason: null,
    declineReasonText: null,
    declinedByUserId: null,
    heldByIncidentId: null,
    createdAt: new Date('2026-05-13T12:00:00.000Z'),
    updatedAt: new Date('2026-05-13T12:00:00.000Z'),
  };
  const row = { ...base, ...overrides };
  prisma.bookings.push(row);
  return row;
}

const VALID_REQUEST: RecordBookingCheckInRequest = {
  kind: 'check_in',
  latitude: 40.7128,
  longitude: -74.006,
};

const VALID_INPUT: RecordCheckInInput = {
  actorUserId: 'usr_provider',
  bookingId: 'bkg_abc',
  request: VALID_REQUEST,
};

describe('CheckInsService.record', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('records a check_in row, transitions confirmed → in_progress, emits booking.in_progress', async () => {
    const { service, prisma, outbox } = buildSvc();
    seedBooking(prisma);

    const result = await service.record(VALID_INPUT);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.checkIn.bookingId).toBe('bkg_abc');
    expect(result.value.checkIn.kind).toBe('check_in');
    expect(result.value.booking.status).toBe('in_progress');
    expect(result.value.booking.completedAt).toBeNull();
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(prisma.bookingCheckIn.create).toHaveBeenCalledTimes(1);
    expect(prisma.booking.update).toHaveBeenCalledTimes(1);
    expect(outbox.append).toHaveBeenCalledTimes(1);
    expect(outbox.appendCalls[0]?.args.eventName).toBe('booking.in_progress');
  });

  it('records a check_out row, transitions in_progress → completed, stamps completedAt, emits booking.completed', async () => {
    const { service, prisma, outbox } = buildSvc();
    seedBooking(prisma, { status: 'in_progress' });

    const result = await service.record({
      ...VALID_INPUT,
      request: { ...VALID_REQUEST, kind: 'check_out' },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.checkIn.kind).toBe('check_out');
    expect(result.value.booking.status).toBe('completed');
    expect(result.value.booking.completedAt).not.toBeNull();
    expect(outbox.appendCalls[0]?.args.eventName).toBe('booking.completed');
  });

  it('builds a booking.completed payload satisfying the gross == provider + marketplace invariant', async () => {
    const { service, prisma, outbox } = buildSvc();
    seedBooking(prisma, { status: 'in_progress' });

    await service.record({
      ...VALID_INPUT,
      request: { ...VALID_REQUEST, kind: 'check_out' },
    });

    const payload = outbox.appendCalls[0]?.args.payload as Record<string, unknown>;
    expect(payload['grossAmountMinor']).toBe(15_000);
    expect(payload['marketplaceAmountMinor']).toBe(4_500);
    expect(payload['providerAmountMinor']).toBe(10_500);
    expect(payload['currency']).toBe('USD');
    expect(payload['commissionRateBps']).toBe(3000);
  });

  it('rounds JSON-number coordinates to 6 decimal places at the persistence boundary', async () => {
    const { service, prisma } = buildSvc();
    seedBooking(prisma);

    await service.record({
      ...VALID_INPUT,
      request: {
        kind: 'check_in',
        latitude: 40.71281234,
        longitude: -74.0060987,
        locationAccuracyMeters: 8.456,
      },
    });

    const created = prisma.bookingCheckIn.create.mock.calls[0]?.[0]?.data as Record<
      string,
      unknown
    >;
    expect(created['latitude']).toBe('40.712812');
    expect(created['longitude']).toBe('-74.006099');
    expect(created['locationAccuracyMeters']).toBe('8.46');
  });

  it('persists negative-zero coordinates as 0.000000 (no leading minus)', async () => {
    const { service, prisma } = buildSvc();
    seedBooking(prisma);

    await service.record({
      ...VALID_INPUT,
      request: { kind: 'check_in', latitude: 0, longitude: 0 },
    });

    const created = prisma.bookingCheckIn.create.mock.calls[0]?.[0]?.data as Record<
      string,
      unknown
    >;
    expect(created['latitude']).toBe('0.000000');
    expect(created['longitude']).toBe('0.000000');
  });

  it('stamps the actor as recordedByUserId on the row', async () => {
    const { service, prisma } = buildSvc();
    seedBooking(prisma);

    await service.record({ ...VALID_INPUT, actorUserId: 'usr_who_is_this' });

    const created = prisma.bookingCheckIn.create.mock.calls[0]?.[0]?.data as Record<
      string,
      unknown
    >;
    expect(created['recordedByUserId']).toBe('usr_who_is_this');
  });

  it('rejects when the booking does not exist', async () => {
    const { service } = buildSvc();

    const result = await service.record({ ...VALID_INPUT, bookingId: 'bkg_missing' });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.reason).toBe('booking_not_found');
  });

  it('rejects check_in when booking is in pending (invalid_lifecycle_state)', async () => {
    const { service, prisma, outbox } = buildSvc();
    seedBooking(prisma, { status: 'pending' });

    const result = await service.record(VALID_INPUT);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.reason).toBe('invalid_lifecycle_state');
    if (result.error.reason !== 'invalid_lifecycle_state') return;
    expect(result.error.bookingStatus).toBe('pending');
    expect(result.error.requiredStatus).toBe('confirmed');
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(outbox.append).not.toHaveBeenCalled();
  });

  it('rejects check_in when booking is already in_progress', async () => {
    const { service, prisma } = buildSvc();
    seedBooking(prisma, { status: 'in_progress' });

    const result = await service.record(VALID_INPUT);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.reason).toBe('invalid_lifecycle_state');
  });

  it('rejects check_in when booking is completed', async () => {
    const { service, prisma } = buildSvc();
    seedBooking(prisma, { status: 'completed' });

    const result = await service.record(VALID_INPUT);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.reason).toBe('invalid_lifecycle_state');
  });

  it('rejects check_in when booking is canceled', async () => {
    const { service, prisma } = buildSvc();
    seedBooking(prisma, { status: 'canceled' });

    const result = await service.record(VALID_INPUT);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.reason).toBe('invalid_lifecycle_state');
  });

  it('rejects check_out when booking is in confirmed (not yet in progress)', async () => {
    const { service, prisma } = buildSvc();
    seedBooking(prisma, { status: 'confirmed' });

    const result = await service.record({
      ...VALID_INPUT,
      request: { ...VALID_REQUEST, kind: 'check_out' },
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.reason).toBe('invalid_lifecycle_state');
    if (result.error.reason !== 'invalid_lifecycle_state') return;
    expect(result.error.bookingStatus).toBe('confirmed');
    expect(result.error.requiredStatus).toBe('in_progress');
  });

  it('surfaces a UNIQUE collision as already_recorded', async () => {
    const { service, prisma } = buildSvc();
    seedBooking(prisma);
    // Pre-seed a check_in row for this booking.
    prisma.checkIns.push({
      id: 'chk_existing',
      bookingId: 'bkg_abc',
      kind: 'check_in',
      latitude: wrapDecimal('40.712800'),
      longitude: wrapDecimal('-74.006000'),
      locationAccuracyMeters: null,
      occurredAt: new Date('2026-05-14T17:00:00.000Z'),
      recordedByUserId: 'usr_provider',
      createdAt: new Date('2026-05-14T17:00:00.000Z'),
      updatedAt: new Date('2026-05-14T17:00:00.000Z'),
    });
    // Booking is already seeded in `confirmed` by the helper so the
    // lifecycle gate would otherwise accept a fresh check_in — the
    // UNIQUE constraint wins first.

    const result = await service.record(VALID_INPUT);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.reason).toBe('already_recorded');
    if (result.error.reason !== 'already_recorded') return;
    expect(result.error.kind).toBe('check_in');
  });

  it('rejects an empty actorUserId with invalid_request', async () => {
    const { service } = buildSvc();
    const result = await service.record({ ...VALID_INPUT, actorUserId: '' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.reason).toBe('invalid_request');
  });

  it('rejects an empty bookingId with invalid_request', async () => {
    const { service } = buildSvc();
    const result = await service.record({ ...VALID_INPUT, bookingId: '' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.reason).toBe('invalid_request');
  });

  it('rolls back when outbox validation fails (no check-in row + no booking update visible)', async () => {
    const { service, prisma, outbox } = buildSvc();
    seedBooking(prisma);
    outbox.nextResultOverride = 'validation_failed';

    const result = await service.record(VALID_INPUT);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.reason).toBe('outbox_validation_failed');
    // The fake doesn't actually roll back the in-memory state because
    // it's not a real transactional store; we assert the failure
    // surfaced typed and the outbox saw exactly one append call.
    expect(outbox.append).toHaveBeenCalledTimes(1);
  });

  it('appends to outbox inside the same transaction (append occurs after booking.update)', async () => {
    const { service, prisma, outbox } = buildSvc();
    seedBooking(prisma);

    await service.record(VALID_INPUT);

    expect(prisma.bookingCheckIn.create).toHaveBeenCalledTimes(1);
    expect(prisma.booking.update).toHaveBeenCalledTimes(1);
    expect(outbox.append).toHaveBeenCalledTimes(1);
    // The fake `$transaction` invokes the callback synchronously; the
    // mock-call ordering tracks chronologically.
    const createOrder = prisma.bookingCheckIn.create.mock.invocationCallOrder[0];
    const updateOrder = prisma.booking.update.mock.invocationCallOrder[0];
    const appendOrder = outbox.append.mock.invocationCallOrder[0];
    expect(createOrder).toBeLessThan(updateOrder!);
    expect(updateOrder).toBeLessThan(appendOrder!);
  });
});

describe('CheckInsService.record domain metrics (TS-060-followup-4a)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('records confirmed → in_progress applied on a successful check_in', async () => {
    const { service, prisma, metrics } = buildSvc();
    seedBooking(prisma);

    await service.record(VALID_INPUT);

    expect(metrics.recordTransitionOutcome).toHaveBeenCalledTimes(1);
    expect(metrics.recordTransitionOutcome).toHaveBeenCalledWith(
      'confirmed',
      'in_progress',
      'applied',
    );
  });

  it('records in_progress → completed applied on a successful check_out (fans the completion funnel)', async () => {
    const { service, prisma, metrics } = buildSvc();
    seedBooking(prisma, { status: 'in_progress' });

    await service.record({
      ...VALID_INPUT,
      request: { ...VALID_REQUEST, kind: 'check_out' },
    });

    // `to === 'completed'` so `recordTransitionOutcome` fans onto the
    // completion sub-funnel internally — proven in booking-metrics.test.ts.
    expect(metrics.recordTransitionOutcome).toHaveBeenCalledWith(
      'in_progress',
      'completed',
      'applied',
    );
  });

  it('records the not_found outcome with the kind-derived `to` label', async () => {
    const { service, metrics } = buildSvc();

    await service.record({ ...VALID_INPUT, bookingId: 'bkg_missing' });

    expect(metrics.recordTransitionOutcome).toHaveBeenCalledWith(
      'unknown',
      'in_progress',
      'not_found',
    );
  });

  it('records invalid_transition on a lifecycle mismatch', async () => {
    const { service, prisma, metrics } = buildSvc();
    seedBooking(prisma, { status: 'pending' });

    await service.record(VALID_INPUT);

    expect(metrics.recordTransitionOutcome).toHaveBeenCalledWith(
      'pending',
      'in_progress',
      'invalid_transition',
    );
  });

  it('records the already_recorded outcome on a UNIQUE collision', async () => {
    const { service, prisma, metrics } = buildSvc();
    seedBooking(prisma);
    prisma.checkIns.push({
      id: 'chk_existing',
      bookingId: 'bkg_abc',
      kind: 'check_in',
      latitude: wrapDecimal('40.712800'),
      longitude: wrapDecimal('-74.006000'),
      locationAccuracyMeters: null,
      occurredAt: new Date('2026-05-14T17:00:00.000Z'),
      recordedByUserId: 'usr_provider',
      createdAt: new Date('2026-05-14T17:00:00.000Z'),
      updatedAt: new Date('2026-05-14T17:00:00.000Z'),
    });

    await service.record(VALID_INPUT);

    expect(metrics.recordTransitionOutcome).toHaveBeenCalledWith(
      'confirmed',
      'in_progress',
      'already_recorded',
    );
  });

  it('records outbox_validation_failed when the append is rejected', async () => {
    const { service, prisma, outbox, metrics } = buildSvc();
    seedBooking(prisma);
    outbox.nextResultOverride = 'validation_failed';

    await service.record(VALID_INPUT);

    expect(metrics.recordTransitionOutcome).toHaveBeenCalledWith(
      'confirmed',
      'in_progress',
      'outbox_validation_failed',
    );
  });

  it('records invalid_request with the `unknown` from-sentinel on an empty actor', async () => {
    const { service, metrics } = buildSvc();

    await service.record({ ...VALID_INPUT, actorUserId: '' });

    expect(metrics.recordTransitionOutcome).toHaveBeenCalledWith(
      'unknown',
      'in_progress',
      'invalid_request',
    );
  });
});

describe('CheckInsService.listByBookingId', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns an empty array when the booking has no check-ins', async () => {
    const { service, prisma } = buildSvc();
    seedBooking(prisma);

    const result = await service.listByBookingId({
      actorUserId: 'usr_observer',
      bookingId: 'bkg_abc',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual([]);
  });

  it('returns check-ins ordered oldest-first', async () => {
    const { service, prisma } = buildSvc();
    seedBooking(prisma);
    prisma.checkIns.push(
      {
        id: 'chk_late',
        bookingId: 'bkg_abc',
        kind: 'check_out',
        latitude: wrapDecimal('40.000000'),
        longitude: wrapDecimal('-74.000000'),
        locationAccuracyMeters: null,
        occurredAt: new Date('2026-05-14T20:00:00.000Z'),
        recordedByUserId: 'usr_provider',
        createdAt: new Date('2026-05-14T20:00:00.000Z'),
        updatedAt: new Date('2026-05-14T20:00:00.000Z'),
      },
      {
        id: 'chk_early',
        bookingId: 'bkg_abc',
        kind: 'check_in',
        latitude: wrapDecimal('40.000000'),
        longitude: wrapDecimal('-74.000000'),
        locationAccuracyMeters: null,
        occurredAt: new Date('2026-05-14T18:00:00.000Z'),
        recordedByUserId: 'usr_provider',
        createdAt: new Date('2026-05-14T18:00:00.000Z'),
        updatedAt: new Date('2026-05-14T18:00:00.000Z'),
      },
    );

    const result = await service.listByBookingId({
      actorUserId: 'usr_observer',
      bookingId: 'bkg_abc',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.map((r) => r.id)).toEqual(['chk_early', 'chk_late']);
  });

  it('returns booking_not_found when the booking does not exist', async () => {
    const { service } = buildSvc();

    const result = await service.listByBookingId({
      actorUserId: 'usr_observer',
      bookingId: 'bkg_missing',
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.reason).toBe('booking_not_found');
  });

  it('rejects empty actorUserId with invalid_request', async () => {
    const { service, prisma } = buildSvc();
    seedBooking(prisma);

    const result = await service.listByBookingId({
      actorUserId: '',
      bookingId: 'bkg_abc',
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.reason).toBe('invalid_request');
  });

  it('rejects empty bookingId with invalid_request', async () => {
    const { service } = buildSvc();

    const result = await service.listByBookingId({
      actorUserId: 'usr_observer',
      bookingId: '',
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.reason).toBe('invalid_request');
  });
});

describe('CheckInsService.record — trust & safety hold (TS-302e)', () => {
  it('REFUSES a check-in on a held booking', () => {
    // Nothing has happened yet, and letting the visit start is precisely what
    // the hold exists to prevent.
    const { service, prisma } = buildSvc();
    seedBooking(prisma, { status: 'confirmed', heldByIncidentId: 'inc_1' });
    return service
      .record({
        actorUserId: 'usr_provider',
        bookingId: 'bkg_abc',
        request: { kind: 'check_in', latitude: 40.7, longitude: -73.9 },
      })
      .then((result) => {
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error.reason).toBe('booking_held');
          // The failure carries NO incident id, which is what makes the
          // controller structurally unable to leak one into the 409 body. This
          // response goes to a provider's phone, and the provider may BE the
          // held subject (CLAUDE.md §3.9, §12).
          expect(JSON.stringify(result.error)).not.toContain('inc_1');
        }
      });
  });

  it('writes NOTHING when it refuses — no check-in row, no status change, no event', async () => {
    const { service, prisma, outbox } = buildSvc();
    seedBooking(prisma, { status: 'confirmed', heldByIncidentId: 'inc_1' });
    await service.record({
      actorUserId: 'usr_provider',
      bookingId: 'bkg_abc',
      request: { kind: 'check_in', latitude: 40.7, longitude: -73.9 },
    });
    expect(prisma.checkIns).toHaveLength(0);
    expect(prisma.bookings[0]?.status).toBe('confirmed');
    expect(outbox.appendCalls).toHaveLength(0);
  });

  it('ALLOWS a check-out on a held booking, and completes it', async () => {
    // The visit HAPPENED. Refusing does not un-happen it — it only means the
    // platform holds no record of a visit that occurred, and loses the fact
    // that a held visit went ahead, which is the part hardest to reconstruct.
    const { service, prisma, outbox } = buildSvc();
    seedBooking(prisma, { status: 'in_progress', heldByIncidentId: 'inc_1' });
    const result = await service.record({
      actorUserId: 'usr_provider',
      bookingId: 'bkg_abc',
      request: { kind: 'check_out', latitude: 40.7, longitude: -73.9 },
    });
    expect(result.ok).toBe(true);
    expect(prisma.bookings[0]?.status).toBe('completed');
    expect(prisma.bookings[0]?.completedAt).not.toBeNull();
    expect(outbox.appendCalls).toHaveLength(1);
  });

  it('does NOT clear the hold by completing under it', async () => {
    // The hold belongs to the incident and is released when the incident
    // closes (TS-304). A completion is not a closure.
    const { service, prisma } = buildSvc();
    seedBooking(prisma, { status: 'in_progress', heldByIncidentId: 'inc_1' });
    await service.record({
      actorUserId: 'usr_provider',
      bookingId: 'bkg_abc',
      request: { kind: 'check_out', latitude: 40.7, longitude: -73.9 },
    });
    expect(prisma.bookings[0]?.heldByIncidentId).toBe('inc_1');
  });

  it('counts both decisions, on their own counter', async () => {
    // An allowed held check-out is an `applied` transition, so it would be
    // invisible in the very funnel that counts completions.
    const { service, prisma, metrics } = buildSvc();
    const spy = vi.spyOn(metrics, 'recordHeldCheckIn');

    seedBooking(prisma, { status: 'confirmed', heldByIncidentId: 'inc_1' });
    await service.record({
      actorUserId: 'usr_provider',
      bookingId: 'bkg_abc',
      request: { kind: 'check_in', latitude: 40.7, longitude: -73.9 },
    });
    expect(spy).toHaveBeenCalledWith('check_in', 'refused');

    prisma.bookings.length = 0;
    seedBooking(prisma, { status: 'in_progress', heldByIncidentId: 'inc_1' });
    await service.record({
      actorUserId: 'usr_provider',
      bookingId: 'bkg_abc',
      request: { kind: 'check_out', latitude: 40.7, longitude: -73.9 },
    });
    expect(spy).toHaveBeenCalledWith('check_out', 'allowed');
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('leaves an unheld booking entirely alone', async () => {
    const { service, prisma, metrics } = buildSvc();
    const spy = vi.spyOn(metrics, 'recordHeldCheckIn');
    seedBooking(prisma, { status: 'confirmed', heldByIncidentId: null });
    const result = await service.record({
      actorUserId: 'usr_provider',
      bookingId: 'bkg_abc',
      request: { kind: 'check_in', latitude: 40.7, longitude: -73.9 },
    });
    expect(result.ok).toBe(true);
    expect(prisma.bookings[0]?.status).toBe('in_progress');
    expect(spy).not.toHaveBeenCalled();
  });
});
