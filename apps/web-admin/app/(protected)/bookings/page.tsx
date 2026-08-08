import { redirect } from 'next/navigation';
import Link from 'next/link';
import type { Metadata } from 'next';
import {
  AdminBookingsListResponseSchema,
  MeResponseSchema,
  type AdminBookingSummary,
  type AdminBookingsListResponse,
  type MeResponse,
} from '@taste-and-see/contracts';

import { callGateway } from '@/lib/api';
import { hasSuperAdminRole } from '@/lib/admin-gate';

export const metadata: Metadata = {
  title: 'Bookings — Taste & See Admin',
};

/**
 * Admin bookings list (TS-128 Slice 1; PRD §10.5).
 *
 * Server-rendered list with five filter affordances (household id,
 * provider id, senior id, service kind, status) and cursor pagination.
 * Each row links to `/bookings/[id]` for the full detail view. Filters
 * round-trip through the URL query so a bookmarked search re-runs on
 * load.
 *
 * The page enforces three gates on every request:
 *   1. Authenticated (cookie present).
 *   2. MFA-verified.
 *   3. Active super_admin role — Phase-1 only super_admins land on
 *      admin tooling; other admin roles bounce to /dashboard/no-access.
 *
 * Slice-1 surface is read-only. Mutations (manual concierge booking
 * creation, cancel/refund, dispute open/resolve) arrive in TS-128
 * follow-ups.
 */
export default async function BookingsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}): Promise<React.JSX.Element> {
  const params = await searchParams;
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

  const filters: ListFilters = {
    householdId: stringParam(params['householdId']),
    providerId: stringParam(params['providerId']),
    seniorId: stringParam(params['seniorId']),
    serviceKind: stringParam(params['serviceKind']),
    status: stringParam(params['status']),
    cursor: stringParam(params['cursor']),
  };

  const list = await fetchBookings(filters);

  return (
    <div className="dash-shell">
      <div className="admin-banner">
        <span>Admin console — bookings</span>
        <span className="admin-banner__operator" title={me.userId}>
          {me.userId}
        </span>
      </div>
      <header className="dash-top">
        <span className="dash-brand">Taste &amp; See — Admin</span>
        <div className="dash-account">
          <Link href="/dashboard" className="dash-logout">
            Back to console
          </Link>
        </div>
      </header>
      <main className="dash-main">
        <h1>Bookings</h1>
        <p>
          Browse bookings across every household, senior, and provider. Read-only at launch — manual
          booking creation, cancellation, refund, and dispute resolution arrive in later slices.
        </p>

        <BookingFilters initial={filters} />

        {list === null ? (
          <p className="auth-alert">
            We couldn&apos;t load the bookings list right now. The downstream booking service may be
            unreachable.
          </p>
        ) : (
          <BookingTable list={list} filters={filters} />
        )}
      </main>
    </div>
  );
}

interface ListFilters {
  readonly householdId: string | null;
  readonly providerId: string | null;
  readonly seniorId: string | null;
  readonly serviceKind: string | null;
  readonly status: string | null;
  readonly cursor: string | null;
}

function BookingFilters({ initial }: { readonly initial: ListFilters }): React.JSX.Element {
  return (
    <form action="/bookings" method="get" className="filter-bar" role="search">
      <label className="filter-bar__field">
        <span>Household id</span>
        <input
          type="text"
          name="householdId"
          defaultValue={initial.householdId ?? ''}
          placeholder="hh_..."
          autoComplete="off"
        />
      </label>
      <label className="filter-bar__field">
        <span>Provider id</span>
        <input
          type="text"
          name="providerId"
          defaultValue={initial.providerId ?? ''}
          placeholder="pro_..."
          autoComplete="off"
        />
      </label>
      <label className="filter-bar__field">
        <span>Senior id</span>
        <input
          type="text"
          name="seniorId"
          defaultValue={initial.seniorId ?? ''}
          placeholder="sen_..."
          autoComplete="off"
        />
      </label>
      <label className="filter-bar__field">
        <span>Service kind</span>
        <select name="serviceKind" defaultValue={initial.serviceKind ?? ''}>
          <option value="">Any</option>
          <option value="companion_dining">Companion dining</option>
          <option value="personal_chef_visit">Personal chef visit</option>
          <option value="grocery_coordination">Grocery coordination</option>
          <option value="transportation">Transportation</option>
          <option value="social_outing">Social outing</option>
          <option value="event_dining">Event dining</option>
          <option value="emergency_concierge">Emergency concierge</option>
          <option value="holiday_dinner">Holiday dinner</option>
          <option value="birthday_experience">Birthday experience</option>
          <option value="tea_social">Tea social</option>
          <option value="museum_outing">Museum outing</option>
          <option value="memory_meal">Memory meal</option>
          <option value="custom_request">Custom request</option>
        </select>
      </label>
      <label className="filter-bar__field">
        <span>Status</span>
        <select name="status" defaultValue={initial.status ?? ''}>
          <option value="">Any</option>
          <option value="pending">Pending</option>
          <option value="confirmed">Confirmed</option>
          <option value="in_progress">In progress</option>
          <option value="completed">Completed</option>
          <option value="canceled">Canceled</option>
        </select>
      </label>
      <div className="filter-bar__actions">
        <button type="submit" className="filter-bar__submit">
          Apply filters
        </button>
        <Link href="/bookings" className="filter-bar__reset">
          Reset
        </Link>
      </div>
    </form>
  );
}

