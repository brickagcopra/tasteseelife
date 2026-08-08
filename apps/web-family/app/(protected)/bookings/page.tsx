import Link from 'next/link';
import { redirect } from 'next/navigation';
import type { Metadata } from 'next';
import { z } from 'zod';

import { callGateway } from '@/lib/api';
import { formatServiceKind, formatStatus, formatVisitTime, listBookings } from '@/lib/bookings-api';

export const metadata: Metadata = {
  title: 'Your visits — Taste & See',
};

const MeBodySchema = z.object({
  userId: z.string().min(1),
});

/**
 * Family-portal bookings list (TS-125).
 *
 * Server-rendered. Calls `GET /api/v1/bookings?householdId=<userId>`
 * via the BFF. Phase-1 uses the user's `me.userId` as the householdId
 * (same Phase-1 simplification as TS-124 and `/bookings/new`); the
 * household-svc-resolved householdId arrives with TS-125-followup-2.
 */
export default async function BookingsListPage({
  searchParams,
}: {
  readonly searchParams?: Promise<Record<string, string | string[] | undefined>>;
}): Promise<React.JSX.Element> {
  const params = (await searchParams) ?? {};
  const cursor = typeof params.cursor === 'string' ? params.cursor : undefined;

  const meResult = await callGateway<unknown>('/api/v1/me');
  if (meResult.kind === 'unauthorized') {
    redirect('/login?expired=1');
  }
  if (meResult.kind !== 'ok') {
    return renderUnreachable();
  }
  const me = MeBodySchema.safeParse(meResult.body);
  if (!me.success) {
    return renderUnreachable();
  }

  const result = await listBookings({
    householdId: me.data.userId,
    ...(cursor !== undefined && { cursor }),
  });
  if (result.kind === 'unauthorized') {
    redirect('/login?expired=1');
  }

  return (
    <div className="dash-shell">
      <header className="dash-top">
        <span className="dash-brand">Taste &amp; See</span>
        <Link href="/dashboard" className="dash-logout">
          Dashboard
        </Link>
      </header>
      <main className="dash-main">
        <h1>Your visits</h1>
        <p>
          Each visit lives here. Tap into one to see who&apos;s coming, what they&apos;ll cook, and
          how to reach the concierge if anything changes.
        </p>

        {result.kind !== 'ok' ? (
          <p className="providers-empty">
            We couldn&apos;t load your visits. Please refresh in a moment.
          </p>
        ) : result.bookings.length === 0 ? (
          <div className="providers-empty">
            <p>No visits yet. Pick a chef and we&apos;ll start there.</p>
            <Link href="/providers" className="plans-cta">
              Browse providers
            </Link>
          </div>
        ) : (
          <>
            <ul className="bookings-list">
              {result.bookings.map((b) => (
                <li key={b.id} className="bookings-card">
                  <header className="bookings-card-head">
                    <h2>{formatServiceKind(b.serviceKind)}</h2>
                    <span className={`bookings-status bookings-status--${b.status}`}>
                      {formatStatus(b.status)}
                    </span>
                  </header>
                  <p className="bookings-time">{formatVisitTime(b.scheduledStart)}</p>
                  <p className="bookings-meta">Reference {b.id}</p>
                  <footer className="bookings-card-foot">
                    <Link href={`/bookings/${encodeURIComponent(b.id)}`} className="link-inline">
                      View details
                    </Link>
                  </footer>
                </li>
              ))}
            </ul>
            {result.nextCursor !== null ? (
              <div className="bookings-more">
                <Link
                  href={`/bookings?cursor=${encodeURIComponent(result.nextCursor)}`}
                  className="link-inline"
                >
                  Load earlier visits
                </Link>
              </div>
            ) : null}
          </>
        )}
      </main>
    </div>
  );
}

function renderUnreachable(): React.JSX.Element {
  return (
    <div className="dash-shell">
      <main className="dash-main">
        <h1>We&apos;re having a moment</h1>
        <p>Our service is briefly unreachable. Please refresh in a few seconds.</p>
        <Link href="/dashboard" className="link-back">
          Back to dashboard
        </Link>
      </main>
    </div>
  );
}
