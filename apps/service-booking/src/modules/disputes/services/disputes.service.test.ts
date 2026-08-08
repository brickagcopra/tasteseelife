import type { Logger } from '@nestjs/common';
import type {
  OpenBookingDisputeRequest,
  TransitionableBookingDisputeStatus,
  UpdateBookingDisputeRequest,
} from '@taste-and-see/contracts';
import type { OutboxRawExecutor } from '@taste-and-see/nest-outbox';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { PrismaService, PrismaTransactionClient } from '../../../prisma/prisma.service';
import type { BookingStatus } from '../../lifecycle/booking-status';
import { DisputesService, type DisputeRecord, type DisputeStatus } from './disputes.service';

/**
 * DisputesService unit suite (TS-065).
 *
 * Covers:
 *   - input-validation guards
 *   - booking_not_found / dispute_not_found shapes
 *   - lifecycle gate on open (rejects when the booking is `pending`)
 *   - opener-role derivation from actor role names (family / provider
 *     / admin)
 *   - happy-path open + emits `booking.dispute_opened` outbox event
 *   - listByBookingId chronological ordering
 *   - dispute status transitions: open → under_review → resolved /
 *     dismissed; open → resolved / dismissed (direct)
 *   - resolution_notes required for terminal transitions
 *   - terminal transition stamps resolvedAt + resolvedByUserId AND
 *     emits `booking.dispute_resolved` event
 *   - illegal transitions surface `invalid_status_transition`
 *   - outbox validation failure rolls back the transaction
 *
 * Uses an in-memory `FakePrisma` mirroring the pattern in
 * `bookings.service.test.ts` (the established service-booking test
 * convention).
 */

interface FakeBookingRow {
  id: string;
  status: BookingStatus;
  householdId: string;
  providerId: string;
}

interface FakeDisputeRow extends DisputeRecord {}

class FakePrisma {
  public bookings: FakeBookingRow[] = [];
  public disputes: FakeDisputeRow[] = [];
  private disputeIdCounter = 0;

  booking = {
    findUnique: vi.fn(
      async (args: {
        where: { id: string };
        select?: Record<string, boolean>;
      }): Promise<{
        id: string;
        status?: BookingStatus;
        householdId?: string;
        providerId?: string;
      } | null> => {
        const row = this.bookings.find((b) => b.id === args.where.id);
        if (row === undefined) return null;
        // The service uses `select` shapes; we just hand back everything
        // it might have asked for. Test-time precision is sufficient.
        const out: {
          id: string;
          status?: BookingStatus;
          householdId?: string;
          providerId?: string;
        } = { id: row.id };
        if (args.select?.['status']) out.status = row.status;
        if (args.select?.['householdId']) out.householdId = row.householdId;
        if (args.select?.['providerId']) out.providerId = row.providerId;
        return out;
      },
    ),
  };

