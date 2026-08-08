import { redirect } from 'next/navigation';
import Link from 'next/link';
import type { Metadata } from 'next';
import {
  AdminSubscriptionsListResponseSchema,
  MeResponseSchema,
  type AdminSubscriptionSummary,
  type AdminSubscriptionsListResponse,
  type MeResponse,
} from '@taste-and-see/contracts';

import { callGateway } from '@/lib/api';
import { hasSuperAdminRole } from '@/lib/admin-gate';

export const metadata: Metadata = {
  title: 'Subscriptions — Taste & See Admin',
};

/**
 * Admin subscriptions list (TS-127 Slice 1; PRD §10.3).
 *
 * Server-rendered list with four filter affordances (customer group,
 * status, plan id, customer id) and cursor pagination. Each row links to
 * `/subscriptions/[id]` for the full detail view. Filters round-trip
 * through the URL query so a bookmarked search re-runs on load.
 *
 * The page enforces three gates on every request:
 *   1. Authenticated (cookie present) — the (protected) layout's cheap
 *      cookie check + the gateway's 401-on-missing-bearer.
 *   2. MFA-verified — gateway-side requirement for any admin actor.
 *   3. Active super_admin role — Phase-1 only super_admins land on admin
 *      tooling; other admin roles bounce to /dashboard/no-access.
 *
 * Slice-1 surface is read-only. Per-row "Comp / Refund / Pause" mutations
 * are captured as TS-127-followup-1.
 */
export default async function SubscriptionsPage({
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
    customerGroup: stringParam(params['customerGroup']),
    status: stringParam(params['status']),
    planId: stringParam(params['planId']),
    customerId: stringParam(params['customerId']),
    cursor: stringParam(params['cursor']),
  };

  const list = await fetchSubscriptions(filters);

  return (
    <div className="dash-shell">
      <div className="admin-banner">
        <span>Admin console — subscriptions</span>
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
        <h1>Subscriptions</h1>
        <p>
          Search subscriptions across every customer group. Read-only at launch — comp, refund,
          pause, and bulk operations arrive in later slices.
        </p>

        <SubscriptionFilters initial={filters} />

        {list === null ? (
          <p className="auth-alert">
            We couldn&apos;t load the subscription list right now. The downstream subscription
            service may be unreachable.
          </p>
        ) : (
          <SubscriptionTable list={list} filters={filters} />
        )}
      </main>
    </div>
  );
}

interface ListFilters {
  readonly customerGroup: string | null;
  readonly status: string | null;
  readonly planId: string | null;
  readonly customerId: string | null;
  readonly cursor: string | null;
}

function SubscriptionFilters({ initial }: { readonly initial: ListFilters }): React.JSX.Element {
  return (
    <form action="/subscriptions" method="get" className="filter-bar" role="search">
      <label className="filter-bar__field">
        <span>Customer group</span>
        <select name="customerGroup" defaultValue={initial.customerGroup ?? ''}>
          <option value="">Any</option>
          <option value="family">Family</option>
          <option value="provider">Provider</option>
          <option value="academy">Academy</option>
        </select>
      </label>
      <label className="filter-bar__field">
        <span>Status</span>
        <select name="status" defaultValue={initial.status ?? ''}>
          <option value="">Any</option>
          <option value="active">Active</option>
          <option value="trialing">Trialing</option>
          <option value="past_due">Past due</option>
          <option value="unpaid">Unpaid</option>
          <option value="paused">Paused</option>
          <option value="canceled">Canceled</option>
          <option value="incomplete">Incomplete</option>
          <option value="incomplete_expired">Incomplete expired</option>
        </select>
      </label>
      <label className="filter-bar__field">
        <span>Plan id</span>
        <input
          type="text"
          name="planId"
          defaultValue={initial.planId ?? ''}
          placeholder="plan_..."
          autoComplete="off"
        />
      </label>
      <label className="filter-bar__field">
        <span>Customer id</span>
        <input
          type="text"
          name="customerId"
          defaultValue={initial.customerId ?? ''}
          placeholder="hh_... / prv_... / usr_..."
          autoComplete="off"
        />
      </label>
      <div className="filter-bar__actions">
        <button type="submit" className="filter-bar__submit">
          Apply filters
        </button>
        <Link href="/subscriptions" className="filter-bar__reset">
          Reset
        </Link>
      </div>
    </form>
  );
}

