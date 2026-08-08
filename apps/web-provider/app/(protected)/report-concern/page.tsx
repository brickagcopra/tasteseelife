import Link from 'next/link';
import type { Metadata } from 'next';

import { TRUST_SAFETY_REPORT_DESCRIPTION_MAX_LENGTH } from '@taste-and-see/contracts';

import { reportConcernAction } from './actions';

export const metadata: Metadata = {
  title: 'Report a concern — Taste & See Provider Portal',
};

/**
 * Report a concern — provider portal (TS-301b; PRD §10.14; PDD §16.1).
 *
 * The provider-side trust & safety intake, cloned from the family surface
 * (TS-301a) with provider-appropriate copy. Two things differ from the
 * family page beyond wording:
 *
 *   - **No household.** A provider's report concerns no household of their
 *     own; service-trust-safety files it with `source: 'provider'` anchored
 *     on the verified reporter id. Nothing identifying is posted.
 *   - **Mandated-reporter framing.** Providers are the people most likely to
 *     witness welfare concerns first-hand, and in many states they are
 *     mandated reporters (CLAUDE.md §12; PDD §16.1). The copy says plainly
 *     that reporting here does not discharge that duty and never counts
 *     against them — a provider who fears losing bookings for speaking up is
 *     a provider who stays quiet.
 *
 * Zero client JS: a plain server-action form, `?ref=` confirmation,
 * `?action=err&code=` errors (the provider portal has no flash channel).
 */

const CATEGORY_OPTIONS: ReadonlyArray<{ readonly value: string; readonly label: string }> = [
  { value: 'welfare', label: 'A worry about a client’s wellbeing' },
  { value: 'safety', label: 'A safety or security concern' },
  { value: 'billing', label: 'A payment or earnings concern' },
  { value: 'conduct', label: 'How someone behaved' },
];

const ERROR_COPY: Readonly<Record<string, string>> = {
  invalid: 'Please choose a topic and tell us what happened before sending.',
  failed: 'We couldn’t send that just now. Please try again in a moment.',
};

interface PageProps {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export default async function ReportConcernPage({
  searchParams,
}: PageProps): Promise<React.JSX.Element> {
  const params = await searchParams;
  const reference = typeof params['ref'] === 'string' ? params['ref'] : null;
  const errorCode =
    params['action'] === 'err' && typeof params['code'] === 'string' ? params['code'] : null;

  if (reference !== null) {
    return (
      <Shell>
        <h1>We&apos;ve received your report</h1>
        <p className="concierge-emergency-after" role="status">
          Thank you for raising this. Our trust &amp; safety team reviews every report promptly, and
          we&apos;ll be in touch if we need more detail from you.
        </p>
        <p>
          Your reference number is <strong>{reference}</strong>. Keep it handy if you call or write
          to us about this concern.
        </p>
        <p>
          If someone is in immediate danger, <strong>call 911 first</strong>. And if you are a
          mandated reporter in your state, filing here does not replace your reporting duty.
        </p>
        <p>
          <Link href="/dashboard" className="link-inline">
            Back to your dashboard
          </Link>
        </p>
      </Shell>
    );
  }

  return (
    <Shell>
      <h1>Report a concern</h1>

      {errorCode !== null ? (
        <p className="auth-alert" role="alert">
          {ERROR_COPY[errorCode] ?? ERROR_COPY['failed']}
        </p>
      ) : null}

      <p className="concierge-emergency-911" role="note">
        <strong>If someone is in immediate danger, call 911 first.</strong> This form reaches our
        trust &amp; safety team, who review every report — but it is not an emergency channel.
      </p>

      <p>
        You see things we can&apos;t. If something felt wrong on a visit — a client who seemed
        frightened or unwell, a home situation that worried you, conduct you don&apos;t want to let
        pass — tell us. Reporting a concern <strong>never counts against you</strong>, and we treat
        what you share with discretion.
      </p>

      <p className="concierge-emergency-911" role="note">
        If you are a <strong>mandated reporter</strong> in your state, filing here does not replace
        your legal reporting duty — please follow your state&apos;s process as well.
      </p>

      <form action={reportConcernAction} className="concierge-emergency-form">
        <div className="concierge-field">
          <label htmlFor="category" className="concierge-field__label">
            What is this about?
          </label>
          <select
            id="category"
            name="category"
            className="concierge-field__control"
            defaultValue="welfare"
          >
            {CATEGORY_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </div>

        <div className="concierge-field">
          <label htmlFor="description" className="concierge-field__label">
            What happened?
          </label>
          <span id="description-helper" className="concierge-field__helper">
            Tell us what you saw or heard — who was involved, when it happened, and what gave you
            pause. Plain language is fine; you don&apos;t need to be certain to raise it.
          </span>
          <textarea
            id="description"
            name="description"
            rows={6}
            required
            maxLength={TRUST_SAFETY_REPORT_DESCRIPTION_MAX_LENGTH}
            className="concierge-field__control"
            aria-describedby="description-helper"
            placeholder="e.g. On Tuesday’s visit the home was much colder than usual and…"
          />
        </div>

        <div className="concierge-actions">
          <button type="submit" className="concierge-emergency-cta">
            Send report
          </button>
        </div>
      </form>

      <p className="concierge-emergency-after">
        After you send this, our trust &amp; safety team reviews it promptly. You&apos;ll get a
        reference number right away, and we&apos;ll reach out if we need anything more.
      </p>
    </Shell>
  );
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
