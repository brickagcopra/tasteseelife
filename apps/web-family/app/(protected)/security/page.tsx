import Link from 'next/link';
import { redirect } from 'next/navigation';
import type { Metadata } from 'next';

import type { MfaMethodSummary } from '@taste-and-see/contracts';

import { isConfirmed, listMethods } from '@/lib/mfa-api';

import { removeMethodAction } from './actions';
import { MfaEnrollForm } from './enroll-form';

export const metadata: Metadata = {
  title: 'Sign-in security — Taste & See',
};

/**
 * Sign-in security — family portal (TS-309d-followup-1; CLAUDE.md §3.1, §8.3).
 *
 * **This page closes a hole rather than adding a feature.** The portal could
 * COMPLETE an MFA challenge at login but had no way to ENROL one: the gateway
 * proxied `POST /api/v1/auth/mfa/verify` and nothing else of the MFA surface,
 * while service-identity has owned enrol / confirm / list / remove since
 * TS-023. A customer who never enrolled could not obtain an `mfaVerified`
 * session **by any route the product offered**, which shut TS-309a's Privacy
 * Center filing gate to them permanently — and would shut every future
 * step-up-protected action too. TS-309d had to render an explanation where a
 * form should have been. This is the form.
 *
 * The gate itself was never the problem and is not relaxed here: TS-309a made
 * a session the verification, and a session is only worth that if it is
 * MFA-backed.
 *
 * **Copy rules on this surface.** The audience includes seniors and the family
 * members who help them, so: no "2FA", no "TOTP", no "factor". An authenticator
 * app, a six-digit code, and codes to keep somewhere safe. The one place the
 * page raises its voice is the recovery codes, because they are shown once and
 * a customer who skims past them loses their way back in after a lost phone.
 *
 * Enrolment is the only client-side component in the portal's settings area,
 * and `enroll-form.tsx` documents why: the secret and then the codes must
 * survive two submissions without touching a cookie or a query string.
 */
export default async function SecurityPage(): Promise<React.JSX.Element> {
  const result = await listMethods();

  if (result.kind === 'unauthorized') redirect('/login?expired=1');

  return (
    <div className="dash-shell">
      <header className="dash-top">
        <span className="dash-brand">Taste &amp; See</span>
        <Link href="/dashboard" className="dash-logout">
          Back to dashboard
        </Link>
      </header>

      <main className="dash-main">
        <h1>Sign-in security</h1>

        <p>
          Add an authenticator app so that knowing your password isn&apos;t enough for someone to
          sign in as you.
        </p>

        {result.kind === 'ok' ? (
          <MethodsSection methods={result.methods} />
        ) : (
          // Never render the enrolment form on top of a failed read: enrolling
          // a second authenticator when one already exists is refused
          // downstream, and offering it without knowing would send the customer
          // through the whole flow to a 409 at the end.
          <p className="auth-alert" role="alert">
            We couldn&apos;t load your security settings just now. Please refresh in a moment.
          </p>
        )}
      </main>
    </div>
  );
}

function MethodsSection({
  methods,
}: {
  readonly methods: readonly MfaMethodSummary[];
}): React.JSX.Element {
  const live = methods.filter(isConfirmed);
  // A begun-and-never-finished enrolment protects nothing. Counting it as
  // security is how a settings page tells someone they are covered when they
  // are not — so it is listed separately and honestly.
  const unfinished = methods.filter((method) => !isConfirmed(method));

  return (
    <>
      <section className="privacy-card">
        <h2>Your authenticator{live.length === 1 ? '' : 's'}</h2>
        {live.length === 0 ? (
          <p>
            You don&apos;t have an authenticator set up yet. Your account is protected by your
            password alone.
          </p>
        ) : (
          <ul className="mfa-method-list">
            {live.map((method) => (
              <li key={method.id} className="mfa-method">
                <span className="mfa-method__name">{method.label ?? 'Authenticator app'}</span>
                <span className="mfa-method__meta">
                  Added {formatDate(method.createdAt)}
                  {method.lastUsedAt !== null
                    ? ` · last used ${formatDate(method.lastUsedAt)}`
                    : ''}
                </span>
                <form action={removeMethodAction} className="mfa-method__form">
                  <input type="hidden" name="methodId" value={method.id} />
                  <button type="submit" className="link-inline">
                    Remove
                  </button>
                </form>
              </li>
            ))}
          </ul>
        )}
        {unfinished.length > 0 ? (
          <p className="mfa-hint">
            {unfinished.length === 1 ? 'One setup was' : `${unfinished.length} setups were`} started
            but never finished, so {unfinished.length === 1 ? 'it isn’t' : 'they aren’t'} protecting
            anything. Starting again below replaces {unfinished.length === 1 ? 'it' : 'them'}.
          </p>
        ) : null}
      </section>

      {live.length === 0 ? (
        <section className="privacy-card">
          <h2>Set up an authenticator</h2>
          <MfaEnrollForm />
        </section>
      ) : (
        <section className="privacy-card">
          <h2>Adding another device</h2>
          <p>
            To move your authenticator to a new phone, remove the one above first, then set up the
            new one. Keep your recovery codes handy while you do — you&apos;ll need one if you
            can&apos;t reach the old device.
          </p>
        </section>
      )}
    </>
  );
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    dateStyle: 'medium',
  });
}