function SubscriptionTable({
  list,
  filters,
}: {
  readonly list: AdminSubscriptionsListResponse;
  readonly filters: ListFilters;
}): React.JSX.Element {
  if (list.subscriptions.length === 0) {
    return (
      <div className="user-empty">
        <p>No subscriptions match these filters.</p>
      </div>
    );
  }

  return (
    <>
      <div className="user-table" role="table" aria-label="Subscriptions">
        <div className="user-table__head" role="row">
          <span role="columnheader">Plan</span>
          <span role="columnheader">Status</span>
          <span role="columnheader">Group</span>
          <span role="columnheader">Price</span>
          <span role="columnheader">Created</span>
        </div>
        {list.subscriptions.map((sub) => (
          <SubscriptionRow key={sub.id} subscription={sub} />
        ))}
      </div>
      <Pagination cursor={list.nextCursor} filters={filters} />
    </>
  );
}

function SubscriptionRow({
  subscription,
}: {
  readonly subscription: AdminSubscriptionSummary;
}): React.JSX.Element {
  return (
    <Link
      key={subscription.id}
      href={`/subscriptions/${encodeURIComponent(subscription.id)}`}
      className="user-row"
      role="row"
    >
      <span role="cell">
        <span className="user-row__email">{subscription.planName}</span>
        {subscription.inDunningGrace && (
          <span className="user-row__chip user-row__chip--warn">past due</span>
        )}
        {subscription.isPaused && <span className="user-row__chip">paused</span>}
        {subscription.cancelAtPeriodEnd && !subscription.isPaused && (
          <span className="user-row__chip">cancel scheduled</span>
        )}
      </span>
      <span
        role="cell"
        className={`user-row__status user-row__status--${statusBucket(subscription.status)}`}
      >
        {subscription.status.replace(/_/g, ' ')}
      </span>
      <span role="cell">{subscription.customerGroup}</span>
      <span role="cell">
        {formatMoney(subscription.unitPriceMinor, subscription.currency)}{' '}
        <span className="user-detail__hint">/ {subscription.billingInterval}</span>
      </span>
      <span role="cell" className="user-row__date">
        {formatDate(subscription.createdAt)}
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
  if (filters.customerGroup !== null) params.set('customerGroup', filters.customerGroup);
  if (filters.status !== null) params.set('status', filters.status);
  if (filters.planId !== null) params.set('planId', filters.planId);
  if (filters.customerId !== null) params.set('customerId', filters.customerId);
  params.set('cursor', cursor);
  return (
    <p className="user-pagination">
      <Link href={`/subscriptions?${params.toString()}`} className="filter-bar__submit">
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

async function fetchSubscriptions(
  filters: ListFilters,
): Promise<AdminSubscriptionsListResponse | null> {
  const query = new URLSearchParams();
  if (filters.customerGroup !== null) query.set('customerGroup', filters.customerGroup);
  if (filters.status !== null) query.set('status', filters.status);
  if (filters.planId !== null) query.set('planId', filters.planId);
  if (filters.customerId !== null) query.set('customerId', filters.customerId);
  if (filters.cursor !== null) query.set('cursor', filters.cursor);
  query.set('limit', '25');

  const result = await callGateway<unknown>(`/api/v1/admin/subscriptions?${query.toString()}`);
  if (result.kind === 'unauthorized') {
    redirect('/login?expired=1');
  }
  if (result.kind !== 'ok') return null;
  const parsed = AdminSubscriptionsListResponseSchema.safeParse(result.body);
  return parsed.success ? parsed.data : null;
}

function stringParam(value: string | string[] | undefined): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

/**
 * Bucket every SubscriptionStatus into one of the three palette CSS
 * classes already shipped for users (`active` / `suspended` /
 * `deactivated`). Keeps the chrome consistent without adding a new
 * palette per surface.
 *
 *   - `active`        → active palette
 *   - `trialing`      → active palette (paying / trialing both green)
 *   - `past_due`      → suspended palette (amber)
 *   - `paused`        → suspended palette (amber)
 *   - `unpaid`        → deactivated palette (red)
 *   - `canceled`      → deactivated palette
 *   - `incomplete*`   → suspended palette (incomplete is operationally
 *                       "awaiting attention" — same chip colour)
 */
function statusBucket(
  status: AdminSubscriptionSummary['status'],
): 'active' | 'suspended' | 'deactivated' {
  switch (status) {
    case 'active':
    case 'trialing':
      return 'active';
    case 'past_due':
    case 'paused':
    case 'incomplete':
    case 'incomplete_expired':
      return 'suspended';
    case 'unpaid':
    case 'canceled':
      return 'deactivated';
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

/**
 * Pretty-print integer minor units as a localized currency string. Falls
 * back to a `$xx.yy` shape when `Intl.NumberFormat` rejects the
 * currency code (defensive — Phase-1 currency is USD only).
 */
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
