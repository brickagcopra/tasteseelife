'use server';

import { redirect } from 'next/navigation';

import { clearSession } from '@/lib/session';

/**
 * Provider-portal logout server action (TS-122).
 *
 * Mirrors `apps/web-family/app/(protected)/dashboard/actions.ts`.
 * Phase-1 skeleton scope: clears the portal's own HttpOnly cookies and
 * redirects to `/login`. It does NOT yet call the upstream
 * `POST /api/v1/auth/logout` to revoke the refresh-token family — that
 * step lands when the gateway grows the logout proxy (TS-121-followup-1
 * is the gating work; TS-122 inherits the same upgrade for free once
 * that ships).
 *
 * Until then the upstream refresh token expires naturally on its TTL,
 * which is acceptable for the skeleton but should not ship to
 * production.
 */
export async function logoutAction(): Promise<void> {
  await clearSession();
  redirect('/login');
}
