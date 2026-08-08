'use server';

import { redirect } from 'next/navigation';
import { z } from 'zod';

import { callGateway } from '@/lib/api';
import { PROVIDER_TIER_OPTIONS } from '@/lib/tiers';

/**
 * Provider-portal signup server action (TS-122).
 *
 * Mirrors `apps/web-family/app/(public)/signup/actions.ts`. Creates a
 * new account via `POST /api/v1/auth/signup` on the gateway BFF. Signup
 * does NOT issue a session token (CLAUDE.md §3.1 — login is the
 * credential-bearing step); the action records the chosen tier code in
 * a URL query param so the post-signup login flow (and the eventual
 * TS-051 provider application wizard) knows which subscription to
 * propose.
 *
 * Failure modes:
 *   - 409 from the gateway → "email already in use".
 *   - 400 from the gateway → "please check the form".
 *   - 5xx / network → generic retry copy.
 *
 * The action does NOT auto-log-in the user after signup. The current
 * service-identity contract (TS-021) returns no token on signup. The
 * follow-up surface is the `/login?signed_up=1&tier=...` redirect,
 * which surfaces a success banner.
 *
 * Phase-1 scope: signup creates a generic identity (no provider record
 * is materialised yet). The provider application + background check
 * flow (PRD §7.1) is TS-051 territory. The tier choice captured here
 * gets handed off to that wizard via the URL query param.
 */

const TIER_CODES = PROVIDER_TIER_OPTIONS.map((option) => option.code) as readonly string[];

const SignupInputSchema = z
  .object({
    email: z.string().min(3).max(254).email(),
    password: z.string().min(8).max(64),
    /**
     * Optional at this layer — the page form enforces a tier selection,
     * but the action tolerates a missing tier so an applicant can still
     * finish signup if product later allows a "tier-later" path (e.g. a
     * culinary-academy student who joins to learn first).
     */
    tier: z
      .string()
      .refine((v) => TIER_CODES.includes(v), 'choose a tier from the list')
      .optional(),
  })
  .strip();

export interface SignupActionState {
  readonly status: 'idle' | 'error';
  readonly message?: string;
}

export const INITIAL_SIGNUP_STATE: SignupActionState = { status: 'idle' };

export async function signupAction(
  _previous: SignupActionState,
  formData: FormData,
): Promise<SignupActionState> {
  const parsed = SignupInputSchema.safeParse({
    email: formData.get('email'),
    password: formData.get('password'),
    tier: formData.get('tier'),
  });
  if (!parsed.success) {
    const firstIssue = parsed.error.issues[0];
    return {
      status: 'error',
      message:
        firstIssue !== undefined
          ? humaniseSignupIssue(firstIssue.path[0], firstIssue.message)
          : 'Please double-check the form and try again.',
    };
  }

  const result = await callGateway<unknown>('/api/v1/auth/signup', {
    method: 'POST',
    body: {
      email: parsed.data.email,
      password: parsed.data.password,
    },
    authenticated: false,
  });

  if (result.kind === 'network_error') {
    return {
      status: 'error',
      message: 'We could not reach the service right now. Please try again in a moment.',
    };
  }
  if (result.kind === 'unauthorized') {
    return {
      status: 'error',
      message: 'Sign-up is temporarily unavailable. Please try again shortly.',
    };
  }
  if (result.kind === 'client_error') {
    if (result.status === 409) {
      return {
        status: 'error',
        message:
          'That email is already in use. If this is you, sign in instead — or use a different email to apply.',
      };
    }
    return { status: 'error', message: 'Please double-check the form and try again.' };
  }
  if (result.kind === 'server_error') {
    return {
      status: 'error',
      message: 'Something went wrong on our end. Please try again shortly.',
    };
  }

  const params = new URLSearchParams({ signed_up: '1' });
  if (parsed.data.tier !== undefined) params.set('tier', parsed.data.tier);
  redirect(`/login?${params.toString()}`);
}

function humaniseSignupIssue(field: unknown, fallback: string): string {
  if (field === 'email') return 'Please enter a valid email address.';
  if (field === 'password') return 'Passwords need to be at least 8 characters.';
  if (field === 'tier') return 'Please choose a tier to continue.';
  return fallback;
}
