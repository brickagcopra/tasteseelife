import Link from 'next/link';
import type { Metadata } from 'next';

import { CONCIERGE_EMERGENCY_NOTE_MAX_LENGTH } from '@taste-and-see/contracts';

import { triggerEmergencyAction } from './actions';

export const metadata: Metadata = {
  title: 'Emergency assistance — Taste & See',
};

/**
 * Emergency concierge assistance (TS-225; PRD §5.1 Tier 3).
 *
 * A deliberately simple, high-contrast surface: pick a category, optionally
 * add a line of context, and send. Triggering opens a high-severity ticket
 * and pages the on-call concierge supervisor. The copy is explicit that this
 * is NOT a substitute for 911 — for a life-threatening emergency, the family
 * should call emergency services first.
 *
 * Reachable by any household (no Tier-3 hard gate — blocking a safety surface
 * on a billing tier would be dangerous). The Tier-3 positioning lives in the
 * dashboard placement + copy, not a hard 403.
 */

const CATEGORY_OPTIONS: ReadonlyArray<{ readonly value: string; readonly label: string }> = [
  { value: 'medical', label: 'A medical concern' },
  { value: 'safety', label: 'A safety or security concern' },
  { value: 'urgent_need', label: 'An urgent need that can’t wait' },
  { value: 'other', label: 'Something else urgent' },
];

export default function ConciergeEmergencyPage(): React.JSX.Element {
  return (
    <Shell>
      <h1>Emergency assistance</h1>

      <p className="concierge-emergency-911" role="note">
        <strong>If this is a life-threatening emergency, call 911 first.</strong> This channel
        reaches our on-call concierge team right away, but it is not a substitute for emergency
        services.
      </p>

      <p>
        Tell us what’s happening and we’ll alert our on-call concierge supervisor immediately. Your
        family’s concierge will be paged and will reach out as fast as possible.
      </p>

      <form action={triggerEmergencyAction} className="concierge-emergency-form">
        <div className="concierge-field">
          <label htmlFor="category" className="concierge-field__label">
            What’s happening?
          </label>
          <select
            id="category"
            name="category"
            className="concierge-field__control"
            defaultValue="medical"
          >
            {CATEGORY_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </div>

        <div className="concierge-field">
          <label htmlFor="note" className="concierge-field__label">
            Anything we should know? <span className="concierge-field__optional">(optional)</span>
          </label>
          <span id="note-helper" className="concierge-field__helper">
            A quick line of context helps our team respond — but don’t wait on it if every second
            counts.
          </span>
          <textarea
            id="note"
            name="note"
            rows={3}
            maxLength={CONCIERGE_EMERGENCY_NOTE_MAX_LENGTH}
            className="concierge-field__control"
            aria-describedby="note-helper"
            placeholder="e.g. Mom isn’t answering the door and was expecting us."
          />
        </div>

        <div className="concierge-actions">
          <button type="submit" className="concierge-emergency-cta">
            Request emergency assistance now
          </button>
        </div>
      </form>

      <p className="concierge-emergency-after">
        After you send this, our team is alerted instantly. You’ll see this request in{' '}
        <Link href="/concierge/requests" className="link-inline">
          your requests
        </Link>{' '}
        with its status.
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
