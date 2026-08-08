'use server';

import { redirect } from 'next/navigation';

import { clearSession } from '@/lib/session';

/**
 * Logout server action (TS-121).
 *
 * Phase-1 skeleton scope: clears the portal's own HttpOnly cookies and
 * redirects to `/login`. It does NOT yet call the upstream
 * `POST /api/v1/auth/logout` to revoke the refresh-token family — that
 * step lands when the gateway grows the logout proxy (TS-121-followup).
 * Until then the upstream refresh token expires naturally on its TTL,
 * which is acceptable for the skeleton but should not ship to
 * production.
 *
 * Captured up-front so the upgrade has a named owner.
 */
export async function logoutAction(): Promise<void> {
  await clearSession();
  redirect('/login');
}
