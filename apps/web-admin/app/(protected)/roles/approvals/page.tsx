import { redirect } from 'next/navigation';
import Link from 'next/link';
import type { Metadata } from 'next';
import {
  ADMIN_ROLE_APPROVAL_STATUSES,
  AdminRoleApprovalsListResponseSchema,
  MeResponseSchema,
  type AdminRoleApprovalRecord,
  type AdminRoleApprovalStatus,
  type MeResponse,
} from '@taste-and-see/contracts';

import { callGateway } from '@/lib/api';
import { hasPermission, hasSuperAdminRole } from '@/lib/admin-gate';
import { approveRoleApprovalAction, rejectRoleApprovalAction } from './actions';
import { readBanner, type Banner } from '@/lib/search-params';

export const metadata: Metadata = {
  title: 'RBAC — approvals — Taste & See Admin',
};

/**
 * Sensitive-role approvals queue (TS-294; CLAUDE.md §3.2). Lists grant
 * requests for `super_admin` / `finance`; a SECOND admin approves or
 * rejects. Page-gated `rbac:read`; deciding needs `rbac:write` AND an
 * active super_admin assignment (a requester may always reject —
 * withdraw — their own request). Every invariant is re-enforced
 * server-side; the UI only disables the affordances it can prove
 * won't succeed.
 */
export default async function RoleApprovalsPage({
  searchParams,
}: {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}): Promise<React.JSX.Element> {
  const search = searchParams ? await searchParams : undefined;
  const banner = readBanner(search);
  const statusFilter = readStatus(search);

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
  const isSuperAdmin = hasSuperAdminRole(me);
  const approvals = await fetchApprovals(statusFilter);

  return (
    <div className="dash-shell">
      <div className="admin-banner">
        <span>Admin console — RBAC approvals</span>
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
        <h1>Sensitive-role approvals</h1>
        <p>
          Grants of <code>super_admin</code> and <code>finance</code> require a second admin&apos;s
          approval — the grant only becomes active once approved. Requests are filed from a
          user&apos;s detail page. Approving requires an active <code>super_admin</code> assignment
          and you cannot approve your own request; a requester can always withdraw (reject) their
          own.
        </p>

        {banner !== null && <ActionBanner banner={banner} />}

        <nav aria-label="Filter by status" className="user-detail__hint">
          <Link href="/roles/approvals">pending</Link>
          {ADMIN_ROLE_APPROVAL_STATUSES.filter((s) => s !== 'pending').map((s) => (
            <span key={s}>
              {' · '}
              <Link href={`/roles/approvals?status=${s}`}>{s}</Link>
            </span>
          ))}
          <span>
            {' · '}
            <Link href="/roles/approvals?status=all">all</Link>
          </span>
        </nav>

        <section className="user-detail__section">
          <h2>{statusFilter === undefined ? 'All requests' : `${statusFilter} requests`}</h2>
          {approvals === null ? (
            <p className="auth-alert" role="alert">
              We couldn&apos;t load approval requests right now. The identity service may be
              unreachable.
            </p>
          ) : approvals.length === 0 ? (
            <div className="user-empty">
              <p>Nothing here. Sensitive-role requests appear the moment they are filed.</p>
            </div>
          ) : (
            <ul className="concierge-event-list">
              {approvals.map((approval) => (
                <ApprovalCard
                  key={approval.id}
                  approval={approval}
                  meUserId={me.userId}
                  canWrite={canWrite}
                  isSuperAdmin={isSuperAdmin}
                />
              ))}
            </ul>
          )}
        </section>
      </main>
    </div>
  );
}

