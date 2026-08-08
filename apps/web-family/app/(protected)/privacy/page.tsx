import Link from 'next/link';
import { redirect } from 'next/navigation';
import type { Metadata } from 'next';

import {
  DATA_SUBJECT_REQUEST_NOTE_MAX_LENGTH,
  type DataSubjectRequestReceipt,
} from '@taste-and-see/contracts';

import { fetchMe } from '@/lib/me-api';
import { listPrivacyRequests } from '@/lib/privacy-api';
import { listMySeniors } from '@/lib/seniors-api';

import { filePrivacyRequestAction, withdrawPrivacyRequestAction } from './actions';

export const metadata: Metadata = {
  title: 'Your privacy — Taste & See',
};

/**
 * Privacy Center — family portal (TS-309d; PRD §11.4; CLAUDE.md §8.3, §12).
 *
 * See what you've asked us for, ask for something, take a request back. The
 * lifecycle behind it is real (TS-309a) and every piece of copy here is
 * constrained by what the platform will actually do:
 *
 * **It does not promise a deletion.** Erasure is accepted and answered, and
 * some of it will be refused because records must be kept — so the page says
 * that BEFORE someone asks, in plain words, rather than letting them find out
 * in a refusal notice. TS-309c owns the retention schedule and is compliance-
 * blocked; the honest thing meanwhile is to be clear that "delete everything"
 * is not a button we have.
 *
 * **It does not promise a download.** Assembling the export is TS-309b2 and
 * does not exist yet. A "Download" button that 404s would be worse than the
 * truth, which is that we work the request and come back to you.
 *
 * **It does not imply a family member speaks for a senior.** A request about
 * someone you care for is accepted and then WAITS — the senior's consent
 * (CLAUDE.md §12) is not something the person filing can assert on their
 * behalf. The form says so at the point of choosing, not in the small print.
 *
 * **It does not print the statutory window as a promise.** The 45-day constant
 * is documented-unconfirmed in TS-309a. The page shows the target date stored
 * on the request and calls it a target, never a legal guarantee.
 *
 * Zero client JS: server component, form posts to server actions, senior-mode
 * inherits from the portal shell.
 */

