import { describe, expect, it } from 'vitest';

import type { Env } from '../../../config/env';
import type { PrismaService, PrismaTransactionClient } from '../../../prisma/prisma.service';

import {
  PayoutAccountsService,
  type ApplyStripeAccountUpdateInput,
  type PayoutAccountRecord,
} from './payout-accounts.service';
import { StripeAccountEventsService, type IngestEventInput } from './stripe-account-events.service';
import { StripeConnectService } from './stripe-connect.service';

function buildEnv(): Env {
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
  };
}

interface FakeEventRow {
  id: string;
  stripeEventId: string;
  eventType: string;
  stripeAccountId: string;
  providerPayoutAccountId: string | null;
  occurredAt: Date;
  payload: Record<string, unknown>;
  outcome: string;
  createdAt: Date;
}

class FakeAccountsService {
  store = new Map<string, PayoutAccountRecord>();
  applyResult: PayoutAccountRecord | null = null;
  applyShouldRetryUnique = false;
  private applyCallCount = 0;
  appliedInputs: ApplyStripeAccountUpdateInput[] = [];

  setupAccount(record: PayoutAccountRecord): void {
    this.store.set(record.stripeAccountId, record);
    this.applyResult = record;
  }

  async getByStripeAccountId(id: string): Promise<PayoutAccountRecord | null> {
    return this.store.get(id) ?? null;
  }

  async applyAccountUpdate(
    _tx: PrismaTransactionClient,
    input: ApplyStripeAccountUpdateInput,
  ): Promise<PayoutAccountRecord | null> {
    this.appliedInputs.push(input);
    this.applyCallCount++;
    if (this.applyShouldRetryUnique && this.applyCallCount === 1) {
      const err: unknown = { code: 'P2002' };
      throw err;
    }
    return this.applyResult;
  }
}

class FakePrisma {
  events: FakeEventRow[] = [];
  private idCounter = 0;
  forceCreateConflict = false;

  stripeAccountEvent = {
    findUnique: async (args: {
      where: { stripeEventId: string };
    }): Promise<FakeEventRow | null> => {
      return this.events.find((e) => e.stripeEventId === args.where.stripeEventId) ?? null;
    },
    create: async (args: { data: Partial<FakeEventRow> }): Promise<FakeEventRow> => {
      if (this.forceCreateConflict) {
        const err: unknown = { code: 'P2002' };
        throw err;
      }
      const d = args.data;
      if (this.events.some((e) => e.stripeEventId === d.stripeEventId)) {
        const err: unknown = { code: 'P2002' };
        throw err;
      }
      const row: FakeEventRow = {
        id: `evt_${++this.idCounter}`,
        stripeEventId: d.stripeEventId ?? '',
        eventType: d.eventType ?? 'account.updated',
        stripeAccountId: d.stripeAccountId ?? '',
        providerPayoutAccountId: d.providerPayoutAccountId ?? null,
        occurredAt: d.occurredAt ?? new Date(),
        payload: (d.payload as Record<string, unknown>) ?? {},
        outcome: d.outcome ?? 'applied',
        createdAt: new Date(),
      };
      this.events.push(row);
      return row;
    },
  };

  $transaction = async <T>(fn: (tx: PrismaTransactionClient) => Promise<T>): Promise<T> => {
    return fn(this as unknown as PrismaTransactionClient);
  };
}

