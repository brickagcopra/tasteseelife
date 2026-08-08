import { UnauthorizedException } from '@nestjs/common';
import {
  TenantContextStore,
  type TenantContextFrame,
} from '@taste-and-see/nest-prisma-tenant-scope';
import { describe, expect, it } from 'vitest';
import type { Request } from 'express';

import type { Env } from '../../../config/env';
import type {
  ApplyTransferEventInput,
  ApplyTransferEventResult,
  DisbursementRecord,
  DisbursementsService,
} from '../services/disbursements.service';

import { TransferEventsController } from './transfer-events.controller';

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

function buildDisbursement(): DisbursementRecord {
  return {
    id: 'pd_1',
    providerId: 'pr_a',
    stripeAccountId: 'acct_stub_pr_a',
    stripeTransferId: 'tr_stub_pd_1',
    currency: 'USD',
    amountMinor: 25_000,
    idempotencyKey: 'sweep:2026-05-16:pr_a',
    sourceEventId: 'payout:disbursement:pd_1',
    scheduledFor: new Date('2026-05-16T00:00:00.000Z'),
    heldUntil: new Date('2026-05-18T00:00:00.000Z'),
    initiatedAt: new Date('2026-05-18T01:00:00.000Z'),
    paidAt: new Date('2026-05-18T02:00:00.000Z'),
    failedAt: null,
    failureReason: null,
    memo: null,
    status: 'paid',
    liveMode: false,
    createdAt: new Date('2026-05-16T01:00:00.000Z'),
    updatedAt: new Date('2026-05-18T02:00:00.000Z'),
  };
}

class FakeDisbursementsService {
  nextResult: ApplyTransferEventResult = {
    outcome: 'applied',
    disbursement: buildDisbursement(),
  };
  captureStore: TenantContextStore | null = null;
  capturedFrame: TenantContextFrame | null = null;
  lastInput: ApplyTransferEventInput | null = null;
  async applyTransferEvent(input: ApplyTransferEventInput): Promise<ApplyTransferEventResult> {
    this.lastInput = input;
    if (this.captureStore !== null) {
      this.capturedFrame = this.captureStore.current();
    }
    return this.nextResult;
  }
}

function buildRequest(headers: Record<string, string> = {}): Request {
  return {
    header: (name: string) => headers[name.toLowerCase()],
  } as unknown as Request;
}

function makeStore(): TenantContextStore {
  return new TenantContextStore();
}

const baseBody = {
  stripeEventId: 'evt_test_1',
  eventType: 'transfer.paid',
  stripeTransferId: 'tr_stub_pd_1',
  outcome: 'paid' as const,
  occurredAt: '2026-05-18T02:00:00.000Z',
};

