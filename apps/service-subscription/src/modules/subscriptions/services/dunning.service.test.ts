import type { OutboxService } from '@taste-and-see/nest-outbox';
import { initMetrics, serializeMetrics, shutdownMetrics } from '@taste-and-see/tracing';
import Decimal from 'decimal.js';
import type Stripe from 'stripe';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Env } from '../../../config/env';
import type { PrismaService, PrismaTransactionClient } from '../../../prisma/prisma.service';

import { DunningMetrics } from './dunning-metrics';
import { DunningService } from './dunning.service';

interface FakePlanRow {
  id: string;
  code: string;
  name: string;
  customerGroup: 'family' | 'provider' | 'academy';
  monthlyPrice: Decimal;
  annualPrice: Decimal;
  currency: string;
  active: boolean;
  stripeProductId: string | null;
}

interface FakeSubscriptionRow {
  id: string;
  stripeSubscriptionId: string;
  stripeCustomerId: string;
  customerId: string;
  customerGroup: 'family' | 'provider' | 'academy';
  planId: string;
  status: string;
  billingInterval: string;
  currentPeriodStart: Date;
  currentPeriodEnd: Date;
  trialEnd: Date | null;
  cancelAtPeriodEnd: boolean;
  cancelReason: string | null;
  canceledAt: Date | null;
  dunningAttempts: number;
  dunningLastAttemptAt: Date | null;
  dunningGraceUntil: Date | null;
  pauseCollectionStartedAt: Date | null;
  pauseCollectionResumesAt: Date | null;
  pauseReason: string | null;
  createdAt: Date;
  updatedAt: Date;
}

interface FakeHistoryRow {
  id: string;
  subscriptionId: string;
  event: string;
  fromStatus: string | null;
  toStatus: string | null;
  context: unknown;
  actorUserId: string | null;
  actorKind: string;
  source: string | null;
  occurredAt: Date;
}

/**
 * Tiny in-memory Prisma stand-in for the DunningService — same posture as
 * the SubscriptionsService fake but narrowed to the surface dunning
 * touches (subscription findUnique/update + subscriptionHistory.create).
 */
class FakePrisma {
  public plans: FakePlanRow[] = [];
  public subscriptions: FakeSubscriptionRow[] = [];
  public histories: FakeHistoryRow[] = [];
  private idCounter = 0;

  subscription = {
    findUnique: vi.fn(
      async (args: {
        where: { id: string };
        include?: { plan?: boolean };
      }): Promise<(FakeSubscriptionRow & { plan?: FakePlanRow }) | null> => {
        const sub = this.subscriptions.find((s) => s.id === args.where.id);
        if (sub === undefined) return null;
        if (args.include?.plan === true) {
          const plan = this.plans.find((p) => p.id === sub.planId);
          if (plan === undefined) {
            throw new Error(`plan ${sub.planId} missing for subscription ${sub.id}`);
          }
          return { ...sub, plan };
        }
        return sub;
      },
    ),
    update: vi.fn(
      async (args: {
        where: { id: string };
        data: Partial<FakeSubscriptionRow>;
      }): Promise<FakeSubscriptionRow> => {
        const idx = this.subscriptions.findIndex((s) => s.id === args.where.id);
        if (idx === -1) throw new Error(`sub ${args.where.id} not found in fake`);
        const next: FakeSubscriptionRow = { ...this.subscriptions[idx]!, ...args.data };
        this.subscriptions[idx] = next;
        return next;
      },
    ),
  };

  subscriptionHistory = {
    create: vi.fn(
      async (args: {
        data: Omit<FakeHistoryRow, 'id' | 'occurredAt' | 'source'> & {
          source?: string | null;
        };
      }): Promise<FakeHistoryRow> => {
        this.idCounter += 1;
        const row: FakeHistoryRow = {
          id: `hist_${this.idCounter}`,
          occurredAt: new Date('2026-05-12T00:00:00.000Z'),
          ...args.data,
          source: args.data.source ?? null,
        } as FakeHistoryRow;
        this.histories.push(row);
        return row;
      },
    ),
  };

  /**
   * TS-042-followup-3 — the callback now ROLLS BACK on throw, which the
   * outbox-validation tests depend on: the property under test is that a
   * rejected lifecycle event leaves the subscription row untouched, and a
   * fake that commits regardless would pass that assertion vacuously.
   *
   * The snapshot deep-copies each row rather than copying the arrays
   * (`[...this.subscriptions]`). A shallow copy restores INSERTS but not
   * in-place UPDATEs, and `subscription.update` above replaces the array
   * slot — so a shallow snapshot would silently keep the mutation. Same
   * fixture bug found in service-trust-safety's `FakeIncidentsPrisma`.
   */
  $transaction = vi.fn(async <T>(fn: (tx: PrismaTransactionClient) => Promise<T>): Promise<T> => {
    const snapshot = {
      plans: this.plans.map((r) => ({ ...r })),
      subscriptions: this.subscriptions.map((r) => ({ ...r })),
      histories: this.histories.map((r) => ({ ...r })),
    };
    try {
      return await fn(this as unknown as PrismaTransactionClient);
    } catch (e) {
      this.plans = snapshot.plans;
      this.subscriptions = snapshot.subscriptions;
      this.histories = snapshot.histories;
      throw e;
    }
  });
}

/**
 * Outbox stand-in for the DunningService (TS-042-followup-3). Mirrors the
 * `FakeOutboxService` in `subscriptions.service.test.ts`: it records every
 * append so a test can assert the exact event name, id, and payload, and
 * `nextResultOverride` forces the `validation_failed` branch without having
 * to construct an invalid payload the type system would reject.
 */
class FakeOutboxService {
  public appendCalls: Array<{
    eventName: string;
    eventId: string;
    occurredAt: Date;
    payload: Record<string, unknown>;
  }> = [];
  public nextResultOverride: 'validation_failed' | null = null;

  append = vi.fn(
    async (
      _tx: unknown,
      args: {
        eventName: string;
        eventId: string;
        occurredAt: Date;
        payload: unknown;
      },
    ): Promise<
      | { kind: 'appended'; eventId: string; eventName: string; occurredAt: Date }
      | {
          kind: 'validation_failed';
          eventName: string;
          issues: ReadonlyArray<{ path: ReadonlyArray<string | number>; message: string }>;
        }
    > => {
      this.appendCalls.push({
        eventName: args.eventName,
        eventId: args.eventId,
        occurredAt: args.occurredAt,
        payload: args.payload as Record<string, unknown>,
      });
      if (this.nextResultOverride === 'validation_failed') {
        this.nextResultOverride = null;
        return {
          kind: 'validation_failed',
          eventName: args.eventName,
          issues: [{ path: ['subscriptionId'], message: 'forced failure' }],
        };
      }
      return {
        kind: 'appended',
        eventId: args.eventId,
        eventName: args.eventName,
        occurredAt: args.occurredAt,
      };
    },
  );

