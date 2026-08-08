import { notFound, redirect } from 'next/navigation';
import Link from 'next/link';
import type { Metadata } from 'next';
import {
  ADMIN_ROLE_ASSIGNMENTS_SENSITIVE_ROLES,
  ADMIN_USERS_REINSTATE_REASONS,
  ADMIN_USERS_SUSPEND_REASONS,
  AdminRoleAssignmentsListResponseSchema,
  AdminRolesListResponseSchema,
  AdminUserDetailResponseSchema,
  MeResponseSchema,
  type AdminRoleAssignmentRecord,
  type AdminUserDetail,
  type AdminUserLockoutSummary,
  type AdminUserMfaSummary,
  type AdminUserKycSummary,
  type MeResponse,
  type MeRoleAssignment,
} from '@taste-and-see/contracts';

import { callGateway } from '@/lib/api';
import { hasPermission, hasSuperAdminRole } from '@/lib/admin-gate';
import {
  grantRoleAssignmentAction,
  impersonateUserAction,
  reinstateUserAction,
  requestRoleApprovalAction,
  revokeRoleAssignmentAction,
  suspendUserAction,
  unlockUserAction,
} from './actions';

export const metadata: Metadata = {
  title: 'User detail — Taste & See Admin',
};

/**
 * Admin user detail (TS-126 Slice 1; PRD §10.2).
 *
 * Single-page view of one account: identity columns, active role
 * assignments, confirmed MFA methods, the most-recent KYC snapshot,
 * and the lockout state. Read-only — Slice 1 has no mutations.
 *
 * Mutations (suspend / reinstate / unlock — TS-025-followup-2),
 * impersonation, KYC document review, and Checkr background-check
 * surface arrive as follow-ups.
 */
export default async function UserDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ readonly id: string }>;
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}): Promise<React.JSX.Element> {
  const { id } = await params;
  const search = searchParams ? await searchParams : undefined;
  const banner = readBanner(search);
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

  const detail = await fetchUserDetail(id);
  if (detail === 'not_found') notFound();
  if (detail === null) {
    return (
      <div className="dash-shell">
        <ServiceWarning />
      </div>
    );
  }

  return (
    <div className="dash-shell">
      <div className="admin-banner">
        <span>Admin console — user detail</span>
        <span className="admin-banner__operator" title={me.userId}>
          {me.userId}
        </span>
      </div>
      <header className="dash-top">
        <span className="dash-brand">Taste &amp; See — Admin</span>
        <div className="dash-account">
          <Link href="/users" className="dash-logout">
            ← All users
          </Link>
        </div>
      </header>
      <main className="dash-main">
        <h1>{detail.email}</h1>
        <p className="user-detail__sub">
          <span className={`user-row__status user-row__status--${detail.status}`}>
            {detail.status.replace(/_/g, ' ')}
          </span>
          {detail.holdsAdminRole && <span className="user-row__chip">staff</span>}
          {detail.lockout.currentlyLocked && (
            <span className="user-row__chip user-row__chip--warn">locked</span>
          )}
          {detail.deletedAt !== null && (
            <span className="user-row__chip user-row__chip--warn">deleted</span>
          )}
        </p>

        <section className="user-detail__section">
          <h2>Identity</h2>
          <dl className="user-detail__dl">
            <dt>User id</dt>
            <dd className="user-detail__mono">{detail.id}</dd>
            <dt>Email</dt>
            <dd>
              {detail.email}{' '}
              {detail.emailVerifiedAt !== null && (
                <span className="user-detail__hint">
                  verified {formatDate(detail.emailVerifiedAt)}
                </span>
              )}
            </dd>
            <dt>Phone</dt>
            <dd>{detail.phone ?? <span className="user-detail__hint">none on file</span>}</dd>
            <dt>MFA</dt>
            <dd>
              {detail.mfaEnabled ? 'enabled' : 'disabled'}
              {detail.mfaMethods.length > 0 && (
                <span className="user-detail__hint"> ({detail.mfaMethods.length} methods)</span>
              )}
            </dd>
            <dt>Created</dt>
            <dd>{formatDateTime(detail.createdAt)}</dd>
            <dt>Updated</dt>
            <dd>{formatDateTime(detail.updatedAt)}</dd>
          </dl>
        </section>

        {banner !== null && <ActionBanner banner={banner} />}

        <RolesSection roles={detail.roles} />
        {hasPermission(me, 'rbac:read') && (
          <RoleAssignmentsManageSection
            userId={detail.id}
            canWrite={hasPermission(me, 'rbac:write')}
          />
        )}
        <MfaSection methods={detail.mfaMethods} />
        <KycSection kyc={detail.latestKyc} />
        <LockoutSection lockout={detail.lockout} />

        <ActionsSection
          detail={detail}
          actorUserId={me.userId}
          canImpersonate={hasPermission(me, 'user:impersonate')}
        />

        <section className="user-detail__section user-detail__section--placeholder">
          <h2>More actions</h2>
          <p>
            KYC document review and the Checkr background-check surface arrive in later TS-126
            follow-ups. The audit log of every admin action lands with TS-100.
          </p>
        </section>
      </main>
    </div>
  );
}

