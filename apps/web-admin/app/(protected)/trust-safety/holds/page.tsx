import { redirect } from 'next/navigation';
import Link from 'next/link';
import type { Metadata } from 'next';
import {
  BOOKING_HOLD_LIMIT_DEFAULT,
  BookingHoldListResponseSchema,
  MeResponseSchema,
  type BookingHoldListResponse,
  type MeResponse,
} from '@taste-and-see/contracts';

import { callGateway } from '@/lib/api';
import { hasPermission } from '@/lib/admin-gate';
import { readOffset } from '@/lib/search-params';
import { groupByIncident, type HoldGroup } from '@/lib/trust-safety-view';

export const metadata: Metadata = {
  title: 'Booking holds — Taste & See Admin',
};

/**
 * Active booking holds (TS-304-followup-3; PRD §10.14, PDD §16.1;
 * CLAUDE.md §12).
 *
 * The question a committee asks before it deliberates: **how much care
 * is this hold interrupting.** TS-304 made a high-severity incident
 * suspend the subject's bookings, but `booking_subject_holds` was
 * queryable only in-process — so the suspension was enforced and
 * invisible, and nobody could weigh it.
 *
 * **Read-only, and it stays that way.** There is no lift control here
 * and there is no endpoint behind one. A hold is placed by an incident
 * and lifted by the committee closing that incident; a button here
 * would be a way to un-suspend a provider without touching the incident
 * that suspended them.
 *
 * **Rows are grouped by incident on screen**, because the booking count
 * is per-incident. An incident that named a provider and a household
 * produces two rows carrying the *same* number for the *same* set of
 * bookings — reading them as one group is what stops an operator
 * doubling the figure they report to the committee.
 *
 * Gated `trust_safety:read`. The incident link is rendered only for a
 * viewer who also holds `trust_safety:write`, which is what the
 * incident detail requires — a link that always bounces reads as a
 * broken console, not as a boundary.
 */

interface ListFilters {
  readonly status: 'active' | 'released' | 'all';
  readonly offset: number;
}

export default async function BookingHoldsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}): Promise<React.JSX.Element> {
  const params = await searchParams;

  const me = await fetchMe();
  if (me === null) {
    return (
      <div className="dash-shell">
        <main className="dash-main">
          <h1>We&apos;re having a moment</h1>
          <p>Our service is briefly unreachable. Please refresh in a few seconds.</p>
        </main>
      </div>
    );
  }
  if (!me.mfaVerified) redirect('/login?expired=1');
  if (!hasPermission(me, 'trust_safety:read')) redirect('/dashboard/no-access');

  const canOpenIncident = hasPermission(me, 'trust_safety:write');

  const filters: ListFilters = {
    status: statusParam(params['status']),
    offset: readOffset(params['offset']),
  };

  const list = await fetchHolds(filters);

  return (
    <div className="dash-shell">
      <div className="admin-banner">
        <span>Admin console — booking holds</span>
        <span className="admin-banner__operator" title={me.userId}>
          {me.userId}
        </span>
      </div>
      <header className="dash-top">
        <span className="dash-brand">Taste &amp; See — Admin</span>
        <div className="dash-account">
          <Link href="/trust-safety/incidents" className="dash-logout">
            Incident queue
          </Link>
        </div>
      </header>
      <main className="dash-main">
        <h1>Booking holds</h1>
        <p>
          Visits suspended because a trust &amp; safety incident named the provider, the senior, or
          the household. A hold is lifted by resolving the incident that placed it — there is no
          control here, by design.
        </p>

        <HoldFilters initial={filters} />

        {list === null ? (
          <p className="auth-alert" role="alert">
            We couldn&apos;t load the hold list. The booking service may be unreachable — do not
            read this as &ldquo;nothing is on hold&rdquo;. Enforcement is unaffected: holds are
            applied in service-booking and do not depend on this page.
          </p>
        ) : (
          <HoldList list={list} filters={filters} canOpenIncident={canOpenIncident} />
        )}
      </main>
    </div>
  );
}

function HoldFilters({ initial }: { readonly initial: ListFilters }): React.JSX.Element {
  return (
    <form action="/trust-safety/holds" method="get" className="filter-bar" role="search">
      <label className="filter-bar__field">
        <span>Show</span>
        <select name="status" defaultValue={initial.status}>
          <option value="active">Active holds</option>
          <option value="released">Released holds</option>
          <option value="all">All holds</option>
        </select>
      </label>
      <div className="filter-bar__actions">
        <button type="submit" className="filter-bar__submit">
          Apply
        </button>
        <Link href="/trust-safety/holds" className="filter-bar__reset">
          Reset
        </Link>
      </div>
    </form>
  );
}

