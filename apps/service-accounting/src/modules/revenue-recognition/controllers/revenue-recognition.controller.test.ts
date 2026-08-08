import {
  ConflictException,
  NotFoundException,
  UnauthorizedException,
  UnprocessableEntityException,
} from '@nestjs/common';
import type { RequestWithContext } from '@taste-and-see/nest-auth';
import { IDEMPOTENT_METADATA } from '@taste-and-see/nest-idempotency';
import {
  TenantContextStore,
  type TenantContextFrame,
} from '@taste-and-see/nest-prisma-tenant-scope';
import { describe, expect, it, vi } from 'vitest';

import type { Env } from '../../../config/env';
import type { SubscriptionRevenueRecognizerService } from '../services/subscription-revenue-recognizer.service';
import {
  RECOGNITION_INTERNAL_API_KEY_HEADER,
  RevenueRecognitionController,
} from './revenue-recognition.controller';

function buildEnv(): Env {
  return {
    NODE_ENV: 'test',
    PORT: 3015,
    LOG_LEVEL: 'info',
    DATABASE_URL: 'postgresql://x:y@localhost:5432/tastesee',
    SERVICE_VERSION: 'test',
    OTEL_TRACES_ENABLED: false,
    OTEL_METRICS_ENABLED: false,
    JWT_ACCESS_SECRET: 'a'.repeat(32),
    INTERNAL_TRUST_SIGNING_SECRET: 't'.repeat(32),
    INTERNAL_TRUST_MAX_AGE_SECONDS: 60,
    JWT_ISSUER: 'taste-and-see/service-identity',
    JWT_AUDIENCE: 'taste-and-see/api',
    REDIS_URL: 'redis://localhost:6379',
    IDEMPOTENCY_TTL_SECONDS: 60 * 60 * 24,
    IDEMPOTENCY_IN_FLIGHT_TTL_SECONDS: 30,
    INTERNAL_POST_JOURNAL_API_KEY: 'b'.repeat(32),
    OUTBOX_CONSUMER_NAME: 'default',
    OUTBOX_STREAM_PREFIX: 'events',
    OUTBOX_CONSUMER_MAX_ATTEMPTS: 10,
    OUTBOX_CONSUMER_POLL_BLOCK_MS: 5000,
    OUTBOX_CONSUMER_RECLAIM_IDLE_MS: 60_000,
    OUTBOX_CONSUMER_POLL_INTERVAL_MS: 1000,
    STRIPE_API_VERSION: '2024-12-18.acacia',
    STRIPE_RECONCILIATION_TOLERANCE_MINOR: 0,
  };
}

function makeStubService(): SubscriptionRevenueRecognizerService {
  return {
    recognizeActivation: vi.fn(),
    recognizeDaily: vi.fn(),
    cancelDeferredRevenue: vi.fn(),
  } as unknown as SubscriptionRevenueRecognizerService;
}

function makeStore(): TenantContextStore {
  return new TenantContextStore();
}

function makeRequest(headers: Record<string, string> = {}): RequestWithContext {
  return {
    header: (name: string) => headers[name.toLowerCase()],
  } as unknown as RequestWithContext;
}

function makeAuthedRequest(
  userId: string,
  headers: Record<string, string> = {},
): RequestWithContext {
  const req = makeRequest(headers);
  Object.assign(req, {
    requestContext: {
      userId,
      roles: [],
      tenantScope: { type: 'global' },
    },
  });
  return req;
}

const validActivationBody = {
  subscriptionId: 'sub_abc',
  customerId: 'cus_abc',
  customerGroup: 'family' as const,
  planCode: 'family.tier2',
  amountMinor: 29_900,
  currency: 'USD' as const,
  servicePeriodStart: '2026-05-01T00:00:00.000Z',
  servicePeriodEnd: '2026-05-31T23:59:59.999Z',
  sourceEventId: 'evt_sub.activated_abc',
  occurredAt: '2026-05-01T12:00:00.000Z',
};

