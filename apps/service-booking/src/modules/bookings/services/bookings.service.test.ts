import type { Logger } from '@nestjs/common';
import type {
  BookingTierGatingMode,
  CreateBookingRequest,
  TransitionableBookingStatus,
} from '@taste-and-see/contracts';
import type { OutboxRawExecutor } from '@taste-and-see/nest-outbox';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { BookingMetrics } from '../../../observability/booking-metrics';
import type { PrismaService, PrismaTransactionClient } from '../../../prisma/prisma.service';
import { BookingLifecycleService } from '../../lifecycle/booking-lifecycle.service';
import type { BookingStatus } from '../../lifecycle/booking-status';
import type {
  ActiveSubjectHold,
  SubjectHoldsService,
} from '../../subject-holds/services/subject-holds.service';
import type {
  TierGatingDecision,
  TierGatingService,
} from '../../tier-gating/services/tier-gating.service';
import { BookingsService, type BookingRecord, type CreateBookingInput } from './bookings.service';

/**
 * BookingsService unit suite (TS-060-followup-1).
 *
 * The service orchestrates booking lifecycle transitions inside a
 * Prisma `$transaction` and appends domain events to the outbox in the
 * same transaction. The tests use an in-memory `FakePrisma` (mirroring
 * the service-subscription / service-provider pattern) so we can
 * deterministically assert:
 *
 *   - The outbox is called inside the transaction (the fake records
 *     append calls in order with the bookings row mutation).
 *   - The right event name is emitted on each transition.
 *   - The terminal-state stamps (`completedAt` / `canceledAt`) land
 *     exactly once on the matching transition.
 *   - Illegal transitions surface as typed `invalid_transition`
 *     failures from the service.
 *   - Outbox validation failures surface as typed failures + the
 *     transaction rolls back the booking row.
 *   - Row-level access decisions log the actor.
 */

interface FakeBookingRow extends BookingRecord {
  basePrice: { toString(): string };
  commissionRate: { toString(): string };
  commissionAmount: { toString(): string };
  finalPrice: { toString(): string };
}

class FakePrisma {
  public bookings: FakeBookingRow[] = [];
  private idCounter = 0;

  booking = {
    create: vi.fn(async (args: { data: Record<string, unknown> }): Promise<FakeBookingRow> => {
      this.idCounter += 1;
      const data = args.data;
      const row: FakeBookingRow = {
        id: (data['id'] as string) ?? `bkg_fake_${this.idCounter}`,
        householdId: data['householdId'] as string,
        seniorId: data['seniorId'] as string,
        providerId: data['providerId'] as string,
        serviceKind: data['serviceKind'] as FakeBookingRow['serviceKind'],
        status: ((data['status'] as BookingStatus) ?? 'pending') as BookingStatus,
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
      };
      this.bookings.push(row);
      return row;
    }),
    findUnique: vi.fn(async (args: { where: { id: string } }): Promise<FakeBookingRow | null> => {
      return this.bookings.find((b) => b.id === args.where.id) ?? null;
    }),
    update: vi.fn(
      async (args: {
        where: { id: string };
        data: Record<string, unknown>;
      }): Promise<FakeBookingRow> => {
        const idx = this.bookings.findIndex((b) => b.id === args.where.id);
        if (idx === -1) {
          throw new Error(`booking ${args.where.id} not found in fake`);
        }
        const data = args.data;
        const next: FakeBookingRow = {
          ...this.bookings[idx]!,
          status: (data['status'] as BookingStatus) ?? this.bookings[idx]!.status,
          completedAt:
            data['completedAt'] !== undefined
              ? (data['completedAt'] as Date)
              : this.bookings[idx]!.completedAt,
          canceledAt:
            data['canceledAt'] !== undefined
              ? (data['canceledAt'] as Date)
              : this.bookings[idx]!.canceledAt,
          cancellationReason:
            data['cancellationReason'] !== undefined
              ? (data['cancellationReason'] as string)
              : this.bookings[idx]!.cancellationReason,
          cancellationReasonText:
            data['cancellationReasonText'] !== undefined
              ? (data['cancellationReasonText'] as string)
              : this.bookings[idx]!.cancellationReasonText,
          declinedAt:
            data['declinedAt'] !== undefined
              ? (data['declinedAt'] as Date)
              : this.bookings[idx]!.declinedAt,
          declineKind:
            data['declineKind'] !== undefined
              ? (data['declineKind'] as string)
              : this.bookings[idx]!.declineKind,
          declineReason:
            data['declineReason'] !== undefined
              ? (data['declineReason'] as string | null)
              : this.bookings[idx]!.declineReason,
          declineReasonText:
            data['declineReasonText'] !== undefined
              ? (data['declineReasonText'] as string)
              : this.bookings[idx]!.declineReasonText,
          declinedByUserId:
            data['declinedByUserId'] !== undefined
              ? (data['declinedByUserId'] as string)
              : this.bookings[idx]!.declinedByUserId,
          updatedAt: new Date('2026-05-13T12:05:00.000Z'),
        };
        this.bookings[idx] = next;
        return next;
      },
    ),
  };

  $transaction = vi.fn(async <T>(fn: (tx: PrismaTransactionClient) => Promise<T>): Promise<T> => {
    // Pass `this` as the transaction client — model methods exist on
    // both the outer client and the inner tx in real Prisma. The
    // `$executeRaw` slot lives below for the outbox SDK.
    return fn(this as unknown as PrismaTransactionClient);
  });

