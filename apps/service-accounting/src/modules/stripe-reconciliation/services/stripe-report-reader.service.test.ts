import { describe, expect, it } from 'vitest';

import type { Env } from '../../../config/env';

import {
  StripeReportReader,
  summarizeActivity,
  summarizeBalance,
} from './stripe-report-reader.service';

function buildEnv(overrides: Partial<Env> = {}): Env {
  return {
    NODE_ENV: 'test',
    PORT: 3015,
    LOG_LEVEL: 'info',
    DATABASE_URL: 'postgresql://u:p@localhost:5432/db',
    SERVICE_VERSION: 'test',
    OTEL_TRACES_ENABLED: false,
    OTEL_METRICS_ENABLED: false,
    JWT_ACCESS_SECRET: 'x'.repeat(32),
    INTERNAL_TRUST_SIGNING_SECRET: 't'.repeat(32),
    INTERNAL_TRUST_MAX_AGE_SECONDS: 60,
    JWT_ISSUER: 'taste-and-see/service-identity',
    JWT_AUDIENCE: 'taste-and-see/api',
    REDIS_URL: 'redis://localhost:6379',
    IDEMPOTENCY_TTL_SECONDS: 86_400,
    IDEMPOTENCY_IN_FLIGHT_TTL_SECONDS: 30,
    INTERNAL_POST_JOURNAL_API_KEY: 'k'.repeat(32),
    OUTBOX_CONSUMER_NAME: 'default',
    OUTBOX_STREAM_PREFIX: 'events',
    OUTBOX_CONSUMER_MAX_ATTEMPTS: 10,
    OUTBOX_CONSUMER_POLL_BLOCK_MS: 5000,
    OUTBOX_CONSUMER_RECLAIM_IDLE_MS: 60_000,
    OUTBOX_CONSUMER_POLL_INTERVAL_MS: 1000,
    STRIPE_API_VERSION: '2024-12-18.acacia',
    STRIPE_RECONCILIATION_TOLERANCE_MINOR: 0,
    ...overrides,
  } as Env;
}

describe('summarizeBalance', () => {
  it('sums available + pending for the requested currency only', () => {
    const balance = {
      available: [
        { amount: 10_000, currency: 'usd' },
        { amount: 999, currency: 'eur' },
      ],
      pending: [{ amount: 2_500, currency: 'usd' }],
    };
    expect(summarizeBalance(balance, 'usd')).toBe(12_500);
  });

  it('returns 0 when no entry matches the currency', () => {
    expect(summarizeBalance({ available: [], pending: [] }, 'usd')).toBe(0);
  });
});

describe('summarizeActivity', () => {
  it('sums net + counts transactions for the requested currency only', () => {
    const txns = [
      { net: 1_000, currency: 'usd' },
      { net: -250, currency: 'usd' },
      { net: 5_000, currency: 'eur' },
    ];
    expect(summarizeActivity(txns, 'usd')).toEqual({ netMinor: 750, count: 2 });
  });

  it('handles an empty stream', () => {
    expect(summarizeActivity([], 'usd')).toEqual({ netMinor: 0, count: 0 });
  });
});

describe('StripeReportReader (stub mode)', () => {
  it('is stub mode when no secret key is configured', async () => {
    const reader = new StripeReportReader(buildEnv());
    expect(reader.isLiveMode()).toBe(false);
    const report = await reader.read({
      start: new Date('2026-05-28T00:00:00.000Z'),
      end: new Date('2026-05-29T00:00:00.000Z'),
      currency: 'USD',
    });
    expect(report).toBeNull();
  });

  it('is stub mode for the explicit sk_test_stub_ sentinel even with a key set', async () => {
    const reader = new StripeReportReader(buildEnv({ STRIPE_SECRET_KEY: 'sk_test_stub_abc' }));
    expect(reader.isLiveMode()).toBe(false);
    expect(
      await reader.read({
        start: new Date('2026-05-28T00:00:00.000Z'),
        end: new Date('2026-05-29T00:00:00.000Z'),
        currency: 'USD',
      }),
    ).toBeNull();
  });

  it('reports live mode when a real secret key is configured', () => {
    const reader = new StripeReportReader(buildEnv({ STRIPE_SECRET_KEY: 'sk_test_realish_key' }));
    expect(reader.isLiveMode()).toBe(true);
  });
});
