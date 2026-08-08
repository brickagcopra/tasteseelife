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
import type { JournalPostingService, Result } from '../services/journal-posting.service';
import { JOURNAL_INTERNAL_API_KEY_HEADER, JournalsController } from './journals.controller';

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

function buildOkResponse(overrides: Record<string, unknown> = {}): {
  readonly ok: true;
  readonly value: Record<string, unknown>;
} {
  return {
    ok: true,
    value: {
      id: 'jrnl_abc',
      kind: 'subscription_activation',
      occurredAt: '2026-05-13T00:00:00.000Z',
      postedAt: '2026-05-13T00:00:01.000Z',
      sourceEventId: 'evt_abc',
      description: 'Tier 2 activated.',
      periodId: 'prd_2026-05',
      periodName: '2026-05',
      postedByUserId: null,
      reversedJournalId: null,
      reversedByJournalId: null,
      context: {},
      lines: [
        {
          id: 'jl_1',
          accountId: 'coa_cash',
          accountCode: '1000',
          debitMinor: 29_900,
          creditMinor: 0,
          currency: 'USD',
        },
        {
          id: 'jl_2',
          accountId: 'coa_deferred',
          accountCode: '2000.family.tier2',
          debitMinor: 0,
          creditMinor: 29_900,
          currency: 'USD',
        },
      ],
      ...overrides,
    },
  };
}

function makeStubService(): JournalPostingService {
  return {
    post: vi.fn(),
    postManualAdjustment: vi.fn(),
    reverse: vi.fn(),
  } as unknown as JournalPostingService;
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
  // `requestContext` is optional under `exactOptionalPropertyTypes`;
  // the controller reads it via `request.requestContext` and falls
  // back to 401 when missing.
  Object.assign(req, {
    requestContext: {
      userId,
      roles: [],
      tenantScope: { type: 'global' },
    },
  });
  return req;
}

const validBody = {
  kind: 'subscription_activation' as const,
  occurredAt: '2026-05-13T00:00:00.000Z',
  sourceEventId: 'evt_abc',
  description: 'Tier 2 activated.',
  lines: [
    { accountCode: '1000', debitMinor: 29_900, currency: 'USD' as const },
    {
      accountCode: '2000.family.tier2',
      creditMinor: 29_900,
      currency: 'USD' as const,
    },
  ],
};