describe('TransferEventsController.ingest', () => {
  it('rejects a missing shared-secret header with 401', async () => {
    const fake = new FakeDisbursementsService();
    const controller = new TransferEventsController(
      fake as unknown as DisbursementsService,
      buildEnv(),
      makeStore(),
    );

    await expect(controller.ingest(baseBody, buildRequest({}))).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('rejects a wrong-value shared-secret with 401', async () => {
    const fake = new FakeDisbursementsService();
    const controller = new TransferEventsController(
      fake as unknown as DisbursementsService,
      buildEnv(),
      makeStore(),
    );

    await expect(
      controller.ingest(baseBody, buildRequest({ 'x-internal-api-key': 'x'.repeat(40) })),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('returns the applied response on success', async () => {
    const fake = new FakeDisbursementsService();
    const controller = new TransferEventsController(
      fake as unknown as DisbursementsService,
      buildEnv(),
      makeStore(),
    );

    const out = await controller.ingest(
      baseBody,
      buildRequest({ 'x-internal-api-key': 't'.repeat(40) }),
    );
    expect(out.outcome).toBe('applied');
    expect(out.disbursement?.id).toBe('pd_1');
  });

  it('forwards the failure reason when outcome is failed', async () => {
    const fake = new FakeDisbursementsService();
    fake.nextResult = {
      outcome: 'applied',
      disbursement: {
        ...buildDisbursement(),
        status: 'failed',
        failedAt: new Date('2026-05-18T03:00:00.000Z'),
        failureReason: 'insufficient_funds',
      },
    };
    const controller = new TransferEventsController(
      fake as unknown as DisbursementsService,
      buildEnv(),
      makeStore(),
    );

    await controller.ingest(
      {
        stripeEventId: 'evt_test_failed_1',
        eventType: 'transfer.failed',
        stripeTransferId: 'tr_stub_pd_1',
        outcome: 'failed',
        occurredAt: '2026-05-18T03:00:00.000Z',
        failureReason: 'insufficient_funds',
      },
      buildRequest({ 'x-internal-api-key': 't'.repeat(40) }),
    );

    expect(fake.lastInput?.outcome).toBe('failed');
    expect(fake.lastInput?.failureReason).toBe('insufficient_funds');
  });

  it('returns the ignored response with null disbursement when the transfer is unknown', async () => {
    const fake = new FakeDisbursementsService();
    fake.nextResult = { outcome: 'ignored', disbursement: null };
    const controller = new TransferEventsController(
      fake as unknown as DisbursementsService,
      buildEnv(),
      makeStore(),
    );

    const out = await controller.ingest(
      baseBody,
      buildRequest({ 'x-internal-api-key': 't'.repeat(40) }),
    );
    expect(out.outcome).toBe('ignored');
    expect(out.disbursement).toBeNull();
  });

  it('honours a custom PAYOUT_TRANSFERS_HEADER_NAME override', async () => {
    const fake = new FakeDisbursementsService();
    const env: Env = { ...buildEnv(), PAYOUT_TRANSFERS_HEADER_NAME: 'x-tns-transfers' };
    const controller = new TransferEventsController(
      fake as unknown as DisbursementsService,
      env,
      makeStore(),
    );

    const out = await controller.ingest(
      baseBody,
      buildRequest({ 'x-tns-transfers': 't'.repeat(40) }),
    );
    expect(out.outcome).toBe('applied');
  });
});

/**
 * Tenant-scope exempt-wrap contract (TS-020-followup-2b-platform-rollout).
 *
 * `ingest` is a shared-secret-pinned internal endpoint authenticating
 * via the `PAYOUT_TRANSFERS_HEADER_NAME` header rather than
 * `AccessTokenGuard`. The `TenantContextInterceptor` cannot seed a
 * scoped frame from a `request.requestContext` that does not exist,
 * so the handler body wraps in `runWithoutTenantContext` to satisfy
 * the `enforcement: 'enforce'` posture wired in `AppModule`.
 *
 * These tests pin the wrap contract by passing a real
 * `TenantContextStore` and a fake `DisbursementsService` that captures
 * `store.current()` at call time. The captured frame must be
 * `{ kind: 'exempt', reason: 'internal-payout-transfer-event' }`.
 */
describe('TransferEventsController tenant-scope exempt wrap (TS-020-followup-2b-platform-rollout)', () => {
  it('runs ingest inside an exempt frame with reason "internal-payout-transfer-event"', async () => {
    const store = makeStore();
    const fake = new FakeDisbursementsService();
    fake.captureStore = store;
    const controller = new TransferEventsController(
      fake as unknown as DisbursementsService,
      buildEnv(),
      store,
    );

    await controller.ingest(baseBody, buildRequest({ 'x-internal-api-key': 't'.repeat(40) }));

    expect(fake.capturedFrame).toEqual({
      kind: 'exempt',
      reason: 'internal-payout-transfer-event',
    });
  });

  it('captures the frame on the 401 short-circuit branch (wrap encloses the shared-secret check)', async () => {
    const store = makeStore();
    let frameAtThrow: TenantContextFrame | null = null;
    const fake = new FakeDisbursementsService();
    const controller = new TransferEventsController(
      fake as unknown as DisbursementsService,
      buildEnv(),
      store,
    );
    const req = {
      header: () => {
        frameAtThrow = store.current();
        return undefined;
      },
    } as unknown as Request;

    await expect(controller.ingest(baseBody, req)).rejects.toBeInstanceOf(UnauthorizedException);

    expect(frameAtThrow).toEqual({
      kind: 'exempt',
      reason: 'internal-payout-transfer-event',
    });
  });

  it('does not leak the exempt frame outside the handler', async () => {
    const store = makeStore();
    const fake = new FakeDisbursementsService();
    const controller = new TransferEventsController(
      fake as unknown as DisbursementsService,
      buildEnv(),
      store,
    );

    expect(store.current()).toBeNull();
    await controller.ingest(baseBody, buildRequest({ 'x-internal-api-key': 't'.repeat(40) }));
    expect(store.current()).toBeNull();
  });
});