  /** The single append recorded, asserting exactly one happened. */
  onlyCall(): {
    eventName: string;
    eventId: string;
    occurredAt: Date;
    payload: Record<string, unknown>;
  } {
    expect(this.appendCalls).toHaveLength(1);
    return this.appendCalls[0]!;
  }
}

interface FakeStripe {
  subscriptions: {
    update: ReturnType<typeof vi.fn>;
  };
}

function buildStripe(): FakeStripe {
  return {
    subscriptions: {
      update: vi.fn(),
    },
  };
}

function buildStripeSubscription(
  overrides: Partial<Stripe.Subscription> = {},
): Stripe.Subscription {
  return {
    id: 'sub_stripe_xyz',
    status: 'active',
    current_period_start: 1_715_904_000,
    current_period_end: 1_718_582_400,
    trial_end: null,
    canceled_at: null,
    cancel_at_period_end: false,
    items: { data: [{ id: 'si_first' } as Stripe.SubscriptionItem] },
    ...overrides,
  } as unknown as Stripe.Subscription;
}

function buildEnv(overrides: Partial<Env> = {}): Env {
  return {
    NODE_ENV: 'test',
    PORT: 3012,
    LOG_LEVEL: 'info',
    DATABASE_URL: 'postgres://user:pass@localhost:5432/test',
    SERVICE_VERSION: 'test',
    STRIPE_SECRET_KEY: 'sk_test_dunning_service_unit_tests',
    JWT_ACCESS_SECRET: 'a'.repeat(40),
    INTERNAL_TRUST_SIGNING_SECRET: 't'.repeat(32),
    INTERNAL_TRUST_MAX_AGE_SECONDS: 60,
    JWT_ISSUER: 'taste-and-see/service-identity',
    JWT_AUDIENCE: 'taste-and-see/api',
    REDIS_URL: 'redis://localhost:6379',
    IDEMPOTENCY_TTL_SECONDS: 86_400,
    IDEMPOTENCY_IN_FLIGHT_TTL_SECONDS: 60,
    DUNNING_GRACE_DAYS: 21,
    BILLING_PORTAL_RETURN_URL: 'http://localhost:3000/billing',
    ...overrides,
  } as Env;
}

function buildSvc(envOverrides: Partial<Env> = {}): {
  service: DunningService;
  prisma: FakePrisma;
  stripe: FakeStripe;
  outbox: FakeOutboxService;
} {
  const prisma = new FakePrisma();
  const stripe = buildStripe();
  const env = buildEnv(envOverrides);
  const outbox = new FakeOutboxService();
  const service = new DunningService(
    prisma as unknown as PrismaService,
    stripe as unknown as Stripe,
    env,
    outbox as unknown as OutboxService,
  );
  return { service, prisma, stripe, outbox };
}

function seedPlan(prisma: FakePrisma, overrides: Partial<FakePlanRow> = {}): FakePlanRow {
  const plan: FakePlanRow = {
    id: 'plan_companion',
    code: 'family.tier2',
    name: 'Companion Dining',
    customerGroup: 'family',
    monthlyPrice: new Decimal('199.00'),
    annualPrice: new Decimal('1990.00'),
    currency: 'USD',
    active: true,
    stripeProductId: 'prod_test',
    ...overrides,
  };
  prisma.plans.push(plan);
  return plan;
}

function seedSubscription(
  prisma: FakePrisma,
  overrides: Partial<FakeSubscriptionRow> = {},
): FakeSubscriptionRow {
  const plan = prisma.plans[0] ?? seedPlan(prisma);
  const sub: FakeSubscriptionRow = {
    id: 'sub_internal_existing',
    stripeSubscriptionId: 'sub_stripe_existing',
    stripeCustomerId: 'cus_existing',
    customerId: 'hh_123',
    customerGroup: 'family',
    planId: plan.id,
    status: 'active',
    billingInterval: 'monthly',
    currentPeriodStart: new Date('2026-05-01T00:00:00.000Z'),
    currentPeriodEnd: new Date('2026-06-01T00:00:00.000Z'),
    trialEnd: null,
    cancelAtPeriodEnd: false,
    cancelReason: null,
    canceledAt: null,
    dunningAttempts: 0,
    dunningLastAttemptAt: null,
    dunningGraceUntil: null,
    pauseCollectionStartedAt: null,
    pauseCollectionResumesAt: null,
    pauseReason: null,
    createdAt: new Date('2026-05-01T00:00:00.000Z'),
    updatedAt: new Date('2026-05-01T00:00:00.000Z'),
    ...overrides,
  };
  prisma.subscriptions.push(sub);
  return sub;
}

// ─────────────────────────────────────────────────────────────────────────
// recordPaymentFailure
// ─────────────────────────────────────────────────────────────────────────

