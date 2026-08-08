import { describe, expect, it, vi } from 'vitest';

import type { EmailVerificationMailerService } from '../email-verification-mailer.service';

import { IdentityEmailVerificationRequestedHandler } from './email-verification.handler';

const TOKEN = 'tok_live_single_use_secret_value_abc123';

function build(): {
  handler: IdentityEmailVerificationRequestedHandler;
  mailer: { deliver: ReturnType<typeof vi.fn> };
} {
  const mailer = { deliver: vi.fn().mockResolvedValue({ kind: 'sent', replayed: false }) };
  return {
    handler: new IdentityEmailVerificationRequestedHandler(
      mailer as unknown as EmailVerificationMailerService,
    ),
    mailer,
  };
}

function payload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    eventId: 'evt_abc',
    occurredAt: '2026-08-02T12:00:00.000Z',
    userId: 'usr_new',
    email: 'someone@example.org',
    token: TOKEN,
    expiresAt: '2026-08-03T12:00:00.000Z',
    reason: 'signup',
    ...overrides,
  };
}

describe('IdentityEmailVerificationRequestedHandler', () => {
  it('parses the event and hands it to the mailer', async () => {
    const { handler, mailer } = build();

    const outcome = await handler.handle({ payload: payload() });

    expect(outcome).toEqual({ kind: 'sent', replayed: false });
    expect(mailer.deliver).toHaveBeenCalledWith({
      eventId: 'evt_abc',
      userId: 'usr_new',
      email: 'someone@example.org',
      token: TOKEN,
      expiresAt: '2026-08-03T12:00:00.000Z',
      occurredAt: '2026-08-02T12:00:00.000Z',
      isResend: false,
    });
  });

  it('maps reason=resend to isResend', async () => {
    const { handler, mailer } = build();
    await handler.handle({ payload: payload({ reason: 'resend' }) });
    expect((mailer.deliver.mock.calls[0]?.[0] as { isResend: boolean }).isResend).toBe(true);
  });

  it('throws on a malformed payload so the event redelivers', async () => {
    const { handler, mailer } = build();
    await expect(handler.handle({ payload: payload({ token: undefined }) })).rejects.toThrow();
    expect(mailer.deliver).not.toHaveBeenCalled();
  });

  it('NEVER puts the payload in the validation error — it carries a live token', async () => {
    const { handler } = build();

    // A payload that fails on one field still carries a valid token in
    // another. Zod's default error would serialise the whole thing.
    const thrown = await handler
      .handle({ payload: payload({ email: 'not-an-email' }) })
      .catch((e: unknown) => e);

    const serialised = JSON.stringify({
      message: (thrown as Error).message,
      // `cause` and any custom props too — anything a logger would reach for.
      ...(thrown as object),
    });
    expect(serialised).not.toContain(TOKEN);
    expect(serialised).not.toContain('not-an-email');
    expect((thrown as Error).message).toContain('details withheld');
  });
});