interface PageProps {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export default async function PrivacyCenterPage({
  searchParams,
}: PageProps): Promise<React.JSX.Element> {
  const params = await searchParams;
  const filed = readParam(params, 'filed');
  const withdrawn = readParam(params, 'withdrawn');

  const [me, requests, seniors] = await Promise.all([
    fetchMe(),
    listPrivacyRequests(),
    listMySeniors(),
  ]);

  if (me.kind === 'unauthorized' || requests.kind === 'unauthorized') {
    redirect('/login?expired=1');
  }

  // A hint, not a gate — the action re-checks. Absent a readable session
  // projection we show the form and let the refusal explain itself, rather
  // than hiding the whole surface behind a failed side call.
  const sessionVerified = me.kind === 'ok' ? me.me.mfaVerified : true;
  const myRequests = requests.kind === 'ok' ? requests.requests : [];
  const mySeniors = seniors.kind === 'ok' ? seniors.seniors : [];

  return (
    <div className="dash-shell">
      <header className="dash-top">
        <span className="dash-brand">Taste &amp; See</span>
        <Link href="/dashboard" className="dash-logout">
          Back to dashboard
        </Link>
      </header>

      <main className="dash-main">
        <h1>Your privacy</h1>

        <p>
          Your information — and your loved one&apos;s — is yours. You can ask us for a copy of what
          we hold, or ask us to remove it. Tell us what you&apos;d like and we&apos;ll take it from
          there.
        </p>

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
                We gather what we hold about you across the service — your account, your visits,
                your messages with us — and prepare it for you. Some things we deliberately leave
                out, such as passwords and security details, and we&apos;ll tell you what those were
                and why.
              </p>
            </div>

            <div className="privacy-card">
              <h3>Removing your information</h3>
              <p>
                You can ask us to remove what we hold. We&apos;ll always answer — and we&apos;ll be
                straight with you about what we can and can&apos;t remove.{' '}
                <strong>Some records we have to keep</strong>: care and safety records, and
                financial records that go with payments we&apos;ve taken. Where we keep something,
                we&apos;ll tell you plainly which records and why, rather than quietly leaving them
                in place.
              </p>
            </div>
          </div>
        </section>

        <section className="privacy-section" aria-labelledby="make-a-request">
          <h2 id="make-a-request">Make a request</h2>

          {sessionVerified ? (
            <form action={filePrivacyRequestAction} className="concierge-emergency-form">
              <fieldset className="privacy-fieldset">
                <legend className="concierge-field__label">What would you like us to do?</legend>
                <label className="privacy-choice">
                  <input type="radio" name="kind" value="access" defaultChecked />
                  <span>Send me a copy of the information you hold</span>
                </label>
                <label className="privacy-choice">
                  <input type="radio" name="kind" value="erasure" />
                  <span>Remove the information you hold, where you&apos;re able to</span>
                </label>
              </fieldset>

              <div className="concierge-field">
                <label htmlFor="about" className="concierge-field__label">
                  Who is this about?
                </label>
                <span id="about-helper" className="concierge-field__helper">
                  If it&apos;s about someone you care for, we&apos;ll need to check with them first.
                  That takes a little longer, and sometimes the answer is theirs to give rather than
                  ours.
                </span>
                <select
                  id="about"
                  name="about"
                  className="concierge-field__control"
                  defaultValue="me"
                  aria-describedby="about-helper"
                >
                  <option value="me">Me — my own account</option>
                  {mySeniors.map((senior) => (
                    <option key={senior.seniorId} value={senior.seniorId}>
                      {senior.displayName ?? `${senior.firstName} ${senior.lastName}`}
                    </option>
                  ))}
                </select>
              </div>

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
                  placeholder="e.g. I’m mainly interested in the visit notes from this year."
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
                be certain who we&apos;re speaking to before we can accept it. Sign out and sign
                back in using your two-step code, and this form will be waiting for you.
              </p>
              <p>
                If you don&apos;t have a two-step code set up, or you&apos;d rather not use one, get
                in touch and we&apos;ll take your request another way —{' '}
                <Link href="/concierge/requests" className="link-inline">
                  ask your concierge
                </Link>{' '}
                and they&apos;ll help.
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
      </main>
    </div>
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
        About {request.selfService ? 'you' : subjectCopy(request.subjectKind)} · asked on{' '}
        {formatDate(request.receivedAt)}
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

/**
 * Status in the person's terms, not the system's.
 *
 * `received` and `verifying` are one thing to the person waiting — we have it
 * and we're getting to it — and splitting them would only invite the question
 * "what's the difference", whose honest answer is internal. `fulfilled` is
 * deliberately soft on HOW the answer arrives, because until TS-309b2 lands
 * there is no download to point at.
 */
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

function subjectCopy(subjectKind: DataSubjectRequestReceipt['subjectKind']): string {
  switch (subjectKind) {
    case 'senior':
      return 'someone you care for';
    case 'provider':
      return 'a care provider';
    case 'user':
      return 'another account';
  }
}

/**
 * Why we said no, in plain language.
 *
 * Each one names the actual reason rather than a generic apology, because a
 * refusal nobody can understand is the same as no answer at all. Note what is
 * NOT here: a legal citation. Which records must be kept, and under whose
 * rule, is legal reference data this platform does not author (TS-303a's
 * precedent, and TS-309c owns the schedule).
 */
function refusalCopy(reason: NonNullable<DataSubjectRequestReceipt['refusalReason']>): string {
  switch (reason) {
    case 'identity_not_verified':
      return 'We weren’t able to confirm who was asking, so we didn’t act on this one. You’re welcome to ask again — get in touch and we’ll help you through it.';
    case 'not_the_subject':
      return 'This request was about someone else, and we weren’t able to establish that you could ask on their behalf.';
    case 'subject_consent_absent':
      return 'This was about someone you care for, and they haven’t agreed to share this with us on your behalf. That decision is theirs, and we’ll respect it.';
    case 'retention_required':
      return 'We have to keep these particular records, so we weren’t able to remove them. Everything we could act on, we did.';
    case 'duplicate_request':
      return 'You already had an open request asking the same thing, so we’re handling it there.';
    case 'out_of_scope':
      return 'What was asked for isn’t personal information we hold about the person named.';
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
