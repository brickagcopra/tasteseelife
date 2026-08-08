import { redirect } from 'next/navigation';
import Link from 'next/link';
import type { Metadata } from 'next';
import {
  AdminRolesListResponseSchema,
  MeResponseSchema,
  type AdminRoleRecord,
  type AdminRolesListResponse,
  type MeResponse,
} from '@taste-and-see/contracts';

import { callGateway } from '@/lib/api';
import { hasPermission } from '@/lib/admin-gate';
import { readBanner, type Banner } from '@/lib/search-params';

export const metadata: Metadata = {
  title: 'RBAC — roles — Taste & See Admin',
};

/**
 * RBAC role catalog list (TS-290; PRD §10.12; PDD §10.3). The web-admin
 * surface over the service-identity role-definition API via the gateway
 * BFF. Page-gated on `rbac:read`; mutations additionally on `rbac:write`
 * (the gateway + service-identity re-enforce both, defence-in-depth).
 */
export default async function RolesPage({
  searchParams,
}: {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}): Promise<React.JSX.Element> {
  const search = searchParams ? await searchParams : undefined;
  const banner = readBanner(search);
  const includeArchived = search?.['archived'] === '1';

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
  const list = await fetchRoles(includeArchived);

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
          <Link href="/dashboard" className="dash-logout">
            Back to dashboard
          </Link>
        </div>
      </header>
      <main className="dash-main">
        <h1>Roles</h1>
        <p>
          The role catalog. System roles come from the seed catalog and are read-only; custom roles
          are yours to build. Viewing gated on <code>rbac:read</code>, editing on{' '}
          <code>rbac:write</code>.
        </p>

        {banner !== null && <ActionBanner banner={banner} />}

        {canWrite && (
          <p className="user-detail__hint">
            <Link href="/roles/new">+ New role</Link>
          </p>
        )}

        <p className="user-detail__hint">
          <Link href="/roles/assignments">Bulk role assignments (CSV)</Link> — validate a sheet with{' '}
          <code>rbac:read</code>; committing needs <code>rbac:write</code>.
        </p>

        <p className="user-detail__hint">
          <Link href="/roles/approvals">Sensitive-role approvals</Link> — pending{' '}
          <code>super_admin</code> / <code>finance</code> grant requests awaiting a second
          admin&apos;s signoff (TS-294).
        </p>

        <p className="user-detail__hint">
          <Link href="/roles/history">Change history</Link> — every role, assignment, and approval
          change with actor and before/after diff, from the audit log (needs <code>audit:read</code>
          ).
        </p>

        <p className="user-detail__hint">
          <Link href="/roles/security-policies">Org security policies</Link> — per-scope sign-in
          requirements for staff (SSO enforcement, TS-296).
        </p>

        <p className="user-detail__hint">
          <a href="/roles/catalog-export" download>
            Export catalog (JSON)
          </a>{' '}
          — the portable role + permission catalog for cross-environment parity (TS-299); importing
          runs via the <code>rbac:catalog</code> CLI, never the web.
        </p>

        <p className="user-detail__hint">
          {includeArchived ? (
            <Link href="/roles">Hide archived roles</Link>
          ) : (
            <Link href="/roles?archived=1">Show archived roles</Link>
          )}
        </p>

        <section className="user-detail__section">
          <h2>All roles</h2>
          {list === null ? (
            <p className="auth-alert" role="alert">
              We couldn&apos;t load roles right now. The identity service may be unreachable.
            </p>
          ) : (
            <RoleList list={list} />
          )}
        </section>
      </main>
    </div>
  );
}

function RoleList({ list }: { readonly list: AdminRolesListResponse }): React.JSX.Element {
  if (list.roles.length === 0) {
    return (
      <div className="user-empty">
        <p>
          No roles yet. Seed the catalog (<code>pnpm seed:rbac</code>) or create one.
        </p>
      </div>
    );
  }
  return (
    <ul className="concierge-event-list">
      {list.roles.map((role) => (
        <RoleRow key={role.id} role={role} />
      ))}
    </ul>
  );
}

function RoleRow({ role }: { readonly role: AdminRoleRecord }): React.JSX.Element {
  return (
    <li className="concierge-event-card">
      <div className="concierge-event-card__head">
        <Link
          href={`/roles/${encodeURIComponent(role.id)}`}
          className="concierge-event-card__title"
        >
          {role.name}
        </Link>
        {role.isSystem && <span className="user-row__chip">system</span>}
        {role.archivedAt !== null && <span className="user-row__chip">archived</span>}
      </div>
      <dl className="concierge-detail__facts">
        {role.description !== null && <FactItem label="Description">{role.description}</FactItem>}
        <FactItem label="Permissions">{role.permissions.length}</FactItem>
      </dl>
      <p className="user-detail__hint">
        <Link href={`/roles/${encodeURIComponent(role.id)}`}>
          {role.isSystem || role.archivedAt !== null ? 'View role →' : 'Edit role →'}
        </Link>
      </p>
    </li>
  );
}

function FactItem({
  label,
  children,
}: {
  readonly label: string;
  readonly children: React.ReactNode;
}): React.JSX.Element {
  return (
    <div className="concierge-detail__fact">
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

function ActionBanner({ banner }: { readonly banner: Banner }): React.JSX.Element {
  if (banner.kind === 'ok') {
    return (
      <p className="auth-alert auth-alert--success" role="status">
        Saved.
      </p>
    );
  }
  return (
    <p className="auth-alert" role="alert">
      Something went wrong ({banner.code}). Please try again.
    </p>
  );
}

async function fetchMe(): Promise<MeResponse | null> {
  const result = await callGateway<unknown>('/api/v1/me');
  if (result.kind === 'unauthorized') redirect('/login?expired=1');
  if (result.kind !== 'ok') return null;
  const parsed = MeResponseSchema.safeParse(result.body);
  return parsed.success ? parsed.data : null;
}

async function fetchRoles(includeArchived: boolean): Promise<AdminRolesListResponse | null> {
  const path = includeArchived ? '/api/v1/admin/roles?includeArchived=true' : '/api/v1/admin/roles';
  const result = await callGateway<unknown>(path);
  if (result.kind === 'unauthorized') redirect('/login?expired=1');
  if (result.kind !== 'ok') return null;
  const parsed = AdminRolesListResponseSchema.safeParse(result.body);
  return parsed.success ? parsed.data : null;
}