  // `OutboxRawExecutor`-compatible — the outbox SDK calls $executeRaw
  // on the tx. The fake records calls so tests can assert the SDK ran
  // inside the transaction.
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

/**
 * Fake OutboxService — records every append call so tests can assert
 * the right event name + payload. Allows the test to make the next
 * append return `validation_failed` to exercise the rollback path.
 */
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

/**
 * Fake tier-gating service. Defaults to `allowed` so every test that
 * doesn't care about tier gating behaves like the pre-TS-064 era.
 * Tests that DO care override `nextDecision` (or `getMode`) before
 * invoking `createBooking`.
 */
class FakeTierGatingService {
  public mode: BookingTierGatingMode = 'enforce';
  public nextDecision: TierGatingDecision = {
    outcome: 'allowed',
    householdTier: 'tier_2_companion',
    providerTier: 'certified',
  };

  evaluate = vi.fn(async (): Promise<TierGatingDecision> => this.nextDecision);
  getMode = vi.fn((): BookingTierGatingMode => this.mode);
}

/**
 * Fake hold screen (TS-304). Empty by default — the vast majority of
 * bookings are unheld, so the default keeps every pre-existing assertion in
 * this suite meaningful. Pass `activeHolds` to `buildSvc` to exercise the
 * refusal.
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

function buildSvc(
  options: {
    acceptWindowMinutes?: number;
    /** TS-304 — active trust & safety holds the screen should report. */
    activeHolds?: readonly ActiveSubjectHold[];
  } = {},
): {
  service: BookingsService;
  prisma: FakePrisma;
  outbox: FakeOutboxService;
  lifecycle: BookingLifecycleService;
  tierGating: FakeTierGatingService;
  subjectHolds: FakeSubjectHoldsService;
} {
  const prisma = new FakePrisma();
  const outbox = new FakeOutboxService();
  const lifecycle = new BookingLifecycleService();
  const tierGating = new FakeTierGatingService();
  // Minimal Env shape — the service only reads
  // `BOOKING_ACCEPT_WINDOW_MINUTES` today. Casting via `unknown` keeps
  // the test out of the full env-validation contract.
  const env = {
    BOOKING_ACCEPT_WINDOW_MINUTES: options.acceptWindowMinutes ?? 30,
  } as unknown as import('../../../config/env').Env;
  // Real `BookingMetrics` — safe to construct without a booted SDK (it
  // falls back to a no-op meter), so the service's metric calls exercise
  // the real wiring without polluting the assertions (TS-060-followup-4).
  // The domain-counter serialization is proven in booking-metrics.test.ts.
  const metrics = new BookingMetrics();
  const subjectHolds = new FakeSubjectHoldsService();
  if (options.activeHolds !== undefined) subjectHolds.holds = [...options.activeHolds];
  const service = new BookingsService(
    prisma as unknown as PrismaService,
    lifecycle,
    outbox as unknown as import('@taste-and-see/nest-outbox').OutboxService,
    tierGating as unknown as TierGatingService,
    subjectHolds as unknown as SubjectHoldsService,
    metrics,
    env,
  );
  // Silence the logger in tests.
  const log = (service as unknown as { logger: Logger }).logger;
  log.log = vi.fn();
  log.debug = vi.fn();
  log.error = vi.fn();
  log.warn = vi.fn();
  return { service, prisma, outbox, lifecycle, tierGating, subjectHolds };
}

const VALID_CREATE_REQUEST: CreateBookingRequest = {
  householdId: 'hh_abc',
  seniorId: 'sr_abc',
  providerId: 'prv_abc',
  serviceKind: 'companion_dining',
  scheduledStart: '2026-05-20T18:00:00.000Z',
  scheduledEnd: '2026-05-20T20:00:00.000Z',
  currency: 'USD',
  basePriceMinor: 15_000,
  commissionRateBps: 3000,
};

const VALID_INPUT: CreateBookingInput = {
  actorUserId: 'usr_owner',
  request: VALID_CREATE_REQUEST,
};

/**
 * TS-060-followup-1c — `createBooking` now rejects a `scheduledStart`
 * in the past against the server clock (`new Date()`). Pin the system
 * time deterministically (CLAUDE.md §9.3 — clock fakes, never the real
 * wall-clock) so the fixed-date fixtures above (scheduled 2026-05-20)
 * stay strictly in the FUTURE relative to "now" and the suite never
 * time-bombs as the calendar advances. Only `Date` is faked — timers
 * and microtasks stay real so the service's `await`s resolve normally.
 */
