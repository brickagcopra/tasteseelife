import Link from 'next/link';
import { redirect } from 'next/navigation';
import type { Metadata } from 'next';

import {
  CONCIERGE_TICKET_BODY_MAX_LENGTH,
  CONCIERGE_TICKET_PARTY_SIZE_MAX,
  CONCIERGE_TICKET_PARTY_SIZE_MIN,
  CONCIERGE_TICKET_SUBJECT_MAX_LENGTH,
  CONCIERGE_TICKET_THEME_MAX_LENGTH,
  type ConciergeTicketRecord,
} from '@taste-and-see/contracts';

import { getMyConcierge, type MyConciergeResult } from '@/lib/concierge-api';
import {
  listMyConciergeRequests,
  type ConciergeRequestsListResult,
} from '@/lib/concierge-requests-api';

import { submitConciergeRequestAction } from './actions';

export const metadata: Metadata = {
  title: 'Concierge requests — Taste & See',
};

/**
 * Concierge custom-request submission (TS-223; PRD §6.6).
 *
 * The family submits a structured service request — a free-text body plus
 * optional date / party size / theme — under one of the PRD §6.6 request
 * kinds. service-concierge routes it to the household's active dedicated
 * concierge (when one exists) and stamps a per-kind SLA. Below the form we
 * list the household's submitted requests with their status.
 *
 * No hard Tier-3 gate (that needs a cross-service tier read — deferred, the
 * same posture as TS-222). A household with no dedicated concierge still
 * submits; the request lands in the ops queue and the intro copy adapts.
 */
const KIND_OPTIONS: ReadonlyArray<{ readonly value: string; readonly label: string }> = [
  { value: 'custom_request', label: 'Custom request' },
  { value: 'holiday_dinner', label: 'Holiday dinner' },
  { value: 'birthday_experience', label: 'Birthday experience' },
  { value: 'grocery_stocking', label: 'Grocery stocking' },
  { value: 'tea_social', label: 'Tea social' },
  { value: 'museum_outing', label: 'Museum outing' },
  { value: 'memory_meal', label: 'Memory meal' },
];

const KIND_LABELS: Record<ConciergeTicketRecord['kind'], string> = {
  custom_request: 'Custom request',
  holiday_dinner: 'Holiday dinner',
  birthday_experience: 'Birthday experience',
  grocery_stocking: 'Grocery stocking',
  tea_social: 'Tea social',
  museum_outing: 'Museum outing',
  memory_meal: 'Memory meal',
  transportation: 'Transportation',
  emergency_assistance: 'Emergency assistance',
};

const STATUS_LABELS: Record<ConciergeTicketRecord['status'], string> = {
  open: 'Received',
  assigned: 'With your concierge',
  in_progress: 'In progress',
  escalated: 'Escalated',
  resolved: 'Completed',
  canceled: 'Canceled',
};