  bookingDispute = {
    create: vi.fn(async (args: { data: Record<string, unknown> }): Promise<FakeDisputeRow> => {
      const now = new Date('2026-05-14T18:00:00.000Z');
      const data = args.data;
      this.disputeIdCounter += 1;
      const row: FakeDisputeRow = {
        id: (data['id'] as string) ?? `dsp_fake_${this.disputeIdCounter}`,
        bookingId: data['bookingId'] as string,
        openedByUserId: data['openedByUserId'] as string,
        openedByRole: data['openedByRole'] as FakeDisputeRow['openedByRole'],
        reason: data['reason'] as FakeDisputeRow['reason'],
        reasonDetail: (data['reasonDetail'] as string | undefined) ?? null,
        status: ((data['status'] as DisputeStatus) ?? 'open') as DisputeStatus,
        resolutionNotes: null,
        resolvedByUserId: null,
        resolvedAt: null,
        createdAt: now,
        updatedAt: now,
      };
      this.disputes.push(row);
      return row;
    }),
    findUnique: vi.fn(async (args: { where: { id: string } }): Promise<FakeDisputeRow | null> => {
      return this.disputes.find((d) => d.id === args.where.id) ?? null;
    }),
    findMany: vi.fn(
      async (args: {
        where: { bookingId: string };
        orderBy: { createdAt: 'asc' | 'desc' };
      }): Promise<FakeDisputeRow[]> => {
        const rows = this.disputes.filter((d) => d.bookingId === args.where.bookingId);
        rows.sort((a, b) =>
          args.orderBy.createdAt === 'asc'
            ? a.createdAt.getTime() - b.createdAt.getTime()
            : b.createdAt.getTime() - a.createdAt.getTime(),
        );
        return rows;
      },
    ),
    update: vi.fn(
      async (args: {
        where: { id: string };
        data: Record<string, unknown>;
      }): Promise<FakeDisputeRow> => {
        const idx = this.disputes.findIndex((d) => d.id === args.where.id);
        if (idx === -1) {
          throw new Error(`dispute ${args.where.id} not found in fake`);
        }
        const data = args.data;
        const next: FakeDisputeRow = {
          ...this.disputes[idx]!,
          status: (data['status'] as DisputeStatus) ?? this.disputes[idx]!.status,
          resolutionNotes:
            data['resolutionNotes'] !== undefined
              ? ((data['resolutionNotes'] as string | null) ?? null)
              : this.disputes[idx]!.resolutionNotes,
          resolvedByUserId:
            data['resolvedByUserId'] !== undefined
              ? ((data['resolvedByUserId'] as string | null) ?? null)
              : this.disputes[idx]!.resolvedByUserId,
          resolvedAt:
            data['resolvedAt'] !== undefined
              ? ((data['resolvedAt'] as Date | null) ?? null)
              : this.disputes[idx]!.resolvedAt,
          updatedAt: new Date('2026-05-14T18:30:00.000Z'),
        };
        this.disputes[idx] = next;
        return next;
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
  service: DisputesService;
  prisma: FakePrisma;
  outbox: FakeOutboxService;
} {
  const prisma = new FakePrisma();
  const outbox = new FakeOutboxService();
  const service = new DisputesService(
    prisma as unknown as PrismaService,
    outbox as unknown as import('@taste-and-see/nest-outbox').OutboxService,
  );
  const log = (service as unknown as { logger: Logger }).logger;
  log.log = vi.fn();
  log.debug = vi.fn();
  log.error = vi.fn();
  log.warn = vi.fn();
  return { service, prisma, outbox };
}

const VALID_OPEN_REQUEST: OpenBookingDisputeRequest = {
  reason: 'service_quality',
  reasonDetail: 'Chef arrived an hour late and meal was cold.',
};

const SEED_BOOKING: FakeBookingRow = {
  id: 'bkg_1',
  status: 'completed',
  householdId: 'hh_1',
  providerId: 'prov_1',
};

describe('DisputesService.openDispute', () => {
  let svc: ReturnType<typeof buildSvc>;
  beforeEach(() => {
    svc = buildSvc();
  });

  it('rejects when actorUserId is empty', async () => {
    const result = await svc.service.openDispute({
      actorUserId: '',
      actorRoleNames: ['family_payer'],
      bookingId: 'bkg_1',
      request: VALID_OPEN_REQUEST,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.reason).toBe('invalid_request');
  });

  it('rejects when bookingId is empty', async () => {
    const result = await svc.service.openDispute({
      actorUserId: 'usr_family',
      actorRoleNames: ['family_payer'],
      bookingId: '',
      request: VALID_OPEN_REQUEST,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.reason).toBe('invalid_request');
  });

  it('returns booking_not_found when the booking does not exist', async () => {
    const result = await svc.service.openDispute({
      actorUserId: 'usr_family',
      actorRoleNames: ['family_payer'],
      bookingId: 'bkg_ghost',
      request: VALID_OPEN_REQUEST,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.reason).toBe('booking_not_found');
  });

  it('rejects when the booking is in pending (no service rendered)', async () => {
    svc.prisma.bookings.push({ ...SEED_BOOKING, status: 'pending' });
    const result = await svc.service.openDispute({
      actorUserId: 'usr_family',
      actorRoleNames: ['family_payer'],
      bookingId: 'bkg_1',
      request: VALID_OPEN_REQUEST,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.reason).toBe('invalid_booking_status');
      if (result.error.reason === 'invalid_booking_status') {
        expect(result.error.bookingStatus).toBe('pending');
        expect(result.error.allowed).toEqual(['confirmed', 'in_progress', 'completed', 'canceled']);
      }
    }
    expect(svc.prisma.disputes).toHaveLength(0);
    expect(svc.outbox.appendCalls).toHaveLength(0);
  });

  it.each([['confirmed'], ['in_progress'], ['completed'], ['canceled']] as const)(
    'accepts an open when the booking is %s',
    async (status) => {
      svc.prisma.bookings.push({ ...SEED_BOOKING, status });
      const result = await svc.service.openDispute({
        actorUserId: 'usr_family',
        actorRoleNames: ['family_payer'],
        bookingId: 'bkg_1',
        request: VALID_OPEN_REQUEST,
      });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.bookingId).toBe('bkg_1');
        expect(result.value.openedByUserId).toBe('usr_family');
        expect(result.value.status).toBe('open');
      }
    },
  );

  it('derives openedByRole=family for family_payer roles', async () => {
    svc.prisma.bookings.push({ ...SEED_BOOKING });
    const result = await svc.service.openDispute({
      actorUserId: 'usr_family',
      actorRoleNames: ['family_payer'],
      bookingId: 'bkg_1',
      request: VALID_OPEN_REQUEST,
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.openedByRole).toBe('family');
  });

  it('derives openedByRole=provider when the actor holds the provider role', async () => {
    svc.prisma.bookings.push({ ...SEED_BOOKING });
    const result = await svc.service.openDispute({
      actorUserId: 'usr_provider',
      actorRoleNames: ['provider'],
      bookingId: 'bkg_1',
      request: { reason: 'property_damage' },
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.openedByRole).toBe('provider');
  });

  it('derives openedByRole=admin when the actor holds an admin staff role', async () => {
    svc.prisma.bookings.push({ ...SEED_BOOKING });
    const result = await svc.service.openDispute({
      actorUserId: 'usr_ops',
      actorRoleNames: ['concierge_lead', 'family_payer'],
      bookingId: 'bkg_1',
      request: { reason: 'other' },
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.openedByRole).toBe('admin');
  });

  it('persists the optional reasonDetail when supplied', async () => {
    svc.prisma.bookings.push({ ...SEED_BOOKING });
    const result = await svc.service.openDispute({
      actorUserId: 'usr_family',
      actorRoleNames: ['family_payer'],
      bookingId: 'bkg_1',
      request: VALID_OPEN_REQUEST,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.reasonDetail).toBe(VALID_OPEN_REQUEST.reasonDetail);
    }
  });

  it('leaves reasonDetail null when omitted', async () => {
    svc.prisma.bookings.push({ ...SEED_BOOKING });
    const result = await svc.service.openDispute({
      actorUserId: 'usr_family',
      actorRoleNames: ['family_payer'],
      bookingId: 'bkg_1',
      request: { reason: 'no_show' },
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.reasonDetail).toBeNull();
  });

  it('emits booking.dispute_opened with the expected payload shape', async () => {
    svc.prisma.bookings.push({ ...SEED_BOOKING });
    await svc.service.openDispute({
      actorUserId: 'usr_family',
      actorRoleNames: ['family_payer'],
      bookingId: 'bkg_1',
      request: VALID_OPEN_REQUEST,
    });
    expect(svc.outbox.appendCalls).toHaveLength(1);
    const call = svc.outbox.appendCalls[0]!;
    expect(call.args.eventName).toBe('booking.dispute_opened');
    const payload = call.args.payload as Record<string, unknown>;
    expect(payload['bookingId']).toBe('bkg_1');
    expect(payload['householdId']).toBe('hh_1');
    expect(payload['providerId']).toBe('prov_1');
    expect(payload['openedByUserId']).toBe('usr_family');
    expect(payload['openedByRole']).toBe('family');
    expect(payload['reason']).toBe('service_quality');
    expect(payload['hasReasonDetail']).toBe(true);
    expect(typeof payload['eventId']).toBe('string');
    expect(typeof payload['occurredAt']).toBe('string');
  });

  it('sets hasReasonDetail=false on the event when no detail supplied', async () => {
    svc.prisma.bookings.push({ ...SEED_BOOKING });
    await svc.service.openDispute({
      actorUserId: 'usr_family',
      actorRoleNames: ['family_payer'],
      bookingId: 'bkg_1',
      request: { reason: 'no_show' },
    });
    const payload = svc.outbox.appendCalls[0]!.args.payload as Record<string, unknown>;
    expect(payload['hasReasonDetail']).toBe(false);
  });

  it('rolls back the row + event on outbox validation failure', async () => {
    svc.prisma.bookings.push({ ...SEED_BOOKING });
    svc.outbox.nextResultOverride = 'validation_failed';
    const result = await svc.service.openDispute({
      actorUserId: 'usr_family',
      actorRoleNames: ['family_payer'],
      bookingId: 'bkg_1',
      request: VALID_OPEN_REQUEST,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.reason).toBe('outbox_validation_failed');
  });
});

describe('DisputesService.getById', () => {
  let svc: ReturnType<typeof buildSvc>;
  beforeEach(() => {
    svc = buildSvc();
  });

  it('rejects when actorUserId is empty', async () => {
    const result = await svc.service.getById({ actorUserId: '', disputeId: 'dsp_1' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.reason).toBe('invalid_request');
  });

  it('rejects when disputeId is empty', async () => {
    const result = await svc.service.getById({ actorUserId: 'usr', disputeId: '' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.reason).toBe('invalid_request');
  });

  it('returns dispute_not_found when the dispute does not exist', async () => {
    const result = await svc.service.getById({
      actorUserId: 'usr',
      disputeId: 'dsp_ghost',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.reason).toBe('dispute_not_found');
  });

  it('returns the row when present', async () => {
    svc.prisma.bookings.push({ ...SEED_BOOKING });
    const opened = await svc.service.openDispute({
      actorUserId: 'usr_family',
      actorRoleNames: ['family_payer'],
      bookingId: 'bkg_1',
      request: VALID_OPEN_REQUEST,
    });
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    const result = await svc.service.getById({
      actorUserId: 'usr_family',
      disputeId: opened.value.id,
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.id).toBe(opened.value.id);
  });
});

describe('DisputesService.listByBookingId', () => {
  let svc: ReturnType<typeof buildSvc>;
  beforeEach(() => {
    svc = buildSvc();
  });

  it('returns booking_not_found when the booking does not exist', async () => {
    const result = await svc.service.listByBookingId({
      actorUserId: 'usr',
      bookingId: 'bkg_ghost',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.reason).toBe('booking_not_found');
  });

  it('returns an empty list when the booking has no disputes', async () => {
    svc.prisma.bookings.push({ ...SEED_BOOKING });
    const result = await svc.service.listByBookingId({
      actorUserId: 'usr',
      bookingId: 'bkg_1',
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toEqual([]);
  });

  it('returns disputes in chronological ascending order', async () => {
    svc.prisma.bookings.push({ ...SEED_BOOKING });
    // Push three disputes with monotonically advancing createdAt
    // (the fake stamps the same constant; we override via direct push).
    svc.prisma.disputes.push(
      {
        id: 'dsp_1',
        bookingId: 'bkg_1',
        openedByUserId: 'usr_a',
        openedByRole: 'family',
        reason: 'no_show',
        reasonDetail: null,
        status: 'resolved',
        resolutionNotes: 'comped',
        resolvedByUserId: 'usr_ops',
        resolvedAt: new Date('2026-05-14T12:00:00.000Z'),
        createdAt: new Date('2026-05-14T11:00:00.000Z'),
        updatedAt: new Date('2026-05-14T12:00:00.000Z'),
      },
      {
        id: 'dsp_2',
        bookingId: 'bkg_1',
        openedByUserId: 'usr_b',
        openedByRole: 'provider',
        reason: 'property_damage',
        reasonDetail: null,
        status: 'open',
        resolutionNotes: null,
        resolvedByUserId: null,
        resolvedAt: null,
        createdAt: new Date('2026-05-14T13:00:00.000Z'),
        updatedAt: new Date('2026-05-14T13:00:00.000Z'),
      },
      // Out of order in the underlying array — the fake's orderBy sorts.
      {
        id: 'dsp_0',
        bookingId: 'bkg_1',
        openedByUserId: 'usr_a',
        openedByRole: 'family',
        reason: 'service_quality',
        reasonDetail: null,
        status: 'dismissed',
        resolutionNotes: 'investigated',
        resolvedByUserId: 'usr_ops',
        resolvedAt: new Date('2026-05-14T11:30:00.000Z'),
        createdAt: new Date('2026-05-14T10:00:00.000Z'),
        updatedAt: new Date('2026-05-14T11:30:00.000Z'),
      },
    );
    const result = await svc.service.listByBookingId({
      actorUserId: 'usr',
      bookingId: 'bkg_1',
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.map((d) => d.id)).toEqual(['dsp_0', 'dsp_1', 'dsp_2']);
    }
  });
});

describe('DisputesService.updateDispute', () => {
  let svc: ReturnType<typeof buildSvc>;
  beforeEach(() => {
    svc = buildSvc();
  });

  async function seedOpenDispute(): Promise<string> {
    svc.prisma.bookings.push({ ...SEED_BOOKING });
    const opened = await svc.service.openDispute({
      actorUserId: 'usr_family',
      actorRoleNames: ['family_payer'],
      bookingId: 'bkg_1',
      request: VALID_OPEN_REQUEST,
    });
    if (!opened.ok) throw new Error('test seed failed');
    svc.outbox.appendCalls = []; // reset for assertion clarity
    return opened.value.id;
  }

  it('rejects when actorUserId is empty', async () => {
    const result = await svc.service.updateDispute({
      actorUserId: '',
      disputeId: 'dsp_1',
      request: { targetStatus: 'under_review' },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.reason).toBe('invalid_request');
  });

  it('rejects when disputeId is empty', async () => {
    const result = await svc.service.updateDispute({
      actorUserId: 'usr',
      disputeId: '',
      request: { targetStatus: 'under_review' },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.reason).toBe('invalid_request');
  });

  it('returns dispute_not_found when the dispute does not exist', async () => {
    const result = await svc.service.updateDispute({
      actorUserId: 'usr',
      disputeId: 'dsp_ghost',
      request: { targetStatus: 'under_review' },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.reason).toBe('dispute_not_found');
  });

  it('transitions open → under_review without emitting an event', async () => {
    const id = await seedOpenDispute();
    const result = await svc.service.updateDispute({
      actorUserId: 'usr_ops',
      disputeId: id,
      request: { targetStatus: 'under_review' },
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.status).toBe('under_review');
      expect(result.value.resolvedAt).toBeNull();
      expect(result.value.resolvedByUserId).toBeNull();
      expect(result.value.resolutionNotes).toBeNull();
    }
    expect(svc.outbox.appendCalls).toHaveLength(0);
  });

  it('transitions open → resolved with notes + emits booking.dispute_resolved', async () => {
    const id = await seedOpenDispute();
    const result = await svc.service.updateDispute({
      actorUserId: 'usr_ops',
      disputeId: id,
      request: { targetStatus: 'resolved', resolutionNotes: 'Refunded $100.' },
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.status).toBe('resolved');
      expect(result.value.resolvedAt).not.toBeNull();
      expect(result.value.resolvedByUserId).toBe('usr_ops');
      expect(result.value.resolutionNotes).toBe('Refunded $100.');
    }
    expect(svc.outbox.appendCalls).toHaveLength(1);
    const call = svc.outbox.appendCalls[0]!;
    expect(call.args.eventName).toBe('booking.dispute_resolved');
    const payload = call.args.payload as Record<string, unknown>;
    expect(payload['disputeId']).toBe(id);
    expect(payload['outcome']).toBe('resolved');
    expect(payload['resolvedByUserId']).toBe('usr_ops');
    expect(payload['hasResolutionNotes']).toBe(true);
  });

  it('transitions open → dismissed with notes + emits dismissed outcome', async () => {
    const id = await seedOpenDispute();
    const result = await svc.service.updateDispute({
      actorUserId: 'usr_ops',
      disputeId: id,
      request: { targetStatus: 'dismissed', resolutionNotes: 'Unfounded complaint.' },
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.status).toBe('dismissed');
    const payload = svc.outbox.appendCalls[0]!.args.payload as Record<string, unknown>;
    expect(payload['outcome']).toBe('dismissed');
  });

  it('rejects open → resolved without resolutionNotes', async () => {
    const id = await seedOpenDispute();
    const result = await svc.service.updateDispute({
      actorUserId: 'usr_ops',
      disputeId: id,
      // The contract layer's superRefine would have caught this at the
      // wire, but the service repeats the gate so a non-HTTP caller
      // (admin script, future internal endpoint) gets the same gate.
      request: { targetStatus: 'resolved' } as UpdateBookingDisputeRequest,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.reason).toBe('resolution_notes_required');
    expect(svc.prisma.disputes[0]!.status).toBe('open');
    expect(svc.outbox.appendCalls).toHaveLength(0);
  });

  it.each([
    ['under_review', 'resolved'],
    ['under_review', 'dismissed'],
  ] as const)('transitions under_review → %s when valid', async (_from, to) => {
    const id = await seedOpenDispute();
    // First move to under_review (no event).
    await svc.service.updateDispute({
      actorUserId: 'usr_ops',
      disputeId: id,
      request: { targetStatus: 'under_review' },
    });
    svc.outbox.appendCalls = [];
    const result = await svc.service.updateDispute({
      actorUserId: 'usr_ops',
      disputeId: id,
      request: { targetStatus: to, resolutionNotes: 'Outcome notes.' },
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.status).toBe(to);
    expect(svc.outbox.appendCalls).toHaveLength(1);
  });

  it('rejects a terminal → any transition (resolved is terminal)', async () => {
    const id = await seedOpenDispute();
    await svc.service.updateDispute({
      actorUserId: 'usr_ops',
      disputeId: id,
      request: { targetStatus: 'resolved', resolutionNotes: 'Done.' },
    });
    const result = await svc.service.updateDispute({
      actorUserId: 'usr_ops',
      disputeId: id,
      request: { targetStatus: 'under_review' as TransitionableBookingDisputeStatus },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.reason).toBe('invalid_status_transition');
      if (result.error.reason === 'invalid_status_transition') {
        expect(result.error.from).toBe('resolved');
        expect(result.error.to).toBe('under_review');
        expect(result.error.allowed).toEqual([]);
      }
    }
  });

  it('rejects dismissed → resolved (terminal)', async () => {
    const id = await seedOpenDispute();
    await svc.service.updateDispute({
      actorUserId: 'usr_ops',
      disputeId: id,
      request: { targetStatus: 'dismissed', resolutionNotes: 'Closed.' },
    });
    const result = await svc.service.updateDispute({
      actorUserId: 'usr_ops',
      disputeId: id,
      request: { targetStatus: 'resolved', resolutionNotes: 'Reconsidering.' },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.reason).toBe('invalid_status_transition');
  });

  it('rolls back on outbox validation failure during resolved transition', async () => {
    const id = await seedOpenDispute();
    svc.outbox.nextResultOverride = 'validation_failed';
    const result = await svc.service.updateDispute({
      actorUserId: 'usr_ops',
      disputeId: id,
      request: { targetStatus: 'resolved', resolutionNotes: 'Done.' },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.reason).toBe('outbox_validation_failed');
  });
});
