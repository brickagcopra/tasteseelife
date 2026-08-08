'use server';

import { redirect } from 'next/navigation';
import { z } from 'zod';

import { callGateway } from '@/lib/api';
import {
  clearMfaChallengeCookie,
  extractCookieFromUpstreamSetCookie,
  readMfaChallengeCookie,
  writeSession,
} from '@/lib/session';

/**
 * Admin-console MFA-verify server action (TS-123).
 *
 * Mirrors the login server action's shape but for the second hop:
 *
 *   - Reads the MFA challenge token from the short-lived HttpOnly
 *     cookie (the only place it lives — the URL never carries it,
 *     the form never echoes it). If the cookie is missing or empty
 *     bounce to `/login` (the challenge has likely expired or the
 *     verify page was opened without a prior login).
 *
 *   - Reads the 6-digit code from the form payload. Validates shape
 *     at the boundary (Zod) so a malformed paste returns inline copy
 *     rather than calling the gateway.
 *
 *   - Calls `POST /api/v1/auth/mfa/verify` on the gateway BFF. On a
 *     2xx LoginSession response: clears the challenge cookie, writes
 *     the access + refresh session cookies, redirects to `/dashboard`.
 *     The dashboard's RBAC gate then enforces the admin-role check.
 *
 *   - On a downstream 401 (wrong code / expired challenge / single-
 *     use challenge replayed): clears the challenge cookie and
 *     bounces back to `/login?verify_failed=1` so the operator starts
 *     fresh. Generic copy — no oracle.
 */

const SERVICE_IDENTITY_REFRESH_COOKIE_NAME = 'tas_refresh';

const VerifyInputSchema = z
  .object({
    code: z.string().regex(/^\d{6}$/, 'code must be exactly 6 digits'),
  })
  .strip();

const LoginSessionBodySchema = z.object({
  outcome: z.literal('session'),
  accessToken: z.string().min(1),
  tokenType: z.literal('Bearer'),
  expiresIn: z.number().int().positive(),
  user: z.object({
    id: z.string().min(1),
    email: z.string().email(),
    status: z.enum(['pending_verification', 'active', 'suspended', 'deactivated']),
  }),
});

export interface VerifyActionState {
  readonly status: 'idle' | 'error';
  readonly message?: string;
}

export const INITIAL_VERIFY_STATE: VerifyActionState = { status: 'idle' };

export async function verifyAction(
  _previous: VerifyActionState,
  formData: FormData,
): Promise<VerifyActionState> {
  const challengeToken = await readMfaChallengeCookie();
  if (challengeToken === null) {
    redirect('/login');
  }

  const parsed = VerifyInputSchema.safeParse({ code: formData.get('code') });
  if (!parsed.success) {
    return { status: 'error', message: 'Enter the six-digit code from your authenticator app.' };
  }

  const result = await callGateway<unknown>('/api/v1/auth/mfa/verify', {
    method: 'POST',
    body: { challengeToken, code: parsed.data.code },
    authenticated: false,
  });

  if (result.kind === 'network_error') {
    return {
      status: 'error',
      message: 'We could not reach the service right now. Please try again in a moment.',
    };
  }
  if (result.kind === 'unauthorized' || result.kind === 'client_error') {
    // Wrong code OR expired/replayed challenge. The downstream returns
    // the same generic 401 for every failure mode, so we can't
    // distinguish "wrong code" from "challenge expired" here. The
    // user-facing flow re-issues a challenge by bouncing through
    // `/login` so they start over with a fresh six-digit code.
    await clearMfaChallengeCookie();
    redirect('/login?verify_failed=1');
  }
  if (result.kind === 'server_error') {
    return {
      status: 'error',
      message: 'Something went wrong on our end. Please try again shortly.',
    };
  }

  const session = LoginSessionBodySchema.safeParse(result.body);
  if (!session.success) {
    return {
      status: 'error',
      message: 'Something went wrong on our end. Please try again shortly.',
    };
  }

  const refreshToken = extractCookieFromUpstreamSetCookie(
    result.setCookies,
    SERVICE_IDENTITY_REFRESH_COOKIE_NAME,
  );
  await writeSession({
    accessToken: session.data.accessToken,
    ...(refreshToken !== null && { refreshToken }),
  });
  await clearMfaChallengeCookie();
  redirect('/dashboard');
}
