import { redirect } from 'next/navigation';
import Link from 'next/link';
import type { Metadata } from 'next';
import { MeResponseSchema, type MeResponse } from '@taste-and-see/contracts';

import { callGateway } from '@/lib/api';
import { hasPermission } from '@/lib/admin-gate';

import { BULK_CSV_HEADERS } from './csv';
import { BulkAssignmentsFlow } from './bulk-flow';

export const metadata: Metadata = {
  title: 'RBAC — bulk role assignments — Taste & See Admin',
};

/**
 * Bulk role-assignment workflow (TS-292; PRD §10.12; PDD §10.3).
 * Upload a CSV → per-row validation preview → confirm → per-row
 * outcomes, applied through the gateway BFF with partial-success
 * semantics. Viewing + validating gated on `rbac:read`; committing on
 * `rbac:write` (re-enforced by the gateway and service-identity).
 */
export default async function BulkAssignmentsPage(): Promise<React.JSX.Element> {
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
  if (!hasPermission(me, 'rbac:read')) redirect('/dashboard/no-access');
  const canWrite = hasPermission(me, 'rbac:write');

  return (
    <div className="dash-shell">
      <div className="admin-banner">
        <span>Admin console — RBAC</span>
        <span className="admin-banner__operator" title={me.userId}>
          {me.userId}
        </span>
      </div>
      <header className="dash-top">
        <span className="dash-brand">Taste &amp; See — Admin</span>
        <div className="dash-account">
          <Link href="/roles" className="dash-logout">
            ← Roles
          </Link>
        </div>
      </header>
      <main className="dash-main">
        <h1>Bulk role assignments</h1>
        <p>
          Upload a CSV of grants; every row is validated before anything is applied, and each grant
          is audit-logged individually. Rows are independent — a failing row never rolls back the
          others.
        </p>

        <section className="user-detail__section">
          <h2>Sheet format</h2>
          <p>
            Header row required, exactly these columns: <code>{BULK_CSV_HEADERS.join(',')}</code>.{' '}
            <code>scopeType</code> is <code>global</code>, <code>tenant</code>, or{' '}
            <code>household</code>; <code>scopeId</code> stays empty for global and carries the
            tenant / household id otherwise; <code>expiresAt</code> is an ISO-8601 instant or empty
            for no expiry.
          </p>
          <p className="user-detail__hint">
            Sensitive roles (<code>super_admin</code>, <code>finance</code>) cannot be granted here
            — they require the reviewer-approval flow.
          </p>
        </section>

        <BulkAssignmentsFlow canWrite={canWrite} />
      </main>
    </div>
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
