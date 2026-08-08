import { describe, expect, it } from 'vitest';

import type { Env } from '../../../config/env';

import { EmailDispatcher } from './email-dispatcher.service';
import type { ChannelDispatchInput } from './channel-dispatcher';
import type { PostmarkEmailClient } from './postmark.constants';

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
    recipientAddress: 'recipient@example.com',
    fromAddress: 'no-reply@example.com',
    fromName: 'Taste & See',
    rendered: {
      templateCode: 'welcome',
      locale: 'en-US',
      kind: 'email',
      version: 1,
      subject: 'Welcome!',
      bodyHtml: '<p>Hi</p>',
      bodyText: 'Hi',
    },
    ...overrides,
  };
}

describe('EmailDispatcher', () => {
  it('returns a stub-mode sent outcome when POSTMARK_SERVER_TOKEN is missing', async () => {
    const d = new EmailDispatcher(makeEnv(), null);
    const out = await d.send(makeInput());
    expect(out).toEqual({
      status: 'sent',
      providerMessageId: 'stub-disp_abc',
      liveMode: false,
    });
  });

  it('FAILS rather than reporting sent when the token is set but no client was provided', async () => {
    // The defect TS-073-followup-1 existed to delete: this branch used to
    // return `sent` with a stub id, so configuring the credential moved the
    // platform from "obviously sending nothing" to "recording every
    // notification as delivered while sending nothing" — a `sent` row in
    // `notification_dispatches` for mail that never existed.
    const d = new EmailDispatcher(makeEnv({ POSTMARK_SERVER_TOKEN: 'pm-token' }), null);
    const out = await d.send(makeInput());
    expect(out.status).toBe('failed');
  });

  it('rejects malformed recipient addresses', async () => {
    const d = new EmailDispatcher(makeEnv(), null);
    const out = await d.send(makeInput({ recipientAddress: 'not-an-email' }));
    expect(out.status).toBe('failed');
  });

  it('rejects a wrong rendered kind', async () => {
    const d = new EmailDispatcher(makeEnv(), null);
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

  it('exposes channel = email', () => {
    expect(new EmailDispatcher(makeEnv(), null).channel).toBe('email');
  });
});

/**
 * Live-mode tests (TS-073-followup-1). The Postmark client is a fake, so
 * nothing opens a socket — that is the whole reason the client is injected
 * rather than constructed inside the adapter.
 */
describe('EmailDispatcher — live Postmark mode', () => {
  const LIVE_ENV = { POSTMARK_SERVER_TOKEN: 'pm-token' } as const;

  /** A complete Postmark success response — the SDK type requires all four. */
  function sentResponse(messageId: string): Awaited<ReturnType<PostmarkEmailClient['sendEmail']>> {
    return {
      MessageID: messageId,
      SubmittedAt: '2026-08-01T00:00:00Z',
      To: 'recipient@example.com',
      ErrorCode: 0,
      Message: 'OK',
    };
  }

  function makeClient(impl: PostmarkEmailClient['sendEmail']): {
    client: PostmarkEmailClient;
    calls: unknown[];
  } {
    const calls: unknown[] = [];
    const client = {
      sendEmail: (async (payload: unknown) => {
        calls.push(payload);
        return impl(payload as never);
      }) as PostmarkEmailClient['sendEmail'],
    };
    return { client, calls };
  }

  it('sends through Postmark and returns the real MessageID with liveMode true', async () => {
    const { client, calls } = makeClient((async () =>
      sentResponse('pm-msg-123')) as PostmarkEmailClient['sendEmail']);
    const d = new EmailDispatcher(makeEnv(LIVE_ENV), client);

    const out = await d.send(makeInput());

    expect(out).toEqual({
      status: 'sent',
      providerMessageId: 'pm-msg-123',
      liveMode: true,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      From: '"Taste & See" <no-reply@example.com>',
      To: 'recipient@example.com',
      Subject: 'Welcome!',
      HtmlBody: '<p>Hi</p>',
      TextBody: 'Hi',
      // Pinned, not derived: sending transactional mail on a broadcast
      // stream puts a password reset behind a bulk reputation.
      MessageStream: 'outbound',
    });
  });

  it('omits a null body rather than sending an empty one', async () => {
    const { client, calls } = makeClient((async () =>
      sentResponse('pm-msg-2')) as PostmarkEmailClient['sendEmail']);
    const d = new EmailDispatcher(makeEnv(LIVE_ENV), client);

    await d.send(
      makeInput({
        rendered: {
          templateCode: 'welcome',
          locale: 'en-US',
          kind: 'email',
          version: 1,
          subject: 'Hi',
          bodyHtml: '<p>Hi</p>',
          bodyText: null,
        },
      }),
    );

    expect(calls[0]).not.toHaveProperty('TextBody');
    expect(calls[0]).toHaveProperty('HtmlBody');
  });

  it('refuses a template that rendered no body at all, without calling Postmark', async () => {
    // Naming the real fault here beats a 422 whose ErrorCode would classify
    // as transient and be retried forever against a template that will never
    // produce a body.
    const { client, calls } = makeClient((async () =>
      sentResponse('never')) as PostmarkEmailClient['sendEmail']);
    const d = new EmailDispatcher(makeEnv(LIVE_ENV), client);

    const out = await d.send(
      makeInput({
        rendered: {
          templateCode: 'empty-template',
          locale: 'en-US',
          kind: 'email',
          version: 1,
          subject: 'Hi',
          bodyHtml: null,
          bodyText: null,
        },
      }),
    );

    expect(out.status).toBe('failed');
    if (out.status === 'failed') expect(out.errorMessage).toContain('empty-template');
    expect(calls).toHaveLength(0);
  });

  it('classifies ErrorCode 300 as a permanent invalid-address failure', async () => {
    const { client } = makeClient((async () => {
      throw Object.assign(new Error('bad address'), { ErrorCode: 300, statusCode: 422 });
    }) as PostmarkEmailClient['sendEmail']);
    const d = new EmailDispatcher(makeEnv(LIVE_ENV), client);

    const out = await d.send(makeInput());
    expect(out.status).toBe('failed');
    if (out.status === 'failed') expect(out.errorMessage).toContain('invalid');
  });

  it('classifies ErrorCode 406 as a suppressed (inactive) recipient', async () => {
    const { client } = makeClient((async () => {
      throw Object.assign(new Error('inactive'), { ErrorCode: 406, statusCode: 422 });
    }) as PostmarkEmailClient['sendEmail']);
    const d = new EmailDispatcher(makeEnv(LIVE_ENV), client);

    const out = await d.send(makeInput());
    expect(out.status).toBe('failed');
    if (out.status === 'failed') expect(out.errorMessage).toContain('inactive');
  });

  it('treats a 5xx as transient', async () => {
    const { client } = makeClient((async () => {
      throw Object.assign(new Error('boom'), { statusCode: 503 });
    }) as PostmarkEmailClient['sendEmail']);
    const d = new EmailDispatcher(makeEnv(LIVE_ENV), client);

    const out = await d.send(makeInput());
    expect(out.status).toBe('failed');
    if (out.status === 'failed') expect(out.errorMessage).toContain('503');
  });

  it('defaults an unrecognised failure to transient, not permanent', async () => {
    // Erring this way wastes a retry; erring the other way abandons a message
    // the platform owes someone.
    const { client } = makeClient((async () => {
      throw new Error('socket hang up');
    }) as PostmarkEmailClient['sendEmail']);
    const d = new EmailDispatcher(makeEnv(LIVE_ENV), client);

    const out = await d.send(makeInput());
    expect(out.status).toBe('failed');
    if (out.status === 'failed') expect(out.errorMessage).toContain('postmark send failed');
  });

  it('never puts the recipient address in the persisted error message', async () => {
    // `errorMessage` is written to `notification_dispatches` and read in admin
    // surfaces; the address is already its own column there (§3.9).
    const { client } = makeClient((async () => {
      throw Object.assign(new Error('recipient@example.com is bad'), {
        ErrorCode: 300,
        statusCode: 422,
      });
    }) as PostmarkEmailClient['sendEmail']);
    const d = new EmailDispatcher(makeEnv(LIVE_ENV), client);

    const out = await d.send(makeInput());
    if (out.status === 'failed') expect(out.errorMessage).not.toContain('recipient@example.com');
  });

  it('strips quotes from the From display name rather than breaking the header', async () => {
    const { client, calls } = makeClient((async () =>
      sentResponse('pm-msg-3')) as PostmarkEmailClient['sendEmail']);
    const d = new EmailDispatcher(makeEnv(LIVE_ENV), client);

    await d.send(makeInput({ fromName: 'Taste "&" See\\' }));
    expect(calls[0]).toMatchObject({ From: '"Taste & See" <no-reply@example.com>' });
  });
});
