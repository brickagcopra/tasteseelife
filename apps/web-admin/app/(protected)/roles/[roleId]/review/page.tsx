import { redirect } from 'next/navigation';
import Link from 'next/link';
import type { Metadata } from 'next';
import {
  AdminPermissionsListResponseSchema,
  AdminRoleResponseSchema,
  MeResponseSchema,
  type AdminRoleRecord,
  type MeResponse,
} from '@taste-and-see/contracts';

import { callGateway } from '@/lib/api';
import { hasPermission } from '@/lib/admin-gate';

import { updateRoleAction } from '../../actions';
import {
  computeRoleDiff,
  parseProposalFromSearch,
  proposalToQuery,
  type PermissionDiffEntry,
} from '../../role-diff';

export const metadata: Metadata = {
  title: 'RBAC — review changes — Taste & See Admin',
};

/**
 * Role-edit review step (TS-291; PRD §10.12). The editor's form GETs
 * its pending state here; this page diffs it against the role's
 * CURRENT server state and renders a side-by-side before/after so a
 * reviewer can see exactly what "Apply changes" will do. Applying
 * POSTs the pending set (hidden fields + fresh Idempotency-Key via the
 * server action) — nothing is saved until then. Zero client JS.
 */
export default async function RoleReviewPage({
  params,
  searchParams,
}: {
  params: Promise<{ roleId: string }>;
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}): Promise<React.JSX.Element> {
  const { roleId } = await params;
  const search = searchParams ? await searchParams : {};
  const editorPath = `/roles/${encodeURIComponent(roleId)}`;

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
  // Review exists solely to gate a write — read-only operators go back.
  if (!hasPermission(me, 'rbac:write')) redirect(editorPath);

  const [role, catalog] = await Promise.all([fetchRole(roleId), fetchPermissions()]);
  if (role === null) redirect(`/roles?action=err&code=not-found`);
  // System / archived roles are not editable; the editor explains why.
  if (role.isSystem || role.archivedAt !== null) redirect(editorPath);

  if (catalog === null) {
    return (
      <div className="dash-shell">
        <main className="dash-main">
          <h1>Review changes</h1>
          <p className="auth-alert" role="alert">
            We couldn&apos;t load the permission catalog right now, so the diff can&apos;t be
            computed. <Link href={editorPath}>Back to the editor</Link>.
          </p>
        </main>
      </div>
    );
  }

  const catalogValues = new Set(
    catalog.map((permission) => `${permission.resource}:${permission.action}`),
  );
  const proposal = parseProposalFromSearch(search, catalogValues);
  const diff = computeRoleDiff(role, proposal);
  const backToEditHref = `${editorPath}?draft=1&${proposalToQuery(proposal).toString()}`;

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
          <Link href={backToEditHref} className="dash-logout">
            Back to edit
          </Link>
        </div>
      </header>
      <main className="dash-main">
        <h1>
          Review changes — <code>{role.name}</code>
        </h1>
        <p>
          Nothing has been saved yet. Check the before/after below, then apply. Applying commits
          against the role&apos;s <strong>latest saved state</strong> — if someone else edited this
          role after you opened the editor, their permission changes will be replaced by this set.
        </p>

        {!diff.hasChanges ? (
          <>
            <p className="auth-alert" role="status">
              No changes to apply — the proposed state matches the role as currently saved.
            </p>
            <p>
              <Link href={backToEditHref}>Back to the editor</Link>
            </p>
          </>
        ) : (
          <>
            {(diff.nameChanged || diff.descriptionChanged) && (
              <section className="user-detail__section">
                <h2>Details</h2>
                <table className="perm-matrix perm-diff">
                  <caption className="sr-only">Role detail changes — before and after</caption>
                  <thead>
                    <tr>
                      <th scope="col">Field</th>
                      <th scope="col">Before</th>
                      <th scope="col">After</th>
                    </tr>
                  </thead>
                  <tbody>
                    {diff.nameChanged && (
                      <tr>
                        <th scope="row">Name</th>
                        <td>
                          <code>{diff.nameBefore}</code>
                        </td>
                        <td>
                          <code>{diff.nameAfter}</code>{' '}
                          <span className="perm-diff__chip perm-diff__chip--added">changed</span>
                        </td>
                      </tr>
                    )}
                    {diff.descriptionChanged && (
                      <tr>
                        <th scope="row">Description</th>
                        <td>
                          {diff.descriptionBefore ?? (
                            <span className="perm-diff__empty">(none)</span>
                          )}
                        </td>
                        <td>
                          {diff.descriptionAfter ?? (
                            <span className="perm-diff__empty">(cleared)</span>
                          )}{' '}
                          <span className="perm-diff__chip perm-diff__chip--added">changed</span>
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </section>
            )}

            <section className="user-detail__section">
              <h2>Permission changes</h2>
              {diff.addedCount === 0 && diff.removedCount === 0 ? (
                <p>No permission changes — only the details above change.</p>
              ) : (
                <>
                  <p role="status">
                    {diff.addedCount} added, {diff.removedCount} removed, {diff.unchangedCount}{' '}
                    unchanged.
                  </p>
                  <table className="perm-matrix perm-diff">
                    <caption className="sr-only">
                      Permission changes — one row per resource, before and after side by side
                    </caption>
                    <thead>
                      <tr>
                        <th scope="col">Resource</th>
                        <th scope="col">Before</th>
                        <th scope="col">After</th>
                      </tr>
                    </thead>
                    <tbody>
                      {diff.changedResources.map((resourceDiff) => (
                        <tr key={resourceDiff.resource}>
                          <th scope="row">
                            <code>{resourceDiff.resource}</code>
                          </th>
                          <td>
                            <DiffCell entries={resourceDiff.entries} side="before" />
                          </td>
                          <td>
                            <DiffCell entries={resourceDiff.entries} side="after" />
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </>
              )}

              {diff.unchangedResources.length > 0 && (
                <details className="perm-diff__unchanged">
                  <summary>
                    {diff.unchangedResources.length} resource
                    {diff.unchangedResources.length === 1 ? '' : 's'} without changes
                  </summary>
                  <ul className="perm-matrix__actions" role="list">
                    {diff.unchangedResources.flatMap((resourceDiff) =>
                      resourceDiff.entries.map((entry) => (
                        <li key={entry.value}>
                          <code>{entry.value}</code>
                        </li>
                      )),
                    )}
                  </ul>
                </details>
              )}
            </section>

            <section className="user-detail__section">
              <h2>Apply</h2>
              <form action={updateRoleAction} className="user-detail__action-form">
                <input type="hidden" name="roleId" value={role.id} />
                <input type="hidden" name="name" value={diff.nameAfter} />
                <input type="hidden" name="description" value={diff.descriptionAfter ?? ''} />
                {proposal.permissions.map((permission) => (
                  <input key={permission} type="hidden" name={`perm__${permission}`} value="on" />
                ))}
                <div className="user-detail__action-row">
                  <button type="submit" className="user-detail__action-button">
                    Apply changes
                  </button>
                  <Link href={backToEditHref}>Back to edit</Link>
                </div>
              </form>
            </section>
          </>
        )}
      </main>
    </div>
  );
}

/**
 * One side of the side-by-side. "before" renders unchanged + removed
 * entries (removals labelled); "after" renders unchanged + added
 * (additions labelled). Labels are text, never color alone (§8.3).
 */
function DiffCell({
  entries,
  side,
}: {
  readonly entries: readonly PermissionDiffEntry[];
  readonly side: 'before' | 'after';
}): React.JSX.Element {
  const visible = entries.filter((entry) =>
    side === 'before' ? entry.status !== 'added' : entry.status !== 'removed',
  );
  if (visible.length === 0) {
    return <span className="perm-diff__empty">(no permissions)</span>;
  }
  return (
    <ul className="perm-matrix__actions" role="list">
      {visible.map((entry) => (
        <li key={entry.value} className={`perm-diff__entry perm-diff__entry--${entry.status}`}>
          <code>{entry.action}</code>
          {entry.status === 'removed' && side === 'before' && (
            <span className="perm-diff__chip perm-diff__chip--removed">&minus; Removed</span>
          )}
          {entry.status === 'added' && side === 'after' && (
            <span className="perm-diff__chip perm-diff__chip--added">+ Added</span>
          )}
        </li>
      ))}
    </ul>
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

async function fetchPermissions(): Promise<
  readonly { readonly resource: string; readonly action: string }[] | null
> {
  const result = await callGateway<unknown>('/api/v1/admin/permissions');
  if (result.kind === 'unauthorized') redirect('/login?expired=1');
  if (result.kind !== 'ok') return null;
  const parsed = AdminPermissionsListResponseSchema.safeParse(result.body);
  return parsed.success ? parsed.data.permissions : null;
}