function HoldList({
  list,
  filters,
  canOpenIncident,
}: {
  readonly list: BookingHoldListResponse;
  readonly filters: ListFilters;
  readonly canOpenIncident: boolean;
}): React.JSX.Element {
  if (list.holds.length === 0) {
    return (
      <div className="user-empty">
        <p>
          {filters.status === 'active'
            ? 'Nothing is currently on hold.'
            : 'No holds match this filter.'}
        </p>
      </div>
    );
  }

  const groups = groupByIncident(list.holds);
  const first = list.offset + 1;
  const last = list.offset + list.holds.length;

  return (
    <>
      <p className="user-detail__hint">
        Showing {first}–{last} of {list.total} hold {list.total === 1 ? 'row' : 'rows'} across{' '}
        {groups.length} {groups.length === 1 ? 'incident' : 'incidents'} on this page. One incident
        can hold several subjects — the suspended-visit count belongs to the incident, not to each
        subject, so it is stated once per group and must not be added up.
      </p>

      {groups.map((group) => (
        <HoldGroupCard key={group.incidentId} group={group} canOpenIncident={canOpenIncident} />
      ))}

      <Pagination list={list} filters={filters} />
    </>
  );
}

function HoldGroupCard({
  group,
  canOpenIncident,
}: {
  readonly group: HoldGroup;
  readonly canOpenIncident: boolean;
}): React.JSX.Element {
  return (
    <section className="user-detail__section">
      <h2>
        {canOpenIncident ? (
          <Link href={`/trust-safety/incidents/${encodeURIComponent(group.incidentId)}`}>
            Incident {group.incidentId}
          </Link>
        ) : (
          <>Incident {group.incidentId}</>
        )}
      </h2>
      <p className="user-detail__hint">
        {group.severity} · {group.category} ·{' '}
        {group.suspendedBookingCount === 0
          ? 'no visits currently suspended by this incident'
          : `${group.suspendedBookingCount} ${
              group.suspendedBookingCount === 1 ? 'visit' : 'visits'
            } currently suspended by this incident`}
        {!canOpenIncident && ' · reading the report needs trust_safety:write'}
      </p>
      <div className="user-table" role="table" aria-label={`Subjects held by ${group.incidentId}`}>
        <div className="user-table__head" role="row">
          <span role="columnheader">Subject</span>
          <span role="columnheader">Id</span>
          <span role="columnheader">Held since</span>
          <span role="columnheader">Released</span>
        </div>
        {group.rows.map((row) => (
          <div className="user-row" role="row" key={row.id}>
            <span role="cell">
              {row.subjectKind}
              {row.releasedAt === null && (
                <span className="user-row__chip user-row__chip--warn">on hold</span>
              )}
            </span>
            <span role="cell">
              {row.subjectKind === 'provider' ? (
                <Link href={`/providers/${encodeURIComponent(row.subjectId)}/360`}>
                  {row.subjectId}
                </Link>
              ) : (
                <code>{row.subjectId}</code>
              )}
            </span>
            <span role="cell" className="user-row__date">
              {formatTimestamp(row.heldAt)}
            </span>
            <span role="cell" className="user-row__date">
              {row.releasedAt === null ? '—' : formatTimestamp(row.releasedAt)}
            </span>
          </div>
        ))}
      </div>
    </section>
  );
}

function Pagination({
  list,
  filters,
}: {
  readonly list: BookingHoldListResponse;
  readonly filters: ListFilters;
}): React.JSX.Element {
  const hasPrev = list.offset > 0;
  const hasNext = list.offset + list.holds.length < list.total;
  if (!hasPrev && !hasNext) return <p className="user-pagination">End of list.</p>;

  return (
    <p className="user-pagination">
      {hasPrev && (
        <Link
          href={`/trust-safety/holds?${queryString(filters, Math.max(0, list.offset - list.limit))}`}
          className="filter-bar__submit"
        >
          ← Previous
        </Link>
      )}{' '}
      {hasNext && (
        <Link
          href={`/trust-safety/holds?${queryString(filters, list.offset + list.limit)}`}
          className="filter-bar__submit"
        >
          Next page →
        </Link>
      )}
    </p>
  );
}

// ─────────────────────────────────────────────────────────────────────
// Data + params
// ─────────────────────────────────────────────────────────────────────

async function fetchMe(): Promise<MeResponse | null> {
  const result = await callGateway<unknown>('/api/v1/me');
  if (result.kind === 'unauthorized') redirect('/login?expired=1');
  if (result.kind !== 'ok') return null;
  const parsed = MeResponseSchema.safeParse(result.body);
  return parsed.success ? parsed.data : null;
}

async function fetchHolds(filters: ListFilters): Promise<BookingHoldListResponse | null> {
  const result = await callGateway<unknown>(
    `/api/v1/admin/booking-holds?${queryString(filters, filters.offset)}`,
  );
  if (result.kind === 'unauthorized') redirect('/login?expired=1');
  if (result.kind !== 'ok') return null;
  const parsed = BookingHoldListResponseSchema.safeParse(result.body);
  return parsed.success ? parsed.data : null;
}

function queryString(filters: ListFilters, offset: number): string {
  const params = new URLSearchParams();
  params.set('status', filters.status);
  params.set('limit', String(BOOKING_HOLD_LIMIT_DEFAULT));
  if (offset > 0) params.set('offset', String(offset));
  return params.toString();
}

function statusParam(value: string | string[] | undefined): ListFilters['status'] {
  if (value === 'released' || value === 'all') return value;
  return 'active';
}

function formatTimestamp(iso: string): string {
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return iso;
  return parsed.toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
}
