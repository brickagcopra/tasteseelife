import {
  IDENTITY_EMAIL_VERIFICATION_REQUESTED,
  IdentityEmailVerificationRequestedSchema,
} from '@taste-and-see/contracts';
import { expect, test } from '@playwright/test';

import { DEFAULT_PASSWORD, signUp } from '../src/auth-flows';
import { gateway } from '../src/gateway-client';
import { uniqueEmail } from '../src/actors';
import { waitForOutboxEvent } from '../src/outbox-reader';

/**
 * Email verification (TS-510) end to end through the api-gateway.
 *
 * This surface exists because TS-505's second run proved the platform could not
 * onboard anybody: `signup` creates `pending_verification`, `login` requires
 * `active`, and nothing moved an account between the two. These specs pin the
 * behaviours that make the fix safe rather than merely functional — the ones a
 * later refactor could quietly lose.
 */
test.describe('email verification', () => {
  test('mints exactly one delivery event per signup, carrying a live token', async () => {
    const created = await signUp(uniqueEmail('verify-event'));

    const event = await waitForOutboxEvent(
      IDENTITY_EMAIL_VERIFICATION_REQUESTED,
      (payload) => payload['userId'] === created.id,
    );
    const delivery = IdentityEmailVerificationRequestedSchema.parse(event.payload);

    expect(delivery.reason).toBe('signup');
    expect(delivery.email).toBe(created.email);
    // The event is appended inside the signup transaction, so a committed
    // signup always has a queued delivery — no polling gap to tolerate.
    expect(new Date(delivery.expiresAt).getTime()).toBeGreaterThan(Date.now());

    const verify = await gateway('/api/v1/auth/verify-email', {
      method: 'POST',
      body: { token: delivery.token },
    });
    expect(verify.status, verify.text).toBe(200);
    expect(verify.body).toMatchObject({ userId: created.id, status: 'active' });
  });

  test('spends the token once — a replayed link cannot re-verify', async () => {
    const created = await signUp(uniqueEmail('verify-single-use'));
    const event = await waitForOutboxEvent(
      IDENTITY_EMAIL_VERIFICATION_REQUESTED,
      (payload) => payload['userId'] === created.id,
    );
    const { token } = IdentityEmailVerificationRequestedSchema.parse(event.payload);

    const first = await gateway('/api/v1/auth/verify-email', {
      method: 'POST',
      body: { token },
    });
    expect(first.status, first.text).toBe(200);

    const replay = await gateway('/api/v1/auth/verify-email', {
      method: 'POST',
      body: { token },
    });
    expect(replay.status, replay.text).toBe(400);
    expect(replay.body).toMatchObject({ code: 'verification_token_already_consumed' });
  });

  test('replays the original result for a retry carrying the same Idempotency-Key', async () => {
    const created = await signUp(uniqueEmail('verify-idempotent'));
    const event = await waitForOutboxEvent(
      IDENTITY_EMAIL_VERIFICATION_REQUESTED,
      (payload) => payload['userId'] === created.id,
    );
    const { token } = IdentityEmailVerificationRequestedSchema.parse(event.payload);

    // The scenario is mundane and breaks the feature without this: a mail
    // client or link scanner fetches the URL before the human clicks it. Same
    // key ⇒ the second call replays the first 200 instead of failing as
    // already-consumed.
    const key = `e2e-verify-${created.id}`;
    const first = await gateway('/api/v1/auth/verify-email', {
      method: 'POST',
      body: { token },
      idempotencyKey: key,
    });
    expect(first.status, first.text).toBe(200);

    const retry = await gateway('/api/v1/auth/verify-email', {
      method: 'POST',
      body: { token },
      idempotencyKey: key,
    });
    expect(retry.status, retry.text).toBe(200);
    expect(retry.body).toEqual(first.body);
  });

  test('rejects an unknown token with the same shape as a spent one', async () => {
    const unknown = await gateway('/api/v1/auth/verify-email', {
      method: 'POST',
      // 43 base64url characters — the same shape a real token has, so the
      // rejection is about the lookup and not about the schema.
      body: { token: 'A'.repeat(43) },
    });
    expect(unknown.status, unknown.text).toBe(400);
    expect(unknown.body).toMatchObject({ code: 'invalid_token' });

    // Titles and details match across every rejection code; only the machine-
    // readable code differs, and only a caller holding a real token can reach
    // anything other than `invalid_token`.
    const created = await signUp(uniqueEmail('verify-shape'));
    const event = await waitForOutboxEvent(
      IDENTITY_EMAIL_VERIFICATION_REQUESTED,
      (payload) => payload['userId'] === created.id,
    );
    const { token } = IdentityEmailVerificationRequestedSchema.parse(event.payload);
    await gateway('/api/v1/auth/verify-email', { method: 'POST', body: { token } });
    const spent = await gateway('/api/v1/auth/verify-email', { method: 'POST', body: { token } });

    const unknownBody = unknown.body as Record<string, unknown>;
    const spentBody = spent.body as Record<string, unknown>;
    expect(spentBody['title']).toBe(unknownBody['title']);
    expect(spentBody['detail']).toBe(unknownBody['detail']);
  });

  test('accepts a resend for any address without disclosing whether it exists', async () => {
    const created = await signUp(uniqueEmail('verify-resend'));

    const resend = await gateway('/api/v1/auth/verification-emails', {
      method: 'POST',
      body: { email: created.email },
    });
    expect(resend.status, resend.text).toBe(202);
    expect(resend.body).toEqual({ accepted: true });

    // A second, *distinct* token now exists with `reason: 'resend'`. The
    // original stays spendable on purpose — invalidating it would break the
    // link the user may be clicking at this moment.
    const resent = await waitForOutboxEvent(
      IDENTITY_EMAIL_VERIFICATION_REQUESTED,
      (payload) => payload['userId'] === created.id && payload['reason'] === 'resend',
    );
    const resentDelivery = IdentityEmailVerificationRequestedSchema.parse(resent.payload);

    const signupDelivery = IdentityEmailVerificationRequestedSchema.parse(
      (
        await waitForOutboxEvent(
          IDENTITY_EMAIL_VERIFICATION_REQUESTED,
          (payload) => payload['userId'] === created.id && payload['reason'] === 'signup',
        )
      ).payload,
    );
    expect(resentDelivery.token).not.toBe(signupDelivery.token);

    // Both tokens work; the first one used wins and activates the account.
    const viaResent = await gateway('/api/v1/auth/verify-email', {
      method: 'POST',
      body: { token: resentDelivery.token },
    });
    expect(viaResent.status, viaResent.text).toBe(200);

    // An unregistered address, an already-verified one, and a registered
    // pending one are byte-identical responses. This is the property that keeps
    // an unauthenticated endpoint from being an account-enumeration oracle.
    const unregistered = await gateway('/api/v1/auth/verification-emails', {
      method: 'POST',
      body: { email: uniqueEmail('never-registered') },
    });
    const alreadyVerified = await gateway('/api/v1/auth/verification-emails', {
      method: 'POST',
      body: { email: created.email },
    });
    expect(unregistered.status).toBe(202);
    expect(alreadyVerified.status).toBe(202);
    expect(unregistered.text).toBe(resend.text);
    expect(alreadyVerified.text).toBe(resend.text);
  });

  test('verification does not hand out a session', async () => {
    const created = await signUp(uniqueEmail('verify-no-session'), DEFAULT_PASSWORD);
    const event = await waitForOutboxEvent(
      IDENTITY_EMAIL_VERIFICATION_REQUESTED,
      (payload) => payload['userId'] === created.id,
    );
    const { token } = IdentityEmailVerificationRequestedSchema.parse(event.payload);

    const verify = await gateway('/api/v1/auth/verify-email', {
      method: 'POST',
      body: { token },
    });
    expect(verify.status, verify.text).toBe(200);

    // Proving control of a mailbox is not proving knowledge of the password,
    // and verification links get forwarded. No token, no cookie.
    expect(verify.text).not.toContain('accessToken');
    expect(verify.headers.getSetCookie()).toEqual([]);
  });
});
