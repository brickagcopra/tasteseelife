import Link from 'next/link';
import { redirect } from 'next/navigation';
import type { Metadata } from 'next';

import {
  DATA_SUBJECT_REQUEST_NOTE_MAX_LENGTH,
  type DataSubjectRequestReceipt,
} from '@taste-and-see/contracts';

import { fetchMe } from '@/lib/me-api';
import { listPrivacyRequests } from '@/lib/privacy-api';

import { filePrivacyRequestAction, withdrawPrivacyRequestAction } from './actions';

export const metadata: Metadata = {
  title: 'Your privacy — Taste & See Provider Portal',
};

/**
 * Privacy Center — provider portal (TS-309d; PRD §11.4; CLAUDE.md §12).
 *
 * The provider-side twin of the family surface. Same lifecycle (TS-309a),
 * same honesty constraints — no promised deletion, no download that does not
 * exist yet (TS-309b2), no statutory window printed as a guarantee — with two
 * differences that are specific to providers:
 *
 *   - **Account, not profile.** This surface asks about the provider's
 *     ACCOUNT. Their provider-directory profile is a separate subject in
 *     another service's schema, and identity cannot establish that this user
 *     is that provider without a cross-service call it may not make
 *     (CLAUDE.md §2.3). Rather than quietly file something that would sit
 *     unverified, the page says which one this is and where to ask about the
 *     other.
 *   - **Records we keep are different, and some of them protect other
 *     people.** A provider's history includes visit records about the people
 *     they cared for and any trust & safety matter they were part of. Those
 *     are not the provider's to erase, and the copy says so up front rather
 *     than in a refusal.
 *
 * Zero client JS; `?action=err&code=` for errors (no flash channel here).
 */

const ERROR_COPY: Readonly<Record<string, string>> = {
  invalid: 'Please choose what you’d like us to do before sending.',
  mfa_required:
    'Before we can accept a privacy request, we need to be certain it’s really you. Please sign in again with your two-step code, then try once more.',
  duplicate: 'You already have an open request just like this one — we’re working on it.',
  not_found: 'We couldn’t find that request.',
  already_closed: 'That request has already been closed, so there’s nothing to withdraw.',
  failed: 'We couldn’t send that just now. Please try again in a moment.',
};

