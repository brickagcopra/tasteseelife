import { describe, expect, it } from 'vitest';

import type { Env } from '../../../config/env';

import { __testing, StripeConnectService } from './stripe-connect.service';

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

describe('StripeConnectService (stub mode)', () => {
  it('reports stub mode when STRIPE_SECRET_KEY is absent', () => {
    const service = new StripeConnectService(buildEnv());
    expect(service.isLiveMode()).toBe(false);
  });

  it('reports stub mode for the sk_test_stub_ sentinel', () => {
    const service = new StripeConnectService(
      buildEnv({ STRIPE_SECRET_KEY: 'sk_test_stub_anything' }),
    );
    expect(service.isLiveMode()).toBe(false);
  });

  it('reports live mode for a real-looking secret', () => {
    const service = new StripeConnectService(
      buildEnv({ STRIPE_SECRET_KEY: 'sk_test_live_abc123' }),
    );
    expect(service.isLiveMode()).toBe(true);
  });

  it('createConnectAccount returns a deterministic stub account in stub mode', async () => {
    const service = new StripeConnectService(buildEnv());
    const out = await service.createConnectAccount({
      providerId: 'pr_abc',
      country: 'US',
      defaultCurrency: 'USD',
    });

    expect(out.stripeAccountId).toBe('acct_stub_pr_abc');
    expect(out.country).toBe('US');
    expect(out.defaultCurrency).toBe('USD');
    expect(out.chargesEnabled).toBe(false);
    expect(out.payoutsEnabled).toBe(false);
    expect(out.detailsSubmitted).toBe(false);
    expect(out.requirementsCurrentlyDue.length).toBeGreaterThan(0);
    expect(out.requirementsPastDue).toHaveLength(0);
    expect(out.disabledReason).toBeNull();
    expect(out.liveMode).toBe(false);
  });

  it('createConnectAccount is deterministic across repeated calls', async () => {
    const service = new StripeConnectService(buildEnv());
    const a = await service.createConnectAccount({
      providerId: 'pr_xyz',
      country: 'US',
      defaultCurrency: 'USD',
    });
    const b = await service.createConnectAccount({
      providerId: 'pr_xyz',
      country: 'US',
      defaultCurrency: 'USD',
    });
    expect(a.stripeAccountId).toBe(b.stripeAccountId);
  });

  it('createConnectAccount produces a different id for a different provider', async () => {
    const service = new StripeConnectService(buildEnv());
    const a = await service.createConnectAccount({
      providerId: 'pr_a',
      country: 'US',
      defaultCurrency: 'USD',
    });
    const b = await service.createConnectAccount({
      providerId: 'pr_b',
      country: 'US',
      defaultCurrency: 'USD',
    });
    expect(a.stripeAccountId).not.toBe(b.stripeAccountId);
  });

  it('createAccountLink returns a stub URL with the supplied kind + ~10 min expiry', async () => {
    const before = Date.now();
    const service = new StripeConnectService(buildEnv());
    const link = await service.createAccountLink({
      stripeAccountId: 'acct_stub_pr_abc',
      kind: 'account_onboarding',
      refreshUrl: 'https://app.example.com/r',
      returnUrl: 'https://app.example.com/d',
    });
    const after = Date.now();

    expect(link.url.startsWith('https://stub.example.test/account_onboarding/')).toBe(true);
    expect(link.url.endsWith('acct_stub_pr_abc')).toBe(true);
    expect(link.liveMode).toBe(false);
    const expiryMs = link.expiresAt.getTime();
    expect(expiryMs).toBeGreaterThanOrEqual(before + 9 * 60 * 1000);
    expect(expiryMs).toBeLessThanOrEqual(after + 11 * 60 * 1000);
  });

  it('createAccountLink honours a custom STRIPE_STUB_ONBOARDING_BASE_URL', async () => {
    const service = new StripeConnectService(
      buildEnv({ STRIPE_STUB_ONBOARDING_BASE_URL: 'https://internal.test/connect' }),
    );
    const link = await service.createAccountLink({
      stripeAccountId: 'acct_stub_pr_a',
      kind: 'account_update',
      refreshUrl: 'https://app.example.com/r',
      returnUrl: 'https://app.example.com/d',
    });
    expect(link.url).toBe('https://internal.test/connect/account_update/acct_stub_pr_a');
  });

  it('buildStubAccountId truncates + hashes provider ids longer than the column cap', () => {
    const long = 'pr_'.padEnd(64, 'x');
    const id = __testing.buildStubAccountId(long);
    expect(id.length).toBeLessThanOrEqual(40);
    expect(id.startsWith('acct_stub_')).toBe(true);
    // Idempotent.
    expect(__testing.buildStubAccountId(long)).toBe(id);
  });

  it('buildStubAccountId yields different ids for different long providers that share a prefix', () => {
    const a = `pr_${'x'.repeat(40)}_a`;
    const b = `pr_${'x'.repeat(40)}_b`;
    const idA = __testing.buildStubAccountId(a);
    const idB = __testing.buildStubAccountId(b);
    expect(idA).not.toBe(idB);
  });

  it('createConnectAccount in live mode logs [live-pending] and returns a stub-shaped account', async () => {
    // Live mode is gated behind a real secret; until TS-090-followup-1
    // lands, the live path still falls back to the stub generator.
    const service = new StripeConnectService(buildEnv({ STRIPE_SECRET_KEY: 'sk_test_live_abc' }));
    expect(service.isLiveMode()).toBe(true);
    const out = await service.createConnectAccount({
      providerId: 'pr_live',
      country: 'US',
      defaultCurrency: 'USD',
    });
    expect(out.stripeAccountId).toBe('acct_stub_pr_live');
    expect(out.liveMode).toBe(false);
  });
});
