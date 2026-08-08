import { ConflictException, NotFoundException, UnauthorizedException } from '@nestjs/common';
import type { RequestWithContext } from '@taste-and-see/nest-auth';
import { IDEMPOTENT_METADATA } from '@taste-and-see/nest-idempotency';
import { TenantContextStore } from '@taste-and-see/nest-prisma-tenant-scope';
import type { StripeReconciliationCheckRecord } from '@taste-and-see/contracts';
import { describe, expect, it, vi } from 'vitest';

import type { Env } from '../../../config/env';
import type {
  ListChecksOutput,
  ReconcileOutput,
  ResolveCheckResult,
  StripeReconciliationService,
} from '../services/stripe-reconciliation.service';

import {
  STRIPE_RECONCILIATION_INTERNAL_API_KEY_HEADER,
  StripeReconciliationController,
} from './stripe-reconciliation.controller';

const SECRET = 'b'.repeat(32);

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
    IDEMPOTENCY_TTL_SECONDS: 86_400,
    IDEMPOTENCY_IN_FLIGHT_TTL_SECONDS: 30,
    INTERNAL_POST_JOURNAL_API_KEY: SECRET,
    OUTBOX_CONSUMER_NAME: 'default',
    OUTBOX_STREAM_PREFIX: 'events',
    OUTBOX_CONSUMER_MAX_ATTEMPTS: 10,
    OUTBOX_CONSUMER_POLL_BLOCK_MS: 5000,
    OUTBOX_CONSUMER_RECLAIM_IDLE_MS: 60_000,
    OUTBOX_CONSUMER_POLL_INTERVAL_MS: 1000,
    STRIPE_API_VERSION: '2024-12-18.acacia',
    STRIPE_RECONCILIATION_TOLERANCE_MINOR: 0,
  } as Env;
}

function sampleCheck(
  overrides: Partial<StripeReconciliationCheckRecord> = {},
): StripeReconciliationCheckRecord {
  return {
    reconciliationDate: '2026-05-28',
    category: 'balance',
    status: 'matched',
    mode: 'live',
    currency: 'USD',
    expectedAmountMinor: 100_000,
    actualAmountMinor: 100_000,
    deltaAmountMinor: 0,
    toleranceAmountMinor: 0,
    stripeTransactionCount: null,
    windowStart: '2026-05-28T00:00:00.000Z',
    windowEnd: '2026-05-29T00:00:00.000Z',
    detail: 'matched',
    computedAt: '2026-05-29T03:00:00.000Z',
    resolvedAt: null,
    resolvedByUserId: null,
    resolutionNotes: null,
    ...overrides,
  };
}

interface Stubs {
  controller: StripeReconciliationController;
  reconcile: ReturnType<typeof vi.fn>;
  listChecks: ReturnType<typeof vi.fn>;
  resolveCheck: ReturnType<typeof vi.fn>;
}

function build(
  overrides: {
    reconcile?: ReconcileOutput;
    listChecks?: ListChecksOutput;
    resolveCheck?: ResolveCheckResult;
  } = {},
): Stubs {
  const reconcile = vi.fn(
    async (): Promise<ReconcileOutput> =>
      overrides.reconcile ?? {
        reconciliationDate: '2026-05-28',
        mode: 'live',
        checks: [sampleCheck()],
        openMismatchCount: 0,
      },
  );
  const listChecks = vi.fn(
    async (): Promise<ListChecksOutput> =>
      overrides.listChecks ?? { checks: [sampleCheck()], from: '2026-05-28', to: '2026-05-28' },
  );
  const resolveCheck = vi.fn(
    async (): Promise<ResolveCheckResult> =>
      overrides.resolveCheck ?? {
        ok: true,
        check: sampleCheck({ status: 'mismatch_resolved', resolvedByUserId: 'usr_admin' }),
      },
  );
  const service = { reconcile, listChecks, resolveCheck } as unknown as StripeReconciliationService;
  const controller = new StripeReconciliationController(
    service,
    buildEnv(),
    new TenantContextStore(),
  );
  return { controller, reconcile, listChecks, resolveCheck };
}

function makeRequest(headers: Record<string, string> = {}): RequestWithContext {
  return { header: (name: string) => headers[name.toLowerCase()] } as unknown as RequestWithContext;
}

function makeAuthedRequest(userId: string): RequestWithContext {
  const req = makeRequest();
  Object.assign(req, {
    requestContext: { userId, roles: [], tenantScope: { type: 'global' } },
  });
  return req;
}

