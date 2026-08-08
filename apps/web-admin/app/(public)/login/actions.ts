'use server';

import { redirect } from 'next/navigation';
import { z } from 'zod';

import { callGateway } from '@/lib/api';
import { clearMfaChallengeCookie, clearSession, writeMfaChallengeCookie } from '@/lib/session';

/**
 * Admin-console login server action (TS-123).
 *
 * The admin console always expects an MFA challenge from
 * service-identity — the admin-MFA gate added in TS-023-followup-1
 * rejects a session-issuing login for any user holding an
 * `ADMIN_ROLE_NAMES` role with `mfa_enabled = false`. So this action's
 * branching is:
 *
 *   - `outcome: 'challenge'` (the expected path) — write the challenge
 *     token to an HttpOnly cookie and redirect to `/login/verify`.
 *
 *   - `outcome: 'session'` — service-identity issued a session directly,
 *     meaning the actor has no MFA configured AND no admin role. The
 *     admin-MFA gate would have refused the session if any admin role
 *     were held. We clear any session that may have been written and
 *     bounce back to `/login?no_admin_role=1` — the actor is real, but
 *     they don't belong in the admin console.
 *
 *   - 401 / 403 — generic copy ("email or password incorrect"). Per
 *     CLAUDE.md §3.1, no oracle revealing which input was wrong.
 *
 *   - 403 with admin-MFA hint — service-identity's admin-MFA gate
 *     refuses sessions for an admin-role-holder without MFA enrolled
 *     and returns 403 with a Problem-Details body. The body's `detail`
 *     mentions MFA. We surface that as `?mfa_required=1` so the operator
 *     understands they need MFA enrollment via a super_admin.
 *
 * The action never logs the password or its length (CLAUDE.md §3.5).
 */

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
const ProblemDetailsBodySchema = z.object({
  code: z.string().optional(),
  detail: z.string().optional(),
});

export interface LoginActionState {
  readonly status: 'idle' | 'error';
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
  if (result.kind === 'unauthorized') {
    return { status: 'error', message: 'Email or password is incorrect.' };
  }
  if (result.kind === 'client_error') {
    // The admin login gates return 403 with a problem-details body:
    // the admin-MFA gate (TS-023-followup-1) and the SSO gate
    // (TS-296). Branch on the stable machine-readable `code` (TS-296);
    // the detail-text regex remains ONLY as a fallback for responses
    // minted by pre-`code` identity deployments. Every other 4xx is a
    // generic credential failure.
    if (result.status === 403) {
      const body = ProblemDetailsBodySchema.safeParse(result.body);
      const code = body.success ? (body.data.code ?? '') : '';
      const detail = body.success ? (body.data.detail ?? '') : '';
      if (code === 'sso_assertion_required') {
        redirect('/login?sso_required=1');
      }
      if (code === 'mfa_enrollment_required' || /mfa|multi-factor/i.test(detail)) {
        redirect('/login?mfa_required=1');
      }
    }
    return { status: 'error', message: 'Email or password is incorrect.' };
  }
  if (result.kind === 'server_error') {
    return {
      status: 'error',
      message: 'Something went wrong on our end. Please try again shortly.',
    };
  }

  const challenge = LoginChallengeBodySchema.safeParse(result.body);
  if (challenge.success) {
    await writeMfaChallengeCookie(challenge.data.challengeToken);
    redirect('/login/verify');
  }

  const session = LoginSessionBodySchema.safeParse(result.body);
  if (session.success) {
    // The downstream issued a session directly, which means the user
    // has no MFA configured AND no admin role (or the admin-MFA gate
    // would have refused). The actor is real, but does not belong in
    // the admin console — clear any state and route to the no-admin
    // page rather than ever rendering authenticated chrome.
    await clearSession();
    await clearMfaChallengeCookie();
    redirect('/login?no_admin_role=1');
  }

  return {
    status: 'error',
    message: 'Something went wrong on our end. Please try again shortly.',
  };
}
