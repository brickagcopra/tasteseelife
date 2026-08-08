import { beforeEach, describe, expect, it } from 'vitest';

import type { Env } from '../../../config/env';
import type { PrismaService } from '../../../prisma/prisma.service';
import type { PayoutAccountRecord } from '../../connect/services/payout-accounts.service';
import type { PayoutAccountsService } from '../../connect/services/payout-accounts.service';

import { __testing, DisbursementsService } from './disbursements.service';
import { StripeTransfersService } from './stripe-transfers.service';

function buildEnv(overrides: Partial<Env> = {}): Env {
  return {
    NODE_ENV: 'test',
    PORT: 3018,
    LOG_LEVEL: 'info',
    DATABASE_URL: 'postgresql://test:test@localhost:5432/test',
    SERVICE_VERSION: 'dev',
    OTEL_TRACES_ENABLED: false,
    OTEL_METRICS_ENABLED: false,
    JWT_ACCESS_SECRET: 'a'.repeat(32),
    INTERNAL_TRUST_SIGNING_SECRET: 't'.repeat(32),
    INTERNAL_TRUST_MAX_AGE_SECONDS: 60,
    JWT_ISSUER: 'taste-and-see/service-identity',
    JWT_AUDIENCE: 'taste-and-see/api',
    STRIPE_API_VERSION: '2024-12-18.acacia',
    STRIPE_STUB_ONBOARDING_BASE_URL: 'https://stub.example.test',
    STRIPE_EVENTS_HEADER_NAME: 'x-internal-api-key',
    STRIPE_EVENTS_API_KEY: 'k'.repeat(40),
    PAYOUT_HOLD_DAYS: 2,
    PAYOUT_MIN_AMOUNT_MINOR: 100,
    PAYOUT_DEFAULT_CURRENCY: 'USD',
    PAYOUT_TRANSFERS_HEADER_NAME: 'x-internal-api-key',
    PAYOUT_TRANSFERS_API_KEY: 't'.repeat(40),
    ...overrides,
  };
}

interface FakeDisbursementRow {
  id: string;
  providerId: string;
  stripeAccountId: string;
  stripeTransferId: string | null;
  currency: string;
  amountMinor: bigint;
  idempotencyKey: string;
  sourceEventId: string;
  scheduledFor: Date;
  heldUntil: Date;
  initiatedAt: Date | null;
  paidAt: Date | null;
  failedAt: Date | null;
  failureReason: string | null;
  memo: string | null;
  status: 'pending' | 'in_transit' | 'paid' | 'failed' | 'canceled';
  liveMode: boolean;
  createdAt: Date;
  updatedAt: Date;
}

class FakePrisma {
  rows: FakeDisbursementRow[] = [];
  private idCounter = 0;

