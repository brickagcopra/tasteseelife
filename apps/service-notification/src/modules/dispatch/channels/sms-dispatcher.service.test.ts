import { describe, expect, it } from 'vitest';

import type { Env } from '../../../config/env';

import { SmsDispatcher } from './sms-dispatcher.service';
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
    recipientAddress: '+12025550100',
    fromAddress: '',
    fromName: '',
    rendered: {
      templateCode: 'otp',
      locale: 'en-US',
      kind: 'sms',
      version: 1,
      subject: null,
      bodyHtml: null,
      bodyText: 'Your code is 123456',
    },
    ...overrides,
  };
}

describe('SmsDispatcher', () => {
  it('returns stub-mode sent when Twilio credentials are missing', async () => {
    const d = new SmsDispatcher(makeEnv());
    const out = await d.send(makeInput());
    expect(out).toEqual({
      status: 'sent',
      providerMessageId: 'stub-disp_abc',
      liveMode: false,
    });
  });

  it('rejects a non-E.164 recipient address', async () => {
    const d = new SmsDispatcher(makeEnv());
    const out = await d.send(makeInput({ recipientAddress: '202-555-0100' }));
    expect(out.status).toBe('failed');
  });

  it('rejects a wrong rendered kind', async () => {
    const d = new SmsDispatcher(makeEnv());
    const out = await d.send(
      makeInput({
        rendered: {
          templateCode: 'welcome',
          locale: 'en-US',
          kind: 'email',
          version: 1,
          subject: 'hi',
          bodyHtml: '<p>hi</p>',
          bodyText: null,
        },
      }),
    );
    expect(out.status).toBe('failed');
  });

  it('rejects empty bodyText', async () => {
    const d = new SmsDispatcher(makeEnv());
    const out = await d.send(
      makeInput({
        rendered: {
          templateCode: 'otp',
          locale: 'en-US',
          kind: 'sms',
          version: 1,
          subject: null,
          bodyHtml: null,
          bodyText: null,
        },
      }),
    );
    expect(out.status).toBe('failed');
  });

  it('falls back to stub when credentials are partial', async () => {
    const d = new SmsDispatcher(makeEnv({ TWILIO_ACCOUNT_SID: 'AC' + 'x'.repeat(20) }));
    const out = await d.send(makeInput());
    expect(out.status).toBe('sent');
  });

  it('exposes channel = sms', () => {
    expect(new SmsDispatcher(makeEnv()).channel).toBe('sms');
  });

  it('FAILS rather than reporting sent when credentials are set but no SDK is wired', async () => {
    // TS-073-followup-1b. This branch used to return `sent` with a stub
    // provider id, so configuring Twilio moved the service from "obviously
    // sending nothing" to "recording every SMS as delivered while sending
    // nothing". No test covered it, which is how it survived.
    const d = new SmsDispatcher(
      makeEnv({
        TWILIO_ACCOUNT_SID: 'AC' + 'x'.repeat(20),
        TWILIO_AUTH_TOKEN: 't'.repeat(32),
        NOTIFICATION_SMS_FROM_NUMBER: '+15550001111',
      }),
    );
    const out = await d.send(makeInput());
    expect(out.status).toBe('failed');
    if (out.status === 'failed') expect(out.errorMessage).toContain('not wired');
  });
});