describe('JournalsController.postSystemJournal', () => {
  it('accepts the shared-secret header and returns the journal response', async () => {
    const service = makeStubService();
    vi.mocked(service.post).mockResolvedValue(buildOkResponse() as never);
    const controller = new JournalsController(service, buildEnv(), makeStore());

    const req = makeRequest({
      [JOURNAL_INTERNAL_API_KEY_HEADER]: 'b'.repeat(32),
    });
    const result = await controller.postSystemJournal(validBody, req);
    expect(result.id).toBe('jrnl_abc');
    expect(service.post).toHaveBeenCalledWith(validBody, null);
  });

  it('rejects with 401 when the shared-secret header is missing', async () => {
    const service = makeStubService();
    const controller = new JournalsController(service, buildEnv(), makeStore());
    const req = makeRequest();
    await expect(controller.postSystemJournal(validBody, req)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect(service.post).not.toHaveBeenCalled();
  });

  it('rejects with 401 when the shared-secret header is wrong', async () => {
    const service = makeStubService();
    const controller = new JournalsController(service, buildEnv(), makeStore());
    const req = makeRequest({
      [JOURNAL_INTERNAL_API_KEY_HEADER]: 'c'.repeat(32),
    });
    await expect(controller.postSystemJournal(validBody, req)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('maps `journal_unbalanced` to a 422', async () => {
    const service = makeStubService();
    vi.mocked(service.post).mockResolvedValue({
      ok: false,
      failure: {
        kind: 'journal_unbalanced',
        debitTotalMinor: 29_900,
        creditTotalMinor: 29_800,
      },
    } as Result<never, never>);
    const controller = new JournalsController(service, buildEnv(), makeStore());
    const req = makeRequest({
      [JOURNAL_INTERNAL_API_KEY_HEADER]: 'b'.repeat(32),
    });
    await expect(controller.postSystemJournal(validBody, req)).rejects.toBeInstanceOf(
      UnprocessableEntityException,
    );
  });

  it('maps `account_not_found` to a 404', async () => {
    const service = makeStubService();
    vi.mocked(service.post).mockResolvedValue({
      ok: false,
      failure: { kind: 'account_not_found', accountCode: '9999' },
    } as Result<never, never>);
    const controller = new JournalsController(service, buildEnv(), makeStore());
    const req = makeRequest({
      [JOURNAL_INTERNAL_API_KEY_HEADER]: 'b'.repeat(32),
    });
    await expect(controller.postSystemJournal(validBody, req)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('maps `account_inactive` to a 422', async () => {
    const service = makeStubService();
    vi.mocked(service.post).mockResolvedValue({
      ok: false,
      failure: { kind: 'account_inactive', accountCode: '4099' },
    } as Result<never, never>);
    const controller = new JournalsController(service, buildEnv(), makeStore());
    const req = makeRequest({
      [JOURNAL_INTERNAL_API_KEY_HEADER]: 'b'.repeat(32),
    });
    await expect(controller.postSystemJournal(validBody, req)).rejects.toBeInstanceOf(
      UnprocessableEntityException,
    );
  });

  it('maps `period_closed` to a 422', async () => {
    const service = makeStubService();
    vi.mocked(service.post).mockResolvedValue({
      ok: false,
      failure: {
        kind: 'period_closed',
        periodId: 'prd_2026-04',
        periodName: '2026-04',
      },
    } as Result<never, never>);
    const controller = new JournalsController(service, buildEnv(), makeStore());
    const req = makeRequest({
      [JOURNAL_INTERNAL_API_KEY_HEADER]: 'b'.repeat(32),
    });
    await expect(controller.postSystemJournal(validBody, req)).rejects.toBeInstanceOf(
      UnprocessableEntityException,
    );
  });

  it('maps `mixed_currency` to a 422', async () => {
    const service = makeStubService();
    vi.mocked(service.post).mockResolvedValue({
      ok: false,
      failure: { kind: 'mixed_currency', currencies: ['EUR', 'USD'] },
    } as Result<never, never>);
    const controller = new JournalsController(service, buildEnv(), makeStore());
    const req = makeRequest({
      [JOURNAL_INTERNAL_API_KEY_HEADER]: 'b'.repeat(32),
    });
    await expect(controller.postSystemJournal(validBody, req)).rejects.toBeInstanceOf(
      UnprocessableEntityException,
    );
  });

  it('is marked @Idempotent()', () => {
    const flag = Reflect.getMetadata(
      IDEMPOTENT_METADATA,
      JournalsController.prototype.postSystemJournal,
    );
    expect(flag).toBe(true);
  });
});

describe('JournalsController.postManualAdjustment', () => {
  const validAdjBody = {
    occurredAt: '2026-05-13T00:00:00.000Z',
    sourceEventId: 'manual_001',
    description: 'Off-platform check cleared.',
    reasonCode: 'OFF_PLATFORM_REFUND',
    lines: [
      { accountCode: '4520', debitMinor: 9_900, currency: 'USD' as const },
      { accountCode: '1000', creditMinor: 9_900, currency: 'USD' as const },
    ],
  };

  it('passes the body + actor through to the service', async () => {
    const service = makeStubService();
    vi.mocked(service.postManualAdjustment).mockResolvedValue(
      buildOkResponse({ kind: 'manual_adjustment' }) as never,
    );
    const controller = new JournalsController(service, buildEnv(), makeStore());
    const req = makeAuthedRequest('usr_admin_finance');

    const result = await controller.postManualAdjustment(validAdjBody, req);
    expect(result.id).toBe('jrnl_abc');
    expect(service.postManualAdjustment).toHaveBeenCalledWith(validAdjBody, 'usr_admin_finance');
  });

  it('rejects with 401 when no requestContext is present', async () => {
    const service = makeStubService();
    const controller = new JournalsController(service, buildEnv(), makeStore());
    const req = makeRequest();
    await expect(controller.postManualAdjustment(validAdjBody, req)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('is marked @Idempotent()', () => {
    const flag = Reflect.getMetadata(
      IDEMPOTENT_METADATA,
      JournalsController.prototype.postManualAdjustment,
    );
    expect(flag).toBe(true);
  });
});

describe('JournalsController.reverseJournal', () => {
  const validRevBody = {
    sourceEventId: 'reversal_evt_001',
    occurredAt: '2026-05-15T00:00:00.000Z',
    reasonCode: 'BOOKING_DISPUTE_REFUND',
  };

  it('passes the body + actor through to the service', async () => {
    const service = makeStubService();
    vi.mocked(service.reverse).mockResolvedValue(buildOkResponse({ kind: 'reversal' }) as never);
    const controller = new JournalsController(service, buildEnv(), makeStore());
    const req = makeAuthedRequest('usr_admin_finance');

    const result = await controller.reverseJournal('jrnl_orig', validRevBody, req);
    expect(result.id).toBe('jrnl_abc');
    expect(service.reverse).toHaveBeenCalledWith('jrnl_orig', validRevBody, 'usr_admin_finance');
  });

  it('maps `journal_not_found` to a 404', async () => {
    const service = makeStubService();
    vi.mocked(service.reverse).mockResolvedValue({
      ok: false,
      failure: { kind: 'journal_not_found', journalId: 'jrnl_missing' },
    } as Result<never, never>);
    const controller = new JournalsController(service, buildEnv(), makeStore());
    const req = makeAuthedRequest('usr_admin_finance');
    await expect(
      controller.reverseJournal('jrnl_missing', validRevBody, req),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('maps `already_reversed` to a 409', async () => {
    const service = makeStubService();
    vi.mocked(service.reverse).mockResolvedValue({
      ok: false,
      failure: {
        kind: 'already_reversed',
        journalId: 'jrnl_orig',
        reversedByJournalId: 'jrnl_existing_reversal',
      },
    } as Result<never, never>);
    const controller = new JournalsController(service, buildEnv(), makeStore());
    const req = makeAuthedRequest('usr_admin_finance');
    await expect(controller.reverseJournal('jrnl_orig', validRevBody, req)).rejects.toBeInstanceOf(
      ConflictException,
    );
  });

  it('maps `account_inactive` (downstream PostJournalFailure) to a 422', async () => {
    const service = makeStubService();
    vi.mocked(service.reverse).mockResolvedValue({
      ok: false,
      failure: { kind: 'account_inactive', accountCode: '4099' },
    } as Result<never, never>);
    const controller = new JournalsController(service, buildEnv(), makeStore());
    const req = makeAuthedRequest('usr_admin_finance');
    await expect(controller.reverseJournal('jrnl_orig', validRevBody, req)).rejects.toBeInstanceOf(
      UnprocessableEntityException,
    );
  });

  it('is marked @Idempotent()', () => {
    const flag = Reflect.getMetadata(
      IDEMPOTENT_METADATA,
      JournalsController.prototype.reverseJournal,
    );
    expect(flag).toBe(true);
  });
});

/**
 * Tenant-scope exempt-wrap contract (TS-020-followup-2b-platform-rollout).
 *
 * `postSystemJournal` is the only shared-secret-pinned internal
 * endpoint in this controller. It authenticates via the
 * `JOURNAL_INTERNAL_API_KEY_HEADER` rather than the `AccessTokenGuard`,
 * so the `TenantContextInterceptor` cannot seed a scoped frame from a
 * `request.requestContext` that does not exist. Without an explicit
 * exempt wrap, every Prisma operation downstream of this handler
 * (the chart-of-accounts lookup + period-membership check + the
 * journal + journal-lines insert) would hard-fail with
 * `MissingRequestContextError` under the `enforcement: 'enforce'`
 * posture wired in `AppModule`.
 *
 * These tests pin the wrap contract by passing a real
 * `TenantContextStore` and a fake `JournalPostingService` that
 * captures `store.current()` at call time. The captured frame must be
 * `{ kind: 'exempt', reason: 'internal-journals-post' }`.
 *
 * The two admin endpoints (`postManualAdjustment` + `reverseJournal`)
 * are deliberately NOT covered here — they sit behind
 * `AccessTokenGuard` so the `TenantContextInterceptor` seeds a scoped
 * frame from the access-token claims before the handler body runs.
 */
describe('JournalsController tenant-scope exempt wrap (TS-020-followup-2b-platform-rollout)', () => {
  it('runs postSystemJournal inside an exempt frame with reason "internal-journals-post"', async () => {
    const store = makeStore();
    let captured: TenantContextFrame | null = null;
    const service = makeStubService();
    vi.mocked(service.post).mockImplementation(async () => {
      captured = store.current();
      return buildOkResponse() as never;
    });
    const controller = new JournalsController(service, buildEnv(), store);
    const req = makeRequest({
      [JOURNAL_INTERNAL_API_KEY_HEADER]: 'b'.repeat(32),
    });

    await controller.postSystemJournal(validBody, req);

    expect(captured).toEqual({
      kind: 'exempt',
      reason: 'internal-journals-post',
    });
    expect(service.post).toHaveBeenCalledTimes(1);
  });

  it('captures the frame on the 401 short-circuit branch (wrap encloses the shared-secret check)', async () => {
    const store = makeStore();
    let frameAtThrow: TenantContextFrame | null = null;
    const service = makeStubService();
    const controller = new JournalsController(service, buildEnv(), store);
    const req = {
      header: () => {
        frameAtThrow = store.current();
        return undefined;
      },
    } as unknown as RequestWithContext;

    await expect(controller.postSystemJournal(validBody, req)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );

    expect(frameAtThrow).toEqual({
      kind: 'exempt',
      reason: 'internal-journals-post',
    });
    expect(service.post).not.toHaveBeenCalled();
  });

  it('does not leak the exempt frame outside the handler', async () => {
    const store = makeStore();
    const service = makeStubService();
    vi.mocked(service.post).mockResolvedValue(buildOkResponse() as never);
    const controller = new JournalsController(service, buildEnv(), store);
    const req = makeRequest({
      [JOURNAL_INTERNAL_API_KEY_HEADER]: 'b'.repeat(32),
    });

    expect(store.current()).toBeNull();
    await controller.postSystemJournal(validBody, req);
    expect(store.current()).toBeNull();
  });
});
