import Link from 'next/link';
import type { Metadata } from 'next';

import { verifyEmailAction } from './actions';

export const metadata: Metadata = {
  title: 'Confirm your email — Taste & See',
  // A page reached by a URL containing a live credential must never be
  // indexed, and must not leak the token to whatever the reader clicks next.
  robots: { index: false, follow: false },
  referrer: 'no-referrer',
};

interface VerifyEmailPageProps {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}

/**
 * Email-verification confirmation page (TS-510, TS-510-followup-2).
 *
 * **This page exists because a GET must not spend the token.**
 * `POST /api/v1/auth/verify-email` is `@Idempotent()`, which covers a
 * retry carrying the same `Idempotency-Key`. It does not cover the real
 * case with no key at all: a mail client, link previewer, corporate
 * link-scanner or antivirus product fetches the URL the moment the
 * message arrives, spends the token, and the human's click then fails as
 * "already used". That is a classic way for a verification flow to break
 * for a *subset* of users — exactly the subset whose employer runs a mail
 * scanner — in a way that is near-impossible to diagnose from logs, since
 * every request looks like a successful verification followed by a
 * customer complaint.
 *
 * So the emailed link is a **GET that changes nothing**, and the token is
 * spent only when a person presses the button (CLAUDE.md §5.1: no
 * non-idempotent side effect hangs off a GET).
 *
 * **It was also, until now, a 404.** TS-510-followup-4 made the platform
 * actually send these emails; the link they carry points here.
 *
 * The token stays in the query string while the page is shown — it has to
 * travel from the link to the form somehow — and the page is `noindex` +
 * `no-referrer` so it reaches neither a search engine nor the next site
 * the reader visits.
 */
export default async function VerifyEmailPage({
  searchParams,
}: VerifyEmailPageProps): Promise<React.JSX.Element> {
  const params = await searchParams;
  const state = readOne(params['state']);
  const token = readOne(params['token']);

  if (state === 'verified') {
    return (
      <Shell title="You're all set">
        <p>
          Your email is confirmed. You can sign in whenever you&apos;re ready — we&apos;re glad
          you&apos;re here.
        </p>
        <p className="auth-foot">
          <Link href="/login">Sign in</Link>
        </p>
      </Shell>
    );
  }

  if (state === 'failed') {
    return (
      <Shell title="That link didn't work">
        <p>
          It may have already been used, or it may have run out — these links don&apos;t last long,
          on purpose. If your account still needs confirming, sign in and we&apos;ll send you a
          fresh one.
        </p>
        <p className="auth-foot">
          <Link href="/login">Sign in</Link>
        </p>
      </Shell>
    );
  }

  if (state === 'unavailable') {
    return (
      <Shell title="We couldn't confirm that just now">
        <p>
          Something on our side didn&apos;t respond. Your link hasn&apos;t been used — please try
          again in a few seconds.
        </p>
        {token.length > 0 ? <ConfirmForm token={token} label="Try again" /> : null}
      </Shell>
    );
  }

  if (token.length === 0) {
    // Includes `state=invalid`. Nothing to confirm and nothing to explain
    // beyond "open it from the email" — a form with no token would be a
    // button that cannot work.
    return (
      <Shell title="Confirm your email">
        <p>
          Open this page from the link in the email we sent you. If you can&apos;t find it, sign in
          and we&apos;ll send another.
        </p>
        <p className="auth-foot">
          <Link href="/login">Sign in</Link>
        </p>
      </Shell>
    );
  }

  return (
    <Shell title="Confirm your email">
      <p>One tap and your account is confirmed.</p>
      <ConfirmForm token={token} label="Confirm my email" />
    </Shell>
  );
}

function ConfirmForm({
  token,
  label,
}: {
  readonly token: string;
  readonly label: string;
}): React.JSX.Element {
  return (
    <form action={verifyEmailAction}>
      {/* The token rides the form, not the action's closure — a server
          action's bound arguments are serialised into the page too, and
          a hidden field keeps the one copy visible to a reviewer. */}
      <input type="hidden" name="token" value={token} />
      <button type="submit" className="cta">
        {label}
      </button>
    </form>
  );
}

/**
 * A repeated query parameter arrives as an array. Take nothing rather
 * than guess: `?token=a&token=b` is not a request this page can honour,
 * and picking the first would spend whichever one an attacker put first.
 */
function readOne(value: string | string[] | undefined): string {
  return typeof value === 'string' ? value.trim() : '';
}

function Shell({
  title,
  children,
}: {
  readonly title: string;
  readonly children: React.ReactNode;
}): React.JSX.Element {
  return (
    <main className="auth-shell">
      <div className="auth-card">
        <h1>{title}</h1>
        {children}
      </div>
    </main>
  );
}