describe('StripeReconciliationController.runInternal', () => {
  it('accepts the shared-secret header and returns the run summary', async () => {
    const { controller, reconcile } = build();
    const result = await controller.runInternal(
      {},
      makeRequest({ [STRIPE_RECONCILIATION_INTERNAL_API_KEY_HEADER]: SECRET }),
    );
    expect(result.reconciliationDate).toBe('2026-05-28');
    expect(result.openMismatchCount).toBe(0);
    expect(reconcile).toHaveBeenCalledTimes(1);
  });

  it('forwards an explicit asOf', async () => {
    const { controller, reconcile } = build();
    await controller.runInternal(
      { asOf: '2026-05-15T00:00:00.000Z' },
      makeRequest({ [STRIPE_RECONCILIATION_INTERNAL_API_KEY_HEADER]: SECRET }),
    );
    const arg = reconcile.mock.calls[0]?.[0] as { asOf?: Date };
    expect(arg.asOf?.toISOString()).toBe('2026-05-15T00:00:00.000Z');
  });

  it('omits asOf when the body has none', async () => {
    const { controller, reconcile } = build();
    await controller.runInternal(
      {},
      makeRequest({ [STRIPE_RECONCILIATION_INTERNAL_API_KEY_HEADER]: SECRET }),
    );
    expect(reconcile.mock.calls[0]?.[0]).toEqual({});
  });

  it('rejects with 401 when the shared secret is missing', async () => {
    const { controller, reconcile } = build();
    await expect(controller.runInternal({}, makeRequest())).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect(reconcile).not.toHaveBeenCalled();
  });

  it('rejects with 401 when the shared secret is wrong', async () => {
    const { controller, reconcile } = build();
    await expect(
      controller.runInternal(
        {},
        makeRequest({ [STRIPE_RECONCILIATION_INTERNAL_API_KEY_HEADER]: 'c'.repeat(32) }),
      ),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(reconcile).not.toHaveBeenCalled();
  });

  it('is marked @Idempotent()', () => {
    const flag = Reflect.getMetadata(
      IDEMPOTENT_METADATA,
      StripeReconciliationController.prototype.runInternal,
    );
    expect(flag).toBe(true);
  });
});

describe('StripeReconciliationController.runAdmin', () => {
  it('runs for an authenticated actor', async () => {
    const { controller, reconcile } = build();
    const result = await controller.runAdmin({}, makeAuthedRequest('usr_admin'));
    expect(result.reconciliationDate).toBe('2026-05-28');
    expect(reconcile).toHaveBeenCalledTimes(1);
  });

  it('rejects with 401 when there is no request context', async () => {
    const { controller, reconcile } = build();
    await expect(controller.runAdmin({}, makeRequest())).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect(reconcile).not.toHaveBeenCalled();
  });
});

describe('StripeReconciliationController.listChecks', () => {
  it('forwards filters and returns the mapped list', async () => {
    const { controller, listChecks } = build();
    const result = await controller.listChecks({ status: 'mismatch_open', from: '2026-05-01' });
    expect(result.checks).toHaveLength(1);
    expect(listChecks).toHaveBeenCalledWith({ status: 'mismatch_open', from: '2026-05-01' });
  });

  it('passes an empty filter through', async () => {
    const { controller, listChecks } = build();
    await controller.listChecks({});
    expect(listChecks).toHaveBeenCalledWith({});
  });
});

describe('StripeReconciliationController.resolveCheck', () => {
  it('resolves an open mismatch', async () => {
    const { controller, resolveCheck } = build();
    const result = await controller.resolveCheck(
      'chk_1',
      { resolutionNotes: 'Explained.' },
      makeAuthedRequest('usr_admin'),
    );
    expect(result.check.status).toBe('mismatch_resolved');
    expect(resolveCheck).toHaveBeenCalledWith({
      checkId: 'chk_1',
      actorUserId: 'usr_admin',
      resolutionNotes: 'Explained.',
    });
  });

  it('throws 404 when the check is not found', async () => {
    const { controller } = build({ resolveCheck: { ok: false, reason: 'not_found' } });
    await expect(
      controller.resolveCheck('nope', { resolutionNotes: 'x' }, makeAuthedRequest('usr_admin')),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('throws 409 when the check is not an open mismatch', async () => {
    const { controller } = build({ resolveCheck: { ok: false, reason: 'not_open' } });
    await expect(
      controller.resolveCheck('chk_1', { resolutionNotes: 'x' }, makeAuthedRequest('usr_admin')),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('rejects with 401 when there is no request context', async () => {
    const { controller, resolveCheck } = build();
    await expect(
      controller.resolveCheck('chk_1', { resolutionNotes: 'x' }, makeRequest()),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(resolveCheck).not.toHaveBeenCalled();
  });

  it('is marked @Idempotent()', () => {
    const flag = Reflect.getMetadata(
      IDEMPOTENT_METADATA,
      StripeReconciliationController.prototype.resolveCheck,
    );
    expect(flag).toBe(true);
  });
});
