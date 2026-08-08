import {
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
import type { BookingCommissionRecognizerService } from '../services/booking-commission-recognizer.service';
import {
  BOOKING_COMMISSION_INTERNAL_API_KEY_HEADER,
  BookingCommissionController,
} from './booking-commission.controller';

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

function makeStubService(): BookingCommissionRecognizerService {
  return {
    recognizeBookingCompleted: vi.fn(),
    readRunningPayableMinor: vi.fn(),
    getProviderPayableBalance: vi.fn(),
  } as unknown as BookingCommissionRecognizerService;
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

const validRequestBody = {
  bookingId: 'bk_abc',
  providerId: 'prv_abc',
  householdId: 'hh_abc',
  grossAmountMinor: 15_000,
  providerAmountMinor: 12_000,
  marketplaceAmountMinor: 3_000,
  commissionRateBps: 2_000,
  currency: 'USD' as const,
  completedAt: '2026-05-15T14:30:00.000Z',
  sourceEventId: 'evt_booking.completed_bk_abc',
};

const okRecognizerOutput = {
  journalId: 'jrnl_1',
  bookingId: 'bk_abc',
  providerId: 'prv_abc',
  grossAmountMinor: 15_000,
  providerAmountMinor: 12_000,
  marketplaceAmountMinor: 3_000,
  commissionRateBps: 2_000,
  currency: 'USD' as const,
  runningPayableMinor: 12_000,
  result: 'created' as const,
};

describe('BookingCommissionController.recognizeBookingCompleted', () => {
  it('accepts the shared-secret header and returns the booking-commission response', async () => {
    const svc = makeStubService();
    vi.mocked(svc.recognizeBookingCompleted).mockResolvedValue({
      ok: true,
      value: okRecognizerOutput,
    } as never);
    const controller = new BookingCommissionController(svc, buildEnv(), makeStore());

    const req = makeRequest({
      [BOOKING_COMMISSION_INTERNAL_API_KEY_HEADER]: 'b'.repeat(32),
    });
    const result = await controller.recognizeBookingCompleted(validRequestBody, req);
    expect(result.journalId).toBe('jrnl_1');
    expect(result.bookingId).toBe('bk_abc');
    expect(result.providerId).toBe('prv_abc');
    expect(result.grossAmountMinor).toBe(15_000);
    expect(result.providerAmountMinor).toBe(12_000);
    expect(result.marketplaceAmountMinor).toBe(3_000);
    expect(result.commissionRateBps).toBe(2_000);
    expect(result.runningPayableMinor).toBe(12_000);
    expect(result.result).toBe('created');
    expect(svc.recognizeBookingCompleted).toHaveBeenCalledWith(validRequestBody);
  });

  it('returns idempotent_replay when the recognizer reports a replay', async () => {
    const svc = makeStubService();
    vi.mocked(svc.recognizeBookingCompleted).mockResolvedValue({
      ok: true,
      value: { ...okRecognizerOutput, result: 'idempotent_replay' as const },
    } as never);
    const controller = new BookingCommissionController(svc, buildEnv(), makeStore());
    const req = makeRequest({
      [BOOKING_COMMISSION_INTERNAL_API_KEY_HEADER]: 'b'.repeat(32),
    });
    const result = await controller.recognizeBookingCompleted(validRequestBody, req);
    expect(result.result).toBe('idempotent_replay');
  });

  it('rejects with 401 when the shared-secret header is missing', async () => {
    const svc = makeStubService();
    const controller = new BookingCommissionController(svc, buildEnv(), makeStore());
    await expect(
      controller.recognizeBookingCompleted(validRequestBody, makeRequest()),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(svc.recognizeBookingCompleted).not.toHaveBeenCalled();
  });

  it('rejects with 401 when the shared-secret header is wrong', async () => {
    const svc = makeStubService();
    const controller = new BookingCommissionController(svc, buildEnv(), makeStore());
    const req = makeRequest({
      [BOOKING_COMMISSION_INTERNAL_API_KEY_HEADER]: 'c'.repeat(32),
    });
    await expect(
      controller.recognizeBookingCompleted(validRequestBody, req),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('maps amount_invariant_violated to 422', async () => {
    const svc = makeStubService();
    vi.mocked(svc.recognizeBookingCompleted).mockResolvedValue({
      ok: false,
      failure: { kind: 'amount_invariant_violated' },
    } as never);
    const controller = new BookingCommissionController(svc, buildEnv(), makeStore());
    const req = makeRequest({
      [BOOKING_COMMISSION_INTERNAL_API_KEY_HEADER]: 'b'.repeat(32),
    });
    await expect(
      controller.recognizeBookingCompleted(validRequestBody, req),
    ).rejects.toBeInstanceOf(UnprocessableEntityException);
  });

  it('maps amount_non_positive to 422', async () => {
    const svc = makeStubService();
    vi.mocked(svc.recognizeBookingCompleted).mockResolvedValue({
      ok: false,
      failure: { kind: 'amount_non_positive' },
    } as never);
    const controller = new BookingCommissionController(svc, buildEnv(), makeStore());
    const req = makeRequest({
      [BOOKING_COMMISSION_INTERNAL_API_KEY_HEADER]: 'b'.repeat(32),
    });
    await expect(
      controller.recognizeBookingCompleted(validRequestBody, req),
    ).rejects.toBeInstanceOf(UnprocessableEntityException);
  });

  it('maps journal_post_failed → account_not_found to 404', async () => {
    const svc = makeStubService();
    vi.mocked(svc.recognizeBookingCompleted).mockResolvedValue({
      ok: false,
      failure: {
        kind: 'journal_post_failed',
        failure: { kind: 'account_not_found', accountCode: '1000' },
      },
    } as never);
    const controller = new BookingCommissionController(svc, buildEnv(), makeStore());
    const req = makeRequest({
      [BOOKING_COMMISSION_INTERNAL_API_KEY_HEADER]: 'b'.repeat(32),
    });
    await expect(
      controller.recognizeBookingCompleted(validRequestBody, req),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('maps journal_post_failed → account_inactive to 422', async () => {
    const svc = makeStubService();
    vi.mocked(svc.recognizeBookingCompleted).mockResolvedValue({
      ok: false,
      failure: {
        kind: 'journal_post_failed',
        failure: { kind: 'account_inactive', accountCode: '4100' },
      },
    } as never);
    const controller = new BookingCommissionController(svc, buildEnv(), makeStore());
    const req = makeRequest({
      [BOOKING_COMMISSION_INTERNAL_API_KEY_HEADER]: 'b'.repeat(32),
    });
    await expect(
      controller.recognizeBookingCompleted(validRequestBody, req),
    ).rejects.toBeInstanceOf(UnprocessableEntityException);
  });

  it('maps journal_post_failed → period_closed to 422', async () => {
    const svc = makeStubService();
    vi.mocked(svc.recognizeBookingCompleted).mockResolvedValue({
      ok: false,
      failure: {
        kind: 'journal_post_failed',
        failure: {
          kind: 'period_closed',
          periodId: 'prd_2026_04',
          periodName: '2026-04',
        },
      },
    } as never);
    const controller = new BookingCommissionController(svc, buildEnv(), makeStore());
    const req = makeRequest({
      [BOOKING_COMMISSION_INTERNAL_API_KEY_HEADER]: 'b'.repeat(32),
    });
    await expect(
      controller.recognizeBookingCompleted(validRequestBody, req),
    ).rejects.toBeInstanceOf(UnprocessableEntityException);
  });

  it('maps journal_post_failed → journal_unbalanced to 422', async () => {
    const svc = makeStubService();
    vi.mocked(svc.recognizeBookingCompleted).mockResolvedValue({
      ok: false,
      failure: {
        kind: 'journal_post_failed',
        failure: {
          kind: 'journal_unbalanced',
          debitTotalMinor: 100,
          creditTotalMinor: 99,
        },
      },
    } as never);
    const controller = new BookingCommissionController(svc, buildEnv(), makeStore());
    const req = makeRequest({
      [BOOKING_COMMISSION_INTERNAL_API_KEY_HEADER]: 'b'.repeat(32),
    });
    await expect(
      controller.recognizeBookingCompleted(validRequestBody, req),
    ).rejects.toBeInstanceOf(UnprocessableEntityException);
  });

  it('carries the @Idempotent decorator metadata', () => {
    const metadata = Reflect.getMetadata(
      IDEMPOTENT_METADATA,
      BookingCommissionController.prototype.recognizeBookingCompleted,
    );
    expect(metadata).toBeDefined();
  });
});

describe('BookingCommissionController.getProviderPayableBalance', () => {
  it('returns the payable response when the provider has a balance row', async () => {
    const svc = makeStubService();
    vi.mocked(svc.getProviderPayableBalance).mockResolvedValue({
      providerId: 'prv_abc',
      currency: 'USD',
      amountMinor: 12_000,
      lastUpdatedAt: new Date('2026-05-15T14:30:00.000Z'),
    });
    const controller = new BookingCommissionController(svc, buildEnv(), makeStore());
    const req = makeAuthedRequest('usr_admin');

    const result = await controller.getProviderPayableBalance('prv_abc', req);
    expect(result.providerId).toBe('prv_abc');
    expect(result.amountMinor).toBe(12_000);
    expect(result.currency).toBe('USD');
    expect(result.lastUpdatedAt).toBe('2026-05-15T14:30:00.000Z');
  });

  it('returns 404 when no booking has been completed for the provider yet', async () => {
    const svc = makeStubService();
    vi.mocked(svc.getProviderPayableBalance).mockResolvedValue(null);
    const controller = new BookingCommissionController(svc, buildEnv(), makeStore());
    const req = makeAuthedRequest('usr_admin');

    await expect(controller.getProviderPayableBalance('prv_unknown', req)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('rejects with 401 when no requestContext is attached (auth not satisfied)', async () => {
    const svc = makeStubService();
    const controller = new BookingCommissionController(svc, buildEnv(), makeStore());
    const req = makeRequest();

    await expect(controller.getProviderPayableBalance('prv_abc', req)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect(svc.getProviderPayableBalance).not.toHaveBeenCalled();
  });

  it('rejects with 422 when providerId is empty', async () => {
    const svc = makeStubService();
    const controller = new BookingCommissionController(svc, buildEnv(), makeStore());
    const req = makeAuthedRequest('usr_admin');
    await expect(controller.getProviderPayableBalance('', req)).rejects.toBeInstanceOf(
      UnprocessableEntityException,
    );
  });

  it('rejects with 422 when providerId exceeds the cap', async () => {
    const svc = makeStubService();
    const controller = new BookingCommissionController(svc, buildEnv(), makeStore());
    const req = makeAuthedRequest('usr_admin');
    await expect(controller.getProviderPayableBalance('x'.repeat(65), req)).rejects.toBeInstanceOf(
      UnprocessableEntityException,
    );
  });

  it('accepts a negative balance (refund-after-payout clawback scenario)', async () => {
    const svc = makeStubService();
    vi.mocked(svc.getProviderPayableBalance).mockResolvedValue({
      providerId: 'prv_abc',
      currency: 'USD',
      amountMinor: -5_000,
      lastUpdatedAt: new Date('2026-05-15T14:30:00.000Z'),
    });
    const controller = new BookingCommissionController(svc, buildEnv(), makeStore());
    const req = makeAuthedRequest('usr_admin');
    const result = await controller.getProviderPayableBalance('prv_abc', req);
    expect(result.amountMinor).toBe(-5_000);
  });
});

/**
 * Tenant-scope exempt-wrap contract (TS-020-followup-2b-platform-rollout).
 *
 * `recognizeBookingCompleted` is the only shared-secret-pinned internal
 * endpoint in this controller. It authenticates via the
 * `BOOKING_COMMISSION_INTERNAL_API_KEY_HEADER` rather than the
 * `AccessTokenGuard`, so the `TenantContextInterceptor` cannot seed a
 * scoped frame from a `request.requestContext` that does not exist.
 * Without an explicit exempt wrap, every Prisma operation downstream
 * (the four-line journal insert + the per-provider running balance
 * upsert) would hard-fail with `MissingRequestContextError` under the
 * `enforcement: 'enforce'` posture wired in `AppModule`.
 *
 * The admin endpoint (`getProviderPayableBalance`) is deliberately NOT
 * covered here — it sits behind `AccessTokenGuard` so the
 * `TenantContextInterceptor` seeds a scoped frame from the
 * access-token claims before the handler body runs.
 */
describe('BookingCommissionController tenant-scope exempt wrap (TS-020-followup-2b-platform-rollout)', () => {
  it('runs recognizeBookingCompleted inside an exempt frame with reason "internal-booking-completed"', async () => {
    const store = makeStore();
    let captured: TenantContextFrame | null = null;
    const svc = makeStubService();
    vi.mocked(svc.recognizeBookingCompleted).mockImplementation(async () => {
      captured = store.current();
      return { ok: true, value: okRecognizerOutput } as never;
    });
    const controller = new BookingCommissionController(svc, buildEnv(), store);
    const req = makeRequest({
      [BOOKING_COMMISSION_INTERNAL_API_KEY_HEADER]: 'b'.repeat(32),
    });

    await controller.recognizeBookingCompleted(validRequestBody, req);

    expect(captured).toEqual({
      kind: 'exempt',
      reason: 'internal-booking-completed',
    });
    expect(svc.recognizeBookingCompleted).toHaveBeenCalledTimes(1);
  });

  it('captures the frame on the 401 short-circuit branch (wrap encloses the shared-secret check)', async () => {
    const store = makeStore();
    let frameAtThrow: TenantContextFrame | null = null;
    const svc = makeStubService();
    const controller = new BookingCommissionController(svc, buildEnv(), store);
    const req = {
      header: () => {
        frameAtThrow = store.current();
        return undefined;
      },
    } as unknown as RequestWithContext;

    await expect(
      controller.recognizeBookingCompleted(validRequestBody, req),
    ).rejects.toBeInstanceOf(UnauthorizedException);

    expect(frameAtThrow).toEqual({
      kind: 'exempt',
      reason: 'internal-booking-completed',
    });
    expect(svc.recognizeBookingCompleted).not.toHaveBeenCalled();
  });

  it('does not leak the exempt frame outside the handler', async () => {
    const store = makeStore();
    const svc = makeStubService();
    vi.mocked(svc.recognizeBookingCompleted).mockResolvedValue({
      ok: true,
      value: okRecognizerOutput,
    } as never);
    const controller = new BookingCommissionController(svc, buildEnv(), store);
    const req = makeRequest({
      [BOOKING_COMMISSION_INTERNAL_API_KEY_HEADER]: 'b'.repeat(32),
    });

    expect(store.current()).toBeNull();
    await controller.recognizeBookingCompleted(validRequestBody, req);
    expect(store.current()).toBeNull();
  });
});