const FIXED_NOW = new Date('2026-05-13T12:00:00.000Z');

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(FIXED_NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('BookingsService.createBooking', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('creates a pending booking and emits booking.created inside the transaction', async () => {
    const { service, prisma, outbox } = buildSvc();

    const result = await service.createBooking(VALID_INPUT);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.status).toBe('pending');
    expect(result.value.householdId).toBe('hh_abc');
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(prisma.booking.create).toHaveBeenCalledTimes(1);
    expect(outbox.append).toHaveBeenCalledTimes(1);
    expect(outbox.appendCalls[0]?.args.eventName).toBe('booking.created');
  });

  it('stores derived commission amount + base prices as Decimal strings', async () => {
    const { service, prisma } = buildSvc();

    await service.createBooking(VALID_INPUT);

    const created = prisma.booking.create.mock.calls[0]?.[0]?.data as Record<string, unknown>;
    expect(created['basePrice']).toBe('150.00');
    expect(created['commissionRate']).toBe('0.3000');
    expect(created['commissionAmount']).toBe('45.00'); // 150 * 0.3
    expect(created['finalPrice']).toBe('150.00');
  });

  it('builds a booking.created event payload with minor-unit money fields', async () => {
    const { service, outbox } = buildSvc();

    await service.createBooking(VALID_INPUT);

    const payload = outbox.appendCalls[0]?.args.payload as Record<string, unknown>;
    expect(payload['basePriceMinor']).toBe(15_000);
    expect(payload['commissionRateBps']).toBe(3000);
    expect(payload['commissionAmountMinor']).toBe(4_500);
    expect(payload['finalPriceMinor']).toBe(15_000);
    expect(payload['currency']).toBe('USD');
    expect(payload['bookingId']).toBe(payload['eventId']);
    // TS-217-prep-4c — searchId defaults to null when the request carries none.
    expect(payload['searchId']).toBeNull();
  });

  it('echoes the request searchId onto booking.created (TS-217-prep-4c)', async () => {
    const { service, outbox } = buildSvc();

    await service.createBooking({
      ...VALID_INPUT,
      request: { ...VALID_CREATE_REQUEST, searchId: 'srch_abc123' },
    });

    const payload = outbox.appendCalls[0]?.args.payload as Record<string, unknown>;
    expect(payload['searchId']).toBe('srch_abc123');
  });

  it('rejects an empty actorUserId with invalid_request', async () => {
    const { service } = buildSvc();
    const result = await service.createBooking({ ...VALID_INPUT, actorUserId: '' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.reason).toBe('invalid_request');
  });

  it('rejects a scheduledStart in the past with invalid_request (TS-060-followup-1c)', async () => {
    const { service, prisma, outbox, tierGating } = buildSvc();

    const result = await service.createBooking({
      ...VALID_INPUT,
      request: {
        ...VALID_CREATE_REQUEST,
        // FIXED_NOW is 2026-05-13T12:00Z; this window is fully in the past.
        scheduledStart: '2026-05-01T18:00:00.000Z',
        scheduledEnd: '2026-05-01T20:00:00.000Z',
      },
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.reason).toBe('invalid_request');
    // The guard short-circuits BEFORE any side effect: no tier-gating
    // round-trip, no row insert, no outbox append.
    expect(tierGating.evaluate).not.toHaveBeenCalled();
    expect(prisma.booking.create).not.toHaveBeenCalled();
    expect(outbox.append).not.toHaveBeenCalled();
  });

  it('accepts a scheduledStart exactly at now (the boundary is exclusive)', async () => {
    const { service } = buildSvc();

    const result = await service.createBooking({
      ...VALID_INPUT,
      request: {
        ...VALID_CREATE_REQUEST,
        scheduledStart: FIXED_NOW.toISOString(),
        scheduledEnd: '2026-05-13T14:00:00.000Z',
      },
    });

    expect(result.ok).toBe(true);
  });

  it('returns outbox_validation_failed when the outbox rejects the payload', async () => {
    const { service, outbox, prisma } = buildSvc();
    outbox.nextResultOverride = 'validation_failed';

    const result = await service.createBooking(VALID_INPUT);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.reason).toBe('outbox_validation_failed');
    // The transaction threw; in real Prisma it rolls back. The fake
    // doesn't enforce rollback, but the fact that append was called
    // AND the service surfaces a typed failure is the contract.
    expect(outbox.append).toHaveBeenCalledTimes(1);
    expect(prisma.booking.create).toHaveBeenCalledTimes(1);
  });

  it('passes the tx into outbox.append (same Prisma transaction as the row insert)', async () => {
    const { service, outbox, prisma } = buildSvc();
    await service.createBooking(VALID_INPUT);
    // The tx the SDK receives is the Prisma transaction client (the
    // fake passes `this`). The fact that both append and create were
    // called within the same `$transaction` callback is the invariant.
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(outbox.appendCalls[0]?.tx).toBeDefined();
  });

  // ──────────────────────────────────────────────────────────────────
  // TS-064 — tier-gating wiring on the booking-create path.
  // ──────────────────────────────────────────────────────────────────

  it('calls tierGating.evaluate with the request household + provider ids + serviceKind', async () => {
    const { service, tierGating } = buildSvc();
    await service.createBooking(VALID_INPUT);
    expect(tierGating.evaluate).toHaveBeenCalledTimes(1);
    expect(tierGating.evaluate).toHaveBeenCalledWith({
      householdId: VALID_CREATE_REQUEST.householdId,
      providerId: VALID_CREATE_REQUEST.providerId,
      serviceKind: VALID_CREATE_REQUEST.serviceKind,
    });
  });

  it('returns tier_gating_violation under enforce mode + tier_3_requires_elite', async () => {
    const { service, tierGating, prisma, outbox } = buildSvc();
    tierGating.mode = 'enforce';
    tierGating.nextDecision = {
      outcome: 'blocked',
      reason: 'tier_3_requires_elite',
      householdTier: 'tier_3_concierge',
      providerTier: 'certified',
    };

    const result = await service.createBooking(VALID_INPUT);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.reason).toBe('tier_gating_violation');
    if (result.error.reason !== 'tier_gating_violation') return;
    expect(result.error.violationReason).toBe('tier_3_requires_elite');
    expect(result.error.householdTier).toBe('tier_3_concierge');
    expect(result.error.providerTier).toBe('certified');
    // The booking row was NEVER inserted.
    expect(prisma.booking.create).not.toHaveBeenCalled();
    // The violation event was emitted before the rejection.
    expect(outbox.append).toHaveBeenCalledTimes(1);
    expect(outbox.appendCalls[0]?.args.eventName).toBe('booking.tier_gating_violation');
    const payload = outbox.appendCalls[0]?.args.payload as Record<string, unknown>;
    expect(payload['mode']).toBe('enforce');
    expect(payload['reason']).toBe('tier_3_requires_elite');
    expect(payload['householdTier']).toBe('tier_3_concierge');
    expect(payload['providerTier']).toBe('certified');
    expect(payload['actorUserId']).toBe('usr_owner');
    expect(payload['serviceKind']).toBe('companion_dining');
    expect(payload['attemptId']).toBe(
      payload['eventId'] ? (payload['eventId'] as string).replace('tgv_', '') : '',
    );
  });

  it('proceeds with the booking under advisory mode but still emits the violation event', async () => {
    const { service, tierGating, prisma, outbox } = buildSvc();
    tierGating.mode = 'advisory';
    tierGating.nextDecision = {
      outcome: 'allowed_with_advisory_warning',
      reason: 'tier_3_requires_elite',
      householdTier: 'tier_3_concierge',
      providerTier: 'basic',
    };

    const result = await service.createBooking(VALID_INPUT);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.status).toBe('pending');
    // Both the booking row + the violation event landed.
    expect(prisma.booking.create).toHaveBeenCalledTimes(1);
    const eventNames = outbox.appendCalls.map((c) => c.args.eventName);
    expect(eventNames).toEqual(['booking.tier_gating_violation', 'booking.created']);
    const violationPayload = outbox.appendCalls[0]?.args.payload as Record<string, unknown>;
    expect(violationPayload['mode']).toBe('advisory');
    expect(violationPayload['providerTier']).toBe('basic');
  });

  it('returns tier_gating_violation under enforce mode + household_snapshot_unknown (null tier)', async () => {
    const { service, tierGating, outbox } = buildSvc();
    tierGating.mode = 'enforce';
    tierGating.nextDecision = {
      outcome: 'blocked',
      reason: 'household_snapshot_unknown',
      householdTier: null,
      providerTier: 'elite',
    };

    const result = await service.createBooking(VALID_INPUT);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    if (result.error.reason !== 'tier_gating_violation') return;
    expect(result.error.violationReason).toBe('household_snapshot_unknown');
    expect(result.error.householdTier).toBeNull();
    expect(result.error.providerTier).toBe('elite');
    const payload = outbox.appendCalls[0]?.args.payload as Record<string, unknown>;
    expect(payload['householdTier']).toBeNull();
    expect(payload['providerTier']).toBe('elite');
  });

  it('does NOT emit the violation event when the gate allows the booking', async () => {
    const { service, outbox } = buildSvc();
    // default decision is `allowed`.
    await service.createBooking(VALID_INPUT);
    const eventNames = outbox.appendCalls.map((c) => c.args.eventName);
    expect(eventNames).toEqual(['booking.created']);
  });

  it('returns outbox_validation_failed when the violation event itself fails to validate', async () => {
    const { service, outbox, tierGating, prisma } = buildSvc();
    tierGating.mode = 'enforce';
    tierGating.nextDecision = {
      outcome: 'blocked',
      reason: 'tier_3_requires_elite',
      householdTier: 'tier_3_concierge',
      providerTier: 'basic',
    };
    outbox.nextResultOverride = 'validation_failed';

    const result = await service.createBooking(VALID_INPUT);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.reason).toBe('outbox_validation_failed');
    // The booking row was NEVER inserted (the rejection happened first).
    expect(prisma.booking.create).not.toHaveBeenCalled();
  });
});