function ApprovalCard({
  approval,
  meUserId,
  canWrite,
  isSuperAdmin,
}: {
  readonly approval: AdminRoleApprovalRecord;
  readonly meUserId: string;
  readonly canWrite: boolean;
  readonly isSuperAdmin: boolean;
}): React.JSX.Element {
  const isOwn = approval.requestedByUserId === meUserId;
  const pending = approval.status === 'pending';
  const canApprove = pending && canWrite && isSuperAdmin && !isOwn;
  const canReject = pending && canWrite && (isSuperAdmin || isOwn);

  return (
    <li className="concierge-event-card">
      <div className="concierge-event-card__head">
        <span className="concierge-event-card__title">
          {approval.roleName} → <span className="user-detail__mono">{approval.userId}</span>
        </span>
        <StatusChip status={approval.status} />
        {isOwn && <span className="user-row__chip">your request</span>}
      </div>
      <dl className="concierge-detail__facts">
        <FactItem label="Requested by">
          <span className="user-detail__mono">{approval.requestedByUserId}</span>
        </FactItem>
        <FactItem label="Scope">{renderScope(approval)}</FactItem>
        <FactItem label="Grant expires">
          {approval.expiresAt !== null ? formatDateTime(approval.expiresAt) : 'never'}
        </FactItem>
        <FactItem label="Filed">{formatDateTime(approval.createdAt)}</FactItem>
        {approval.reason !== null && <FactItem label="Reason">{approval.reason}</FactItem>}
        {approval.approvedByUserId !== null && (
          <FactItem label="Decided by">
            <span className="user-detail__mono">{approval.approvedByUserId}</span>
            {approval.decidedAt !== null && <> — {formatDateTime(approval.decidedAt)}</>}
          </FactItem>
        )}
        {approval.decisionNote !== null && (
          <FactItem label="Decision note">{approval.decisionNote}</FactItem>
        )}
      </dl>

      {pending && canWrite && (
        <div className="user-detail__actions-grid">
          {canApprove ? (
            <details className="user-detail__action-card">
              <summary>
                <strong>Approve</strong>
                <span className="user-detail__hint">
                  Mints the grant immediately. Recorded with both your id and the requester&apos;s.
                </span>
              </summary>
              <form action={approveRoleApprovalAction} className="user-detail__action-form">
                <input type="hidden" name="approvalId" value={approval.id} />
                <label className="user-detail__action-label">
                  Note (optional, audit trail)
                  <textarea
                    name="note"
                    rows={2}
                    maxLength={500}
                    placeholder="How you verified this…"
                  />
                </label>
                <button type="submit" className="user-detail__action-button">
                  Confirm approve
                </button>
              </form>
            </details>
          ) : (
            <div className="user-detail__action-card user-detail__action-card--disabled">
              <strong>Approve</strong>
              <span className="user-detail__hint">
                {isOwn
                  ? 'You filed this request — a second admin must approve it.'
                  : 'Approving requires an active super_admin assignment.'}
              </span>
            </div>
          )}

          {canReject ? (
            <details className="user-detail__action-card">
              <summary>
                <strong>{isOwn ? 'Withdraw' : 'Reject'}</strong>
                <span className="user-detail__hint">
                  {isOwn
                    ? 'Cancels your own request. No second admin needed.'
                    : 'Declines the request; the grant is never minted.'}
                </span>
              </summary>
              <form action={rejectRoleApprovalAction} className="user-detail__action-form">
                <input type="hidden" name="approvalId" value={approval.id} />
                <label className="user-detail__action-label">
                  Note (optional, audit trail)
                  <textarea name="note" rows={2} maxLength={500} placeholder="Why…" />
                </label>
                <button
                  type="submit"
                  className="user-detail__action-button user-detail__action-button--danger"
                >
                  {isOwn ? 'Confirm withdraw' : 'Confirm reject'}
                </button>
              </form>
            </details>
          ) : (
            <div className="user-detail__action-card user-detail__action-card--disabled">
              <strong>Reject</strong>
              <span className="user-detail__hint">
                Rejecting someone else&apos;s request requires an active super_admin assignment.
              </span>
            </div>
          )}
        </div>
      )}
    </li>
  );
}

function StatusChip({ status }: { readonly status: AdminRoleApprovalStatus }): React.JSX.Element {
  if (status === 'approved') {
    return <span className="perm-diff__chip perm-diff__chip--added">Approved</span>;
  }
  if (status === 'rejected' || status === 'expired') {
    return (
      <span className="perm-diff__chip perm-diff__chip--removed">
        {status === 'rejected' ? 'Rejected' : 'Expired'}
      </span>
    );
  }
  return <span className="perm-diff__chip">Pending</span>;
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

function renderScope(approval: AdminRoleApprovalRecord): string {
  switch (approval.scope.type) {
    case 'global':
      return 'global';
    case 'tenant':
      return `tenant ${approval.scope.tenantId}`;
    case 'household':
      return `household ${approval.scope.householdId}`;
  }
}

function ActionBanner({ banner }: { readonly banner: Banner }): React.JSX.Element {
  if (banner.kind === 'ok') {
    return (
      <p className="auth-alert auth-alert--success" role="status">
        Decision recorded.
      </p>
    );
  }
  return (
    <p className="auth-alert" role="alert">
      The decision was not recorded: {describeError(banner.code)}
    </p>
  );
}

function describeError(code: string): string {
  switch (code) {
    case 'forbidden':
      return 'you cannot decide this request (own request, or super_admin required).';
    case 'conflict':
      return 'the request was already decided, or the user gained the role in the meantime.';
    case 'not-found':
      return 'the request was not found.';
    case 'bad-request':
      return 'the submission was rejected. Check the values and try again.';
    case 'service-warning':
      return 'the service is briefly unreachable. Please try again in a moment.';
    default:
      return 'an unexpected error occurred.';
  }
}

/** Default view is the pending queue; `?status=all` lifts the filter. */
function readStatus(
  search: Record<string, string | string[] | undefined> | undefined,
): AdminRoleApprovalStatus | undefined {
  const raw = search?.['status'];
  if (raw === 'all') return undefined;
  if (
    typeof raw === 'string' &&
    (ADMIN_ROLE_APPROVAL_STATUSES as readonly string[]).includes(raw)
  ) {
    return raw as AdminRoleApprovalStatus;
  }
  return 'pending';
}

async function fetchMe(): Promise<MeResponse | null> {
  const result = await callGateway<unknown>('/api/v1/me');
  if (result.kind === 'unauthorized') redirect('/login?expired=1');
  if (result.kind !== 'ok') return null;
  const parsed = MeResponseSchema.safeParse(result.body);
  return parsed.success ? parsed.data : null;
}

async function fetchApprovals(
  status: AdminRoleApprovalStatus | undefined,
): Promise<readonly AdminRoleApprovalRecord[] | null> {
  const path =
    status === undefined
      ? '/api/v1/admin/role-approvals'
      : `/api/v1/admin/role-approvals?status=${status}`;
  const result = await callGateway<unknown>(path);
  if (result.kind === 'unauthorized') redirect('/login?expired=1');
  if (result.kind !== 'ok') return null;
  const parsed = AdminRoleApprovalsListResponseSchema.safeParse(result.body);
  return parsed.success ? parsed.data.approvals : null;
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
