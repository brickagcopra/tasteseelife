import { redirect } from 'next/navigation';
import Link from 'next/link';
import type { Metadata } from 'next';
import {
  AdminUsersListResponseSchema,
  MeResponseSchema,
  type AdminUserSummary,
  type AdminUsersListResponse,
  type MeResponse,
} from '@taste-and-see/contracts';

import { callGateway } from '@/lib/api';
import { hasSuperAdminRole } from '@/lib/admin-gate';

export const metadata: Metadata = {
  title: 'Users — Taste & See Admin',
};

/**
 * Admin users list (TS-126 Slice 1; PRD §10.2).
 *
 * Server-rendered list with three filter affordances (email substring,
 * status, role-name) and cursor pagination. Each row links to
 * `/users/[id]` for the full detail view. Filters round-trip through
 * the URL query so a bookmarked search re-runs on load.
 *
 * The page enforces three gates on every request:
 *
 *   1. Authenticated (cookie present) — the (protected) layout's
 *      cheap cookie check + the gateway's 401-on-missing-bearer.
 *   2. MFA-verified — gateway-side requirement for any admin actor.
 *   3. Active super_admin role — Phase-1 only super_admins land on
 *      admin tooling; other admin roles bounce to /dashboard/no-access.
 *
 * Slice-1 surface is read-only. Per-row "Suspend / Unlock" mutations
 * and a click-through impersonation are captured as TS-126-followup-*.
 */
export default async function UsersPage({
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
    q: stringParam(params['q']),
    status: stringParam(params['status']),
    roleName: stringParam(params['roleName']),
    cursor: stringParam(params['cursor']),
  };

  const list = await fetchUsers(filters);

  return (
    <div className="dash-shell">
      <div className="admin-banner">
        <span>Admin console — users</span>
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
        <h1>Users</h1>
        <p>
          Search families, seniors, providers, partners, and staff. Read-only at launch — suspend,
          unlock, and impersonation arrive in later slices.
        </p>

        <UserFilters initial={filters} />

        {list === null ? (
          <p className="auth-alert">
            We couldn&apos;t load the user list right now. The downstream identity service may be
            unreachable.
          </p>
        ) : (
          <UserTable list={list} filters={filters} />
        )}
      </main>
    </div>
  );
}

interface ListFilters {
  readonly q: string | null;
  readonly status: string | null;
  readonly roleName: string | null;
  readonly cursor: string | null;
}

function UserFilters({ initial }: { readonly initial: ListFilters }): React.JSX.Element {
  return (
    <form action="/users" method="get" className="filter-bar" role="search">
      <label className="filter-bar__field">
        <span>Email contains</span>
        <input
          type="text"
          name="q"
          defaultValue={initial.q ?? ''}
          placeholder="alice@example.com"
          autoComplete="off"
        />
      </label>
      <label className="filter-bar__field">
        <span>Status</span>
        <select name="status" defaultValue={initial.status ?? ''}>
          <option value="">Any</option>
          <option value="active">Active</option>
          <option value="pending_verification">Pending verification</option>
          <option value="suspended">Suspended</option>
          <option value="deactivated">Deactivated</option>
        </select>
      </label>
      <label className="filter-bar__field">
        <span>Role</span>
        <input
          type="text"
          name="roleName"
          defaultValue={initial.roleName ?? ''}
          placeholder="super_admin / family_payer / ..."
          autoComplete="off"
        />
      </label>
      <div className="filter-bar__actions">
        <button type="submit" className="filter-bar__submit">
          Apply filters
        </button>
        <Link href="/users" className="filter-bar__reset">
          Reset
        </Link>
      </div>
    </form>
  );
}

function UserTable({
  list,
  filters,
}: {
  readonly list: AdminUsersListResponse;
  readonly filters: ListFilters;
}): React.JSX.Element {
  if (list.users.length === 0) {
    return (
      <div className="user-empty">
        <p>No users match these filters.</p>
      </div>
    );
  }

  return (
    <>
      <div className="user-table" role="table" aria-label="Users">
        <div className="user-table__head" role="row">
          <span role="columnheader">Email</span>
          <span role="columnheader">Status</span>
          <span role="columnheader">Roles</span>
          <span role="columnheader">MFA</span>
          <span role="columnheader">Created</span>
        </div>
        {list.users.map((user) => (
          <UserRow key={user.id} user={user} />
        ))}
      </div>
      <Pagination cursor={list.nextCursor} filters={filters} />
    </>
  );
}

function UserRow({ user }: { readonly user: AdminUserSummary }): React.JSX.Element {
  return (
    <Link
      key={user.id}
      href={`/users/${encodeURIComponent(user.id)}`}
      className="user-row"
      role="row"
    >
      <span role="cell">
        <span className="user-row__email">{user.email}</span>
        {user.holdsAdminRole && <span className="user-row__chip">staff</span>}
        {user.currentlyLocked && (
          <span className="user-row__chip user-row__chip--warn">locked</span>
        )}
      </span>
      <span role="cell" className={`user-row__status user-row__status--${user.status}`}>
        {user.status.replace(/_/g, ' ')}
      </span>
      <span role="cell">{user.activeRoleCount}</span>
      <span role="cell">{user.mfaEnabled ? 'enabled' : '—'}</span>
      <span role="cell" className="user-row__date">
        {formatDate(user.createdAt)}
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
  if (filters.q !== null) params.set('q', filters.q);
  if (filters.status !== null) params.set('status', filters.status);
  if (filters.roleName !== null) params.set('roleName', filters.roleName);
  params.set('cursor', cursor);
  return (
    <p className="user-pagination">
      <Link href={`/users?${params.toString()}`} className="filter-bar__submit">
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

async function fetchUsers(filters: ListFilters): Promise<AdminUsersListResponse | null> {
  const query = new URLSearchParams();
  if (filters.q !== null) query.set('q', filters.q);
  if (filters.status !== null) query.set('status', filters.status);
  if (filters.roleName !== null) query.set('roleName', filters.roleName);
  if (filters.cursor !== null) query.set('cursor', filters.cursor);
  query.set('limit', '25');

  const result = await callGateway<unknown>(`/api/v1/admin/users?${query.toString()}`);
  if (result.kind === 'unauthorized') {
    redirect('/login?expired=1');
  }
  if (result.kind !== 'ok') return null;
  const parsed = AdminUsersListResponseSchema.safeParse(result.body);
  return parsed.success ? parsed.data : null;
}

function stringParam(value: string | string[] | undefined): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

function formatDate(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
  } catch {
    return iso;
  }
}
