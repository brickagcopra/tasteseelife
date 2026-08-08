import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

import type { Env } from '../../config/env';
import type { DispatchOrchestratorService } from '../dispatch/services/dispatch-orchestrator.service';

import { EmailVerificationMailerService } from './email-verification-mailer.service';

const URL_BASE = 'https://app.tasteandsee.example.com/verify-email';
const TOKEN = 'tok_live_single_use_secret_value_abc123';

interface FakeDispatcher {
  dispatch: ReturnType<typeof vi.fn>;
}

function buildSvc(overrides: Partial<Env> = {}): {
  service: EmailVerificationMailerService;
  dispatcher: FakeDispatcher;
} {
  const dispatcher: FakeDispatcher = {
    dispatch: vi.fn().mockResolvedValue({ replayed: false }),
  };
  const service = new EmailVerificationMailerService(
    dispatcher as unknown as DispatchOrchestratorService,
    {
      EMAIL_VERIFICATION_URL_BASE: URL_BASE,
      DUNNING_APP_NAME: 'Taste & See',
      ...overrides,
    } as unknown as Env,
  );
  return { service, dispatcher };
}

const NOW = new Date('2026-08-02T12:00:00.000Z');

function input(overrides: Record<string, unknown> = {}) {
  return {
    eventId: 'evt_abc',
    userId: 'usr_new',
    email: 'someone@example.org',
    token: TOKEN,
    occurredAt: '2026-08-02T12:00:00.000Z',
    expiresAt: '2026-08-03T12:00:00.000Z',
    isResend: false,
    ...overrides,
  } as Parameters<EmailVerificationMailerService['deliver']>[0];
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('EmailVerificationMailerService.deliver', () => {
  it('dispatches the verification template to the address on the event', async () => {
    const { service, dispatcher } = buildSvc();

    const outcome = await service.deliver(input());

    expect(outcome).toEqual({ kind: 'sent', replayed: false });
    const call = dispatcher.dispatch.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(call['templateCode']).toBe('account-email-verification');
    expect(call['channel']).toBe('email');
    // From the EVENT — resolving it would mean reading identity.users
    // across a service boundary.
    expect(call['recipientAddress']).toBe('someone@example.org');
    expect(call['recipientUserId']).toBe('usr_new');
  });

  it('builds the link from config plus the token, percent-encoded', async () => {
    const { service, dispatcher } = buildSvc();

    await service.deliver(input({ token: 'a+b/c=' }));

    const vars = (dispatcher.dispatch.mock.calls[0]?.[0] as { variables: Record<string, unknown> })
      .variables;
    expect(vars['verificationUrl']).toBe(
      'https://app.tasteandsee.example.com/verify-email?token=a%2Bb%2Fc%3D',
    );
  });

  it('does not double a query string when the base already carries one', async () => {
    const { service, dispatcher } = buildSvc({
      EMAIL_VERIFICATION_URL_BASE: 'https://app.example.com/verify?src=email',
    } as Partial<Env>);

    await service.deliver(input());

    const vars = (dispatcher.dispatch.mock.calls[0]?.[0] as { variables: Record<string, unknown> })
      .variables;
    expect(vars['verificationUrl']).toBe(
      `https://app.example.com/verify?src=email&token=${encodeURIComponent(TOKEN)}`,
    );
  });

  it('BYPASSES quiet hours — someone is at a signup form waiting', async () => {
    const { service, dispatcher } = buildSvc();
    await service.deliver(input());
    const call = dispatcher.dispatch.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(call['bypassQuietHours']).toBe(true);
  });

  it('keys idempotency on the event id, so a resend is a fresh send', async () => {
    const { service, dispatcher } = buildSvc();

    await service.deliver(input({ eventId: 'evt_first' }));
    await service.deliver(input({ eventId: 'evt_resend', isResend: true }));

    const keys = dispatcher.dispatch.mock.calls.map(
      (c) => (c[0] as { idempotencyKey: string }).idempotencyKey,
    );
    expect(keys).toEqual(['email-verification:evt_first', 'email-verification:evt_resend']);
  });

  it('passes isResend through so the copy can change one paragraph', async () => {
    const { service, dispatcher } = buildSvc();
    await service.deliver(input({ isResend: true }));
    const vars = (dispatcher.dispatch.mock.calls[0]?.[0] as { variables: Record<string, unknown> })
      .variables;
    expect(vars['isResend']).toBe(true);
  });

  describe('expiresInLabel', () => {
    it.each([
      ['2026-08-03T12:00:00.000Z', '24 hours'],
      ['2026-08-02T12:45:00.000Z', '45 minutes'],
      ['2026-08-02T13:00:00.000Z', '1 hour'],
      ['2026-08-02T12:01:00.000Z', '1 minute'],
      ['2026-08-05T12:00:00.000Z', '3 days'],
    ])('renders %s as "%s"', async (expiresAt, expected) => {
      const { service, dispatcher } = buildSvc();
      await service.deliver(input({ expiresAt }));
      const vars = (
        dispatcher.dispatch.mock.calls[0]?.[0] as { variables: Record<string, unknown> }
      ).variables;
      expect(vars['expiresInLabel']).toBe(expected);
    });

    it('rounds DOWN so the promise is never longer than the truth', async () => {
      const { service, dispatcher } = buildSvc();
      // 23h59m — must not read as "24 hours".
      await service.deliver(input({ expiresAt: '2026-08-03T11:59:00.000Z' }));
      const vars = (
        dispatcher.dispatch.mock.calls[0]?.[0] as { variables: Record<string, unknown> }
      ).variables;
      expect(vars['expiresInLabel']).toBe('23 hours');
    });

    it('never emits a raw timestamp', async () => {
      const { service, dispatcher } = buildSvc();
      await service.deliver(input());
      const vars = (
        dispatcher.dispatch.mock.calls[0]?.[0] as { variables: Record<string, unknown> }
      ).variables;
      expect(String(vars['expiresInLabel'])).not.toMatch(/\d{4}-\d{2}-\d{2}|Z$/);
    });
  });

  it('skips an already-expired token rather than mailing a dead link', async () => {
    const { service, dispatcher } = buildSvc();

    const outcome = await service.deliver(input({ expiresAt: '2026-08-02T11:59:59.000Z' }));

    expect(outcome).toEqual({ kind: 'skipped_expired' });
    expect(dispatcher.dispatch).not.toHaveBeenCalled();
  });

  describe('the token never reaches a log', () => {
    it('logs neither the token, the URL, nor the full address on success', async () => {
      const { service } = buildSvc();
      const lines: unknown[] = [];
      const logger = (service as unknown as { logger: { log: unknown; warn: unknown } }).logger;
      const capture = (...args: unknown[]): void => {
        lines.push(args);
      };
      (logger as { log: unknown }).log = capture;
      (logger as { warn: unknown }).warn = capture;

      await service.deliver(input());

      const serialised = JSON.stringify(lines);
      expect(serialised).not.toContain(TOKEN);
      expect(serialised).not.toContain(URL_BASE);
      expect(serialised).not.toContain('someone@example.org');
      // The domain IS logged — it answers "are all failures at one mail
      // provider?" without identifying anyone.
      expect(serialised).toContain('example.org');
    });

    it('logs neither the token nor the full address on the expired path', async () => {
      const { service } = buildSvc();
      const lines: unknown[] = [];
      const logger = (service as unknown as { logger: { log: unknown; warn: unknown } }).logger;
      const capture = (...args: unknown[]): void => {
        lines.push(args);
      };
      (logger as { log: unknown }).log = capture;
      (logger as { warn: unknown }).warn = capture;

      await service.deliver(input({ expiresAt: '2026-08-01T00:00:00.000Z' }));

      const serialised = JSON.stringify(lines);
      expect(serialised).not.toContain(TOKEN);
      expect(serialised).not.toContain('someone@example.org');
    });
  });
});