function buildAccount(overrides: Partial<PayoutAccountRecord> = {}): PayoutAccountRecord {
  return {
    id: 'pa_1',
    providerId: 'pr_a',
    stripeAccountId: 'acct_stub_pr_a',
    country: 'US',
    defaultCurrency: 'USD',
    status: 'pending_onboarding',
    chargesEnabled: false,
    payoutsEnabled: false,
    detailsSubmitted: false,
    requirementsCurrentlyDue: [],
    requirementsPastDue: [],
    disabledReason: null,
    liveMode: false,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function buildEvent(overrides: Partial<IngestEventInput> = {}): IngestEventInput {
  return {
    stripeEventId: 'evt_test_1',
    eventType: 'account.updated',
    stripeAccountId: 'acct_stub_pr_a',
    occurredAt: new Date(),
    payload: {
      detailsSubmitted: true,
      chargesEnabled: true,
      payoutsEnabled: true,
    },
    ...overrides,
  };
}

describe('StripeAccountEventsService.ingest', () => {
  it('returns applied on first delivery + persists the event row', async () => {
    const prisma = new FakePrisma();
    const fakeAccounts = new FakeAccountsService();
    fakeAccounts.setupAccount(
      buildAccount({
        status: 'active',
        chargesEnabled: true,
        payoutsEnabled: true,
        detailsSubmitted: true,
      }),
    );
    const svc = new StripeAccountEventsService(
      prisma as unknown as PrismaService,
      fakeAccounts as unknown as PayoutAccountsService,
    );

    const out = await svc.ingest(buildEvent());

    expect(out.outcome).toBe('applied');
    if (out.outcome === 'applied') {
      expect(out.account.id).toBe('pa_1');
    }
    expect(prisma.events).toHaveLength(1);
    expect(prisma.events[0]?.outcome).toBe('applied');
  });

  it('returns replayed on the second call with the same stripeEventId', async () => {
    const prisma = new FakePrisma();
    const fakeAccounts = new FakeAccountsService();
    fakeAccounts.setupAccount(buildAccount({ status: 'active' }));
    const svc = new StripeAccountEventsService(
      prisma as unknown as PrismaService,
      fakeAccounts as unknown as PayoutAccountsService,
    );

    await svc.ingest(buildEvent());
    const replay = await svc.ingest(buildEvent());

    expect(replay.outcome).toBe('replayed');
    expect(prisma.events).toHaveLength(1); // no second row
    expect(fakeAccounts.appliedInputs).toHaveLength(1); // applyAccountUpdate not called twice
  });

  it('returns ignored with a recorded event row when stripeAccountId is unknown', async () => {
    const prisma = new FakePrisma();
    const fakeAccounts = new FakeAccountsService(); // empty store
    fakeAccounts.applyResult = null;
    const svc = new StripeAccountEventsService(
      prisma as unknown as PrismaService,
      fakeAccounts as unknown as PayoutAccountsService,
    );

    const out = await svc.ingest(buildEvent());
    expect(out.outcome).toBe('ignored');
    expect(out.account).toBeNull();
    expect(prisma.events).toHaveLength(1);
    expect(prisma.events[0]?.outcome).toBe('ignored');
    expect(prisma.events[0]?.providerPayoutAccountId).toBeNull();
  });

  it('replays an ignored event as ignored', async () => {
    const prisma = new FakePrisma();
    const fakeAccounts = new FakeAccountsService(); // empty store
    fakeAccounts.applyResult = null;
    const svc = new StripeAccountEventsService(
      prisma as unknown as PrismaService,
      fakeAccounts as unknown as PayoutAccountsService,
    );

    await svc.ingest(buildEvent());
    const replay = await svc.ingest(buildEvent());
    expect(replay.outcome).toBe('ignored');
    expect(replay.account).toBeNull();
    expect(prisma.events).toHaveLength(1);
  });

  it('resolves a concurrent insert race by re-reading on P2002', async () => {
    const prisma = new FakePrisma();
    const fakeAccounts = new FakeAccountsService();
    fakeAccounts.setupAccount(buildAccount({ status: 'active' }));
    const svc = new StripeAccountEventsService(
      prisma as unknown as PrismaService,
      fakeAccounts as unknown as PayoutAccountsService,
    );

    // Pre-seed the event row so the unique-violation check has
    // something to re-read.
    prisma.events.push({
      id: 'pre_evt',
      stripeEventId: 'evt_test_1',
      eventType: 'account.updated',
      stripeAccountId: 'acct_stub_pr_a',
      providerPayoutAccountId: 'pa_1',
      occurredAt: new Date(),
      payload: {},
      outcome: 'applied',
      createdAt: new Date(),
    });
    // Force the upcoming create call to error with P2002.
    prisma.forceCreateConflict = true;

    // Bypass the initial findUnique by removing the row, then re-add
    // it for the post-error re-read. Easier: just temporarily hide it.
    const pre = prisma.events.shift()!;
    // Schedule a re-add via the create override's re-read: we'll
    // restore it inside the apply path by re-pushing.
    const origCreate = prisma.stripeAccountEvent.create;
    let restored = false;
    prisma.stripeAccountEvent.create = async (args) => {
      if (!restored) {
        prisma.events.push(pre);
        restored = true;
      }
      return origCreate(args);
    };

    const out = await svc.ingest(buildEvent());
    expect(out.outcome).toBe('replayed');
  });

  it('rethrows non-P2002 errors from the create path', async () => {
    const prisma = new FakePrisma();
    const fakeAccounts = new FakeAccountsService();
    fakeAccounts.setupAccount(buildAccount({ status: 'active' }));
    const svc = new StripeAccountEventsService(
      prisma as unknown as PrismaService,
      fakeAccounts as unknown as PayoutAccountsService,
    );

    prisma.stripeAccountEvent.create = async () => {
      throw new Error('connection refused');
    };

    await expect(svc.ingest(buildEvent())).rejects.toThrow('connection refused');
  });

  it('propagates the down-projected payload to applyAccountUpdate', async () => {
    const prisma = new FakePrisma();
    const fakeAccounts = new FakeAccountsService();
    fakeAccounts.setupAccount(
      buildAccount({
        status: 'restricted',
        chargesEnabled: true,
        payoutsEnabled: false,
        detailsSubmitted: true,
      }),
    );
    const svc = new StripeAccountEventsService(
      prisma as unknown as PrismaService,
      fakeAccounts as unknown as PayoutAccountsService,
    );

    await svc.ingest(
      buildEvent({
        payload: {
          detailsSubmitted: true,
          chargesEnabled: true,
          payoutsEnabled: false,
          disabledReason: null,
          requirementsCurrentlyDue: ['external_account'],
          requirementsPastDue: ['individual.verification.document'],
        },
      }),
    );

    expect(fakeAccounts.appliedInputs).toHaveLength(1);
    const applied = fakeAccounts.appliedInputs[0]!;
    expect(applied.payoutsEnabled).toBe(false);
    expect(applied.requirementsPastDue).toEqual(['individual.verification.document']);
  });

  it('confirms the orchestration uses the Stripe-connect stub mode signal indirectly via env', () => {
    // The orchestrator does not consult StripeConnect at all — sanity
    // check that StripeConnectService boots in stub mode for the
    // shared env, since multiple tests above depend on it.
    const stripe = new StripeConnectService(buildEnv());
    expect(stripe.isLiveMode()).toBe(false);
  });
});
