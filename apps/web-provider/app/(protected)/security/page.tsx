import Link from 'next/link';
import { redirect } from 'next/navigation';
import type { Metadata } from 'next';

import type { MfaMethodSummary } from '@taste-and-see/contracts';

import { isConfirmed, listMethods } from '@/lib/mfa-api';

import { removeMethodAction } from './actions';
import { MfaEnrollForm } from './enroll-form';

export const metadata: Metadata = {
  title: 'Sign-in security — Taste & See for providers',
};

/**
 * Sign-in security — provider portal (TS-309d-followup-1; CLAUDE.md §3.1).
 *
 * The provider half of the same hole: this portal could complete an MFA
 * challenge at login but had no way to enrol one, because the gateway proxied
 * `POST /api/v1/auth/mfa/verify` and nothing else. A provider who never
 * enrolled could not obtain an `mfaVerified` session by any route the product
 * offered.
 *
 * **The stakes are arguably higher here than on the family portal**, which is
 * why it ships in the same pass rather than as a follow-up: a provider account
 * carries scheduled visits into named households, the visit-prep view of a
 * senior's dietary and mobility picture, and the check-in surface. A takeover
 * is not a billing problem.
 *
 * Copy is plainer than the family portal's — this audience is working
 * professionals rather than seniors — but the same rule holds on the recovery
 * codes: they are shown once, and the page says so rather than implying they
 * can be found again later.
 */
export default async function SecurityPage({
  searchParams,
}: {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}): Promise<React.JSX.Element> {
  const params = await searchParams;
  const action = readParam(params, 'action');
  const errorCode = readParam(params, 'code');

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
          Your account carries your schedule and the household details you need on a visit. An
          authenticator app means a stolen password isn&apos;t enough to reach any of it.
        </p>

        {action === 'removed' ? (
          <p className="auth-alert auth-alert--info" role="status">
            Your authenticator has been removed. Your account is now protected by your password
            alone.
          </p>
        ) : null}
        {action === 'err' ? (
          <p className="auth-alert" role="alert">
            {removeErrorCopy(errorCode)}
          </p>
        ) : null}

        {result.kind === 'ok' ? (
          <MethodsSection methods={result.methods} />
        ) : (
          // Never offer enrolment on top of a failed read — a second
          // authenticator is refused downstream, so the customer would walk the
          // whole flow to a 409.
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
  // A begun-and-never-finished enrolment protects nothing; listing it as
  // security would tell a provider they are covered when they are not.
  const unfinished = methods.filter((method) => !isConfirmed(method));

  return (
    <>
      <section className="concierge-actions">
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
        <section className="concierge-actions">
          <h2>Set up an authenticator</h2>
          <MfaEnrollForm />
        </section>
      ) : (
        <section className="concierge-actions">
          <h2>Moving to a new phone</h2>
          <p>
            Remove the authenticator above first, then set up the new one. Keep your recovery codes
            to hand while you do — you&apos;ll need one if you can no longer reach the old device.
          </p>
        </section>
      )}
    </>
  );
}

function removeErrorCopy(code: string | null): string {
  switch (code) {
    case 'invalid':
      return 'Please choose which authenticator to remove.';
    case 'not-found':
      return "We couldn't find that authenticator — it may already have been removed.";
    default:
      return "We couldn't update your security settings. Please try again in a moment.";
  }
}

function readParam(
  params: Record<string, string | string[] | undefined>,
  key: string,
): string | null {
  const raw = params[key];
  if (typeof raw === 'string' && raw.length > 0) return raw;
  return null;
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    dateStyle: 'medium',
  });
}
