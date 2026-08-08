import Link from 'next/link';
import type { Metadata } from 'next';

import { TRUST_SAFETY_REPORT_DESCRIPTION_MAX_LENGTH } from '@taste-and-see/contracts';

import { reportConcernAction } from './actions';

export const metadata: Metadata = {
  title: 'Report a concern — Taste & See',
};

/**
 * Report a concern (TS-301a; PRD §10.14; PDD §16.1).
 *
 * The family/senior trust & safety intake — a deliberately simple,
 * high-contrast surface cloned from the emergency page (TS-225): pick a
 * topic, tell us what happened, send. Filing opens a trust & safety
 * incident reviewed by our care team; the copy is explicit that for
 * immediate danger 911 comes first. On success (`?ref=` from the action's
 * redirect) the page renders the confirmation with the reference id and
 * "what happens next" reassurance — zero client JS throughout.
 */

const CATEGORY_OPTIONS: ReadonlyArray<{ readonly value: string; readonly label: string }> = [
  { value: 'welfare', label: 'A worry about my loved one’s wellbeing' },
  { value: 'safety', label: 'A safety or security concern' },
  { value: 'billing', label: 'A billing or payment concern' },
  { value: 'conduct', label: 'How someone behaved' },
];

interface PageProps {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export default async function ReportConcernPage({
  searchParams,
}: PageProps): Promise<React.JSX.Element> {
  const params = await searchParams;
  const reference = typeof params['ref'] === 'string' ? params['ref'] : null;

  if (reference !== null) {
    return (
      <Shell>
        <h1>We&apos;ve received your report</h1>
        <p className="concierge-emergency-after" role="status">
          Thank you for telling us. Our care team reviews every concern — someone will look at this
          one promptly, and we&apos;ll reach out if we need anything more from you.
        </p>
        <p>
          Your reference number is <strong>{reference}</strong>. Keep it handy if you call or write
          to us about this concern.
        </p>
        <p>
          If the situation changes or someone is in immediate danger,{' '}
          <strong>call 911 first</strong> — then reach our on-call team via{' '}
          <Link href="/concierge/emergency" className="link-inline">
            emergency assistance
          </Link>
          .
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

      <p className="concierge-emergency-911" role="note">
        <strong>If someone is in immediate danger, call 911 first.</strong> This form reaches our
        trust &amp; safety team, who review every report — but it is not an emergency channel. For
        urgent help, use{' '}
        <Link href="/concierge/emergency" className="link-inline">
          emergency assistance
        </Link>
        .
      </p>

      <p>
        Something on your mind? Tell us. Whether it&apos;s a worry about your loved one, a visit
        that didn&apos;t feel right, or a charge you don&apos;t recognise — we take every concern
        seriously, and we&apos;ll treat what you share with care and discretion.
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
            Share as much as you&apos;re comfortable with — who was involved, when it happened, and
            anything that felt wrong. There&apos;s no wrong way to say it.
          </span>
          <textarea
            id="description"
            name="description"
            rows={6}
            required
            maxLength={TRUST_SAFETY_REPORT_DESCRIPTION_MAX_LENGTH}
            className="concierge-field__control"
            aria-describedby="description-helper"
            placeholder="e.g. During Tuesday’s visit, Dad seemed unusually withdrawn, and…"
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
