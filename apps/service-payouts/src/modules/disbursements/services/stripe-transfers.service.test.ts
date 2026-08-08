import { describe, expect, it } from 'vitest';

import type { Env } from '../../../config/env';

import { __testing, StripeTransfersService } from './stripe-transfers.service';

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

describe('StripeTransfersService (stub mode)', () => {
  it('reports stub mode when STRIPE_SECRET_KEY is absent', () => {
    const service = new StripeTransfersService(buildEnv());
    expect(service.isLiveMode()).toBe(false);
  });

  it('returns deterministic transfer ids for the same disbursement id', async () => {
    const service = new StripeTransfersService(buildEnv());
    const a = await service.createTransfer({
      disbursementId: 'd_abc',
      destinationStripeAccountId: 'acct_stub_pr_abc',
      amountMinor: 10_000,
      currency: 'USD',
      transferGroup: 'payout:d_abc',
      idempotencyKey: 'tr:d_abc',
    });
    const b = await service.createTransfer({
      disbursementId: 'd_abc',
      destinationStripeAccountId: 'acct_stub_pr_abc',
      amountMinor: 10_000,
      currency: 'USD',
      transferGroup: 'payout:d_abc',
      idempotencyKey: 'tr:d_abc',
    });
    expect(a.stripeTransferId).toBe('tr_stub_d_abc');
    expect(b.stripeTransferId).toBe(a.stripeTransferId);
    expect(a.liveMode).toBe(false);
  });

  it('returns different ids for different disbursement ids', async () => {
    const service = new StripeTransfersService(buildEnv());
    const a = await service.createTransfer({
      disbursementId: 'd_abc',
      destinationStripeAccountId: 'acct_stub_pr_abc',
      amountMinor: 10_000,
      currency: 'USD',
      transferGroup: 'payout:d_abc',
      idempotencyKey: 'tr:d_abc',
    });
    const b = await service.createTransfer({
      disbursementId: 'd_def',
      destinationStripeAccountId: 'acct_stub_pr_abc',
      amountMinor: 10_000,
      currency: 'USD',
      transferGroup: 'payout:d_def',
      idempotencyKey: 'tr:d_def',
    });
    expect(a.stripeTransferId).not.toBe(b.stripeTransferId);
  });

  it('truncates excessively long disbursement ids with a hash suffix', () => {
    const longId = 'd_' + 'x'.repeat(70);
    const stub = __testing.buildStubTransferId(longId);
    expect(stub.length).toBeLessThanOrEqual(64);
    expect(stub.startsWith('tr_stub_')).toBe(true);
  });

  it('falls back to the stub generator in live mode (TS-091-followup-1)', async () => {
    const service = new StripeTransfersService(
      buildEnv({ STRIPE_SECRET_KEY: 'sk_test_live_xxxxxx' }),
    );
    expect(service.isLiveMode()).toBe(true);
    const out = await service.createTransfer({
      disbursementId: 'd_xyz',
      destinationStripeAccountId: 'acct_real_xyz',
      amountMinor: 5_000,
      currency: 'USD',
      transferGroup: 'payout:d_xyz',
      idempotencyKey: 'tr:d_xyz',
    });
    // Live wiring deferred → falls back to stub deterministically.
    expect(out.stripeTransferId).toBe('tr_stub_d_xyz');
    expect(out.liveMode).toBe(false);
  });

  it('forces stub mode when the sk_test_stub_* sentinel is set', () => {
    const service = new StripeTransfersService(
      buildEnv({ STRIPE_SECRET_KEY: 'sk_test_stub_force' }),
    );
    expect(service.isLiveMode()).toBe(false);
  });
});