  payoutDisbursement = {
    findUnique: async (args: {
      where: {
        id?: string;
        idempotencyKey?: string;
        sourceEventId?: string;
        stripeTransferId?: string;
      };
    }): Promise<FakeDisbursementRow | null> => {
      const w = args.where;
      const match = this.rows.find((r) => {
        if (w.id !== undefined) return r.id === w.id;
        if (w.idempotencyKey !== undefined) return r.idempotencyKey === w.idempotencyKey;
        if (w.sourceEventId !== undefined) return r.sourceEventId === w.sourceEventId;
        if (w.stripeTransferId !== undefined) return r.stripeTransferId === w.stripeTransferId;
        return false;
      });
      return match ?? null;
    },
    create: async (args: {
      data: Partial<FakeDisbursementRow> & { amountMinor: bigint };
    }): Promise<FakeDisbursementRow> => {
      const d = args.data;
      if (
        this.rows.some(
          (r) => r.idempotencyKey === d.idempotencyKey || r.sourceEventId === d.sourceEventId,
        )
      ) {
        const err: unknown = { code: 'P2002' };
        throw err;
      }
      const now = new Date();
      const row: FakeDisbursementRow = {
        id: `d_${++this.idCounter}`,
        providerId: d.providerId ?? '',
        stripeAccountId: d.stripeAccountId ?? '',
        stripeTransferId: d.stripeTransferId ?? null,
        currency: d.currency ?? 'USD',
        amountMinor: d.amountMinor,
        idempotencyKey: d.idempotencyKey ?? '',
        sourceEventId: d.sourceEventId ?? '',
        scheduledFor: d.scheduledFor ?? now,
        heldUntil: d.heldUntil ?? now,
        initiatedAt: d.initiatedAt ?? null,
        paidAt: d.paidAt ?? null,
        failedAt: d.failedAt ?? null,
        failureReason: d.failureReason ?? null,
        memo: d.memo ?? null,
        status: d.status ?? 'pending',
        liveMode: d.liveMode ?? false,
        createdAt: now,
        updatedAt: now,
      };
      this.rows.push(row);
      return row;
    },
    update: async (args: {
      where: { id: string };
      data: Partial<FakeDisbursementRow>;
    }): Promise<FakeDisbursementRow> => {
      const row = this.rows.find((r) => r.id === args.where.id);
      if (row === undefined) throw new Error('row not found');
      Object.assign(row, args.data);
      row.updatedAt = new Date();
      return row;
    },
    findMany: async (args: {
      where?: {
        providerId?: string;
        status?: string;
        scheduledFor?: { gte?: Date; lte?: Date };
      };
      orderBy?: unknown;
      take?: number;
      cursor?: { id: string };
      skip?: number;
    }): Promise<FakeDisbursementRow[]> => {
      let rows = [...this.rows];
      if (args.where?.providerId !== undefined) {
        rows = rows.filter((r) => r.providerId === args.where!.providerId);
      }
      if (args.where?.status !== undefined) {
        rows = rows.filter((r) => r.status === args.where!.status);
      }
      if (args.where?.scheduledFor !== undefined) {
        const range = args.where.scheduledFor;
        if (range.gte !== undefined) {
          rows = rows.filter((r) => r.scheduledFor.getTime() >= range.gte!.getTime());
        }
        if (range.lte !== undefined) {
          rows = rows.filter((r) => r.scheduledFor.getTime() <= range.lte!.getTime());
        }
      }
      rows.sort((a, b) => {
        if (a.createdAt.getTime() !== b.createdAt.getTime()) {
          return b.createdAt.getTime() - a.createdAt.getTime();
        }
        return a.id < b.id ? 1 : -1;
      });
      if (args.cursor !== undefined) {
        const idx = rows.findIndex((r) => r.id === args.cursor!.id);
        if (idx >= 0) rows = rows.slice(idx + (args.skip ?? 0));
      }
      if (args.take !== undefined && args.take > 0) {
        rows = rows.slice(0, args.take);
      }
      return rows;
    },
  };
}

class FakeAccountsService {
  accounts = new Map<string, PayoutAccountRecord>();

  async getByProvider(providerId: string): Promise<PayoutAccountRecord | null> {
    return this.accounts.get(providerId) ?? null;
  }

