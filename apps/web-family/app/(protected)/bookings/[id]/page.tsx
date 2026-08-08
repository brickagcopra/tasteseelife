import Link from 'next/link';
import { redirect } from 'next/navigation';
import type { Metadata } from 'next';

import { formatServiceKind, formatStatus, formatVisitTime, getBooking } from '@/lib/bookings-api';

export const metadata: Metadata = {
  title: 'Visit details — Taste & See',
};

/**
 * Family-portal booking detail page (TS-125).
 *
 * Reads the booking via the gateway. `?requested=1` triggers the
 * "thanks for the request — concierge is on it" callout so the
 * confirmation-receipt UX is immediate after a successful submit.
 *
 * Self-service cancel is captured as TS-125-followup-4 — for Phase 1
 * the family asks concierge via the in-app messaging surface (TS-070
 * placeholder) or by replying to the confirmation email.
 */
export default async function BookingDetailPage({
  params,
  searchParams,
}: {
  readonly params: Promise<{ readonly id: string }>;
  readonly searchParams?: Promise<Record<string, string | string[] | undefined>>;
}): Promise<React.JSX.Element> {
  const { id } = await params;
  const qp = (await searchParams) ?? {};
  const justRequested = qp.requested === '1';

  const result = await getBooking(id);
  if (result.kind === 'unauthorized') {
    redirect('/login?expired=1');
  }
  if (result.kind === 'not_found') {
    return (
      <div className="dash-shell">
        <main className="dash-main">
          <h1>That visit isn&apos;t here</h1>
          <p>It may have been canceled, or the reference is wrong.</p>
          <Link href="/bookings" className="plans-cta">
            See your visits
          </Link>
        </main>
      </div>
    );
  }
  if (result.kind !== 'ok') {
    return (
      <div className="dash-shell">
        <main className="dash-main">
          <h1>We&apos;re having a moment</h1>
          <p>Visit details are briefly unreachable. Please refresh in a moment.</p>
          <Link href="/bookings" className="link-back">
            Back to your visits
          </Link>
        </main>
      </div>
    );
  }

  const b = result.booking;

  return (
    <div className="dash-shell">
      <header className="dash-top">
        <span className="dash-brand">Taste &amp; See</span>
        <Link href="/bookings" className="dash-logout">
          Back to visits
        </Link>
      </header>
      <main className="dash-main">
        <article className="booking-detail">
          {justRequested ? (
            <div className="booking-thanks" role="status">
              <h2>Your request is in.</h2>
              <p>
                Our concierge team will confirm the date and time with you and the chef within 24
                hours. We&apos;ll send a note as soon as it&apos;s set.
              </p>
            </div>
          ) : null}
          <header className="booking-detail-head">
            <h1>{formatServiceKind(b.serviceKind)}</h1>
            <span className={`bookings-status bookings-status--${b.status}`}>
              {formatStatus(b.status)}
            </span>
          </header>
          {/*
            TS-304-followup-1 — ABOVE the schedule, not below it. The whole
            point is that a family should not read the date and time of a visit
            that is not going to happen. Copy is TS-304's booking-create 409
            verbatim in substance: temporarily unavailable, no reason given,
            points at a human (CLAUDE.md §3.9, §12).
          */}
          {b.onHold ? (
            <p className="visit-card__hold" role="status">
              This visit is temporarily unavailable while our care team completes a review. Please
              contact support and we will help you arrange it.
            </p>
          ) : null}
          <dl className="booking-detail-meta">
            <dt>Scheduled</dt>
            <dd>
              {formatVisitTime(b.scheduledStart)} – {formatVisitTime(b.scheduledEnd)}
            </dd>
            <dt>Reference</dt>
            <dd>{b.id}</dd>
            <dt>Provider</dt>
            <dd>
              <Link href={`/providers/${encodeURIComponent(b.providerId)}`} className="link-inline">
                See profile
              </Link>
            </dd>
            {b.bookingNotes !== null && b.bookingNotes.length > 0 ? (
              <>
                <dt>Notes for the visit</dt>
                <dd>{b.bookingNotes}</dd>
              </>
            ) : null}
          </dl>
          {b.status === 'canceled' && b.cancellationReason !== null ? (
            <p className="booking-canceled">
              This visit was canceled ({b.cancellationReason.replace(/_/g, ' ')}).
              {b.cancellationReasonText !== null ? ` Note: ${b.cancellationReasonText}` : null}
            </p>
          ) : null}
          <footer className="booking-detail-foot">
            <p>
              Need to change or cancel? Reply to your confirmation email or message our concierge
              from your dashboard.
            </p>
          </footer>
        </article>
      </main>
    </div>
  );
}
