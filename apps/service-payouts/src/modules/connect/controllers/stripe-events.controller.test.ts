import { UnauthorizedException } from '@nestjs/common';
import {
  TenantContextStore,
  type TenantContextFrame,
} from '@taste-and-see/nest-prisma-tenant-scope';
import { describe, expect, it } from 'vitest';
import type { Request } from 'express';

import type { Env } from '../../../config/env';
import type {
  IngestEventResult,
  StripeAccountEventsService,
} from '../services/stripe-account-events.service';
import type { PayoutAccountRecord } from '../services/payout-accounts.service';

import { StripeEventsController } from './stripe-events.controller';

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

function buildAccount(): PayoutAccountRecord {
  return {
    id: 'pa_1',
    providerId: 'pr_a',
    stripeAccountId: 'acct_stub_pr_a',
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
    createdAt: new Date('2026-05-16T12:00:00.000Z'),
    updatedAt: new Date('2026-05-16T12:00:00.000Z'),
  };
}

class FakeEventsService {
  nextResult: IngestEventResult = { outcome: 'applied', account: buildAccount() };
  captureStore: TenantContextStore | null = null;
  capturedFrame: TenantContextFrame | null = null;
  async ingest(): Promise<IngestEventResult> {
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
  eventType: 'account.updated',
  stripeAccountId: 'acct_stub_pr_a',
  occurredAt: '2026-05-16T12:00:00.000Z',
  payload: {
    detailsSubmitted: true,
    chargesEnabled: true,
    payoutsEnabled: true,
  },
};

describe('StripeEventsController.ingest', () => {
  it('rejects a missing shared-secret header with 401', async () => {
    const fake = new FakeEventsService();
    const controller = new StripeEventsController(
      fake as unknown as StripeAccountEventsService,
      buildEnv(),
      makeStore(),
    );

    await expect(controller.ingest(baseBody, buildRequest({}))).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('rejects a wrong-value shared-secret with 401', async () => {
    const fake = new FakeEventsService();
    const controller = new StripeEventsController(
      fake as unknown as StripeAccountEventsService,
      buildEnv(),
      makeStore(),
    );

    await expect(
      controller.ingest(baseBody, buildRequest({ 'x-internal-api-key': 'x'.repeat(40) })),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('returns the applied response on success', async () => {
    const fake = new FakeEventsService();
    const controller = new StripeEventsController(
      fake as unknown as StripeAccountEventsService,
      buildEnv(),
      makeStore(),
    );

    const out = await controller.ingest(
      baseBody,
      buildRequest({ 'x-internal-api-key': 'k'.repeat(40) }),
    );
    expect(out.outcome).toBe('applied');
    expect(out.account?.providerId).toBe('pr_a');
  });

  it('returns the ignored response with null account when the account is unknown', async () => {
    const fake = new FakeEventsService();
    fake.nextResult = { outcome: 'ignored', account: null };
    const controller = new StripeEventsController(
      fake as unknown as StripeAccountEventsService,
      buildEnv(),
      makeStore(),
    );

    const out = await controller.ingest(
      baseBody,
      buildRequest({ 'x-internal-api-key': 'k'.repeat(40) }),
    );
    expect(out.outcome).toBe('ignored');
    expect(out.account).toBeNull();
  });

  it('honours a custom STRIPE_EVENTS_HEADER_NAME override', async () => {
    const fake = new FakeEventsService();
    const env: Env = { ...buildEnv(), STRIPE_EVENTS_HEADER_NAME: 'x-tns-stripe' };
    const controller = new StripeEventsController(
      fake as unknown as StripeAccountEventsService,
      env,
      makeStore(),
    );

    const out = await controller.ingest(baseBody, buildRequest({ 'x-tns-stripe': 'k'.repeat(40) }));
    expect(out.outcome).toBe('applied');
  });
});

/**
 * Tenant-scope exempt-wrap contract (TS-020-followup-2b-platform-rollout).
 *
 * `ingest` is a shared-secret-pinned internal endpoint authenticating
 * via the `STRIPE_EVENTS_HEADER_NAME` header rather than
 * `AccessTokenGuard`. The `TenantContextInterceptor` cannot seed a
 * scoped frame from a `request.requestContext` that does not exist,
 * so the handler body wraps in `runWithoutTenantContext` to satisfy
 * the `enforcement: 'enforce'` posture wired in `AppModule`.
 *
 * These tests pin the wrap contract by passing a real
 * `TenantContextStore` and a fake `StripeAccountEventsService` that
 * captures `store.current()` at call time. The captured frame must be
 * `{ kind: 'exempt', reason: 'internal-stripe-account-event' }`.
 */
describe('StripeEventsController tenant-scope exempt wrap (TS-020-followup-2b-platform-rollout)', () => {
  it('runs ingest inside an exempt frame with reason "internal-stripe-account-event"', async () => {
    const store = makeStore();
    const fake = new FakeEventsService();
    fake.captureStore = store;
    const controller = new StripeEventsController(
      fake as unknown as StripeAccountEventsService,
      buildEnv(),
      store,
    );

    await controller.ingest(baseBody, buildRequest({ 'x-internal-api-key': 'k'.repeat(40) }));

    expect(fake.capturedFrame).toEqual({
      kind: 'exempt',
      reason: 'internal-stripe-account-event',
    });
  });

  it('captures the frame on the 401 short-circuit branch (wrap encloses the shared-secret check)', async () => {
    const store = makeStore();
    let frameAtThrow: TenantContextFrame | null = null;
    const fake = new FakeEventsService();
    const controller = new StripeEventsController(
      fake as unknown as StripeAccountEventsService,
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
      reason: 'internal-stripe-account-event',
    });
  });

  it('does not leak the exempt frame outside the handler', async () => {
    const store = makeStore();
    const fake = new FakeEventsService();
    const controller = new StripeEventsController(
      fake as unknown as StripeAccountEventsService,
      buildEnv(),
      store,
    );

    expect(store.current()).toBeNull();
    await controller.ingest(baseBody, buildRequest({ 'x-internal-api-key': 'k'.repeat(40) }));
    expect(store.current()).toBeNull();
  });
});
