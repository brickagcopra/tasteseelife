import { notFound, redirect } from 'next/navigation';
import Link from 'next/link';
import type { Metadata } from 'next';
import {
  AdminPeriodEventsListResponseSchema,
  MeResponseSchema,
  PeriodNameSchema,
  type AdminPeriodEvent,
  type AdminPeriodEventsListResponse,
  type MeResponse,
} from '@taste-and-see/contracts';

import { callGateway } from '@/lib/api';
import { hasSuperAdminRole } from '@/lib/admin-gate';

export const metadata: Metadata = {
  title: 'Period events — Taste & See Admin',
};

/**
 * Per-period lifecycle events list (TS-129 Slice 1; closes
 * TS-085-followup-7).
 *
 * Newest-first. Cursor-paginated. Renders the full audit trail of
 * close + reopen transitions for one accounting period — useful for
 * the finance close runbook + post-close reviews.
 */
export default async function PeriodEventsPage({
  params,
  searchParams,
}: {
  params: Promise<{ readonly periodName: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}): Promise<React.JSX.Element> {
  const { periodName } = await params;
  const sp = await searchParams;

  const me = await fetchMe();
  if (me === null) {
    return (
      <div className="dash-shell">
        <ServiceWarning />
      </div>
    );
  }
  if (!me.mfaVerified) redirect('/login?expired=1');
  if (!hasSuperAdminRole(me)) redirect('/dashboard/no-access');

  // Defence-in-depth: malformed periodName surfaces as 404 client-side
  // rather than relying on the downstream 422.
  const parsedName = PeriodNameSchema.safeParse(periodName);
  if (!parsedName.success) notFound();

  const cursor = stringParam(sp['cursor']);
  const list = await fetchEvents(periodName, cursor);
  if (list === 'not_found') notFound();

  return (
    <div className="dash-shell">
      <div className="admin-banner">
        <span>Admin console — period events</span>
        <span className="admin-banner__operator" title={me.userId}>
          {me.userId}
        </span>
      </div>
      <header className="dash-top">
        <span className="dash-brand">Taste &amp; See — Admin</span>
        <div className="dash-account">
          <Link href="/accounting" className="dash-logout">
            ← Accounting
          </Link>
        </div>
      </header>
      <main className="dash-main">
        <h1>Period {periodName}</h1>
        <p>
          Lifecycle audit for accounting period <strong>{periodName}</strong>. Every close and
          reopen records the actor, the reason code, and the originating source-event id.
        </p>

        <PeriodPicker currentName={periodName} />

        {list === null ? (
          <p className="auth-alert">
            We couldn&apos;t load the period events right now. The downstream accounting service may
            be unreachable.
          </p>
        ) : (
          <EventsTable list={list} periodName={periodName} />
        )}
      </main>
    </div>
  );
}

function PeriodPicker({ currentName }: { readonly currentName: string }): React.JSX.Element {
  return (
    <p className="user-detail__sub">
      Looking at <strong>{currentName}</strong>. Change the period via the URL — e.g.{' '}
      <code>/accounting/periods/2026-04/events</code>. A full period picker UI lands once the period
      catalog browser ships as a follow-up.
    </p>
  );
}

function EventsTable({
  list,
  periodName,
}: {
  readonly list: AdminPeriodEventsListResponse;
  readonly periodName: string;
}): React.JSX.Element {
  if (list.events.length === 0) {
    return (
      <div className="user-empty">
        <p>No lifecycle events recorded for this period.</p>
      </div>
    );
  }
  return (
    <>
      <div className="user-table" role="table" aria-label="Period lifecycle events">
        <div className="user-table__head" role="row">
          <span role="columnheader">Action</span>
          <span role="columnheader">Reason</span>
          <span role="columnheader">Occurred</span>
          <span role="columnheader">Actor</span>
        </div>
        {list.events.map((event) => (
          <EventRow key={event.id} event={event} />
        ))}
      </div>
      {list.nextCursor !== null ? (
        <p className="user-pagination">
          <Link
            href={`/accounting/periods/${encodeURIComponent(periodName)}/events?cursor=${encodeURIComponent(list.nextCursor)}`}
            className="filter-bar__submit"
          >
            Next page →
          </Link>
        </p>
      ) : (
        <p className="user-pagination">End of list.</p>
      )}
    </>
  );
}

function EventRow({ event }: { readonly event: AdminPeriodEvent }): React.JSX.Element {
  return (
    <div key={event.id} className="user-row" role="row">
      <span role="cell">
        <span
          className={`user-row__status user-row__status--${event.kind === 'close' ? 'suspended' : 'active'}`}
        >
          {event.kind}
        </span>
      </span>
      <span role="cell">
        <span className="user-row__email">{event.reasonCode}</span>
        {event.description !== null && (
          <span className="user-row__date"> — {event.description}</span>
        )}
      </span>
      <span role="cell" className="user-row__date">
        {formatDateTime(event.occurredAt)}
      </span>
      <span role="cell">{event.actorUserId}</span>
    </div>
  );
}

function ServiceWarning(): React.JSX.Element {
  return (
    <main className="dash-main">
      <h1>We&apos;re having a moment</h1>
      <p>
        Our service is briefly unreachable. Please refresh in a few seconds — and if it persists,
        our team is already on it.
      </p>
    </main>
  );
}

async function fetchMe(): Promise<MeResponse | null> {
  const result = await callGateway<unknown>('/api/v1/me');
  if (result.kind === 'unauthorized') {
    redirect('/login?expired=1');
  }
  if (result.kind !== 'ok') return null;
  const parsed = MeResponseSchema.safeParse(result.body);
  return parsed.success ? parsed.data : null;
}

async function fetchEvents(
  periodName: string,
  cursor: string | null,
): Promise<AdminPeriodEventsListResponse | null | 'not_found'> {
  const query = new URLSearchParams();
  query.set('limit', '25');
  if (cursor !== null) query.set('cursor', cursor);
  const path = `/api/v1/admin/periods/${encodeURIComponent(periodName)}/events?${query.toString()}`;

  const result = await callGateway<unknown>(path);
  if (result.kind === 'unauthorized') {
    redirect('/login?expired=1');
  }
  if (result.kind === 'client_error' && result.status === 404) {
    return 'not_found';
  }
  if (result.kind !== 'ok') return null;
  const parsed = AdminPeriodEventsListResponseSchema.safeParse(result.body);
  return parsed.success ? parsed.data : null;
}

function stringParam(value: string | string[] | undefined): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

function formatDateTime(iso: string): string {
  try {
    return new Date(iso).toLocaleString('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return iso;
  }
}
