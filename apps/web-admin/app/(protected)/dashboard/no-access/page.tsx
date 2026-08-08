import { redirect } from 'next/navigation';
import type { Metadata } from 'next';
import { MeResponseSchema, type MeResponse } from '@taste-and-see/contracts';

import { callGateway } from '@/lib/api';
import { activeAdminRoleNames, hasAnyAdminRole, hasSuperAdminRole } from '@/lib/admin-gate';

import { logoutAction } from '../actions';

export const metadata: Metadata = {
  title: 'Permissions pending — Taste & See Admin',
};

/**
 * "Permissions pending" placeholder (TS-123).
 *
 * Rendered when an actor holds at least one admin role but is NOT
 * super_admin. Phase-1 only super_admins reach the dashboard root —
 * other admin roles authenticate successfully and see this page
 * listing the roles they currently hold + a note that per-surface
 * permission gating arrives with TS-126 / TS-290.
 *
 * Defensive re-check: if the operator navigates here directly via a
 * URL paste but is actually a super_admin, redirect them to the
 * dashboard root. If they hold no admin role at all (cookie leftover
 * from a stale family-portal session, say), bounce to login.
 */
export default async function NoAccessPage(): Promise<React.JSX.Element> {
  const result = await callGateway<unknown>('/api/v1/me');
  if (result.kind === 'unauthorized') {
    redirect('/login?expired=1');
  }
  if (result.kind !== 'ok') {
    return <ServiceWarning />;
  }
  const parsed = MeResponseSchema.safeParse(result.body);
  if (!parsed.success) {
    return <ServiceWarning />;
  }
  const me: MeResponse = parsed.data;

  if (!hasAnyAdminRole(me)) {
    redirect('/login?no_admin_role=1');
  }
  if (hasSuperAdminRole(me)) {
    redirect('/dashboard');
  }

  const roles = activeAdminRoleNames(me);

  return (
    <div className="dash-shell">
      <div className="admin-banner">
        <span>Admin console</span>
        <span className="admin-banner__operator" title={me.userId}>
          {me.userId}
        </span>
      </div>
      <header className="dash-top">
        <span className="dash-brand">Taste &amp; See — Admin</span>
        <div className="dash-account">
          <form action={logoutAction}>
            <button type="submit" className="dash-logout">
              Sign out
            </button>
          </form>
        </div>
      </header>
      <main className="dash-main">
        <h1>Permissions pending</h1>
        <p>
          You&apos;re signed in to the Taste &amp; See admin console, but the surfaces for your role
          aren&apos;t open yet. Each role gets its own operational view as we ship it; for Phase 1
          only super_admin lands on the console root. Reach out to a super_admin if you need
          something today.
        </p>
        {roles.length > 0 ? (
          <ul className="role-list">
            {roles.map((role) => (
              <li key={role}>{role}</li>
            ))}
          </ul>
        ) : null}
      </main>
    </div>
  );
}

function ServiceWarning(): React.JSX.Element {
  return (
    <div className="dash-shell">
      <main className="dash-main">
        <h1>We&apos;re having a moment</h1>
        <p>
          Our service is briefly unreachable. Please refresh in a few seconds — and if it persists,
          our team is already on it.
        </p>
        <form action={logoutAction}>
          <button type="submit" className="dash-logout">
            Sign out
          </button>
        </form>
      </main>
    </div>
  );
}
