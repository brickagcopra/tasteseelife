import { redirect } from 'next/navigation';
import Link from 'next/link';
import type { Metadata } from 'next';
import {
  AdminPermissionsListResponseSchema,
  AdminRoleResponseSchema,
  MeResponseSchema,
  type AdminPermissionsListResponse,
  type AdminRoleRecord,
  type MeResponse,
} from '@taste-and-see/contracts';

import { callGateway } from '@/lib/api';
import { hasPermission } from '@/lib/admin-gate';

import { archiveRoleAction } from '../actions';
import { PermissionMatrix } from '../permission-matrix';
import { parseProposalFromSearch, type RoleEditProposal } from '../role-diff';

export const metadata: Metadata = {
  title: 'RBAC — role — Taste & See Admin',
};

/**
 * Role editor (TS-290). Rename / re-describe / edit the permission
 * matrix for CUSTOM roles; SYSTEM roles (and archived roles) render
 * the same view read-only with explanatory copy. Viewing gated on
 * `rbac:read`; the edit + archive forms additionally on `rbac:write`.
 *
 * TS-291: saving is a two-step confirm — the edit form GETs its
 * pending state to the review page (side-by-side before/after diff),
 * and only the review page's "Apply changes" commits. When the
 * reviewer comes back via "Back to edit" (`?draft=1&…`), the pending
 * edit rehydrates the form so nothing is lost.
 */
export default async function RoleEditorPage({
  params,
  searchParams,
}: {
  params: Promise<{ roleId: string }>;
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}): Promise<React.JSX.Element> {
  const { roleId } = await params;
  const search = searchParams ? await searchParams : undefined;
  const banner = readBanner(search);

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
  const [role, catalog] = await Promise.all([fetchRole(roleId), fetchPermissions()]);

  if (role === null) {
    return (
      <div className="dash-shell">
        <main className="dash-main">
          <h1>Role not found</h1>
          <p>
            This role doesn&apos;t exist (or the identity service is unreachable).{' '}
            <Link href="/roles">Back to roles</Link>
          </p>
        </main>
      </div>
    );
  }

  const readOnly = !canWrite || role.isSystem || role.archivedAt !== null;

  // TS-291 draft rehydration: coming back from the review step keeps
  // the operator's pending edit instead of resetting to server state.
  const draft: RoleEditProposal | null =
    !readOnly && search?.['draft'] === '1' && catalog !== null
      ? parseProposalFromSearch(
          search,
          new Set(catalog.permissions.map((p) => `${p.resource}:${p.action}`)),
        )
      : null;
  const nameDefault = draft?.name ?? role.name;
  const descriptionDefault = draft !== null ? (draft.description ?? '') : (role.description ?? '');
  const selectedDefault = new Set(draft !== null ? draft.permissions : role.permissions);

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
        <h1>
          {role.name}
          {role.isSystem && <span className="user-row__chip"> system</span>}
          {role.archivedAt !== null && <span className="user-row__chip"> archived</span>}
        </h1>

        {role.isSystem && (
          <p>
            This is a <strong>system role</strong> — its permission set is owned by the seed catalog
            and can only change through a code change + re-seed. The matrix below is read-only.
          </p>
        )}
        {role.archivedAt !== null && (
          <p>
            This role was archived on {formatDate(role.archivedAt)}. Archived roles cannot be
            granted or edited; existing assignments keep working until revoked.
          </p>
        )}

        {banner !== null && <ActionBanner banner={banner} />}

        {catalog === null ? (
          <p className="auth-alert" role="alert">
            We couldn&apos;t load the permission catalog right now. Please refresh.
          </p>
        ) : readOnly ? (
          <section className="user-detail__section">
            <h2>Permissions</h2>
            {role.description !== null && <p>{role.description}</p>}
            <PermissionMatrix
              permissions={catalog.permissions}
              selected={new Set(role.permissions)}
              readOnly
            />
          </section>
        ) : (
          <>
            <section className="user-detail__section">
              <h2>Edit role</h2>
              <p>
                Nothing saves directly from this form — reviewing shows a before/after diff of your
                changes first, and only applying from that page commits them.
              </p>
              <form
                method="get"
                action={`/roles/${encodeURIComponent(role.id)}/review`}
                className="user-detail__action-form concierge-event-form"
              >
                <label className="user-detail__action-label">
                  <span>Role name (lower snake_case)</span>
                  <input
                    name="name"
                    defaultValue={nameDefault}
                    required
                    pattern="[a-z][a-z0-9_]*"
                    title="Lower snake_case starting with a letter"
                  />
                </label>
                <label className="user-detail__action-label">
                  <span>Description (blank clears)</span>
                  <textarea name="description" rows={2} defaultValue={descriptionDefault} />
                </label>
                <h3 className="user-detail__subhead">Permissions</h3>
                <PermissionMatrix permissions={catalog.permissions} selected={selectedDefault} />
                <div className="user-detail__action-row">
                  <button type="submit" className="user-detail__action-button">
                    Review changes
                  </button>
                </div>
              </form>
            </section>

            <section className="user-detail__section">
              <h2>Archive role</h2>
              <p>
                Archiving hides the role from assignment surfaces — no new grants. Existing
                assignments keep working until individually revoked. This cannot be undone from the
                console today.
              </p>
              <form action={archiveRoleAction} className="user-detail__action-form">
                <input type="hidden" name="roleId" value={role.id} />
                <label className="user-detail__action-label">
                  <span>Note for the audit trail (optional)</span>
                  <input name="note" placeholder="superseded by ..." />
                </label>
                <label className="user-detail__action-label">
                  <input type="checkbox" name="confirmArchive" required />
                  <span>I understand this role will stop being grantable.</span>
                </label>
                <div className="user-detail__action-row">
                  <button type="submit" className="user-detail__action-button">
                    Archive role
                  </button>
                </div>
              </form>
            </section>
          </>
        )}

        <section className="user-detail__section">
          <h2>Record</h2>
          <dl className="concierge-detail__facts">
            <FactItem label="Role id">
              <code>{role.id}</code>
            </FactItem>
            <FactItem label="Created">{formatDate(role.createdAt)}</FactItem>
            <FactItem label="Updated">{formatDate(role.updatedAt)}</FactItem>
            <FactItem label="Permission count">{role.permissions.length}</FactItem>
          </dl>
        </section>
      </main>
    </div>
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

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' });
}