export default async function ConciergeRequestsPage(): Promise<React.JSX.Element> {
  const [concierge, requests] = await Promise.all([getMyConcierge(), listMyConciergeRequests()]);

  if (requests.kind === 'unauthorized') {
    redirect('/login?expired=1');
  }

  return (
    <Shell>
      <h1>Make a request</h1>
      <Intro concierge={concierge} />

      <form action={submitConciergeRequestAction} className="concierge-form">
        <div className="concierge-field">
          <label htmlFor="kind" className="concierge-field__label">
            What can we arrange?
          </label>
          <select
            id="kind"
            name="kind"
            className="concierge-field__control"
            defaultValue="custom_request"
          >
            {KIND_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </div>

        <div className="concierge-field">
          <label htmlFor="subject" className="concierge-field__label">
            A short title
          </label>
          <input
            id="subject"
            name="subject"
            type="text"
            required
            maxLength={CONCIERGE_TICKET_SUBJECT_MAX_LENGTH}
            className="concierge-field__control"
            placeholder="e.g. Sunday birthday lunch for Dad"
          />
        </div>

        <div className="concierge-field">
          <label htmlFor="body" className="concierge-field__label">
            Tell us more
          </label>
          <span id="body-helper" className="concierge-field__helper">
            Share anything that helps us get it right — favourite dishes, who&apos;s coming, the
            mood you&apos;re hoping for.
          </span>
          <textarea
            id="body"
            name="body"
            required
            rows={4}
            maxLength={CONCIERGE_TICKET_BODY_MAX_LENGTH}
            className="concierge-field__control"
            aria-describedby="body-helper"
            placeholder="What would make this special?"
          />
        </div>

        <div className="concierge-field-row">
          <div className="concierge-field">
            <label htmlFor="requestedDate" className="concierge-field__label">
              Preferred date <span className="concierge-field__optional">(optional)</span>
            </label>
            <input
              id="requestedDate"
              name="requestedDate"
              type="date"
              className="concierge-field__control"
            />
          </div>
          <div className="concierge-field">
            <label htmlFor="partySize" className="concierge-field__label">
              Party size <span className="concierge-field__optional">(optional)</span>
            </label>
            <input
              id="partySize"
              name="partySize"
              type="number"
              min={CONCIERGE_TICKET_PARTY_SIZE_MIN}
              max={CONCIERGE_TICKET_PARTY_SIZE_MAX}
              className="concierge-field__control"
              placeholder="e.g. 6"
            />
          </div>
        </div>

        <div className="concierge-field">
          <label htmlFor="theme" className="concierge-field__label">
            Theme or occasion <span className="concierge-field__optional">(optional)</span>
          </label>
          <input
            id="theme"
            name="theme"
            type="text"
            maxLength={CONCIERGE_TICKET_THEME_MAX_LENGTH}
            className="concierge-field__control"
            placeholder="e.g. Italian Sunday supper"
          />
        </div>

        <div className="concierge-actions">
          <button type="submit" className="plans-cta">
            Send to your concierge
          </button>
        </div>
      </form>

      <RequestsList requests={requests} />
    </Shell>
  );
}

function Intro({ concierge }: { readonly concierge: MyConciergeResult }): React.JSX.Element {
  if (concierge.kind === 'assigned') {
    const firstName = concierge.assignment.primaryConciergeDisplayName.split(' ')[0];
    return (
      <p>
        Tell us what you have in mind and{' '}
        <strong>{concierge.assignment.primaryConciergeDisplayName}</strong>, your family&apos;s
        dedicated concierge, will take it from there. {firstName} will follow up to confirm the
        details.
      </p>
    );
  }
  return (
    <p>
      Tell us what you have in mind and our concierge team will take it from there. We&apos;ll
      follow up to confirm the details.
    </p>
  );
}

function RequestsList({
  requests,
}: {
  readonly requests: ConciergeRequestsListResult;
}): React.JSX.Element {
  if (requests.kind !== 'ok') {
    return (
      <section className="concierge-history" aria-label="Your requests">
        <h2>Your requests</h2>
        <p className="providers-empty">
          We couldn&apos;t load your recent requests right now. Please refresh in a moment.
        </p>
      </section>
    );
  }

  if (requests.tickets.length === 0) {
    return (
      <section className="concierge-history" aria-label="Your requests">
        <h2>Your requests</h2>
        <p className="providers-empty">
          You haven&apos;t made a request yet. When you do, you&apos;ll see it here with its status.
        </p>
      </section>
    );
  }

  return (
    <section className="concierge-history" aria-label="Your requests">
      <h2>Your requests</h2>
      <ul className="concierge-list">
        {requests.tickets.map((ticket) => (
          <li key={ticket.id} className="concierge-request-card">
            <div className="concierge-request-card__head">
              <span className="concierge-request-card__subject">{ticket.subject}</span>
              <span className={`concierge-status concierge-status--${ticket.status}`}>
                {STATUS_LABELS[ticket.status]}
              </span>
            </div>
            <p className="concierge-request-card__meta">
              {KIND_LABELS[ticket.kind]}
              {ticket.requestedDate !== null && ` · ${ticket.requestedDate}`}
              {ticket.partySize !== null && ` · party of ${ticket.partySize}`}
            </p>
            <p className="concierge-request-card__body">{ticket.body}</p>
          </li>
        ))}
      </ul>
    </section>
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
