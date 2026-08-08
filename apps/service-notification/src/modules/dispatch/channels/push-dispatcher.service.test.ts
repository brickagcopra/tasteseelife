import { describe, expect, it } from 'vitest';

import type { Env } from '../../../config/env';

import { PushDispatcher } from './push-dispatcher.service';
import type { ChannelDispatchInput } from './channel-dispatcher';

function makeEnv(overrides: Partial<Env> = {}): Env {
  return {
    NODE_ENV: 'test',
    PORT: 3017,
    LOG_LEVEL: 'info',
    DATABASE_URL: 'postgresql://x',
    SERVICE_VERSION: 'dev',
    OTEL_TRACES_ENABLED: false,
    OTEL_METRICS_ENABLED: false,
    JWT_ACCESS_SECRET: 'a'.repeat(32),
    INTERNAL_TRUST_SIGNING_SECRET: 't'.repeat(32),
    INTERNAL_TRUST_MAX_AGE_SECONDS: 60,
    JWT_ISSUER: 'iss',
    JWT_AUDIENCE: 'aud',
    NOTIFICATION_RENDER_HEADER_NAME: 'x-internal-api-key',
    NOTIFICATION_RENDER_API_KEY: 'k'.repeat(40),
    NOTIFICATION_DISPATCH_HEADER_NAME: 'x-internal-api-key',
    NOTIFICATION_DISPATCH_API_KEY: 'd'.repeat(40),
    NOTIFICATION_EMAIL_FROM_ADDRESS: 'no-reply@example.com',
    NOTIFICATION_EMAIL_FROM_NAME: 'Taste & See',
    // TS-042-followup-3a2 — the dunning-consumer env cluster.
    REDIS_URL: 'redis://localhost:6379',
    OUTBOX_CONSUMER_NAME: 'default',
    OUTBOX_STREAM_PREFIX: 'events',
    OUTBOX_CONSUMER_MAX_ATTEMPTS: 10,
    OUTBOX_CONSUMER_POLL_BLOCK_MS: 5_000,
    OUTBOX_CONSUMER_RECLAIM_IDLE_MS: 60_000,
    OUTBOX_CONSUMER_POLL_INTERVAL_MS: 1_000,
    DUNNING_NOTIFICATIONS_ENABLED: true,
    HOUSEHOLD_SERVICE_BASE_URL: 'http://service-household:3011',
    PROVIDER_SERVICE_BASE_URL: 'http://service-household:3011',
    PROVIDER_BILLING_CONTACTS_INTERNAL_API_KEY: 'p'.repeat(48),
    PROVIDER_BILLING_CONTACTS_INTERNAL_HEADER_NAME: 'x-provider-billing-contacts-internal-api-key',
    HOUSEHOLD_MEMBERSHIPS_INTERNAL_HEADER_NAME: 'x-internal-api-key',
    HOUSEHOLD_MEMBERSHIPS_INTERNAL_API_KEY: 'a'.repeat(32),
    IDENTITY_SERVICE_BASE_URL: 'http://service-identity:3010',
    IDENTITY_RECIPIENT_CONTACTS_HEADER_NAME: 'x-internal-api-key',
    IDENTITY_RECIPIENT_CONTACTS_API_KEY: 'b'.repeat(32),
    DUNNING_BILLING_URL: 'https://app.example.com/billing/invoices',
    DUNNING_APP_NAME: 'Taste & See',
    EMAIL_VERIFICATION_URL_BASE: 'http://localhost:3000/verify-email',
    EMAIL_VERIFICATION_NOTIFICATIONS_ENABLED: true,
    ...overrides,
  } as Env;
}

function makeInput(overrides: Partial<ChannelDispatchInput> = {}): ChannelDispatchInput {
  return {
    dispatchId: 'disp_abc',
    recipientAddress: 'device-token-abcdef123456789',
    fromAddress: '',
    fromName: '',
    rendered: {
      templateCode: 'booking_reminder',
      locale: 'en-US',
      kind: 'push',
      version: 1,
      subject: 'Reminder',
      bodyHtml: null,
      bodyText: "Don't forget your visit tomorrow.",
    },
    ...overrides,
  };
}

describe('PushDispatcher', () => {
  it('returns stub-mode sent when Firebase credentials are missing', async () => {
    const d = new PushDispatcher(makeEnv());
    const out = await d.send(makeInput());
    expect(out).toEqual({
      status: 'sent',
      providerMessageId: 'stub-disp_abc',
      liveMode: false,
    });
  });

  it('rejects a recipientAddress containing whitespace', async () => {
    const d = new PushDispatcher(makeEnv());
    const out = await d.send(makeInput({ recipientAddress: 'invalid token with spaces' }));
    expect(out.status).toBe('failed');
  });

  it('rejects an empty recipientAddress', async () => {
    const d = new PushDispatcher(makeEnv());
    const out = await d.send(makeInput({ recipientAddress: '' }));
    expect(out.status).toBe('failed');
  });

  it('rejects a wrong rendered kind', async () => {
    const d = new PushDispatcher(makeEnv());
    const out = await d.send(
      makeInput({
        rendered: {
          templateCode: 'welcome',
          locale: 'en-US',
          kind: 'sms',
          version: 1,
          subject: null,
          bodyHtml: null,
          bodyText: 'sms body',
        },
      }),
    );
    expect(out.status).toBe('failed');
  });

  it('exposes channel = push', () => {
    expect(new PushDispatcher(makeEnv()).channel).toBe('push');
  });

  it('FAILS rather than reporting sent when credentials are set but no SDK is wired', async () => {
    // TS-073-followup-1b — the same deleted lie as the SMS and email adapters.
    const d = new PushDispatcher(
      makeEnv({
        FIREBASE_SERVICE_ACCOUNT_B64: Buffer.from('{}').toString('base64'),
        FIREBASE_PROJECT_ID: 'taste-and-see-test',
      }),
    );
    const out = await d.send(makeInput());
    expect(out.status).toBe('failed');
    if (out.status === 'failed') expect(out.errorMessage).toContain('not wired');
  });
});
