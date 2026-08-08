'use server';

import { redirect } from 'next/navigation';
import { z } from 'zod';

import { callGateway } from '@/lib/api';
import { extractCookieFromUpstreamSetCookie, writeSession } from '@/lib/session';

/**
 * Provider-portal login server action (TS-122).
 *
 * Mirrors `apps/web-family/app/(public)/login/actions.ts`:
 *   - Validates the form payload at the boundary with Zod.
 *   - Calls `POST /api/v1/auth/login` on the api-gateway BFF.
 *   - On a `session` outcome: stores the access token in the portal's
 *     own HttpOnly cookie and re-issues the refresh token (parsed out of
 *     the upstream `Set-Cookie` header that the gateway propagates).
 *   - On an MFA `challenge` outcome: surfaces a typed marker so the
 *     page can render copy. Full MFA verify lands as a TS-122
 *     follow-up alongside TS-121-followup-6 (the two portals share the
 *     same verify surface shape).
 *   - On credential failure / generic 4xx: returns a typed `LoginError`
 *     the page renders inline. NO oracle about which credential is
 *     wrong (CLAUDE.md §3.1 — generic 401 on every failure mode).
 *
 * The auth surface is shared with the family portal at the gateway
 * layer; what differs is the portal-side cookie name + the post-login
 * redirect target (`/dashboard` here renders the provider chrome).
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
    return {
      status: 'mfa_required',
      message:
        'Your account requires a second factor. Multi-factor sign-in is rolling out shortly — please reach out to support to complete sign-in.',
    };
  }

  return {
    status: 'error',
    message: 'Something went wrong on our end. Please try again shortly.',
  };
}
