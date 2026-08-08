import { redirect } from 'next/navigation';
import type { Metadata } from 'next';

import { readMfaChallengeCookie } from '@/lib/session';

import { VerifyForm } from './verify-form';

export const metadata: Metadata = {
  title: 'Two-factor verification — Taste & See Admin Console',
};

/**
 * Step 2 of the admin login flow (TS-123).
 *
 * Renders the TOTP code form only when an MFA-challenge cookie is
 * present — otherwise bounces back to `/login`. The cookie is short-
 * lived (5 min, matching service-identity's challenge TTL) so an
 * abandoned flow falls through to a fresh login rather than letting a
 * stale challenge hang around.
 */
export default async function VerifyPage(): Promise<React.JSX.Element> {
  const challenge = await readMfaChallengeCookie();
  if (challenge === null) {
    redirect('/login');
  }

  return (
    <main className="auth-shell">
      <div className="auth-card">
        <h1>Two-factor code</h1>
        <p>
          Enter the six-digit code from your authenticator app. The code refreshes every 30 seconds.
        </p>
        <VerifyForm />
      </div>
    </main>
  );
}