  seedActive(providerId: string): PayoutAccountRecord {
    const record: PayoutAccountRecord = {
      id: `acc_${providerId}`,
      providerId,
      stripeAccountId: `acct_stub_${providerId}`,
      country: 'US',
      defaultCurrency: 'USD',
      status: 'active',
      chargesEnabled: true,
      payoutsEnabled: true,
      detailsSubmitted: true,
      requirementsCurrentlyDue: [],
      requirementsPastDue: [],
      disabledReason: null,
      liveMode: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    this.accounts.set(providerId, record);
    return record;
  }

  seedRestricted(providerId: string): PayoutAccountRecord {
    const record = this.seedActive(providerId);
    const restricted: PayoutAccountRecord = { ...record, status: 'restricted' };
    this.accounts.set(providerId, restricted);
    return restricted;
  }
}

function makeService(prisma: FakePrisma, accounts: FakeAccountsService): DisbursementsService {
  return new DisbursementsService(
    prisma as unknown as PrismaService,
    accounts as unknown as PayoutAccountsService,
    new StripeTransfersService(buildEnv()),
  );
}

describe('DisbursementsService.scheduleDisbursement', () => {
  let prisma: FakePrisma;
  let accounts: FakeAccountsService;
  let service: DisbursementsService;

  beforeEach(() => {
    prisma = new FakePrisma();
    accounts = new FakeAccountsService();
    service = makeService(prisma, accounts);
  });

  const baseInput = {
    providerId: 'pr_a',
    amountMinor: 10_000,
    currency: 'USD',
    idempotencyKey: 'sweep:2026-05-16:pr_a',
    scheduledFor: new Date(Date.UTC(2026, 4, 16)),
    holdDays: 2,
  };

  it('creates a new pending row for an active provider', async () => {
    accounts.seedActive('pr_a');
    const result = await service.scheduleDisbursement(baseInput);
    expect(result.outcome).toBe('created');
    if (result.outcome === 'created') {
      expect(result.disbursement.status).toBe('pending');
      expect(result.disbursement.stripeAccountId).toBe('acct_stub_pr_a');
      expect(result.disbursement.amountMinor).toBe(10_000);
      expect(result.disbursement.sourceEventId).toBe('payout:idempotency:sweep:2026-05-16:pr_a');
    }
  });

  it('returns existing on idempotency-key replay', async () => {
    accounts.seedActive('pr_a');
    const a = await service.scheduleDisbursement(baseInput);
    const b = await service.scheduleDisbursement(baseInput);
    expect(a.outcome).toBe('created');
    expect(b.outcome).toBe('existing');
    if (a.outcome === 'created' && b.outcome === 'existing') {
      expect(b.disbursement.id).toBe(a.disbursement.id);
    }
    expect(prisma.rows.length).toBe(1);
  });

  it('returns account_not_found when no payout account exists', async () => {
    const result = await service.scheduleDisbursement(baseInput);
    expect(result.outcome).toBe('account_not_found');
  });

  it('returns account_not_active for a restricted account', async () => {
    accounts.seedRestricted('pr_a');
    const result = await service.scheduleDisbursement(baseInput);
    expect(result.outcome).toBe('account_not_active');
    if (result.outcome === 'account_not_active') {
      expect(result.status).toBe('restricted');
    }
  });

  it('computes heldUntil = scheduledFor + holdDays', async () => {
    accounts.seedActive('pr_a');
    const result = await service.scheduleDisbursement({
      ...baseInput,
      scheduledFor: new Date(Date.UTC(2026, 4, 16, 10, 30)),
      holdDays: 2,
    });
    expect(result.outcome).toBe('created');
    if (result.outcome === 'created') {
      // scheduledFor stripped to date → 2026-05-16T00:00Z, + 2 days = 2026-05-18T00:00Z.
      expect(result.disbursement.heldUntil.toISOString()).toBe('2026-05-18T00:00:00.000Z');
    }
  });

  it('honours an explicit sourceEventId', async () => {
    accounts.seedActive('pr_a');
    const result = await service.scheduleDisbursement({
      ...baseInput,
      sourceEventId: 'manual:ops-2026-05-16:case-123',
    });
    expect(result.outcome).toBe('created');
    if (result.outcome === 'created') {
      expect(result.disbursement.sourceEventId).toBe('manual:ops-2026-05-16:case-123');
    }
  });

  it('persists a memo when supplied', async () => {
    accounts.seedActive('pr_a');
    const result = await service.scheduleDisbursement({
      ...baseInput,
      memo: 'dispute hold release',
    });
    expect(result.outcome).toBe('created');
    if (result.outcome === 'created') {
      expect(result.disbursement.memo).toBe('dispute hold release');
    }
  });
});

describe('DisbursementsService.executeDisbursement', () => {
  let prisma: FakePrisma;
  let accounts: FakeAccountsService;
  let service: DisbursementsService;

  beforeEach(() => {
    prisma = new FakePrisma();
    accounts = new FakeAccountsService();
    service = makeService(prisma, accounts);
    accounts.seedActive('pr_a');
  });

  it('initiates a pending disbursement past its hold window', async () => {
    const schedule = await service.scheduleDisbursement({
      providerId: 'pr_a',
      amountMinor: 10_000,
      currency: 'USD',
      idempotencyKey: 'k1',
      scheduledFor: new Date(Date.UTC(2026, 4, 16)),
      holdDays: 2,
    });
    if (schedule.outcome !== 'created') throw new Error('precondition');
    const result = await service.executeDisbursement({
      disbursementId: schedule.disbursement.id,
      asOf: new Date(Date.UTC(2026, 4, 20)),
    });
    expect(result?.outcome).toBe('initiated');
    expect(result?.disbursement.status).toBe('in_transit');
    expect(result?.disbursement.stripeTransferId).toBe(`tr_stub_${schedule.disbursement.id}`);
    expect(result?.disbursement.initiatedAt).not.toBeNull();
  });

  it('refuses to initiate before the hold window clears', async () => {
    const schedule = await service.scheduleDisbursement({
      providerId: 'pr_a',
      amountMinor: 10_000,
      currency: 'USD',
      idempotencyKey: 'k2',
      scheduledFor: new Date(Date.UTC(2026, 4, 16)),
      holdDays: 2,
    });
    if (schedule.outcome !== 'created') throw new Error('precondition');
    const result = await service.executeDisbursement({
      disbursementId: schedule.disbursement.id,
      asOf: new Date(Date.UTC(2026, 4, 16, 12)),
    });
    expect(result?.outcome).toBe('not_initiable');
    expect(result?.disbursement.status).toBe('pending');
  });

  it('returns already_initiated for an in_transit row', async () => {
    const schedule = await service.scheduleDisbursement({
      providerId: 'pr_a',
      amountMinor: 10_000,
      currency: 'USD',
      idempotencyKey: 'k3',
      scheduledFor: new Date(Date.UTC(2026, 4, 16)),
      holdDays: 0,
    });
    if (schedule.outcome !== 'created') throw new Error('precondition');
    await service.executeDisbursement({
      disbursementId: schedule.disbursement.id,
      asOf: new Date(Date.UTC(2026, 4, 16)),
    });
    const second = await service.executeDisbursement({
      disbursementId: schedule.disbursement.id,
      asOf: new Date(Date.UTC(2026, 4, 16)),
    });
    expect(second?.outcome).toBe('already_initiated');
  });

  it('returns null for an unknown disbursement id', async () => {
    const result = await service.executeDisbursement({
      disbursementId: 'd_missing',
      asOf: new Date(),
    });
    expect(result).toBeNull();
  });

  it('returns not_initiable for a canceled disbursement', async () => {
    const schedule = await service.scheduleDisbursement({
      providerId: 'pr_a',
      amountMinor: 10_000,
      currency: 'USD',
      idempotencyKey: 'k4',
      scheduledFor: new Date(Date.UTC(2026, 4, 16)),
      holdDays: 0,
    });
    if (schedule.outcome !== 'created') throw new Error('precondition');
    await service.cancelDisbursement({ disbursementId: schedule.disbursement.id });
    const result = await service.executeDisbursement({
      disbursementId: schedule.disbursement.id,
      asOf: new Date(Date.UTC(2026, 4, 20)),
    });
    expect(result?.outcome).toBe('not_initiable');
  });
});

describe('DisbursementsService.applyTransferEvent', () => {
  let prisma: FakePrisma;
  let accounts: FakeAccountsService;
  let service: DisbursementsService;

  beforeEach(() => {
    prisma = new FakePrisma();
    accounts = new FakeAccountsService();
    service = makeService(prisma, accounts);
    accounts.seedActive('pr_a');
  });

  async function makeInTransit(idempotencyKey: string): Promise<{
    disbursementId: string;
    stripeTransferId: string;
  }> {
    const schedule = await service.scheduleDisbursement({
      providerId: 'pr_a',
      amountMinor: 10_000,
      currency: 'USD',
      idempotencyKey,
      scheduledFor: new Date(Date.UTC(2026, 4, 16)),
      holdDays: 0,
    });
    if (schedule.outcome !== 'created') throw new Error('precondition');
    const exec = await service.executeDisbursement({
      disbursementId: schedule.disbursement.id,
      asOf: new Date(Date.UTC(2026, 4, 16)),
    });
    if (exec === null || exec.disbursement.stripeTransferId === null) {
      throw new Error('precondition');
    }
    return {
      disbursementId: schedule.disbursement.id,
      stripeTransferId: exec.disbursement.stripeTransferId,
    };
  }

  it('marks an in_transit row paid on first delivery', async () => {
    const { stripeTransferId } = await makeInTransit('k1');
    const result = await service.applyTransferEvent({
      stripeTransferId,
      outcome: 'paid',
      occurredAt: new Date('2026-05-17T00:00:00Z'),
    });
    expect(result.outcome).toBe('applied');
    if (result.outcome === 'applied') {
      expect(result.disbursement.status).toBe('paid');
      expect(result.disbursement.paidAt?.toISOString()).toBe('2026-05-17T00:00:00.000Z');
    }
  });

  it('returns replayed for a duplicate paid event', async () => {
    const { stripeTransferId } = await makeInTransit('k2');
    const occurredAt = new Date('2026-05-17T00:00:00Z');
    await service.applyTransferEvent({ stripeTransferId, outcome: 'paid', occurredAt });
    const second = await service.applyTransferEvent({
      stripeTransferId,
      outcome: 'paid',
      occurredAt: new Date('2026-05-17T01:00:00Z'),
    });
    expect(second.outcome).toBe('replayed');
  });

  it('marks an in_transit row failed with reason', async () => {
    const { stripeTransferId } = await makeInTransit('k3');
    const result = await service.applyTransferEvent({
      stripeTransferId,
      outcome: 'failed',
      occurredAt: new Date('2026-05-17T00:00:00Z'),
      failureReason: 'account_closed',
    });
    expect(result.outcome).toBe('applied');
    if (result.outcome === 'applied') {
      expect(result.disbursement.status).toBe('failed');
      expect(result.disbursement.failureReason).toBe('account_closed');
    }
  });

  it('throws when failureReason is missing on a failed event', async () => {
    const { stripeTransferId } = await makeInTransit('k4');
    await expect(
      service.applyTransferEvent({
        stripeTransferId,
        outcome: 'failed',
        occurredAt: new Date('2026-05-17T00:00:00Z'),
      }),
    ).rejects.toThrow();
  });

  it('returns ignored for an unknown stripeTransferId', async () => {
    const result = await service.applyTransferEvent({
      stripeTransferId: 'tr_unknown',
      outcome: 'paid',
      occurredAt: new Date(),
    });
    expect(result.outcome).toBe('ignored');
    expect(result.disbursement).toBeNull();
  });

  it('returns ignored when the disbursement was canceled', async () => {
    const schedule = await service.scheduleDisbursement({
      providerId: 'pr_a',
      amountMinor: 10_000,
      currency: 'USD',
      idempotencyKey: 'k5',
      scheduledFor: new Date(Date.UTC(2026, 4, 16)),
      holdDays: 0,
    });
    if (schedule.outcome !== 'created') throw new Error('precondition');
    // Manually attach a stripe transfer id so the lookup path resolves.
    prisma.rows[0]!.stripeTransferId = 'tr_canceled';
    await service.cancelDisbursement({ disbursementId: schedule.disbursement.id });
    const result = await service.applyTransferEvent({
      stripeTransferId: 'tr_canceled',
      outcome: 'paid',
      occurredAt: new Date(),
    });
    expect(result.outcome).toBe('ignored');
  });

  it('handles paid arriving before in_transit (Stripe race) — backfills initiatedAt', async () => {
    // Schedule + manually populate transfer id without executing.
    const schedule = await service.scheduleDisbursement({
      providerId: 'pr_a',
      amountMinor: 10_000,
      currency: 'USD',
      idempotencyKey: 'k6',
      scheduledFor: new Date(Date.UTC(2026, 4, 16)),
      holdDays: 0,
    });
    if (schedule.outcome !== 'created') throw new Error('precondition');
    prisma.rows[0]!.stripeTransferId = 'tr_race';
    const result = await service.applyTransferEvent({
      stripeTransferId: 'tr_race',
      outcome: 'paid',
      occurredAt: new Date('2026-05-17T00:00:00Z'),
    });
    expect(result.outcome).toBe('applied');
    if (result.outcome === 'applied') {
      expect(result.disbursement.status).toBe('paid');
      expect(result.disbursement.initiatedAt?.toISOString()).toBe('2026-05-17T00:00:00.000Z');
    }
  });
});

describe('DisbursementsService.cancelDisbursement', () => {
  let prisma: FakePrisma;
  let accounts: FakeAccountsService;
  let service: DisbursementsService;

  beforeEach(() => {
    prisma = new FakePrisma();
    accounts = new FakeAccountsService();
    service = makeService(prisma, accounts);
    accounts.seedActive('pr_a');
  });

  it('cancels a pending disbursement', async () => {
    const schedule = await service.scheduleDisbursement({
      providerId: 'pr_a',
      amountMinor: 10_000,
      currency: 'USD',
      idempotencyKey: 'k1',
      scheduledFor: new Date(Date.UTC(2026, 4, 16)),
      holdDays: 2,
    });
    if (schedule.outcome !== 'created') throw new Error('precondition');
    const result = await service.cancelDisbursement({
      disbursementId: schedule.disbursement.id,
      reason: 'operator changed mind',
    });
    expect(result?.outcome).toBe('canceled');
    if (result?.outcome === 'canceled') {
      expect(result.disbursement.status).toBe('canceled');
      expect(result.disbursement.memo).toBe('operator changed mind');
    }
  });

  it('returns idempotent_canceled on re-cancel', async () => {
    const schedule = await service.scheduleDisbursement({
      providerId: 'pr_a',
      amountMinor: 10_000,
      currency: 'USD',
      idempotencyKey: 'k2',
      scheduledFor: new Date(Date.UTC(2026, 4, 16)),
      holdDays: 2,
    });
    if (schedule.outcome !== 'created') throw new Error('precondition');
    await service.cancelDisbursement({ disbursementId: schedule.disbursement.id });
    const second = await service.cancelDisbursement({
      disbursementId: schedule.disbursement.id,
    });
    expect(second?.outcome).toBe('idempotent_canceled');
  });

  it('returns not_cancelable for an in_transit disbursement', async () => {
    const schedule = await service.scheduleDisbursement({
      providerId: 'pr_a',
      amountMinor: 10_000,
      currency: 'USD',
      idempotencyKey: 'k3',
      scheduledFor: new Date(Date.UTC(2026, 4, 16)),
      holdDays: 0,
    });
    if (schedule.outcome !== 'created') throw new Error('precondition');
    await service.executeDisbursement({
      disbursementId: schedule.disbursement.id,
      asOf: new Date(Date.UTC(2026, 4, 16)),
    });
    const result = await service.cancelDisbursement({
      disbursementId: schedule.disbursement.id,
    });
    expect(result?.outcome).toBe('not_cancelable');
  });

  it('returns null for an unknown id', async () => {
    const result = await service.cancelDisbursement({ disbursementId: 'd_missing' });
    expect(result).toBeNull();
  });
});

describe('DisbursementsService.list', () => {
  let prisma: FakePrisma;
  let service: DisbursementsService;

  beforeEach(async () => {
    prisma = new FakePrisma();
    const accounts = new FakeAccountsService();
    service = makeService(prisma, accounts);
    accounts.seedActive('pr_a');
    accounts.seedActive('pr_b');
    for (let i = 0; i < 3; i++) {
      await service.scheduleDisbursement({
        providerId: 'pr_a',
        amountMinor: 1_000 + i,
        currency: 'USD',
        idempotencyKey: `a-${i}`,
        scheduledFor: new Date(Date.UTC(2026, 4, 10 + i)),
        holdDays: 0,
      });
    }
    await service.scheduleDisbursement({
      providerId: 'pr_b',
      amountMinor: 5_000,
      currency: 'USD',
      idempotencyKey: 'b-0',
      scheduledFor: new Date(Date.UTC(2026, 4, 14)),
      holdDays: 0,
    });
  });

  it('returns every row newest-first with no filters', async () => {
    const result = await service.list({ limit: 10 });
    expect(result.rows.length).toBe(4);
    expect(result.nextCursor).toBeNull();
  });

  it('filters by providerId', async () => {
    const result = await service.list({ limit: 10, providerId: 'pr_a' });
    expect(result.rows.length).toBe(3);
    expect(result.rows.every((r) => r.providerId === 'pr_a')).toBe(true);
  });

  it('paginates with a cursor', async () => {
    const first = await service.list({ limit: 2 });
    expect(first.rows.length).toBe(2);
    expect(first.nextCursor).not.toBeNull();
    const second = await service.list({ limit: 2, cursor: first.nextCursor! });
    expect(second.rows.length).toBe(2);
    expect(second.nextCursor).toBeNull();
    const allIds = [...first.rows, ...second.rows].map((r) => r.id);
    expect(new Set(allIds).size).toBe(4);
  });

  it('filters by scheduledOnOrAfter / scheduledOnOrBefore', async () => {
    const result = await service.list({
      limit: 10,
      scheduledOnOrAfter: new Date(Date.UTC(2026, 4, 11)),
      scheduledOnOrBefore: new Date(Date.UTC(2026, 4, 12)),
    });
    expect(result.rows.length).toBe(2);
  });
});

describe('helpers', () => {
  it('stripTimeToCalendarDate truncates to midnight UTC', () => {
    const out = __testing.stripTimeToCalendarDate(new Date(Date.UTC(2026, 4, 16, 13, 45)));
    expect(out.toISOString()).toBe('2026-05-16T00:00:00.000Z');
  });

  it('computeHeldUntil adds holdDays to the start-of-day', () => {
    const out = __testing.computeHeldUntil(new Date(Date.UTC(2026, 4, 16, 13)), 3);
    expect(out.toISOString()).toBe('2026-05-19T00:00:00.000Z');
  });

  it('computeHeldUntil with holdDays=0 equals start-of-day', () => {
    const out = __testing.computeHeldUntil(new Date(Date.UTC(2026, 4, 16, 13)), 0);
    expect(out.toISOString()).toBe('2026-05-16T00:00:00.000Z');
  });

  it('isUniqueViolation returns true only for P2002', () => {
    expect(__testing.isUniqueViolation({ code: 'P2002' })).toBe(true);
    expect(__testing.isUniqueViolation({ code: 'P2003' })).toBe(false);
    expect(__testing.isUniqueViolation(null)).toBe(false);
    expect(__testing.isUniqueViolation('boom')).toBe(false);
  });
});