interface PageProps {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export default async function PrivacyCenterPage({
  searchParams,
}: PageProps): Promise<React.JSX.Element> {
  const params = await searchParams;
  const filed = readParam(params, 'filed');
  const withdrawn = readParam(params, 'withdrawn');
  const errorCode =
    params['action'] === 'err' && typeof params['code'] === 'string' ? params['code'] : null;

  const [me, requests] = await Promise.all([fetchMe(), listPrivacyRequests()]);

  if (me.kind === 'unauthorized' || requests.kind === 'unauthorized') {
    redirect('/login?expired=1');
  }

  // A hint, not a gate — the action re-checks, because a token can go stale
  // between this render and the submit.
  const sessionVerified = me.kind === 'ok' ? me.me.mfaVerified : true;
  const myRequests = requests.kind === 'ok' ? requests.requests : [];

  return (
    <Shell>
      <h1>Your privacy</h1>

      <p>
        Your information is yours. You can ask us for a copy of what we hold about you, or ask us to
        remove it. Tell us what you&apos;d like and we&apos;ll take it from there.
      </p>

      {errorCode !== null ? (
        <p className="auth-alert" role="alert">
          {ERROR_COPY[errorCode] ?? ERROR_COPY['failed']}
        </p>
      ) : null}

      {filed !== null ? (
        <p className="privacy-receipt" role="status">
          Thank you — we have your request. Your reference is <strong>{filed}</strong>. We&apos;ll
          work through it and come back to you; you can check on it here any time.
        </p>
      ) : null}

      {withdrawn !== null ? (
        <p className="privacy-receipt" role="status">
          That request has been withdrawn. Nothing further will happen with it, and you can always
          ask again.
        </p>
      ) : null}

      <section className="privacy-section" aria-labelledby="what-you-can-ask">
        <h2 id="what-you-can-ask">What you can ask for</h2>

        <div className="privacy-cards">
          <div className="privacy-card">
            <h3>A copy of your information</h3>
            <p>
              We gather what we hold about your account — how you signed in, the roles you hold, the
              checks we&apos;ve run — and prepare it for you. Some things we deliberately leave out,
              such as passwords and the documents you supplied for verification, and we&apos;ll tell
              you what those were and why.
            </p>
          </div>

          <div className="privacy-card">
            <h3>Removing your information</h3>
            <p>
              You can ask us to remove what we hold. We&apos;ll always answer — and we&apos;ll be
              straight with you about what we can and can&apos;t remove.{' '}
              <strong>Some records we have to keep</strong>: earnings and payment records, and
              records of the care you provided, which are about the people you cared for as much as
              about you. Where we keep something, we&apos;ll tell you which records and why.
            </p>
          </div>
        </div>

        <p className="privacy-note">
          This page is about <strong>your account</strong>. If your question is about your public
          provider profile — your listing, your certifications, your reviews — tell your provider
          support contact and they&apos;ll pick it up with you directly.
        </p>
      </section>

      <section className="privacy-section" aria-labelledby="make-a-request">
        <h2 id="make-a-request">Make a request</h2>

        {sessionVerified ? (
          <form action={filePrivacyRequestAction} className="concierge-emergency-form">
            <fieldset className="privacy-fieldset">
              <legend className="concierge-field__label">What would you like us to do?</legend>
              <label className="privacy-choice">
                <input type="radio" name="kind" value="access" defaultChecked />
                <span>Send me a copy of the information you hold about my account</span>
              </label>
              <label className="privacy-choice">
                <input type="radio" name="kind" value="erasure" />
                <span>Remove the information you hold, where you&apos;re able to</span>
              </label>
            </fieldset>

            <div className="concierge-field">
              <label htmlFor="note" className="concierge-field__label">
                Anything you&apos;d like us to know? (optional)
              </label>
              <textarea
                id="note"
                name="note"
                rows={4}
                maxLength={DATA_SUBJECT_REQUEST_NOTE_MAX_LENGTH}
                className="concierge-field__control"
                placeholder="e.g. I’m mainly interested in my sign-in history."
              />
            </div>

            <div className="concierge-actions">
              <button type="submit" className="concierge-emergency-cta">
                Send request
              </button>
            </div>
          </form>
        ) : (
          <div className="privacy-verify" role="note">
            <h3>First, let&apos;s be sure it&apos;s you</h3>
            <p>
              Because a request like this is about someone&apos;s personal information, we need to
              be certain who we&apos;re speaking to before we can accept it. Sign out and sign back
              in using your two-step code, and this form will be waiting for you.
            </p>
            <p>
              If you don&apos;t have a two-step code set up, get in touch with your provider support
              contact and we&apos;ll take your request another way.
            </p>
          </div>
        )}
      </section>

      <section className="privacy-section" aria-labelledby="your-requests">
        <h2 id="your-requests">Your requests</h2>

        {requests.kind !== 'ok' ? (
          <p role="status">
            We couldn&apos;t load your requests just now. Please refresh in a moment — nothing
            you&apos;ve asked for has been lost.
          </p>
        ) : myRequests.length === 0 ? (
          <p>You haven&apos;t made a privacy request yet. When you do, it&apos;ll appear here.</p>
        ) : (
          <ul className="privacy-list">
            {myRequests.map((request) => (
              <RequestRow key={request.id} request={request} />
            ))}
          </ul>
        )}
      </section>
    </Shell>
  );
}

function RequestRow({
  request,
}: {
  readonly request: DataSubjectRequestReceipt;
}): React.JSX.Element {
  const open = !TERMINAL_STATUSES.includes(request.status);

  return (
    <li className="privacy-list__item">
      <div className="privacy-list__head">
        <span className="privacy-list__kind">
          {request.kind === 'access' ? 'Copy of your information' : 'Removal of your information'}
        </span>
        <span className="privacy-list__status">{statusCopy(request)}</span>
      </div>

      <p className="privacy-list__meta">
        Asked on {formatDate(request.receivedAt)}
        {open ? <> · we&apos;re aiming to come back to you by {formatDate(request.dueAt)}</> : null}
      </p>

      {request.refusalReason !== null ? (
        <p className="privacy-list__refusal">{refusalCopy(request.refusalReason)}</p>
      ) : null}

      {open ? (
        <form action={withdrawPrivacyRequestAction} className="privacy-list__actions">
          <input type="hidden" name="requestId" value={request.id} />
          <button type="submit" className="link-inline">
            Withdraw this request
          </button>
        </form>
      ) : null}
    </li>
  );
}

const TERMINAL_STATUSES: readonly DataSubjectRequestReceipt['status'][] = [
  'fulfilled',
  'refused',
  'withdrawn',
];

/** Status in the person's terms. See the family surface for the reasoning. */
function statusCopy(request: DataSubjectRequestReceipt): string {
  switch (request.status) {
    case 'received':
    case 'verifying':
      return 'With us';
    case 'in_progress':
      return 'Being worked on';
    case 'fulfilled':
      return 'Answered';
    case 'refused':
      return 'We couldn’t do this one';
    case 'withdrawn':
      return 'Withdrawn';
  }
}

/** Why we said no, in plain language — and never with a legal citation. */
function refusalCopy(reason: NonNullable<DataSubjectRequestReceipt['refusalReason']>): string {
  switch (reason) {
    case 'identity_not_verified':
      return 'We weren’t able to confirm who was asking, so we didn’t act on this one. You’re welcome to ask again — get in touch and we’ll help you through it.';
    case 'not_the_subject':
      return 'This request was about someone else, and we weren’t able to establish that you could ask on their behalf.';
    case 'subject_consent_absent':
      return 'This was about someone else, and they haven’t agreed to share it with you. That decision is theirs, and we’ll respect it.';
    case 'retention_required':
      return 'We have to keep these particular records, so we weren’t able to remove them. Everything we could act on, we did.';
    case 'duplicate_request':
      return 'You already had an open request asking the same thing, so we’re handling it there.';
    case 'out_of_scope':
      return 'What was asked for isn’t personal information we hold about you.';
  }
}

function formatDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
}

function readParam(
  params: Record<string, string | string[] | undefined>,
  key: string,
): string | null {
  const value = params[key];
  return typeof value === 'string' && value !== '' ? value : null;
}

function Shell({ children }: { readonly children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="dash-shell">
      <header className="dash-top">
        <span className="dash-brand">Taste &amp; See</span>
        <Link href="/dashboard" className="dash-logout">
          Back to dashboard
        </Link>
      </header>
      <main className="dash-main">{children}</main>
    </div>
  );
}