const okActivationValue = {
  balanceId: 'drb_1',
  subscriptionId: 'sub_abc',
  activationJournalId: 'jrnl_1',
  originalAmountMinor: 29_900,
  recognizedAmountMinor: 0,
  currency: 'USD' as const,
  servicePeriodStart: new Date('2026-05-01T00:00:00.000Z'),
  servicePeriodEnd: new Date('2026-05-31T23:59:59.999Z'),
  status: 'active' as const,
  result: 'created' as const,
};

describe('RevenueRecognitionController.recognizeActivation', () => {
  it('accepts the shared-secret header and returns the activation response', async () => {
    const svc = makeStubService();
    vi.mocked(svc.recognizeActivation).mockResolvedValue({
      ok: true,
      value: okActivationValue,
    } as never);
    const controller = new RevenueRecognitionController(svc, buildEnv(), makeStore());

    const req = makeRequest({
      [RECOGNITION_INTERNAL_API_KEY_HEADER]: 'b'.repeat(32),
    });
    const result = await controller.recognizeActivation(validActivationBody, req);
    expect(result.balanceId).toBe('drb_1');
    expect(result.subscriptionId).toBe('sub_abc');
    expect(result.activationJournalId).toBe('jrnl_1');
    expect(result.originalAmountMinor).toBe(29_900);
    expect(result.status).toBe('active');
    expect(result.result).toBe('created');
    expect(result.servicePeriodStart).toBe('2026-05-01T00:00:00.000Z');
    expect(svc.recognizeActivation).toHaveBeenCalledWith(validActivationBody);
  });

  it('rejects with 401 when shared-secret header is missing', async () => {
    const svc = makeStubService();
    const controller = new RevenueRecognitionController(svc, buildEnv(), makeStore());
    const req = makeRequest();
    await expect(controller.recognizeActivation(validActivationBody, req)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect(svc.recognizeActivation).not.toHaveBeenCalled();
  });

  it('rejects with 401 when shared-secret header is wrong', async () => {
    const svc = makeStubService();
    const controller = new RevenueRecognitionController(svc, buildEnv(), makeStore());
    const req = makeRequest({
      [RECOGNITION_INTERNAL_API_KEY_HEADER]: 'c'.repeat(32),
    });
    await expect(controller.recognizeActivation(validActivationBody, req)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('maps `period_inverted` to a 422', async () => {
    const svc = makeStubService();
    vi.mocked(svc.recognizeActivation).mockResolvedValue({
      ok: false,
      failure: { kind: 'period_inverted' },
    } as never);
    const controller = new RevenueRecognitionController(svc, buildEnv(), makeStore());
    const req = makeRequest({
      [RECOGNITION_INTERNAL_API_KEY_HEADER]: 'b'.repeat(32),
    });
    await expect(controller.recognizeActivation(validActivationBody, req)).rejects.toBeInstanceOf(
      UnprocessableEntityException,
    );
  });

  it('maps `amount_non_positive` to a 422', async () => {
    const svc = makeStubService();
    vi.mocked(svc.recognizeActivation).mockResolvedValue({
      ok: false,
      failure: { kind: 'amount_non_positive' },
    } as never);
    const controller = new RevenueRecognitionController(svc, buildEnv(), makeStore());
    const req = makeRequest({
      [RECOGNITION_INTERNAL_API_KEY_HEADER]: 'b'.repeat(32),
    });
    await expect(controller.recognizeActivation(validActivationBody, req)).rejects.toBeInstanceOf(
      UnprocessableEntityException,
    );
  });

  it('maps `subscription_period_conflict` to a 409', async () => {
    const svc = makeStubService();
    vi.mocked(svc.recognizeActivation).mockResolvedValue({
      ok: false,
      failure: {
        kind: 'subscription_period_conflict',
        subscriptionId: 'sub_abc',
        servicePeriodStart: '2026-05-01T00:00:00.000Z',
      },
    } as never);
    const controller = new RevenueRecognitionController(svc, buildEnv(), makeStore());
    const req = makeRequest({
      [RECOGNITION_INTERNAL_API_KEY_HEADER]: 'b'.repeat(32),
    });
    await expect(controller.recognizeActivation(validActivationBody, req)).rejects.toBeInstanceOf(
      ConflictException,
    );
  });

  it('maps downstream `account_not_found` to a 404', async () => {
    const svc = makeStubService();
    vi.mocked(svc.recognizeActivation).mockResolvedValue({
      ok: false,
      failure: {
        kind: 'journal_post_failed',
        failure: {
          kind: 'account_not_found',
          accountCode: '2000.family.tier2',
        },
      },
    } as never);
    const controller = new RevenueRecognitionController(svc, buildEnv(), makeStore());
    const req = makeRequest({
      [RECOGNITION_INTERNAL_API_KEY_HEADER]: 'b'.repeat(32),
    });
    await expect(controller.recognizeActivation(validActivationBody, req)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('maps downstream `period_closed` to a 422', async () => {
    const svc = makeStubService();
    vi.mocked(svc.recognizeActivation).mockResolvedValue({
      ok: false,
      failure: {
        kind: 'journal_post_failed',
        failure: {
          kind: 'period_closed',
          periodId: 'prd_2026-04',
          periodName: '2026-04',
        },
      },
    } as never);
    const controller = new RevenueRecognitionController(svc, buildEnv(), makeStore());
    const req = makeRequest({
      [RECOGNITION_INTERNAL_API_KEY_HEADER]: 'b'.repeat(32),
    });
    await expect(controller.recognizeActivation(validActivationBody, req)).rejects.toBeInstanceOf(
      UnprocessableEntityException,
    );
  });

  it('is marked @Idempotent()', () => {
    const flag = Reflect.getMetadata(
      IDEMPOTENT_METADATA,
      RevenueRecognitionController.prototype.recognizeActivation,
    );
    expect(flag).toBe(true);
  });
});

describe('RevenueRecognitionController.cancelDeferredRevenue', () => {
  const validCancelBody = {
    subscriptionId: 'sub_abc',
    servicePeriodStart: '2026-05-01T00:00:00.000Z',
    sourceEventId: 'evt_sub.canceled_abc',
    occurredAt: '2026-05-15T00:00:00.000Z',
  };

  it('returns the cancel response on success', async () => {
    const svc = makeStubService();
    vi.mocked(svc.cancelDeferredRevenue).mockResolvedValue({
      ok: true,
      value: {
        balanceId: 'drb_1',
        subscriptionId: 'sub_abc',
        previousStatus: 'active' as const,
        status: 'canceled' as const,
        remainingDeferredMinor: 20_250,
        result: 'canceled' as const,
      },
    } as never);
    const controller = new RevenueRecognitionController(svc, buildEnv(), makeStore());
    const req = makeRequest({
      [RECOGNITION_INTERNAL_API_KEY_HEADER]: 'b'.repeat(32),
    });
    const result = await controller.cancelDeferredRevenue(validCancelBody, req);
    expect(result.previousStatus).toBe('active');
    expect(result.status).toBe('canceled');
    expect(result.remainingDeferredMinor).toBe(20_250);
    expect(result.result).toBe('canceled');
  });

  it('rejects with 401 when shared-secret header is missing', async () => {
    const svc = makeStubService();
    const controller = new RevenueRecognitionController(svc, buildEnv(), makeStore());
    const req = makeRequest();
    await expect(controller.cancelDeferredRevenue(validCancelBody, req)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('maps `balance_not_found` to a 404', async () => {
    const svc = makeStubService();
    vi.mocked(svc.cancelDeferredRevenue).mockResolvedValue({
      ok: false,
      failure: {
        kind: 'balance_not_found',
        subscriptionId: 'sub_missing',
        servicePeriodStart: '2026-05-01T00:00:00.000Z',
      },
    } as never);
    const controller = new RevenueRecognitionController(svc, buildEnv(), makeStore());
    const req = makeRequest({
      [RECOGNITION_INTERNAL_API_KEY_HEADER]: 'b'.repeat(32),
    });
    await expect(
      controller.cancelDeferredRevenue({ ...validCancelBody, subscriptionId: 'sub_missing' }, req),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('is marked @Idempotent()', () => {
    const flag = Reflect.getMetadata(
      IDEMPOTENT_METADATA,
      RevenueRecognitionController.prototype.cancelDeferredRevenue,
    );
    expect(flag).toBe(true);
  });
});

describe('RevenueRecognitionController.recognizeDaily', () => {
  it('forwards the asOf timestamp and returns the report', async () => {
    const svc = makeStubService();
    const asOf = new Date('2026-05-15T03:00:00.000Z');
    vi.mocked(svc.recognizeDaily).mockResolvedValue({
      asOf,
      scannedCount: 10,
      recognizedCount: 8,
      skippedCount: 2,
      completedCount: 1,
      failedCount: 0,
      totalRecognizedMinor: 92_350,
    });
    const controller = new RevenueRecognitionController(svc, buildEnv(), makeStore());
    const req = makeAuthedRequest('usr_admin_finance');

    const result = await controller.recognizeDaily({ asOf: '2026-05-15T03:00:00.000Z' }, req);
    expect(result.scannedCount).toBe(10);
    expect(result.recognizedCount).toBe(8);
    expect(result.completedCount).toBe(1);
    expect(result.totalRecognizedMinor).toBe(92_350);
    expect(result.asOf).toBe('2026-05-15T03:00:00.000Z');
    expect(svc.recognizeDaily).toHaveBeenCalledWith(asOf);
  });

  it('defaults asOf to now() when omitted', async () => {
    const svc = makeStubService();
    vi.mocked(svc.recognizeDaily).mockImplementation(async (asOf: Date) => {
      return {
        asOf,
        scannedCount: 0,
        recognizedCount: 0,
        skippedCount: 0,
        completedCount: 0,
        failedCount: 0,
        totalRecognizedMinor: 0,
      };
    });
    const controller = new RevenueRecognitionController(svc, buildEnv(), makeStore());
    const req = makeAuthedRequest('usr_admin_finance');

    const before = Date.now();
    await controller.recognizeDaily({}, req);
    const after = Date.now();
    expect(svc.recognizeDaily).toHaveBeenCalledTimes(1);
    const passedAsOf = vi.mocked(svc.recognizeDaily).mock.calls[0]![0];
    expect(passedAsOf.getTime()).toBeGreaterThanOrEqual(before);
    expect(passedAsOf.getTime()).toBeLessThanOrEqual(after);
  });

  it('rejects with 401 when no requestContext is present', async () => {
    const svc = makeStubService();
    const controller = new RevenueRecognitionController(svc, buildEnv(), makeStore());
    const req = makeRequest();
    await expect(controller.recognizeDaily({}, req)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('is marked @Idempotent()', () => {
    const flag = Reflect.getMetadata(
      IDEMPOTENT_METADATA,
      RevenueRecognitionController.prototype.recognizeDaily,
    );
    expect(flag).toBe(true);
  });
});

/**
 * Tenant-scope exempt-wrap contract (TS-020-followup-2b-platform-rollout).
 *
 * `recognizeActivation` and `cancelDeferredRevenue` are the two
 * shared-secret-pinned internal endpoints in this controller — they
 * authenticate via the `RECOGNITION_INTERNAL_API_KEY_HEADER` rather
 * than `AccessTokenGuard`, so the `TenantContextInterceptor` cannot
 * seed a scoped frame from a `request.requestContext` that does not
 * exist. Without an explicit exempt wrap, every Prisma operation
 * downstream of these handlers would hard-fail with
 * `MissingRequestContextError` under the `enforcement: 'enforce'`
 * posture wired in `AppModule`.
 *
 * These tests pin the wrap contract by passing a real
 * `TenantContextStore` and a fake `SubscriptionRevenueRecognizerService`
 * that captures `store.current()` at call time. The captured frame must
 * be `{ kind: 'exempt', reason: 'internal-{name}' }` — the precise
 * reason string the audit log will surface, so a future log scan can
 * trace every "no-context" Prisma access back to its internal source.
 *
 * The admin endpoint (`recognizeDaily`) is deliberately NOT covered
 * here — it sits behind `AccessTokenGuard` so the
 * `TenantContextInterceptor` seeds a scoped frame from the
 * access-token claims before the handler body runs.
 */
describe('RevenueRecognitionController tenant-scope exempt wrap (TS-020-followup-2b-platform-rollout)', () => {
  it('runs recognizeActivation inside an exempt frame with reason "internal-subscription-activated"', async () => {
    const store = makeStore();
    let captured: TenantContextFrame | null = null;
    const recognizeActivationMock = vi.fn(async () => {
      captured = store.current();
      return { ok: true as const, value: okActivationValue };
    });
    const svc = {
      recognizeActivation: recognizeActivationMock,
      recognizeDaily: vi.fn(),
      cancelDeferredRevenue: vi.fn(),
    } as unknown as SubscriptionRevenueRecognizerService;
    const controller = new RevenueRecognitionController(svc, buildEnv(), store);
    const req = makeRequest({
      [RECOGNITION_INTERNAL_API_KEY_HEADER]: 'b'.repeat(32),
    });

    await controller.recognizeActivation(validActivationBody, req);

    expect(captured).toEqual({
      kind: 'exempt',
      reason: 'internal-subscription-activated',
    });
    expect(recognizeActivationMock).toHaveBeenCalledTimes(1);
  });

  it('runs cancelDeferredRevenue inside an exempt frame with reason "internal-subscription-canceled"', async () => {
    const store = makeStore();
    let captured: TenantContextFrame | null = null;
    const cancelMock = vi.fn(async () => {
      captured = store.current();
      return {
        ok: true as const,
        value: {
          balanceId: 'drb_1',
          subscriptionId: 'sub_abc',
          previousStatus: 'active' as const,
          status: 'canceled' as const,
          remainingDeferredMinor: 0,
          result: 'canceled' as const,
        },
      };
    });
    const svc = {
      recognizeActivation: vi.fn(),
      recognizeDaily: vi.fn(),
      cancelDeferredRevenue: cancelMock,
    } as unknown as SubscriptionRevenueRecognizerService;
    const controller = new RevenueRecognitionController(svc, buildEnv(), store);
    const req = makeRequest({
      [RECOGNITION_INTERNAL_API_KEY_HEADER]: 'b'.repeat(32),
    });

    await controller.cancelDeferredRevenue(
      {
        subscriptionId: 'sub_abc',
        servicePeriodStart: '2026-05-01T00:00:00.000Z',
        sourceEventId: 'evt_sub.canceled_abc',
        occurredAt: '2026-05-15T00:00:00.000Z',
      },
      req,
    );

    expect(captured).toEqual({
      kind: 'exempt',
      reason: 'internal-subscription-canceled',
    });
    expect(cancelMock).toHaveBeenCalledTimes(1);
  });

  it('captures the frame on the 401 short-circuit branch (wrap encloses the shared-secret check)', async () => {
    const store = makeStore();
    let frameAtThrow: TenantContextFrame | null = null;
    const svc = makeStubService();
    const controller = new RevenueRecognitionController(svc, buildEnv(), store);
    const req = {
      header: () => {
        // Captured the frame from inside the wrap before the 401 throws.
        frameAtThrow = store.current();
        return undefined;
      },
    } as unknown as RequestWithContext;

    await expect(controller.recognizeActivation(validActivationBody, req)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );

    expect(frameAtThrow).toEqual({
      kind: 'exempt',
      reason: 'internal-subscription-activated',
    });
    expect(svc.recognizeActivation).not.toHaveBeenCalled();
  });

  it('does not leak the exempt frame outside the handler', async () => {
    const store = makeStore();
    const svc = makeStubService();
    vi.mocked(svc.recognizeActivation).mockResolvedValue({
      ok: true,
      value: okActivationValue,
    } as never);
    const controller = new RevenueRecognitionController(svc, buildEnv(), store);
    const req = makeRequest({
      [RECOGNITION_INTERNAL_API_KEY_HEADER]: 'b'.repeat(32),
    });

    expect(store.current()).toBeNull();
    await controller.recognizeActivation(validActivationBody, req);
    expect(store.current()).toBeNull();
  });
});