describe('BookingsService.transitionStatus', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  async function seedBooking(svc: ReturnType<typeof buildSvc>): Promise<string> {
    const result = await svc.service.createBooking(VALID_INPUT);
    if (!result.ok) throw new Error('seed failed');
    return result.value.id;
  }

  it('moves pending → confirmed and emits booking.confirmed', async () => {
    const ctx = buildSvc();
    const id = await seedBooking(ctx);
    ctx.outbox.appendCalls = []; // reset to only assert the transition event

    const result = await ctx.service.transitionStatus({
      actorUserId: 'usr_provider',
      actorKind: 'customer',
      bookingId: id,
      targetStatus: 'confirmed',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.status).toBe('confirmed');
    expect(ctx.outbox.appendCalls[0]?.args.eventName).toBe('booking.confirmed');
  });

  it('walks the happy path pending → confirmed → in_progress → completed with the matching events', async () => {
    const ctx = buildSvc();
    const id = await seedBooking(ctx);

    await ctx.service.transitionStatus({
      actorUserId: 'usr_provider',
      actorKind: 'customer',
      bookingId: id,
      targetStatus: 'confirmed',
    });
    await ctx.service.transitionStatus({
      actorUserId: 'usr_provider',
      actorKind: 'customer',
      bookingId: id,
      targetStatus: 'in_progress',
    });
    const final = await ctx.service.transitionStatus({
      actorUserId: 'usr_provider',
      actorKind: 'customer',
      bookingId: id,
      targetStatus: 'completed',
    });

    expect(final.ok).toBe(true);
    if (!final.ok) return;
    expect(final.value.status).toBe('completed');
    expect(final.value.completedAt).not.toBeNull();
    // First append was the create event, then three transition events.
    const eventNames = ctx.outbox.appendCalls.map((c) => c.args.eventName);
    expect(eventNames).toEqual([
      'booking.created',
      'booking.confirmed',
      'booking.in_progress',
      'booking.completed',
    ]);
  });

  it('stamps completedAt exactly once on the completion transition', async () => {
    const ctx = buildSvc();
    const id = await seedBooking(ctx);
    await ctx.service.transitionStatus({
      actorUserId: 'usr_x',
      actorKind: 'customer',
      bookingId: id,
      targetStatus: 'confirmed',
    });
    await ctx.service.transitionStatus({
      actorUserId: 'usr_x',
      actorKind: 'customer',
      bookingId: id,
      targetStatus: 'in_progress',
    });
    const before = ctx.prisma.bookings[0]?.completedAt;
    expect(before).toBeNull();
    const result = await ctx.service.transitionStatus({
      actorUserId: 'usr_x',
      actorKind: 'customer',
      bookingId: id,
      targetStatus: 'completed',
    });
    expect(result.ok).toBe(true);
    expect(ctx.prisma.bookings[0]?.completedAt).toBeInstanceOf(Date);
  });

  it('stamps canceledAt + persists categorical + free-text reasons on cancel', async () => {
    const ctx = buildSvc();
    const id = await seedBooking(ctx);

    const result = await ctx.service.transitionStatus({
      actorUserId: 'usr_x',
      actorKind: 'customer',
      bookingId: id,
      targetStatus: 'canceled',
      cancellationReason: 'family_request',
      cancellationReasonText: 'family travel plans',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.status).toBe('canceled');
    expect(result.value.canceledAt).not.toBeNull();
    expect(result.value.cancellationReason).toBe('family_request');
    expect(result.value.cancellationReasonText).toBe('family travel plans');
  });

  it('persists the cancelling actor ON THE ROW, not only on the event (TS-308c)', async () => {
    // The event has always carried `canceledByUserId`, but an outbox
    // entry is relayed and pruned — so "who cancelled this visit" had no
    // durable answer, and the mass-cancellation detector's
    // distinct-actor count had nothing to count.
    const ctx = buildSvc();
    const id = await seedBooking(ctx);

    await ctx.service.transitionStatus({
      actorUserId: 'usr_actor_who_canceled',
      actorKind: 'customer',
      bookingId: id,
      targetStatus: 'canceled',
      cancellationReason: 'family_request',
    });

    const update = ctx.prisma.booking.update.mock.calls.at(-1)?.[0] as {
      data: Record<string, unknown>;
    };
    expect(update.data['canceledByUserId']).toBe('usr_actor_who_canceled');
  });

  it('does NOT stamp a cancelling actor on a non-cancel transition', async () => {
    const ctx = buildSvc();
    const id = await seedBooking(ctx);

    await ctx.service.transitionStatus({
      actorUserId: 'usr_x',
      actorKind: 'customer',
      bookingId: id,
      targetStatus: 'confirmed',
    });

    const update = ctx.prisma.booking.update.mock.calls.at(-1)?.[0] as {
      data: Record<string, unknown>;
    };
    expect(update.data).not.toHaveProperty('canceledByUserId');
  });

  it('emits booking.canceled with the previousStatus and actor', async () => {
    const ctx = buildSvc();
    const id = await seedBooking(ctx);
    await ctx.service.transitionStatus({
      actorUserId: 'usr_x',
      actorKind: 'customer',
      bookingId: id,
      targetStatus: 'confirmed',
    });
    ctx.outbox.appendCalls = [];

    await ctx.service.transitionStatus({
      actorUserId: 'usr_actor_who_canceled',
      actorKind: 'customer',
      bookingId: id,
      targetStatus: 'canceled',
      cancellationReason: 'no_show',
    });

    const payload = ctx.outbox.appendCalls[0]?.args.payload as Record<string, unknown>;
    expect(ctx.outbox.appendCalls[0]?.args.eventName).toBe('booking.canceled');
    expect(payload['previousStatus']).toBe('confirmed');
    expect(payload['cancellationReason']).toBe('no_show');
    expect(payload['canceledByUserId']).toBe('usr_actor_who_canceled');
  });

  it('emits booking.completed with the four-money-fields invariant satisfied', async () => {
    const ctx = buildSvc();
    const id = await seedBooking(ctx);
    await ctx.service.transitionStatus({
      actorUserId: 'usr_x',
      actorKind: 'customer',
      bookingId: id,
      targetStatus: 'confirmed',
    });
    await ctx.service.transitionStatus({
      actorUserId: 'usr_x',
      actorKind: 'customer',
      bookingId: id,
      targetStatus: 'in_progress',
    });
    ctx.outbox.appendCalls = [];
    await ctx.service.transitionStatus({
      actorUserId: 'usr_x',
      actorKind: 'customer',
      bookingId: id,
      targetStatus: 'completed',
    });

    const payload = ctx.outbox.appendCalls[0]?.args.payload as Record<string, unknown>;
    expect(payload['grossAmountMinor']).toBe(15_000);
    expect(payload['marketplaceAmountMinor']).toBe(4_500);
    expect(payload['providerAmountMinor']).toBe(10_500);
    expect(payload['commissionRateBps']).toBe(3000);
    // Accounting-recognizer invariant.
    expect(
      (payload['providerAmountMinor'] as number) + (payload['marketplaceAmountMinor'] as number),
    ).toBe(payload['grossAmountMinor']);
  });

  it('rejects an illegal transition with invalid_transition', async () => {
    const ctx = buildSvc();
    const id = await seedBooking(ctx);

    const result = await ctx.service.transitionStatus({
      actorUserId: 'usr_x',
      actorKind: 'customer',
      bookingId: id,
      targetStatus: 'completed', // pending → completed is illegal.
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.reason).toBe('invalid_transition');
    if (result.error.reason !== 'invalid_transition') return;
    expect(result.error.from).toBe('pending');
    expect(result.error.to).toBe('completed');
    expect(result.error.allowed).toEqual(['confirmed', 'canceled', 'declined']);
  });

  it('rejects a non-existent booking with not_found', async () => {
    const ctx = buildSvc();
    const result = await ctx.service.transitionStatus({
      actorUserId: 'usr_x',
      actorKind: 'customer',
      bookingId: 'bkg_missing',
      targetStatus: 'confirmed' as TransitionableBookingStatus,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.reason).toBe('not_found');
  });

  it('rejects an empty actorUserId / bookingId with invalid_request', async () => {
    const ctx = buildSvc();
    const a = await ctx.service.transitionStatus({
      actorUserId: '',
      actorKind: 'customer',
      bookingId: 'bkg_abc',
      targetStatus: 'confirmed' as TransitionableBookingStatus,
    });
    expect(a.ok).toBe(false);
    if (a.ok) return;
    expect(a.error.reason).toBe('invalid_request');

    const b = await ctx.service.transitionStatus({
      actorUserId: 'usr_x',
      actorKind: 'customer',
      bookingId: '',
      targetStatus: 'confirmed' as TransitionableBookingStatus,
    });
    expect(b.ok).toBe(false);
    if (b.ok) return;
    expect(b.error.reason).toBe('invalid_request');
  });
});

describe('BookingsService.getById', () => {
  it('returns the booking row for a known id', async () => {
    const ctx = buildSvc();
    const create = await ctx.service.createBooking(VALID_INPUT);
    if (!create.ok) throw new Error('seed failed');

    const result = await ctx.service.getById({
      actorUserId: 'usr_reader',
      bookingId: create.value.id,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.id).toBe(create.value.id);
  });

  it('returns not_found for an unknown id', async () => {
    const ctx = buildSvc();
    const result = await ctx.service.getById({
      actorUserId: 'usr_x',
      bookingId: 'bkg_missing',
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.reason).toBe('not_found');
  });

  it('rejects an empty actorUserId with invalid_request', async () => {
    const ctx = buildSvc();
    const result = await ctx.service.getById({ actorUserId: '', bookingId: 'bkg_x' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.reason).toBe('invalid_request');
  });

  it('rejects an empty bookingId with invalid_request', async () => {
    const ctx = buildSvc();
    const result = await ctx.service.getById({ actorUserId: 'usr_x', bookingId: '' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.reason).toBe('invalid_request');
  });
});

describe('BookingsService.createBooking — TS-205 accept window stamp', () => {
  it('populates acceptWindowExpiresAt at created_at + BOOKING_ACCEPT_WINDOW_MINUTES', async () => {
    const ctx = buildSvc({ acceptWindowMinutes: 45 });
    const before = Date.now();
    const result = await ctx.service.createBooking(VALID_INPUT);
    const after = Date.now();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.acceptWindowExpiresAt).not.toBeNull();
    const expiresAt = result.value.acceptWindowExpiresAt!.getTime();
    // Should be within (now + 45min) by a small wall-clock margin.
    expect(expiresAt).toBeGreaterThanOrEqual(before + 45 * 60_000);
    expect(expiresAt).toBeLessThanOrEqual(after + 45 * 60_000);
  });

  it('honours the default 30-minute window when no override is supplied', async () => {
    const ctx = buildSvc();
    const start = Date.now();
    const result = await ctx.service.createBooking(VALID_INPUT);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const expiresAt = result.value.acceptWindowExpiresAt!.getTime();
    expect(expiresAt).toBeGreaterThanOrEqual(start + 30 * 60_000);
    expect(expiresAt).toBeLessThanOrEqual(start + 30 * 60_000 + 5_000);
  });
});

describe('BookingsService.acceptBooking', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  async function seedPending(svc: ReturnType<typeof buildSvc>): Promise<string> {
    const result = await svc.service.createBooking(VALID_INPUT);
    if (!result.ok) throw new Error('seed failed');
    return result.value.id;
  }

  it('moves pending → confirmed and emits booking.confirmed', async () => {
    const ctx = buildSvc();
    const id = await seedPending(ctx);
    ctx.outbox.appendCalls = [];

    const result = await ctx.service.acceptBooking({
      actorUserId: 'usr_provider',
      bookingId: id,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.status).toBe('confirmed');
    expect(ctx.outbox.appendCalls).toHaveLength(1);
    expect(ctx.outbox.appendCalls[0]?.args.eventName).toBe('booking.confirmed');
  });

  it('rejects an empty actorUserId / bookingId with invalid_request', async () => {
    const ctx = buildSvc();
    const id = await seedPending(ctx);

    const a = await ctx.service.acceptBooking({ actorUserId: '', bookingId: id });
    expect(a.ok).toBe(false);
    if (a.ok) return;
    expect(a.error.reason).toBe('invalid_request');

    const b = await ctx.service.acceptBooking({ actorUserId: 'usr', bookingId: '' });
    expect(b.ok).toBe(false);
    if (b.ok) return;
    expect(b.error.reason).toBe('invalid_request');
  });

  it('returns not_found for an unknown booking id', async () => {
    const ctx = buildSvc();
    const result = await ctx.service.acceptBooking({
      actorUserId: 'usr_provider',
      bookingId: 'bkg_missing',
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.reason).toBe('not_found');
  });

  it('returns invalid_transition when the booking is no longer pending', async () => {
    const ctx = buildSvc();
    const id = await seedPending(ctx);
    // Move to confirmed first.
    await ctx.service.acceptBooking({ actorUserId: 'usr_provider', bookingId: id });

    const result = await ctx.service.acceptBooking({
      actorUserId: 'usr_provider',
      bookingId: id,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.reason).toBe('invalid_transition');
  });

  it('returns accept_window_expired when the window has elapsed', async () => {
    const ctx = buildSvc();
    const id = await seedPending(ctx);
    // Backdate the window expiry to a moment in the past.
    const row = ctx.prisma.bookings.find((b) => b.id === id)!;
    Object.assign(row, { acceptWindowExpiresAt: new Date(Date.now() - 60_000) });

    const result = await ctx.service.acceptBooking({
      actorUserId: 'usr_provider',
      bookingId: id,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.reason).toBe('accept_window_expired');
    if (result.error.reason !== 'accept_window_expired') return;
    expect(result.error.bookingId).toBe(id);
    expect(result.error.windowExpiredAt.getTime()).toBeLessThan(Date.now());
  });

  it('returns outbox_validation_failed when the booking.confirmed payload is rejected', async () => {
    const ctx = buildSvc();
    const id = await seedPending(ctx);
    ctx.outbox.nextResultOverride = 'validation_failed';

    const result = await ctx.service.acceptBooking({
      actorUserId: 'usr_provider',
      bookingId: id,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.reason).toBe('outbox_validation_failed');
  });
});

describe('BookingsService.declineBooking', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  async function seedPending(svc: ReturnType<typeof buildSvc>): Promise<string> {
    const result = await svc.service.createBooking(VALID_INPUT);
    if (!result.ok) throw new Error('seed failed');
    return result.value.id;
  }

  it('moves pending → declined and emits booking.declined with decline metadata', async () => {
    const ctx = buildSvc();
    const id = await seedPending(ctx);
    ctx.outbox.appendCalls = [];

    const result = await ctx.service.declineBooking({
      actorUserId: 'usr_provider',
      bookingId: id,
      declineKind: 'provider_declined',
      declineReason: 'schedule_conflict',
      declineReasonText: 'double-booked at 6pm',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.status).toBe('declined');
    expect(result.value.declinedAt).not.toBeNull();
    expect(result.value.declineKind).toBe('provider_declined');
    expect(result.value.declineReason).toBe('schedule_conflict');
    expect(result.value.declineReasonText).toBe('double-booked at 6pm');
    expect(result.value.declinedByUserId).toBe('usr_provider');

    expect(ctx.outbox.appendCalls).toHaveLength(1);
    expect(ctx.outbox.appendCalls[0]?.args.eventName).toBe('booking.declined');
    const payload = ctx.outbox.appendCalls[0]?.args.payload as Record<string, unknown>;
    expect(payload['declineKind']).toBe('provider_declined');
    expect(payload['declineReason']).toBe('schedule_conflict');
    expect(payload['declinedByUserId']).toBe('usr_provider');
  });

  it('accepts a window_expired decline with a null reason (worker path)', async () => {
    const ctx = buildSvc();
    const id = await seedPending(ctx);
    ctx.outbox.appendCalls = [];

    const result = await ctx.service.declineBooking({
      actorUserId: 'sys:booking-window-watcher',
      bookingId: id,
      declineKind: 'window_expired',
      declineReason: null,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.declineKind).toBe('window_expired');
    expect(result.value.declineReason).toBeNull();
    expect(result.value.declinedByUserId).toBe('sys:booking-window-watcher');
  });

  it('rejects provider_declined / admin_declined with null reason as invalid_request', async () => {
    const ctx = buildSvc();
    const id = await seedPending(ctx);

    const a = await ctx.service.declineBooking({
      actorUserId: 'usr_provider',
      bookingId: id,
      declineKind: 'provider_declined',
      declineReason: null,
    });
    expect(a.ok).toBe(false);
    if (a.ok) return;
    expect(a.error.reason).toBe('invalid_request');

    const b = await ctx.service.declineBooking({
      actorUserId: 'usr_admin',
      bookingId: id,
      declineKind: 'admin_declined',
      declineReason: null,
    });
    expect(b.ok).toBe(false);
    if (b.ok) return;
    expect(b.error.reason).toBe('invalid_request');
  });

  it('rejects an empty actorUserId / bookingId with invalid_request', async () => {
    const ctx = buildSvc();
    const id = await seedPending(ctx);

    const a = await ctx.service.declineBooking({
      actorUserId: '',
      bookingId: id,
      declineKind: 'provider_declined',
      declineReason: 'schedule_conflict',
    });
    expect(a.ok).toBe(false);
    if (a.ok) return;
    expect(a.error.reason).toBe('invalid_request');

    const b = await ctx.service.declineBooking({
      actorUserId: 'usr',
      bookingId: '',
      declineKind: 'provider_declined',
      declineReason: 'schedule_conflict',
    });
    expect(b.ok).toBe(false);
    if (b.ok) return;
    expect(b.error.reason).toBe('invalid_request');
  });

  it('returns not_found for an unknown booking id', async () => {
    const ctx = buildSvc();
    const result = await ctx.service.declineBooking({
      actorUserId: 'usr_provider',
      bookingId: 'bkg_missing',
      declineKind: 'provider_declined',
      declineReason: 'schedule_conflict',
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.reason).toBe('not_found');
  });

  it('returns invalid_transition when the booking is no longer pending', async () => {
    const ctx = buildSvc();
    const id = await seedPending(ctx);
    await ctx.service.acceptBooking({ actorUserId: 'usr_provider', bookingId: id });

    const result = await ctx.service.declineBooking({
      actorUserId: 'usr_provider',
      bookingId: id,
      declineKind: 'provider_declined',
      declineReason: 'schedule_conflict',
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.reason).toBe('invalid_transition');
  });

  it('permits a decline AFTER the accept window has expired (ops backlog path)', async () => {
    const ctx = buildSvc();
    const id = await seedPending(ctx);
    const row = ctx.prisma.bookings.find((b) => b.id === id)!;
    Object.assign(row, { acceptWindowExpiresAt: new Date(Date.now() - 60_000) });

    const result = await ctx.service.declineBooking({
      actorUserId: 'usr_admin',
      bookingId: id,
      declineKind: 'admin_declined',
      declineReason: 'other',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.status).toBe('declined');
  });

  it('returns outbox_validation_failed when the booking.declined payload is rejected', async () => {
    const ctx = buildSvc();
    const id = await seedPending(ctx);
    ctx.outbox.nextResultOverride = 'validation_failed';

    const result = await ctx.service.declineBooking({
      actorUserId: 'usr_provider',
      bookingId: id,
      declineKind: 'provider_declined',
      declineReason: 'schedule_conflict',
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.reason).toBe('outbox_validation_failed');
  });
});

/**
 * TS-304 — the trust & safety hold screen on `createBooking`.
 *
 * The suite pins three things the design depends on: the screen runs, it
 * runs BEFORE the tier gate and before any write, and the refusal carries
 * enough for ops without leaking the concern.
 */
describe('BookingsService.createBooking — trust & safety holds (TS-304)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-01T12:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('screens all three subjects from the request', async () => {
    const { service, subjectHolds } = buildSvc();

    await service.createBooking(VALID_INPUT);

    expect(subjectHolds.screened).toEqual([
      { providerId: 'prv_abc', seniorId: 'sr_abc', householdId: 'hh_abc' },
    ]);
  });

  it('refuses a booking when a hold covers a subject', async () => {
    const { service } = buildSvc({ activeHolds: [ACTIVE_HOLD] });

    const result = await service.createBooking(VALID_INPUT);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toEqual({
        reason: 'subject_on_hold',
        incidentId: 'inc_hold_1',
        subjectKind: 'provider',
      });
    }
  });

  it('writes NOTHING when a hold blocks — no row, no outbox event', async () => {
    const { service, prisma, outbox } = buildSvc({ activeHolds: [ACTIVE_HOLD] });

    await service.createBooking(VALID_INPUT);

    expect(prisma.bookings).toHaveLength(0);
    expect(outbox.appendCalls).toHaveLength(0);
  });

  it('refuses on the HOLD, not the tier gate, when both would block', async () => {
    // Ordering matters: the tier gate emits a
    // `booking.tier_gating_violation` event, which would misattribute a
    // safety refusal as a tier problem in analytics and in trust & safety's
    // own feed.
    const { service, tierGating, outbox } = buildSvc({ activeHolds: [ACTIVE_HOLD] });
    tierGating.nextDecision = {
      outcome: 'blocked',
      reason: 'tier_3_requires_elite',
      householdTier: 'tier_3_concierge',
      providerTier: 'basic',
    };

    const result = await service.createBooking(VALID_INPUT);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.reason).toBe('subject_on_hold');
    expect(tierGating.evaluate).not.toHaveBeenCalled();
    expect(outbox.appendCalls).toHaveLength(0);
  });

  it('reports the FIRST (longest-standing) hold when several apply', async () => {
    const older: ActiveSubjectHold = {
      ...ACTIVE_HOLD,
      incidentId: 'inc_older',
      subjectKind: 'household',
      subjectId: 'hh_abc',
      heldAt: new Date('2026-04-01T00:00:00.000Z'),
    };
    const { service } = buildSvc({ activeHolds: [older, ACTIVE_HOLD] });

    const result = await service.createBooking(VALID_INPUT);

    expect(result.ok).toBe(false);
    if (!result.ok && result.error.reason === 'subject_on_hold') {
      expect(result.error.incidentId).toBe('inc_older');
    }
  });

  it('creates normally when no hold applies', async () => {
    const { service, prisma } = buildSvc();

    const result = await service.createBooking(VALID_INPUT);

    expect(result.ok).toBe(true);
    expect(prisma.bookings).toHaveLength(1);
  });
});