function BookingTable({
  list,
  filters,
}: {
  readonly list: AdminBookingsListResponse;
  readonly filters: ListFilters;
}): React.JSX.Element {
  if (list.bookings.length === 0) {
    return (
      <div className="user-empty">
        <p>No bookings match these filters.</p>
      </div>
    );
  }

  return (
    <>
      <div className="user-table" role="table" aria-label="Bookings">
        <div className="user-table__head" role="row">
          <span role="columnheader">Service</span>
          <span role="columnheader">Status</span>
          <span role="columnheader">Schedule</span>
          <span role="columnheader">Price</span>
          <span role="columnheader">Created</span>
        </div>
        {list.bookings.map((booking) => (
          <BookingRow key={booking.id} booking={booking} />
        ))}
      </div>
      <Pagination cursor={list.nextCursor} filters={filters} />
    </>
  );
}

function BookingRow({ booking }: { readonly booking: AdminBookingSummary }): React.JSX.Element {
  return (
    <Link
      key={booking.id}
      href={`/bookings/${encodeURIComponent(booking.id)}`}
      className="user-row"
      role="row"
    >
      <span role="cell">
        <span className="user-row__email">{formatServiceKind(booking.serviceKind)}</span>
        {booking.isRecurring && <span className="user-row__chip">recurring</span>}
        {/*
          TS-304-followup-1 — a held booking is SUSPENDED, and ops triaging
          this queue was reading it as a normal upcoming visit. The chip says
          that and no more: "which incident" is a `trust_safety:read` question
          answered at /trust-safety/holds, and this queue's audience may not
          hold that permission (CLAUDE.md §12).
        */}
        {booking.onHold && (
          <span
            className="user-row__chip user-row__chip--warn"
            title="Suspended by a trust &amp; safety hold"
          >
            on hold
          </span>
        )}
      </span>
      <span
        role="cell"
        className={`user-row__status user-row__status--${statusBucket(booking.status)}`}
      >
        {booking.status.replace(/_/g, ' ')}
      </span>
      <span role="cell" className="user-row__date">
        {formatDateTime(booking.scheduledStart)}
      </span>
      <span role="cell">{formatMoney(booking.finalPriceMinor, booking.currency)}</span>
      <span role="cell" className="user-row__date">
        {formatDate(booking.createdAt)}
      </span>
    </Link>
  );
}

function Pagination({
  cursor,
  filters,
}: {
  readonly cursor: string | null;
  readonly filters: ListFilters;
}): React.JSX.Element {
  if (cursor === null) {
    return <p className="user-pagination">End of list.</p>;
  }
  const params = new URLSearchParams();
  if (filters.householdId !== null) params.set('householdId', filters.householdId);
  if (filters.providerId !== null) params.set('providerId', filters.providerId);
  if (filters.seniorId !== null) params.set('seniorId', filters.seniorId);
  if (filters.serviceKind !== null) params.set('serviceKind', filters.serviceKind);
  if (filters.status !== null) params.set('status', filters.status);
  params.set('cursor', cursor);
  return (
    <p className="user-pagination">
      <Link href={`/bookings?${params.toString()}`} className="filter-bar__submit">
        Next page →
      </Link>
    </p>
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

async function fetchBookings(filters: ListFilters): Promise<AdminBookingsListResponse | null> {
  const query = new URLSearchParams();
  if (filters.householdId !== null) query.set('householdId', filters.householdId);
  if (filters.providerId !== null) query.set('providerId', filters.providerId);
  if (filters.seniorId !== null) query.set('seniorId', filters.seniorId);
  if (filters.serviceKind !== null) query.set('serviceKind', filters.serviceKind);
  if (filters.status !== null) query.set('status', filters.status);
  if (filters.cursor !== null) query.set('cursor', filters.cursor);
  query.set('limit', '25');

  const result = await callGateway<unknown>(`/api/v1/admin/bookings?${query.toString()}`);
  if (result.kind === 'unauthorized') {
    redirect('/login?expired=1');
  }
  if (result.kind !== 'ok') return null;
  const parsed = AdminBookingsListResponseSchema.safeParse(result.body);
  return parsed.success ? parsed.data : null;
}

function stringParam(value: string | string[] | undefined): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

/**
 * Bucket every BookingStatus into one of the three palette CSS
 * classes already shipped for users / subscriptions. Keeps the chrome
 * consistent without adding a new palette per surface.
 *
 *   - `pending` / `confirmed`     → active palette (the booking is on track)
 *   - `in_progress`               → active palette (the visit is happening)
 *   - `completed`                 → active palette (terminal happy state)
 *   - `canceled` / `declined`     → deactivated palette
 */
function statusBucket(
  status: AdminBookingSummary['status'],
): 'active' | 'suspended' | 'deactivated' {
  switch (status) {
    case 'pending':
    case 'confirmed':
    case 'in_progress':
    case 'completed':
      return 'active';
    case 'canceled':
    case 'declined':
      return 'deactivated';
  }
}

function formatServiceKind(kind: AdminBookingSummary['serviceKind']): string {
  switch (kind) {
    case 'companion_dining':
      return 'Companion dining';
    case 'personal_chef_visit':
      return 'Personal chef visit';
    case 'grocery_coordination':
      return 'Grocery coordination';
    case 'transportation':
      return 'Transportation';
    case 'social_outing':
      return 'Social outing';
    case 'event_dining':
      return 'Event dining';
    case 'emergency_concierge':
      return 'Emergency concierge';
    case 'holiday_dinner':
      return 'Holiday dinner';
    case 'birthday_experience':
      return 'Birthday experience';
    case 'tea_social':
      return 'Tea social';
    case 'museum_outing':
      return 'Museum outing';
    case 'memory_meal':
      return 'Memory meal';
    case 'custom_request':
      return 'Custom request';
  }
}

function formatDate(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    });
  } catch {
    return iso;
  }
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

function formatMoney(minor: number, currency: string): string {
  try {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency,
    }).format(minor / 100);
  } catch {
    return `$${(minor / 100).toFixed(2)}`;
  }
}