type Banner =
  | { readonly kind: 'ok' }
  | { readonly kind: 'archived' }
  | { readonly kind: 'err'; readonly code: string };

function readBanner(
  search: Record<string, string | string[] | undefined> | undefined,
): Banner | null {
  if (search === undefined) return null;
  const action = search['action'];
  if (action === 'ok') return { kind: 'ok' };
  if (action === 'archived') return { kind: 'archived' };
  if (action === 'err') {
    const code = search['code'];
    return { kind: 'err', code: typeof code === 'string' ? code : 'unknown' };
  }
  return null;
}

function ActionBanner({ banner }: { readonly banner: Banner }): React.JSX.Element {
  if (banner.kind === 'ok') {
    return (
      <p className="auth-alert auth-alert--success" role="status">
        Saved.
      </p>
    );
  }
  if (banner.kind === 'archived') {
    return (
      <p className="auth-alert auth-alert--success" role="status">
        Role archived.
      </p>
    );
  }
  return (
    <p className="auth-alert" role="alert">
      Something went wrong ({banner.code}).
      {banner.code === 'conflict' &&
        ' The role may be a system role, already archived, or the name is taken.'}
      {banner.code === 'confirm-required' && ' Tick the confirmation box to archive.'}
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

async function fetchRole(roleId: string): Promise<AdminRoleRecord | null> {
  const result = await callGateway<unknown>(`/api/v1/admin/roles/${encodeURIComponent(roleId)}`);
  if (result.kind === 'unauthorized') redirect('/login?expired=1');
  if (result.kind !== 'ok') return null;
  const parsed = AdminRoleResponseSchema.safeParse(result.body);
  return parsed.success ? parsed.data.role : null;
}

async function fetchPermissions(): Promise<AdminPermissionsListResponse | null> {
  const result = await callGateway<unknown>('/api/v1/admin/permissions');
  if (result.kind === 'unauthorized') redirect('/login?expired=1');
  if (result.kind !== 'ok') return null;
  const parsed = AdminPermissionsListResponseSchema.safeParse(result.body);
  return parsed.success ? parsed.data : null;
}