describe('DunningService.recordPaymentFailure', () => {
  it('first failure transitions active → past_due, stamps grace = +21d', async () => {
    const { service, prisma } = buildSvc();
    seedSubscription(prisma);
    const attemptedAt = new Date('2026-05-12T10:00:00.000Z');

    const result = await service.recordPaymentFailure({
      subscriptionId: 'sub_internal_existing',
      sourceEventId: 'evt_failure_001',
      attemptedAt,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.status).toBe('past_due');
    expect(result.value.dunningAttempts).toBe(1);
    expect(result.value.dunningLastAttemptAt).toBe(attemptedAt.toISOString());
    // 21 days later → 2026-06-02
    expect(result.value.dunningGraceUntil).toBe(
      new Date(attemptedAt.getTime() + 21 * 24 * 60 * 60 * 1000).toISOString(),
    );
    expect(prisma.histories).toHaveLength(1);
    const [history] = prisma.histories;
    expect(history?.event).toBe('status_changed');
    expect(history?.actorKind).toBe('system');
    expect(history?.source).toBe('evt_failure_001');
    expect(history?.context).toMatchObject({
      kind: 'payment_failure',
      attempts: 1,
    });
  });

  it('respects DUNNING_GRACE_DAYS override', async () => {
    const { service, prisma } = buildSvc({ DUNNING_GRACE_DAYS: 7 });
    seedSubscription(prisma);
    const attemptedAt = new Date('2026-05-12T00:00:00.000Z');

    const result = await service.recordPaymentFailure({
      subscriptionId: 'sub_internal_existing',
      sourceEventId: 'evt_x',
      attemptedAt,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.dunningGraceUntil).toBe(
      new Date(attemptedAt.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString(),
    );
  });

  it('subsequent failures preserve the original graceUntil and bump attempts', async () => {
    const { service, prisma } = buildSvc();
    seedSubscription(prisma, {
      status: 'past_due',
      dunningAttempts: 1,
      dunningLastAttemptAt: new Date('2026-05-12T10:00:00.000Z'),
      dunningGraceUntil: new Date('2026-06-02T10:00:00.000Z'),
    });

    const result = await service.recordPaymentFailure({
      subscriptionId: 'sub_internal_existing',
      sourceEventId: 'evt_failure_002',
      attemptedAt: new Date('2026-05-15T10:00:00.000Z'),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.dunningAttempts).toBe(2);
    expect(result.value.dunningGraceUntil).toBe('2026-06-02T10:00:00.000Z');
  });

  it('returns subscription_not_found for unknown id', async () => {
    const { service } = buildSvc();
    const result = await service.recordPaymentFailure({
      subscriptionId: 'sub_unknown',
      sourceEventId: 'evt_x',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.reason).toBe('subscription_not_found');
    }
  });

  it('rejects invalid_state for already-canceled subscription', async () => {
    const { service, prisma } = buildSvc();
    seedSubscription(prisma, { status: 'canceled' });
    const result = await service.recordPaymentFailure({
      subscriptionId: 'sub_internal_existing',
      sourceEventId: 'evt_x',
    });
    expect(result.ok).toBe(false);
    if (!result.ok && result.error.reason === 'invalid_state') {
      expect(result.error.currentStatus).toBe('canceled');
    } else {
      throw new Error('expected invalid_state');
    }
  });

  it('accepts a failure on a paused row (collection retry inside pause grace)', async () => {
    const { service, prisma } = buildSvc();
    seedSubscription(prisma, { status: 'paused' });
    const result = await service.recordPaymentFailure({
      subscriptionId: 'sub_internal_existing',
      sourceEventId: 'evt_x',
    });
    expect(result.ok).toBe(true);
  });

  it('rejects empty subscriptionId / sourceEventId as invalid_request', async () => {
    const { service } = buildSvc();
    const blank = await service.recordPaymentFailure({
      subscriptionId: '',
      sourceEventId: 'evt_x',
    });
    expect(blank.ok).toBe(false);
    if (!blank.ok) expect(blank.error.reason).toBe('invalid_request');

    const blankEvt = await service.recordPaymentFailure({
      subscriptionId: 'sub_x',
      sourceEventId: '',
    });
    expect(blankEvt.ok).toBe(false);
    if (!blankEvt.ok) expect(blankEvt.error.reason).toBe('invalid_request');
  });

  it('forwards actorUserId to history when admin-initiated', async () => {
    const { service, prisma } = buildSvc();
    seedSubscription(prisma);
    await service.recordPaymentFailure({
      subscriptionId: 'sub_internal_existing',
      sourceEventId: 'evt_x',
      actorKind: 'admin',
      actorUserId: 'usr_admin_42',
    });
    expect(prisma.histories[0]?.actorUserId).toBe('usr_admin_42');
    expect(prisma.histories[0]?.actorKind).toBe('admin');
  });
});

// ─────────────────────────────────────────────────────────────────────────
// recordPaymentSuccess
// ─────────────────────────────────────────────────────────────────────────

describe('DunningService.recordPaymentSuccess', () => {
  it('resets dunning counters + transitions past_due → active', async () => {
    const { service, prisma } = buildSvc();
    seedSubscription(prisma, {
      status: 'past_due',
      dunningAttempts: 3,
      dunningLastAttemptAt: new Date('2026-05-12T10:00:00.000Z'),
      dunningGraceUntil: new Date('2026-06-02T10:00:00.000Z'),
    });

    const result = await service.recordPaymentSuccess({
      subscriptionId: 'sub_internal_existing',
      sourceEventId: 'evt_success_001',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.status).toBe('active');
    expect(result.value.dunningAttempts).toBe(0);
    expect(result.value.dunningLastAttemptAt).toBeNull();
    expect(result.value.dunningGraceUntil).toBeNull();
    expect(prisma.histories[0]?.event).toBe('reactivated');
    expect(prisma.histories[0]?.context).toMatchObject({
      kind: 'payment_success',
      recovered: true,
    });
  });

  it('lands on trialing when trial_end is still in the future', async () => {
    const { service, prisma } = buildSvc();
    const future = new Date('2030-01-01T00:00:00.000Z');
    seedSubscription(prisma, {
      status: 'trialing',
      trialEnd: future,
    });
    const result = await service.recordPaymentSuccess({
      subscriptionId: 'sub_internal_existing',
      sourceEventId: 'evt_x',
      succeededAt: new Date('2026-05-12T00:00:00.000Z'),
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.status).toBe('trialing');
    }
  });

  it('non-recovery success writes status_changed event (not reactivated)', async () => {
    const { service, prisma } = buildSvc();
    seedSubscription(prisma, { status: 'active' });
    await service.recordPaymentSuccess({
      subscriptionId: 'sub_internal_existing',
      sourceEventId: 'evt_x',
    });
    expect(prisma.histories[0]?.event).toBe('status_changed');
    expect(prisma.histories[0]?.context).toMatchObject({ recovered: false });
  });

  it('returns subscription_not_found for unknown id', async () => {
    const { service } = buildSvc();
    const result = await service.recordPaymentSuccess({
      subscriptionId: 'sub_unknown',
      sourceEventId: 'evt_x',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.reason).toBe('subscription_not_found');
  });

  it('rejects invalid_state for canceled subscription', async () => {
    const { service, prisma } = buildSvc();
    seedSubscription(prisma, { status: 'canceled' });
    const result = await service.recordPaymentSuccess({
      subscriptionId: 'sub_internal_existing',
      sourceEventId: 'evt_x',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.reason).toBe('invalid_state');
  });
});

// ─────────────────────────────────────────────────────────────────────────
// applyDunningExhaustion
// ─────────────────────────────────────────────────────────────────────────

describe('DunningService.applyDunningExhaustion', () => {
  it('flips past_due → unpaid when grace expired', async () => {
    const { service, prisma } = buildSvc();
    seedSubscription(prisma, {
      status: 'past_due',
      dunningAttempts: 4,
      dunningGraceUntil: new Date('2026-06-01T00:00:00.000Z'),
    });

    const result = await service.applyDunningExhaustion({
      subscriptionId: 'sub_internal_existing',
      sourceEventId: 'sweep_2026-06-02',
      now: new Date('2026-06-02T00:00:00.000Z'),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.status).toBe('unpaid');
    expect(prisma.histories[0]?.event).toBe('status_changed');
    expect(prisma.histories[0]?.context).toMatchObject({
      kind: 'dunning_exhausted',
      attempts: 4,
    });
    expect(prisma.histories[0]?.actorKind).toBe('system');
  });

  it('rejects grace_not_expired when now < graceUntil', async () => {
    const { service, prisma } = buildSvc();
    seedSubscription(prisma, {
      status: 'past_due',
      dunningAttempts: 1,
      dunningGraceUntil: new Date('2026-06-02T00:00:00.000Z'),
    });

    const result = await service.applyDunningExhaustion({
      subscriptionId: 'sub_internal_existing',
      sourceEventId: 'sweep',
      now: new Date('2026-05-30T00:00:00.000Z'),
    });

    expect(result.ok).toBe(false);
    if (!result.ok && result.error.reason === 'grace_not_expired') {
      expect(result.error.graceUntil.toISOString()).toBe('2026-06-02T00:00:00.000Z');
    } else {
      throw new Error('expected grace_not_expired');
    }
    // No history written.
    expect(prisma.histories).toHaveLength(0);
  });

  it('rejects when status !== past_due', async () => {
    const { service, prisma } = buildSvc();
    seedSubscription(prisma, { status: 'active' });
    const result = await service.applyDunningExhaustion({
      subscriptionId: 'sub_internal_existing',
      sourceEventId: 'sweep',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.reason).toBe('invalid_state');
  });

  it('rejects past_due row with no graceUntil set (corrupted state)', async () => {
    const { service, prisma } = buildSvc();
    seedSubscription(prisma, {
      status: 'past_due',
      dunningAttempts: 0,
      dunningGraceUntil: null,
    });
    const result = await service.applyDunningExhaustion({
      subscriptionId: 'sub_internal_existing',
      sourceEventId: 'sweep',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.reason).toBe('invalid_request');
  });

  it('returns subscription_not_found for unknown id', async () => {
    const { service } = buildSvc();
    const result = await service.applyDunningExhaustion({
      subscriptionId: 'sub_unknown',
      sourceEventId: 'sweep',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.reason).toBe('subscription_not_found');
  });
});

// ─────────────────────────────────────────────────────────────────────────
// pauseSubscription
// ─────────────────────────────────────────────────────────────────────────

describe('DunningService.pauseSubscription', () => {
  it('pauses active → paused via Stripe + history', async () => {
    const { service, prisma, stripe } = buildSvc();
    seedSubscription(prisma);
    stripe.subscriptions.update.mockResolvedValue(
      buildStripeSubscription({ id: 'sub_stripe_existing', status: 'paused' }),
    );

    const result = await service.pauseSubscription({
      subscriptionId: 'sub_internal_existing',
      requesterUserId: 'usr_payer',
      reason: 'travel hold',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.status).toBe('paused');
    expect(result.value.pauseReason).toBe('travel hold');
    expect(result.value.pauseCollectionResumesAt).toBeNull();
    expect(result.value.pauseCollectionStartedAt).not.toBeNull();
    expect(stripe.subscriptions.update).toHaveBeenCalledWith(
      'sub_stripe_existing',
      { pause_collection: { behavior: 'void' } },
      expect.any(Object),
    );
    expect(prisma.histories[0]?.event).toBe('paused');
    expect(prisma.histories[0]?.actorUserId).toBe('usr_payer');
  });

  it('forwards resumesAt to Stripe as a Unix second timestamp', async () => {
    const { service, prisma, stripe } = buildSvc();
    seedSubscription(prisma);
    stripe.subscriptions.update.mockResolvedValue(buildStripeSubscription({ status: 'paused' }));

    const resumesAt = new Date('2026-06-12T00:00:00.000Z');
    await service.pauseSubscription({
      subscriptionId: 'sub_internal_existing',
      requesterUserId: 'usr',
      resumesAt,
    });

    const args = stripe.subscriptions.update.mock.calls[0]?.[1];
    expect(args?.pause_collection?.resumes_at).toBe(Math.floor(resumesAt.getTime() / 1000));
  });

  it('forwards the idempotencyKey with :pause suffix to Stripe', async () => {
    const { service, prisma, stripe } = buildSvc();
    seedSubscription(prisma);
    stripe.subscriptions.update.mockResolvedValue(buildStripeSubscription({ status: 'paused' }));

    await service.pauseSubscription({
      subscriptionId: 'sub_internal_existing',
      requesterUserId: 'usr',
      idempotencyKey: 'idem-pause-12345',
    });
    const opts = stripe.subscriptions.update.mock.calls[0]?.[2];
    expect(opts?.idempotencyKey).toBe('idem-pause-12345:pause');
  });

  it('rejects when subscription is canceled', async () => {
    const { service, prisma, stripe } = buildSvc();
    seedSubscription(prisma, { status: 'canceled' });
    const result = await service.pauseSubscription({
      subscriptionId: 'sub_internal_existing',
      requesterUserId: 'usr',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.reason).toBe('invalid_state');
    expect(stripe.subscriptions.update).not.toHaveBeenCalled();
  });

  it('rejects when subscription is already paused', async () => {
    const { service, prisma, stripe } = buildSvc();
    seedSubscription(prisma, { status: 'paused' });
    const result = await service.pauseSubscription({
      subscriptionId: 'sub_internal_existing',
      requesterUserId: 'usr',
    });
    expect(result.ok).toBe(false);
    if (!result.ok && result.error.reason === 'invalid_state') {
      expect(result.error.currentStatus).toBe('paused');
    }
    expect(stripe.subscriptions.update).not.toHaveBeenCalled();
  });

  it('returns stripe_unavailable when Stripe call throws', async () => {
    const { service, prisma, stripe } = buildSvc();
    seedSubscription(prisma);
    stripe.subscriptions.update.mockRejectedValue(new Error('rate limited'));
    const result = await service.pauseSubscription({
      subscriptionId: 'sub_internal_existing',
      requesterUserId: 'usr',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.reason).toBe('stripe_unavailable');
    // No row update on stripe failure.
    expect(prisma.subscriptions[0]?.status).toBe('active');
  });

  it('returns subscription_not_found for unknown id', async () => {
    const { service } = buildSvc();
    const result = await service.pauseSubscription({
      subscriptionId: 'sub_unknown',
      requesterUserId: 'usr',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.reason).toBe('subscription_not_found');
  });

  it('rejects empty subscriptionId / requesterUserId', async () => {
    const { service } = buildSvc();
    const r1 = await service.pauseSubscription({
      subscriptionId: '',
      requesterUserId: 'usr',
    });
    expect(r1.ok).toBe(false);
    if (!r1.ok) expect(r1.error.reason).toBe('invalid_request');

    const r2 = await service.pauseSubscription({
      subscriptionId: 'sub_x',
      requesterUserId: '',
    });
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.error.reason).toBe('invalid_request');
  });

  it('allows pausing a past_due subscription (admin holding collection)', async () => {
    const { service, prisma, stripe } = buildSvc();
    seedSubscription(prisma, {
      status: 'past_due',
      dunningAttempts: 2,
      dunningGraceUntil: new Date('2026-06-02T00:00:00.000Z'),
    });
    stripe.subscriptions.update.mockResolvedValue(buildStripeSubscription({ status: 'paused' }));

    const result = await service.pauseSubscription({
      subscriptionId: 'sub_internal_existing',
      requesterUserId: 'usr_admin',
      reason: 'human review pending',
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.status).toBe('paused');
      // Dunning counters are preserved so resume can pick up where it left off.
      expect(result.value.dunningAttempts).toBe(2);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────
// resumeSubscription
// ─────────────────────────────────────────────────────────────────────────

describe('DunningService.resumeSubscription', () => {
  it('resumes paused → active and clears pause columns', async () => {
    const { service, prisma, stripe } = buildSvc();
    seedSubscription(prisma, {
      status: 'paused',
      pauseCollectionStartedAt: new Date('2026-05-12T00:00:00.000Z'),
      pauseCollectionResumesAt: new Date('2026-06-12T00:00:00.000Z'),
      pauseReason: 'travel',
    });
    stripe.subscriptions.update.mockResolvedValue(
      buildStripeSubscription({ id: 'sub_stripe_existing', status: 'active' }),
    );

    const result = await service.resumeSubscription({
      subscriptionId: 'sub_internal_existing',
      requesterUserId: 'usr_payer',
      note: 'customer ready',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.status).toBe('active');
    expect(result.value.pauseCollectionStartedAt).toBeNull();
    expect(result.value.pauseCollectionResumesAt).toBeNull();
    expect(result.value.pauseReason).toBeNull();
    expect(prisma.histories[0]?.event).toBe('resumed');
    expect(prisma.histories[0]?.context).toMatchObject({ note: 'customer ready' });
    // Stripe call carried an empty-string pause_collection (Emptyable unset).
    const args = stripe.subscriptions.update.mock.calls[0]?.[1];
    expect(args?.pause_collection).toBe('');
  });

  it('lands on trialing if Stripe response status is trialing', async () => {
    const { service, prisma, stripe } = buildSvc();
    seedSubscription(prisma, { status: 'paused' });
    stripe.subscriptions.update.mockResolvedValue(buildStripeSubscription({ status: 'trialing' }));
    const result = await service.resumeSubscription({
      subscriptionId: 'sub_internal_existing',
      requesterUserId: 'usr',
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.status).toBe('trialing');
  });

  it('rejects when subscription is not paused', async () => {
    const { service, prisma, stripe } = buildSvc();
    seedSubscription(prisma, { status: 'active' });
    const result = await service.resumeSubscription({
      subscriptionId: 'sub_internal_existing',
      requesterUserId: 'usr',
    });
    expect(result.ok).toBe(false);
    if (!result.ok && result.error.reason === 'invalid_state') {
      expect(result.error.currentStatus).toBe('active');
      expect(result.error.expected).toEqual(['paused']);
    }
    expect(stripe.subscriptions.update).not.toHaveBeenCalled();
  });

  it('returns stripe_unavailable when Stripe call throws', async () => {
    const { service, prisma, stripe } = buildSvc();
    seedSubscription(prisma, { status: 'paused' });
    stripe.subscriptions.update.mockRejectedValue(new Error('boom'));
    const result = await service.resumeSubscription({
      subscriptionId: 'sub_internal_existing',
      requesterUserId: 'usr',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.reason).toBe('stripe_unavailable');
  });

  it('forwards the idempotencyKey with :resume suffix', async () => {
    const { service, prisma, stripe } = buildSvc();
    seedSubscription(prisma, { status: 'paused' });
    stripe.subscriptions.update.mockResolvedValue(buildStripeSubscription({ status: 'active' }));
    await service.resumeSubscription({
      subscriptionId: 'sub_internal_existing',
      requesterUserId: 'usr',
      idempotencyKey: 'idem-resume-abc',
    });
    const opts = stripe.subscriptions.update.mock.calls[0]?.[2];
    expect(opts?.idempotencyKey).toBe('idem-resume-abc:resume');
  });

  it('returns subscription_not_found for unknown id', async () => {
    const { service } = buildSvc();
    const result = await service.resumeSubscription({
      subscriptionId: 'sub_unknown',
      requesterUserId: 'usr',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.reason).toBe('subscription_not_found');
  });

  it('rejects empty subscriptionId / requesterUserId', async () => {
    const { service } = buildSvc();
    const r1 = await service.resumeSubscription({ subscriptionId: '', requesterUserId: 'usr' });
    expect(r1.ok).toBe(false);
    if (!r1.ok) expect(r1.error.reason).toBe('invalid_request');

    const r2 = await service.resumeSubscription({ subscriptionId: 'sub_x', requesterUserId: '' });
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.error.reason).toBe('invalid_request');
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Observability metrics (TS-042-followup-8; CLAUDE.md §10)
// ─────────────────────────────────────────────────────────────────────────

/**
 * Drives the service end-to-end against a live MeterProvider and asserts the
 * Prometheus exposition reflects the outcome derived from the `Result`. The
 * service must be built AFTER `initMetrics` so its `DunningMetrics`
 * instruments bind to the live meter (KycService observability-test shape).
 */
describe('DunningService — observability metrics (TS-042-followup-8)', () => {
  function buildSvcWithMetrics(metrics: DunningMetrics): {
    service: DunningService;
    prisma: FakePrisma;
    stripe: FakeStripe;
  } {
    const prisma = new FakePrisma();
    const stripe = buildStripe();
    const service = new DunningService(
      prisma as unknown as PrismaService,
      stripe as unknown as Stripe,
      buildEnv(),
      new FakeOutboxService() as unknown as OutboxService,
      metrics,
    );
    return { service, prisma, stripe };
  }

  beforeEach(() => {
    initMetrics({
      service: 'service-subscription-test',
      env: 'test',
      exportIntervalMillis: 3_600_000,
    });
  });

  afterEach(async () => {
    await shutdownMetrics();
  });

  it('counts a successful payment failure with outcome="ok" + a latency sample', async () => {
    const { service, prisma } = buildSvcWithMetrics(new DunningMetrics());
    seedSubscription(prisma);

    const result = await service.recordPaymentFailure({
      subscriptionId: 'sub_internal_existing',
      sourceEventId: 'evt_metrics_ok',
    });
    expect(result.ok).toBe(true);

    const out = await serializeMetrics();
    expect(out).toMatch(/dunning_payment_failure_total\{[^}]*outcome="ok"[^}]*\} 1/);
    expect(out).toMatch(
      /dunning_operation_duration_seconds_count\{[^}]*operation="record_payment_failure"[^}]*outcome="ok"[^}]*\} 1/,
    );
  });

  it('counts a missing-subscription failure with outcome="subscription_not_found"', async () => {
    const { service } = buildSvcWithMetrics(new DunningMetrics());

    const result = await service.recordPaymentFailure({
      subscriptionId: 'sub_does_not_exist',
      sourceEventId: 'evt_metrics_missing',
    });
    expect(result.ok).toBe(false);

    const out = await serializeMetrics();
    expect(out).toMatch(
      /dunning_payment_failure_total\{[^}]*outcome="subscription_not_found"[^}]*\} 1/,
    );
  });

  it('records recovered="true" when a payment success rescues a past_due subscription', async () => {
    const { service, prisma } = buildSvcWithMetrics(new DunningMetrics());
    seedSubscription(prisma, {
      status: 'past_due',
      dunningAttempts: 2,
      dunningGraceUntil: new Date('2026-06-01T00:00:00.000Z'),
    });

    const result = await service.recordPaymentSuccess({
      subscriptionId: 'sub_internal_existing',
      sourceEventId: 'evt_metrics_recovery',
    });
    expect(result.ok).toBe(true);

    const out = await serializeMetrics();
    expect(out).toMatch(
      /dunning_payment_success_total\{[^}]*outcome="ok"[^}]*recovered="true"[^}]*\} 1/,
    );
  });

  it('counts a Stripe-failed pause with outcome="stripe_unavailable"', async () => {
    const { service, prisma, stripe } = buildSvcWithMetrics(new DunningMetrics());
    seedSubscription(prisma);
    stripe.subscriptions.update.mockRejectedValueOnce(new Error('stripe boom'));

    const result = await service.pauseSubscription({
      subscriptionId: 'sub_internal_existing',
      requesterUserId: 'usr_metrics',
    });
    expect(result.ok).toBe(false);

    const out = await serializeMetrics();
    expect(out).toMatch(/dunning_pause_total\{[^}]*outcome="stripe_unavailable"[^}]*\} 1/);
  });

  it('never leaks a subscription / customer / Stripe id onto the scrape surface', async () => {
    const { service, prisma } = buildSvcWithMetrics(new DunningMetrics());
    seedSubscription(prisma);

    await service.recordPaymentFailure({
      subscriptionId: 'sub_internal_existing',
      sourceEventId: 'evt_pii_check',
    });

    const out = await serializeMetrics();
    expect(out).not.toContain('sub_internal_existing');
    expect(out).not.toContain('sub_stripe_existing');
    expect(out).not.toContain('cus_existing');
    expect(out).not.toContain('hh_123');
    expect(out).not.toContain('evt_pii_check');
    // …but the instrument itself is present.
    expect(out).toMatch(/dunning_payment_failure_total/);
  });
});

/**
 * TS-042-followup-3 — dunning + pause/resume lifecycle events.
 *
 * Before this task every dunning transition was invisible outside
 * service-subscription: a family's card could fail, the grace window could
 * expire, and the subscription could go `unpaid` with no event for
 * service-notification to mail on, service-accounting to stop accruing on,
 * or service-analytics to funnel. These tests pin the four properties that
 * make the events trustworthy — the payload's contents, the event id's
 * identity rule, the in-transaction guarantee, and what is deliberately
 * withheld.
 */
describe('DunningService — lifecycle events (TS-042-followup-3)', () => {
  it('emits subscription.payment_failed carrying the grace deadline', async () => {
    const { service, prisma, outbox } = buildSvc();
    seedSubscription(prisma);
    const attemptedAt = new Date('2026-05-12T10:00:00.000Z');

    const result = await service.recordPaymentFailure({
      subscriptionId: 'sub_internal_existing',
      sourceEventId: 'evt_failure_001',
      attemptedAt,
    });

    expect(result.ok).toBe(true);
    const call = outbox.onlyCall();
    expect(call.eventName).toBe('subscription.payment_failed');
    expect(call.payload).toMatchObject({
      subscriptionId: 'sub_internal_existing',
      customerId: 'hh_123',
      // Without the group a consumer cannot tell which service owns
      // `customerId`; it would ask the wrong one, get an empty answer, and
      // the family would silently never be mailed (TS-042-followup-3a2a).
      customerGroup: 'family',
      attemptCount: 1,
      attemptedAt: attemptedAt.toISOString(),
      fromStatus: 'active',
      // The reason this event exists: when WE stop serving, not when Stripe
      // next retries.
      graceUntil: new Date(attemptedAt.getTime() + 21 * 24 * 60 * 60 * 1000).toISOString(),
    });
  });

  it('keys payment_failed on the source event so each attempt emits its own rung', async () => {
    const { service, prisma, outbox } = buildSvc();
    seedSubscription(prisma);

    await service.recordPaymentFailure({
      subscriptionId: 'sub_internal_existing',
      sourceEventId: 'evt_attempt_1',
      attemptedAt: new Date('2026-05-12T10:00:00.000Z'),
    });
    await service.recordPaymentFailure({
      subscriptionId: 'sub_internal_existing',
      sourceEventId: 'evt_attempt_2',
      attemptedAt: new Date('2026-05-15T10:00:00.000Z'),
    });

    // Two distinct ids. A subscription-scoped id would collapse the second
    // onto the first at the outbox PK and the dunning ladder would have
    // exactly one rung no matter how many times the card failed.
    const ids = outbox.appendCalls.map((c) => c.eventId);
    expect(new Set(ids).size).toBe(2);
    expect(ids[0]).toContain('evt_attempt_1');
    expect(ids[1]).toContain('evt_attempt_2');
    expect(outbox.appendCalls[1]?.payload).toMatchObject({ attemptCount: 2 });
  });

  it('emits payment_succeeded with recovered=true and the attempts it cleared', async () => {
    const { service, prisma, outbox } = buildSvc();
    seedSubscription(prisma, {
      status: 'past_due',
      dunningAttempts: 3,
      dunningGraceUntil: new Date('2026-06-02T00:00:00.000Z'),
    });

    const result = await service.recordPaymentSuccess({
      subscriptionId: 'sub_internal_existing',
      sourceEventId: 'evt_paid_001',
      succeededAt: new Date('2026-05-20T09:00:00.000Z'),
    });

    expect(result.ok).toBe(true);
    const call = outbox.onlyCall();
    expect(call.eventName).toBe('subscription.payment_succeeded');
    expect(call.payload).toMatchObject({
      customerGroup: 'family',
      recovered: true,
      fromStatus: 'past_due',
      toStatus: 'active',
      // Read from the pre-update row: the transaction zeroes the counter, so
      // reading it post-update would report every recovery as clearing none.
      attemptsCleared: 3,
    });
  });

  it('marks a routine renewal recovered=false so it is not mailed as a rescue', async () => {
    const { service, prisma, outbox } = buildSvc();
    seedSubscription(prisma, { status: 'active', dunningAttempts: 0 });

    await service.recordPaymentSuccess({
      subscriptionId: 'sub_internal_existing',
      sourceEventId: 'evt_renewal',
    });

    expect(outbox.onlyCall().payload).toMatchObject({
      recovered: false,
      attemptsCleared: 0,
    });
  });

  it('emits dunning_exhausted keyed on the subscription, not the sweep tick', async () => {
    const { service, prisma, outbox } = buildSvc();
    const graceUntil = new Date('2026-05-10T00:00:00.000Z');
    seedSubscription(prisma, {
      status: 'past_due',
      dunningAttempts: 4,
      dunningGraceUntil: graceUntil,
    });

    const result = await service.applyDunningExhaustion({
      subscriptionId: 'sub_internal_existing',
      sourceEventId: 'sweep_tick_2026_05_20',
      now: new Date('2026-05-20T00:00:00.000Z'),
    });

    expect(result.ok).toBe(true);
    const call = outbox.onlyCall();
    expect(call.eventName).toBe('subscription.dunning_exhausted');
    // Exhaustion happens once per dunning cycle; the id must not carry the
    // per-tick source or a loosened status guard would re-emit hourly.
    expect(call.eventId).toBe('sub_internal_existing.dunning_exhausted');
    expect(call.eventId).not.toContain('sweep_tick');
    expect(call.payload).toMatchObject({
      customerGroup: 'family',
      attemptCount: 4,
      graceUntil: graceUntil.toISOString(),
      exhaustedAt: '2026-05-20T00:00:00.000Z',
    });
  });

  it('emits subscription.paused WITHOUT the free-form reason text', async () => {
    const { service, prisma, outbox, stripe } = buildSvc();
    seedSubscription(prisma);
    stripe.subscriptions.update.mockResolvedValue(buildStripeSubscription({ status: 'paused' }));
    const reason = 'mother entered hospice care on the 3rd';

    const result = await service.pauseSubscription({
      subscriptionId: 'sub_internal_existing',
      requesterUserId: 'usr_payer_1',
      reason,
      resumesAt: new Date('2026-08-01T00:00:00.000Z'),
    });

    expect(result.ok).toBe(true);
    const call = outbox.onlyCall();
    expect(call.eventName).toBe('subscription.paused');
    expect(call.payload).toMatchObject({
      hasReason: true,
      requesterUserId: 'usr_payer_1',
      fromStatus: 'active',
      resumesAt: '2026-08-01T00:00:00.000Z',
    });
    // The text stays in the column it was written to. An event replicates to
    // the relay, Redis Streams, and every consumer's dedup table.
    expect(JSON.stringify(call.payload)).not.toContain('hospice');
    expect(call.payload['reason']).toBeUndefined();
    // …and it IS still persisted locally, so nothing was lost.
    expect(prisma.subscriptions[0]?.pauseReason).toBe(reason);
  });

  // Regression: an earlier draft keyed the pause event on `pausedAt`, which is
  // only millisecond-resolution. These three calls complete inside one
  // millisecond, so the two pauses shared an event id and the second would
  // have been dropped at the outbox PK — a pause a family made and nobody was
  // told about. The id is now the history row's, one per transition.
  it('gives repeat pauses distinct event ids even within the same millisecond', async () => {
    const { service, prisma, outbox, stripe } = buildSvc();
    seedSubscription(prisma);

    stripe.subscriptions.update.mockResolvedValue(buildStripeSubscription({ status: 'paused' }));
    const p1 = await service.pauseSubscription({
      subscriptionId: 'sub_internal_existing',
      requesterUserId: 'usr_payer_1',
    });
    stripe.subscriptions.update.mockResolvedValue(buildStripeSubscription({ status: 'active' }));
    const r1 = await service.resumeSubscription({
      subscriptionId: 'sub_internal_existing',
      requesterUserId: 'usr_payer_1',
    });
    stripe.subscriptions.update.mockResolvedValue(buildStripeSubscription({ status: 'paused' }));
    const p2 = await service.pauseSubscription({
      subscriptionId: 'sub_internal_existing',
      requesterUserId: 'usr_payer_1',
    });
    expect([p1.ok, r1.ok, p2.ok]).toEqual([true, true, true]);

    const pauseIds = outbox.appendCalls
      .filter((c) => c.eventName === 'subscription.paused')
      .map((c) => c.eventId);
    expect(pauseIds).toHaveLength(2);
    // A subscription-keyed id would silently drop the second pause.
    expect(new Set(pauseIds).size).toBe(2);
  });

  it('emits subscription.resumed with the status Stripe reported, not an assumed active', async () => {
    const { service, prisma, outbox, stripe } = buildSvc();
    seedSubscription(prisma, { status: 'paused' });
    // A subscription paused mid-dunning resumes to past_due, not active.
    stripe.subscriptions.update.mockResolvedValue(buildStripeSubscription({ status: 'past_due' }));

    const result = await service.resumeSubscription({
      subscriptionId: 'sub_internal_existing',
      requesterUserId: 'usr_payer_1',
      note: 'card replaced over the phone',
    });

    expect(result.ok).toBe(true);
    const call = outbox.onlyCall();
    expect(call.eventName).toBe('subscription.resumed');
    expect(call.payload).toMatchObject({
      toStatus: 'past_due',
      requesterUserId: 'usr_payer_1',
      hasNote: true,
    });
    expect(JSON.stringify(call.payload)).not.toContain('card replaced');
  });

  it('rolls the status change back when the event fails validation', async () => {
    const { service, prisma, outbox } = buildSvc();
    seedSubscription(prisma);
    outbox.nextResultOverride = 'validation_failed';

    const result = await service.recordPaymentFailure({
      subscriptionId: 'sub_internal_existing',
      sourceEventId: 'evt_rejected',
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.reason).toBe('outbox_validation_failed');
    // The whole point of appending in-transaction: a state change nobody can
    // be told about is not a state change we keep.
    expect(prisma.subscriptions[0]?.status).toBe('active');
    expect(prisma.subscriptions[0]?.dunningAttempts).toBe(0);
    expect(prisma.histories).toHaveLength(0);
  });

  it('appends the event through the transaction client, not the base client', async () => {
    const { service, prisma, outbox } = buildSvc();
    seedSubscription(prisma);

    await service.recordPaymentFailure({
      subscriptionId: 'sub_internal_existing',
      sourceEventId: 'evt_tx_check',
    });

    // Structural proof of the outbox invariant (PDD §7.3): append happened
    // inside $transaction, so the event row and the status write commit or
    // roll back together.
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(outbox.append).toHaveBeenCalledTimes(1);
    const [txArg] = outbox.append.mock.calls[0]!;
    expect(txArg).toBe(prisma);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// recordPaymentFailure — local double-count guard (TS-042-followup-3c)
// ─────────────────────────────────────────────────────────────────────────

describe('DunningService.recordPaymentFailure — local replay guard', () => {
  const attemptedAt = new Date('2026-05-12T10:00:00.000Z');

  it('does not double-count a redelivery of the same attempt', async () => {
    const { service, prisma } = buildSvc();
    seedSubscription(prisma);

    const first = await service.recordPaymentFailure({
      subscriptionId: 'sub_internal_existing',
      sourceEventId: 'evt_failure_001',
      attemptedAt,
    });
    const replay = await service.recordPaymentFailure({
      subscriptionId: 'sub_internal_existing',
      sourceEventId: 'evt_failure_001',
      attemptedAt,
    });

    expect(first.ok).toBe(true);
    expect(replay.ok).toBe(true);
    if (!replay.ok) return;
    // The count is what selects the dunning ladder's rung
    // (TS-042-followup-3a3); an inflated one walks a family to a harsher
    // email a rung early.
    expect(replay.value.dunningAttempts).toBe(1);
  });

  it('writes no second history row on a replay', async () => {
    const { service, prisma } = buildSvc();
    seedSubscription(prisma);

    await service.recordPaymentFailure({
      subscriptionId: 'sub_internal_existing',
      sourceEventId: 'evt_failure_001',
      attemptedAt,
    });
    await service.recordPaymentFailure({
      subscriptionId: 'sub_internal_existing',
      sourceEventId: 'evt_failure_001',
      attemptedAt,
    });

    expect(prisma.histories).toHaveLength(1);
  });

  it('returns the current row rather than an error — the caller must be able to ack', async () => {
    const { service, prisma } = buildSvc();
    seedSubscription(prisma);

    await service.recordPaymentFailure({
      subscriptionId: 'sub_internal_existing',
      sourceEventId: 'evt_failure_001',
      attemptedAt,
    });
    const replay = await service.recordPaymentFailure({
      subscriptionId: 'sub_internal_existing',
      sourceEventId: 'evt_failure_001',
      attemptedAt,
    });

    // Erroring would leave the webhook consumer retrying a redelivery
    // forever for a state that is already correct.
    expect(replay.ok).toBe(true);
    if (!replay.ok) return;
    expect(replay.value.status).toBe('past_due');
    expect(replay.value.dunningLastAttemptAt).toBe(attemptedAt.toISOString());
  });

  it('still counts a genuinely LATER attempt', async () => {
    const { service, prisma } = buildSvc();
    seedSubscription(prisma);

    await service.recordPaymentFailure({
      subscriptionId: 'sub_internal_existing',
      sourceEventId: 'evt_failure_001',
      attemptedAt,
    });
    const second = await service.recordPaymentFailure({
      subscriptionId: 'sub_internal_existing',
      sourceEventId: 'evt_failure_002',
      attemptedAt: new Date(attemptedAt.getTime() + 3 * 24 * 60 * 60 * 1000),
    });

    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.value.dunningAttempts).toBe(2);
    expect(prisma.histories).toHaveLength(2);
  });

  it('does not fire on the FIRST failure of a subscription that already carries an attempt instant', async () => {
    // `dunningAttempts === 0` means no failure has been recorded, whatever
    // else is on the row. The guard must not swallow the real first call.
    const { service, prisma } = buildSvc();
    seedSubscription(prisma, { dunningAttempts: 0, dunningLastAttemptAt: attemptedAt });

    const result = await service.recordPaymentFailure({
      subscriptionId: 'sub_internal_existing',
      sourceEventId: 'evt_failure_001',
      attemptedAt,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.dunningAttempts).toBe(1);
    expect(result.value.status).toBe('past_due');
  });

  it('preserves the grace window across a replay', async () => {
    const { service, prisma } = buildSvc();
    seedSubscription(prisma);

    const first = await service.recordPaymentFailure({
      subscriptionId: 'sub_internal_existing',
      sourceEventId: 'evt_failure_001',
      attemptedAt,
    });
    const replay = await service.recordPaymentFailure({
      subscriptionId: 'sub_internal_existing',
      sourceEventId: 'evt_failure_001',
      attemptedAt,
    });

    expect(first.ok && replay.ok).toBe(true);
    if (!first.ok || !replay.ok) return;
    expect(replay.value.dunningGraceUntil).toBe(first.value.dunningGraceUntil);
  });
});
