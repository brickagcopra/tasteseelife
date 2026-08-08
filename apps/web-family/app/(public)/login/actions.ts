'use server';

import { redirect } from 'next/navigation';
import { z } from 'zod';

import { callGateway } from '@/lib/api';
import { extractCookieFromUpstreamSetCookie, writeSession } from '@/lib/session';

/**
 * Login server action (TS-121).
 *
 * - Validates the form payload at the boundary with Zod.
 * - Calls `POST /api/v1/auth/login` on the api-gateway BFF.
 * - On a `session` outcome: stores the access token in the portal's
 *   own HttpOnly cookie and re-issues the refresh token (parsed out of
 *   the upstream `Set-Cookie` header that the gateway propagates).
 * - On an MFA `challenge` outcome: redirects to `/login/mfa` (the
 *   verify surface is deferred to a TS-121 follow-up — the action
 *   surfaces a typed marker so the page can render the right copy).
 * - On credential failure / generic 4xx: returns a typed `LoginError`
 *   the page renders inline. NO oracle about which credential is
 *   wrong (CLAUDE.md §3.1 — generic 401 on every failure mode).
 *
 * The redirect on success uses `redirect('/dashboard')` which throws
 * `NEXT_REDIRECT` — Next.js catches it and issues the 302. The page
 * never re-renders with the action's return value on the success
 * path, so the only `return` shapes encode failure / mfa-pending.
 */

const SERVICE_IDENTITY_REFRESH_COOKIE_NAME = 'tas_refresh';

const LoginInputSchema = z
  .object({
    email: z.string().min(1).max(254),
    password: z.string().min(1).max(1024),
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
const LoginChallengeBodySchema = z.object({
  outcome: z.literal('challenge'),
  challengeToken: z.string().min(1),
  expiresIn: z.number().int().positive(),
});

export interface LoginActionState {
  readonly status: 'idle' | 'mfa_required' | 'error';
  readonly message?: string;
}

export const INITIAL_LOGIN_STATE: LoginActionState = { status: 'idle' };

export async function loginAction(
  _previous: LoginActionState,
  formData: FormData,
): Promise<LoginActionState> {
  const parsed = LoginInputSchema.safeParse({
    email: formData.get('email'),
    password: formData.get('password'),
  });
  if (!parsed.success) {
    return { status: 'error', message: 'Please enter your email and password.' };
  }

  const result = await callGateway<unknown>('/api/v1/auth/login', {
    method: 'POST',
    body: parsed.data,
    authenticated: false,
  });

  if (result.kind === 'network_error') {
    return {
      status: 'error',
      message: 'We could not reach the service right now. Please try again in a moment.',
    };
  }
  if (result.kind === 'unauthorized' || result.kind === 'client_error') {
    return { status: 'error', message: 'Email or password is incorrect.' };
  }
  if (result.kind === 'server_error') {
    return {
      status: 'error',
      message: 'Something went wrong on our end. Please try again shortly.',
    };
  }

  const session = LoginSessionBodySchema.safeParse(result.body);
  if (session.success) {
    const refreshToken = extractCookieFromUpstreamSetCookie(
      result.setCookies,
      SERVICE_IDENTITY_REFRESH_COOKIE_NAME,
    );
    await writeSession({
      accessToken: session.data.accessToken,
      ...(refreshToken !== null && { refreshToken }),
    });
    redirect('/dashboard');
  }

  const challenge = LoginChallengeBodySchema.safeParse(result.body);
  if (challenge.success) {
    // MFA verify is a deferred TS-121 follow-up. Surface the typed
    // marker so the page can render a "we sent you a code" message.
    return {
      status: 'mfa_required',
      message:
        'Your account requires a second factor. Multi-factor sign-in is rolling out shortly — please reach out to support to complete sign-in.',
    };
  }

  // Should not happen: gateway already validates the discriminated
  // union before forwarding. Surfacing a generic copy is still the
  // safer default.
  return {
    status: 'error',
    message: 'Something went wrong on our end. Please try again shortly.',
  };
}
