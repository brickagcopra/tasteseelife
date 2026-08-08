import { redirect } from 'next/navigation';
import Link from 'next/link';
import type { Metadata } from 'next';
import {
  AdminPermissionsListResponseSchema,
  MeResponseSchema,
  type AdminPermissionsListResponse,
  type MeResponse,
} from '@taste-and-see/contracts';

import { callGateway } from '@/lib/api';
import { hasPermission } from '@/lib/admin-gate';

import { createRoleAction } from '../actions';
import { PermissionMatrix } from '../permission-matrix';

export const metadata: Metadata = {
  title: 'RBAC — new role — Taste & See Admin',
};

/**
 * Create-role form (TS-290). Name + optional description + the visual
 * permission matrix. Gated on `rbac:write`. Creates CUSTOM roles only —
 * system roles are seed-owned.
 */
export default async function NewRolePage({
  searchParams,
}: {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}): Promise<React.JSX.Element> {
  const search = searchParams ? await searchParams : undefined;
  const errored = search?.['action'] === 'err';
  const code = typeof search?.['code'] === 'string' ? (search['code'] as string) : 'unknown';

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
  if (!hasPermission(me, 'rbac:write')) redirect('/dashboard/no-access');

  const catalog = await fetchPermissions();

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
            Back to roles
          </Link>
        </div>
      </header>
      <main className="dash-main">
        <h1>New role</h1>
        <p>
          Create a custom role. Names are lower snake_case (like <code>regional_ops</code>) and must
          be unique across system + custom roles.
        </p>

        {errored && (
          <p className="auth-alert" role="alert">
            Couldn&apos;t create the role ({code}).
            {code === 'conflict' && ' A role with that name already exists.'}
          </p>
        )}

        {catalog === null ? (
          <p className="auth-alert" role="alert">
            We couldn&apos;t load the permission catalog right now. Please refresh.
          </p>
        ) : (
          <section className="user-detail__section">
            <form
              action={createRoleAction}
              className="user-detail__action-form concierge-event-form"
            >
              <label className="user-detail__action-label">
                <span>Role name (lower snake_case)</span>
                <input
                  name="name"
                  required
                  pattern="[a-z][a-z0-9_]*"
                  placeholder="regional_ops"
                  title="Lower snake_case starting with a letter"
                />
              </label>
              <label className="user-detail__action-label">
                <span>Description (optional)</span>
                <textarea name="description" rows={2} />
              </label>
              <h3 className="user-detail__subhead">Permissions</h3>
              <PermissionMatrix permissions={catalog.permissions} selected={new Set()} />
              <div className="user-detail__action-row">
                <button type="submit" className="user-detail__action-button">
                  Create role
                </button>
              </div>
            </form>
          </section>
        )}
      </main>
    </div>
  );
}

async function fetchMe(): Promise<MeResponse | null> {
  const result = await callGateway<unknown>('/api/v1/me');
  if (result.kind === 'unauthorized') redirect('/login?expired=1');
  if (result.kind !== 'ok') return null;
  const parsed = MeResponseSchema.safeParse(result.body);
  return parsed.success ? parsed.data : null;
}

async function fetchPermissions(): Promise<AdminPermissionsListResponse | null> {
  const result = await callGateway<unknown>('/api/v1/admin/permissions');
  if (result.kind === 'unauthorized') redirect('/login?expired=1');
  if (result.kind !== 'ok') return null;
  const parsed = AdminPermissionsListResponseSchema.safeParse(result.body);
  return parsed.success ? parsed.data : null;
}