function RolesSection({
  roles,
}: {
  readonly roles: readonly MeRoleAssignment[];
}): React.JSX.Element {
  return (
    <section className="user-detail__section">
      <h2>Active role assignments</h2>
      {roles.length === 0 ? (
        <p className="user-detail__hint">No active role assignments.</p>
      ) : (
        <ul className="user-detail__role-list">
          {roles.map((role, index) => (
            <li key={`${role.name}-${index}`}>
              <span className="user-detail__role-name">{role.name}</span>
              <span className="user-detail__hint">{renderScope(role.scope)}</span>
              {role.expiresAt !== undefined && (
                <span className="user-detail__hint"> · expires {formatDate(role.expiresAt)}</span>
              )}
              {role.permissions.length > 0 && (
                <div className="user-detail__permissions">
                  {role.permissions.map((p) => (
                    <code key={p}>{p}</code>
                  ))}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/**
 * RBAC assignment management (TS-292) — the writable counterpart to
 * the read-only token-claim view above. Lists every assignment row
 * (including revoked / expired history) with per-row revoke, plus a
 * grant form fed by the live role catalog. Rendered only for
 * `rbac:read` holders; mutations additionally gate on `rbac:write`
 * (and the gateway + service re-enforce both).
 */
async function RoleAssignmentsManageSection({
  userId,
  canWrite,
}: {
  readonly userId: string;
  readonly canWrite: boolean;
}): Promise<React.JSX.Element> {
  const [assignments, roleNames] = await Promise.all([
    fetchAssignments(userId),
    canWrite ? fetchRoleNameGroups() : Promise.resolve({ grantable: [], sensitive: [] }),
  ]);
  const grantableRoles = roleNames.grantable;
  const sensitiveRoles = roleNames.sensitive;

  if (assignments === null) {
    return (
      <section className="user-detail__section">
        <h2>Role assignments (manage)</h2>
        <p className="auth-alert" role="alert">
          We couldn&apos;t load the assignment history right now.
        </p>
      </section>
    );
  }

  const boundGrant = grantRoleAssignmentAction.bind(null, userId);
  const boundRevoke = revokeRoleAssignmentAction.bind(null, userId);
  const boundRequestApproval = requestRoleApprovalAction.bind(null, userId);

  return (
    <section className="user-detail__section">
      <h2>Role assignments (manage)</h2>
      {assignments.length === 0 ? (
        <p className="user-detail__hint">No assignments on record.</p>
      ) : (
        <table className="perm-matrix">
          <caption className="sr-only">Every role assignment held by this user</caption>
          <thead>
            <tr>
              <th scope="col">Role</th>
              <th scope="col">Scope</th>
              <th scope="col">Status</th>
              <th scope="col">Granted</th>
              <th scope="col">Expires</th>
              {canWrite && <th scope="col">Actions</th>}
            </tr>
          </thead>
          <tbody>
            {assignments.map((a) => (
              <tr key={a.id}>
                <td>{a.roleName}</td>
                <td>{renderAssignmentScope(a)}</td>
                <td>
                  {a.active ? (
                    <span className="perm-diff__chip perm-diff__chip--added">Active</span>
                  ) : a.revokedAt !== null ? (
                    <span className="perm-diff__chip perm-diff__chip--removed">
                      Revoked {formatDate(a.revokedAt)}
                    </span>
                  ) : (
                    <span className="perm-diff__chip">Expired</span>
                  )}
                </td>
                <td>{formatDate(a.createdAt)}</td>
                <td>{a.expiresAt !== null ? formatDate(a.expiresAt) : 'never'}</td>
                {canWrite && (
                  <td>
                    {a.active && (
                      <form action={boundRevoke} className="user-detail__inline-form">
                        <input type="hidden" name="assignmentId" value={a.id} />
                        <button
                          type="submit"
                          className="user-detail__action-button user-detail__action-button--danger"
                        >
                          Revoke
                        </button>
                      </form>
                    )}
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {canWrite && (
        <details className="user-detail__action-card">
          <summary>
            <strong>Grant a role</strong>
            <span className="user-detail__hint">
              Sensitive roles (super_admin, finance) require reviewer approval — use &ldquo;Request
              a sensitive-role grant&rdquo; below.
            </span>
          </summary>
          <form action={boundGrant} className="user-detail__action-form">
            <label className="user-detail__action-label">
              Role
              <select name="roleName" required>
                {grantableRoles.map((name) => (
                  <option key={name} value={name}>
                    {name}
                  </option>
                ))}
              </select>
            </label>
            <label className="user-detail__action-label">
              Scope
              <select name="scopeType" required defaultValue="global">
                <option value="global">global</option>
                <option value="tenant">tenant</option>
                <option value="household">household</option>
              </select>
            </label>
            <label className="user-detail__action-label">
              Scope id (required for tenant / household, leave empty for global)
              <input type="text" name="scopeId" maxLength={64} />
            </label>
            <label className="user-detail__action-label">
              Expires (optional)
              <input type="datetime-local" name="expiresAt" />
            </label>
            <label className="user-detail__action-label">
              Reason (optional, audit trail)
              <textarea name="reason" rows={2} maxLength={500} placeholder="Ticket, context…" />
            </label>
            <button type="submit" className="user-detail__action-button">
              Grant role
            </button>
          </form>
        </details>
      )}

      {canWrite && sensitiveRoles.length > 0 && (
        <details className="user-detail__action-card">
          <summary>
            <strong>Request a sensitive-role grant (requires approval)</strong>
            <span className="user-detail__hint">
              Files a pending request — a SECOND admin must approve it on the approvals queue before
              the grant becomes active.
            </span>
          </summary>
          <form action={boundRequestApproval} className="user-detail__action-form">
            <label className="user-detail__action-label">
              Sensitive role
              <select name="roleName" required>
                {sensitiveRoles.map((name) => (
                  <option key={name} value={name}>
                    {name}
                  </option>
                ))}
              </select>
            </label>
            <label className="user-detail__action-label">
              Scope
              <select name="scopeType" required defaultValue="global">
                <option value="global">global</option>
                <option value="tenant">tenant</option>
                <option value="household">household</option>
              </select>
            </label>
            <label className="user-detail__action-label">
              Scope id (required for tenant / household, leave empty for global)
              <input type="text" name="scopeId" maxLength={64} />
            </label>
            <label className="user-detail__action-label">
              Expires (optional — sensitive grants should usually expire)
              <input type="datetime-local" name="expiresAt" />
            </label>
            <label className="user-detail__action-label">
              Reason (required — shown to the reviewer, kept for audit)
              <textarea
                name="reason"
                rows={2}
                maxLength={500}
                required
                placeholder="Incident, ticket, why this person, for how long…"
              />
            </label>
            <button type="submit" className="user-detail__action-button">
              File approval request
            </button>
          </form>
        </details>
      )}
      <p className="user-detail__hint">
        Need many grants at once? Use the <Link href="/roles/assignments">bulk CSV workflow</Link>.
        Pending sensitive-role requests live on the{' '}
        <Link href="/roles/approvals">approvals queue</Link>.
      </p>
    </section>
  );
}

async function fetchAssignments(
  userId: string,
): Promise<readonly AdminRoleAssignmentRecord[] | null> {
  const result = await callGateway<unknown>(
    `/api/v1/admin/users/${encodeURIComponent(userId)}/role-assignments?includeInactive=true`,
  );
  if (result.kind === 'unauthorized') redirect('/login?expired=1');
  if (result.kind !== 'ok') return null;
  const parsed = AdminRoleAssignmentsListResponseSchema.safeParse(result.body);
  return parsed.success ? parsed.data.assignments : null;
}

/**
 * Live (non-archived) role names split into the directly-grantable set
 * and the sensitive set (reviewer-approval flow, TS-294). Both derive
 * from the live catalog so an archived sensitive role disappears from
 * the request form too.
 */
async function fetchRoleNameGroups(): Promise<{
  readonly grantable: readonly string[];
  readonly sensitive: readonly string[];
}> {
  const result = await callGateway<unknown>('/api/v1/admin/roles');
  if (result.kind !== 'ok') return { grantable: [], sensitive: [] };
  const parsed = AdminRolesListResponseSchema.safeParse(result.body);
  if (!parsed.success) return { grantable: [], sensitive: [] };
  const sensitive = new Set<string>(ADMIN_ROLE_ASSIGNMENTS_SENSITIVE_ROLES);
  const names = parsed.data.roles.map((r) => r.name);
  return {
    grantable: names.filter((name) => !sensitive.has(name)),
    sensitive: names.filter((name) => sensitive.has(name)),
  };
}

function renderAssignmentScope(a: AdminRoleAssignmentRecord): string {
  switch (a.scope.type) {
    case 'global':
      return 'global';
    case 'tenant':
      return `tenant ${a.scope.tenantId}`;
    case 'household':
      return `household ${a.scope.householdId}`;
  }
}

function MfaSection({
  methods,
}: {
  readonly methods: readonly AdminUserMfaSummary[];
}): React.JSX.Element {
  return (
    <section className="user-detail__section">
      <h2>MFA methods</h2>
      {methods.length === 0 ? (
        <p className="user-detail__hint">No confirmed MFA methods.</p>
      ) : (
        <ul className="user-detail__role-list">
          {methods.map((m) => (
            <li key={m.id}>
              <span className="user-detail__role-name">{m.kind}</span>
              {m.label !== null && <span className="user-detail__hint"> · {m.label}</span>}
              <div className="user-detail__hint">
                confirmed {formatDateTime(m.confirmedAt)}
                {m.lastUsedAt !== null && <> · last used {formatDateTime(m.lastUsedAt)}</>}
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function KycSection({ kyc }: { readonly kyc: AdminUserKycSummary | null }): React.JSX.Element {
  return (
    <section className="user-detail__section">
      <h2>KYC (Stripe Identity)</h2>
      {kyc === null ? (
        <p className="user-detail__hint">No KYC session started.</p>
      ) : (
        <dl className="user-detail__dl">
          <dt>Status</dt>
          <dd>{kyc.status.replace(/_/g, ' ')}</dd>
          <dt>Verified</dt>
          <dd>
            {kyc.verifiedAt !== null ? (
              formatDateTime(kyc.verifiedAt)
            ) : (
              <span className="user-detail__hint">not verified</span>
            )}
          </dd>
          <dt>Created</dt>
          <dd>{formatDateTime(kyc.createdAt)}</dd>
          <dt>Updated</dt>
          <dd>{formatDateTime(kyc.updatedAt)}</dd>
        </dl>
      )}
    </section>
  );
}

function LockoutSection({
  lockout,
}: {
  readonly lockout: AdminUserLockoutSummary;
}): React.JSX.Element {
  return (
    <section className="user-detail__section">
      <h2>Lockout state</h2>
      <dl className="user-detail__dl">
        <dt>Currently locked</dt>
        <dd>
          {lockout.currentlyLocked ? (
            <strong>yes</strong>
          ) : (
            <span className="user-detail__hint">no</span>
          )}
        </dd>
        <dt>Failed login count</dt>
        <dd>{lockout.failedLoginCount}</dd>
        <dt>Last failed login</dt>
        <dd>
          {lockout.lastFailedLoginAt !== null ? (
            formatDateTime(lockout.lastFailedLoginAt)
          ) : (
            <span className="user-detail__hint">none</span>
          )}
        </dd>
        <dt>Locked until</dt>
        <dd>
          {lockout.lockedUntil !== null ? (
            formatDateTime(lockout.lockedUntil)
          ) : (
            <span className="user-detail__hint">—</span>
          )}
        </dd>
      </dl>
    </section>
  );
}

function ActionsSection({
  detail,
  actorUserId,
  canImpersonate,
}: {
  readonly detail: AdminUserDetail;
  readonly actorUserId: string;
  readonly canImpersonate: boolean;
}): React.JSX.Element {
  const canSuspend = detail.status === 'active' && detail.deletedAt === null;
  const canReinstate = detail.status === 'suspended' && detail.deletedAt === null;
  const isLocked = detail.lockout.currentlyLocked;
  // `unlock` is always available for non-deleted accounts — it's a
  // no-op success on an already-clear account, but ops may want the
  // affordance for a "I just want to be sure" reset. We disable the
  // button on soft-deleted rows because the downstream returns 404
  // for them.
  const canUnlock = detail.deletedAt === null;

  // Server actions can't take additional positional args directly,
  // so bind the userId here.
  const boundSuspend = suspendUserAction.bind(null, detail.id);
  const boundReinstate = reinstateUserAction.bind(null, detail.id);
  const boundUnlock = unlockUserAction.bind(null, detail.id);
  const boundImpersonate = impersonateUserAction.bind(null, detail.id);

  // Impersonation (TS-297): the server refuses self-impersonation,
  // admin-staff targets, and deactivated accounts — the UI mirrors the
  // rules it can see locally and lets the service arbitrate the rest.
  const canStartImpersonation =
    detail.deletedAt === null && detail.status !== 'deactivated' && detail.id !== actorUserId;

  // Self-action guard: an admin can technically suspend their own
  // account via this surface, but doing so is almost always an
  // accident. We surface a soft confirmation in the disclosure copy
  // rather than refuse outright (operations teams sometimes deliberately
  // suspend a colleague's account during an incident).
  const isSelf = detail.id === actorUserId;

  return (
    <section className="user-detail__section user-detail__actions">
      <h2>Actions</h2>
      <p className="user-detail__hint">
        Each action emits an audit-trail log line today; the wired <code>service-audit</code> outbox
        event lands with TS-100.
      </p>
      {isSelf && (
        <p className="user-detail__hint user-detail__actions-warn">
          You are signed in as this user. Acting here will affect your own account.
        </p>
      )}

      <div className="user-detail__actions-grid">
        <ActionDisclosure
          summary="Suspend"
          enabled={canSuspend}
          enabledHint="Sets status to suspended. The user will be unable to sign in."
          disabledHint={
            detail.status === 'suspended'
              ? 'Already suspended.'
              : detail.status === 'deactivated'
                ? 'Deactivated accounts cannot be suspended.'
                : detail.status === 'pending_verification'
                  ? 'Cannot suspend an account that has not finished signup.'
                  : 'Soft-deleted accounts cannot be suspended.'
          }
          form={
            <form action={boundSuspend} className="user-detail__action-form">
              <label className="user-detail__action-label">
                Reason
                <select name="reason" required defaultValue="trust_safety">
                  {ADMIN_USERS_SUSPEND_REASONS.map((r) => (
                    <option key={r} value={r}>
                      {r.replace(/_/g, ' ')}
                    </option>
                  ))}
                </select>
              </label>
              <label className="user-detail__action-label">
                Note (optional)
                <textarea
                  name="note"
                  rows={2}
                  maxLength={500}
                  placeholder="Ticket number, context, etc."
                />
              </label>
              <button
                type="submit"
                className="user-detail__action-button user-detail__action-button--danger"
              >
                Confirm suspend
              </button>
            </form>
          }
        />

        <ActionDisclosure
          summary="Reinstate"
          enabled={canReinstate}
          enabledHint="Sets status back to active. The user will be able to sign in again."
          disabledHint={
            detail.status === 'active'
              ? 'Already active.'
              : detail.status === 'deactivated'
                ? 'Deactivated accounts cannot be reinstated from this surface.'
                : detail.status === 'pending_verification'
                  ? 'Cannot reinstate an account that has not finished signup.'
                  : 'Soft-deleted accounts cannot be reinstated.'
          }
          form={
            <form action={boundReinstate} className="user-detail__action-form">
              <label className="user-detail__action-label">
                Reason
                <select name="reason" required defaultValue="investigation_complete">
                  {ADMIN_USERS_REINSTATE_REASONS.map((r) => (
                    <option key={r} value={r}>
                      {r.replace(/_/g, ' ')}
                    </option>
                  ))}
                </select>
              </label>
              <label className="user-detail__action-label">
                Note (optional)
                <textarea name="note" rows={2} maxLength={500} placeholder="Resolution detail" />
              </label>
              <button type="submit" className="user-detail__action-button">
                Confirm reinstate
              </button>
            </form>
          }
        />

        <ActionDisclosure
          summary={isLocked ? 'Unlock' : 'Unlock (no-op)'}
          enabled={canUnlock}
          enabledHint={
            isLocked
              ? 'Clears the failed-login counter and the lockout deadline.'
              : 'Account is not currently locked. This will still reset the failed-login counter to zero.'
          }
          disabledHint="Soft-deleted accounts cannot be unlocked."
          form={
            <form action={boundUnlock} className="user-detail__action-form">
              <label className="user-detail__action-label">
                Note (optional)
                <textarea name="note" rows={2} maxLength={500} placeholder="Support ticket, etc." />
              </label>
              <button type="submit" className="user-detail__action-button">
                Confirm unlock
              </button>
            </form>
          }
        />

        {canImpersonate && (
          <ActionDisclosure
            summary="Start impersonation"
            enabled={canStartImpersonation}
            enabledHint="Opens a short-lived diagnostic session as this user. A banner marks the session and every action is audit-logged with your identity."
            disabledHint={
              detail.id === actorUserId
                ? 'You cannot impersonate your own account.'
                : detail.status === 'deactivated'
                  ? 'Deactivated accounts cannot be impersonated.'
                  : 'Soft-deleted accounts cannot be impersonated.'
            }
            form={
              <form action={boundImpersonate} className="user-detail__action-form">
                <label className="user-detail__action-label">
                  Reason (required)
                  <textarea
                    name="reason"
                    rows={2}
                    maxLength={500}
                    required
                    placeholder="Support ticket and what you need to verify"
                  />
                </label>
                <p className="user-detail__hint">
                  Accounts holding admin-staff roles are refused. The session ends automatically
                  after an hour, or from the banner&apos;s &ldquo;End impersonation&rdquo; control.
                </p>
                <button type="submit" className="user-detail__action-button">
                  Start impersonation
                </button>
              </form>
            }
          />
        )}
      </div>
    </section>
  );
}

function ActionDisclosure({
  summary,
  enabled,
  enabledHint,
  disabledHint,
  form,
}: {
  readonly summary: string;
  readonly enabled: boolean;
  readonly enabledHint: string;
  readonly disabledHint: string;
  readonly form: React.JSX.Element;
}): React.JSX.Element {
  if (!enabled) {
    return (
      <div className="user-detail__action-card user-detail__action-card--disabled">
        <strong>{summary}</strong>
        <span className="user-detail__hint">{disabledHint}</span>
      </div>
    );
  }
  return (
    <details className="user-detail__action-card">
      <summary>
        <strong>{summary}</strong>
        <span className="user-detail__hint">{enabledHint}</span>
      </summary>
      {form}
    </details>
  );
}

type ActionBannerState = { readonly kind: 'ok' } | { readonly kind: 'err'; readonly code: string };

function readBanner(
  search: Record<string, string | string[] | undefined> | undefined,
): ActionBannerState | null {
  const action = pickFirst(search?.['action']);
  if (action === 'ok') return { kind: 'ok' };
  if (action === 'err') {
    const code = pickFirst(search?.['code']) ?? 'unknown';
    return { kind: 'err', code };
  }
  return null;
}

function pickFirst(value: string | string[] | undefined): string | undefined {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value[0];
  return undefined;
}

function ActionBanner({ banner }: { readonly banner: ActionBannerState }): React.JSX.Element {
  if (banner.kind === 'ok') {
    return (
      <div className="user-detail__banner user-detail__banner--ok" role="status">
        Action complete.
      </div>
    );
  }
  return (
    <div className="user-detail__banner user-detail__banner--err" role="alert">
      Action did not complete: {describeBannerError(banner.code)}
    </div>
  );
}

function describeBannerError(code: string): string {
  switch (code) {
    case 'illegal-transition':
      return 'the account is no longer in the required state. Refresh and try again.';
    case 'not-found':
      return 'the user record was not found. It may have been deleted.';
    case 'reason-required':
      return 'a reason is required.';
    case 'impersonation-refused':
      return 'impersonation was refused for this account (own account or admin-staff target).';
    case 'bad-request':
      return 'the submission was rejected by the service. Check the values and try again.';
    case 'service-warning':
      return 'the service is briefly unreachable. Please try again in a moment.';
    default:
      return 'an unexpected error occurred.';
  }
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

async function fetchUserDetail(id: string): Promise<AdminUserDetail | 'not_found' | null> {
  const result = await callGateway<unknown>(`/api/v1/admin/users/${encodeURIComponent(id)}`);
  if (result.kind === 'unauthorized') {
    redirect('/login?expired=1');
  }
  if (result.kind === 'client_error' && result.status === 404) return 'not_found';
  if (result.kind !== 'ok') return null;
  const parsed = AdminUserDetailResponseSchema.safeParse(result.body);
  return parsed.success ? parsed.data.user : null;
}

function renderScope(scope: MeRoleAssignment['scope']): string {
  switch (scope.type) {
    case 'global':
      return 'global';
    case 'tenant':
      return `tenant ${scope.tenantId}`;
    case 'household':
      return `household ${scope.householdId}`;
  }
}

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString('en-US', {
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
