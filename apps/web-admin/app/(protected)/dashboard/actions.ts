'use server';

import { redirect } from 'next/navigation';

import { clearMfaChallengeCookie, clearSession } from '@/lib/session';

/**
 * Admin-console logout server action (TS-123).
 *
 * Phase-1 skeleton scope: clears the portal's HttpOnly cookies (access,
 * refresh, MFA challenge if any leftover) and redirects to `/login`.
 * It does NOT yet call the upstream `POST /api/v1/auth/logout` proxy
 * to revoke the refresh-token family server-side — the gateway proxy
 * lands with TS-121-followup-1; the admin console inherits the upgrade
 * for free once that ships (sibling task TS-123-followup-1).
 *
 * Until then the upstream refresh token expires naturally on its TTL,
 * which is acceptable for the skeleton but should not ship to
 * production for the admin surface specifically — a leaked admin
 * refresh token has higher blast radius than a customer one.
 */
export async function logoutAction(): Promise<void> {
  await clearSession();
  await clearMfaChallengeCookie();
  redirect('/login');
}
