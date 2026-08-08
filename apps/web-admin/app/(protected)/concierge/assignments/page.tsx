import { redirect } from 'next/navigation';
import Link from 'next/link';
import type { Metadata } from 'next';
import {
  ConciergeAssignmentsListResponseSchema,
  CONCIERGE_ASSIGNMENT_DISPLAY_NAME_MAX_LENGTH,
  MeResponseSchema,
  TRUST_SAFETY_REPORT_DESCRIPTION_MAX_LENGTH,
  type ConciergeAssignmentRecord,
  type ConciergeAssignmentsListResponse,
  type MeResponse,
} from '@taste-and-see/contracts';

import { callGateway } from '@/lib/api';
import { hasPermission, hasSuperAdminRole } from '@/lib/admin-gate';
import {
  createConciergeAssignmentAction,
  endConciergeAssignmentAction,
  reportConcernOnBehalfAction,
} from './actions';
import { readBanner, type Banner } from '@/lib/search-params';

export const metadata: Metadata = {
  title: 'Concierge assignments — Taste & See Admin',
};

/**
 * Admin dedicated-concierge assignment surface (TS-222; PRD §5.1 Tier 3
 * "Dedicated culinary concierge", §6.6; PDD §10.6).
 *
 * Look up a Tier-3 household by id, see its current dedicated concierge +
 * assignment history, assign (or replace) the concierge, and end an
 * assignment. Enforces the three admin gates: authenticated, MFA-verified,
 * active super_admin role.
 */
export default async function ConciergeAssignmentsPage({
  searchParams,
}: {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}): Promise<React.JSX.Element> {
  const search = searchParams ? await searchParams : undefined;
  const banner = readBanner(search);
  const householdId = readHouseholdId(search);

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

  const list = householdId === null ? null : await fetchAssignments(householdId);

  return (
    <div className="dash-shell">
      <div className="admin-banner">
        <span>Admin console — concierge assignments</span>
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
        <h1>Dedicated concierge assignments</h1>
        <p>
          Assign a dedicated culinary concierge to a Tier&nbsp;3 household (PRD §5.1). The family
          sees their concierge on the &ldquo;Your concierge&rdquo; card. Reassigning ends the prior
          assignment and keeps the history.
        </p>

        {banner !== null && <ActionBanner banner={banner} />}

        <HouseholdLookupForm householdId={householdId} />

        {householdId !== null && (
          <>
            <section className="user-detail__section">
              <h2>
                Assignments for <code>{householdId}</code>
              </h2>
              {list === null ? (
                <p className="auth-alert">
                  We couldn&apos;t load this household&apos;s assignments right now. The downstream
                  concierge service may be unreachable.
                </p>
              ) : (
                <AssignmentsList householdId={householdId} list={list} />
              )}
            </section>

            <AssignForm householdId={householdId} />

            {hasPermission(me, 'concierge:write') && (
              <ReportConcernOnBehalfForm householdId={householdId} />
            )}
          </>
        )}
      </main>
    </div>
  );
}

function HouseholdLookupForm({
  householdId,
}: {
  readonly householdId: string | null;
}): React.JSX.Element {
  return (
    <section className="user-detail__section">
      <h2>Look up a household</h2>
      <form action="/concierge/assignments" method="GET" className="user-detail__action-form">
        <label className="user-detail__action-label">
          <span>Household id</span>
          <input
            type="text"
            name="householdId"
            defaultValue={householdId ?? ''}
            required
            placeholder="hh_…"
            autoComplete="off"
          />
        </label>
        <button type="submit" className="user-detail__action-button">
          Look up
        </button>
      </form>
    </section>
  );
}

function AssignmentsList({
  householdId,
  list,
}: {
  readonly householdId: string;
  readonly list: ConciergeAssignmentsListResponse;
}): React.JSX.Element {
  if (list.assignments.length === 0) {
    return (
      <div className="user-empty">
        <p>No assignments yet for this household. Use the form below to assign a concierge.</p>
      </div>
    );
  }
  return (
    <div className="user-detail__actions-grid">
      {list.assignments.map((assignment) => (
        <AssignmentCard key={assignment.id} householdId={householdId} assignment={assignment} />
      ))}
    </div>
  );
}

function AssignmentCard({
  householdId,
  assignment,
}: {
  readonly householdId: string;
  readonly assignment: ConciergeAssignmentRecord;
}): React.JSX.Element {
  const isActive = assignment.status === 'active';
  const chipClass = isActive ? 'user-row__chip user-row__chip--ok' : 'user-row__chip';
  const endBound = endConciergeAssignmentAction.bind(null, householdId, assignment.id);

  return (
    <div className="user-detail__action-card">
      <h3 className="user-detail__role-name">
        {assignment.primaryConciergeDisplayName}{' '}
        <span className={chipClass}>{assignment.status}</span>
      </h3>
      <p className="user-detail__hint">
        Primary: <code>{assignment.primaryConciergeUserId}</code>
      </p>
      {assignment.backupConciergeUserId !== null && (
        <p className="user-detail__hint">
          Backup: {assignment.backupConciergeDisplayName} (
          <code>{assignment.backupConciergeUserId}</code>)
        </p>
      )}
      <p className="user-detail__hint">
        Started {formatDate(assignment.startedAt)}
        {assignment.endedAt !== null && ` · ended ${formatDate(assignment.endedAt)}`}
      </p>
      {assignment.assignedByUserId !== null && (
        <p className="user-detail__hint">
          Assigned by <code>{assignment.assignedByUserId}</code>
        </p>
      )}
      {isActive && (
        <form action={endBound} className="user-detail__action-form">
          <button
            type="submit"
            className="user-detail__action-button user-detail__action-button--danger"
          >
            End assignment
          </button>
        </form>
      )}
    </div>
  );
}

function AssignForm({ householdId }: { readonly householdId: string }): React.JSX.Element {
  return (
    <section className="user-detail__section">
      <h2>Assign / replace concierge</h2>
      <p className="user-detail__hint">
        Assigning a new concierge ends the current active assignment automatically.
      </p>
      <form action={createConciergeAssignmentAction} className="user-detail__action-form">
        <input type="hidden" name="householdId" value={householdId} />
        <label className="user-detail__action-label">
          <span>Primary concierge — user id</span>
          <input
            type="text"
            name="primaryConciergeUserId"
            required
            placeholder="user_…"
            autoComplete="off"
          />
        </label>
        <label className="user-detail__action-label">
          <span>Primary concierge — display name</span>
          <input
            type="text"
            name="primaryConciergeDisplayName"
            required
            maxLength={CONCIERGE_ASSIGNMENT_DISPLAY_NAME_MAX_LENGTH}
            placeholder="e.g. Avery Martin"
            autoComplete="off"
          />
        </label>
        <label className="user-detail__action-label">
          <span>Backup concierge — user id (optional)</span>
          <input type="text" name="backupConciergeUserId" placeholder="user_…" autoComplete="off" />
        </label>
        <label className="user-detail__action-label">
          <span>Backup concierge — display name (optional)</span>
          <input
            type="text"
            name="backupConciergeDisplayName"
            maxLength={CONCIERGE_ASSIGNMENT_DISPLAY_NAME_MAX_LENGTH}
            placeholder="e.g. Blair Chen"
            autoComplete="off"
          />
        </label>
        <button type="submit" className="user-detail__action-button">
          Save assignment
        </button>
      </form>
    </section>
  );
}

/**
 * File a trust & safety concern on behalf of the household in view
 * (TS-301b).
 *
 * The concierge is the platform's ear on the phone: a family calls about
 * something that worries them, and the concern needs to reach trust & safety
 * without asking a distressed caller to go log in and fill in a form
 * themselves. `?householdId=` is already resolved on this page, so the form
 * is a hidden field plus the same two questions the family surface asks.
 *
 * Rendered only when the operator holds `concierge:write` — the affordance
 * mirrors the gate the gateway and service both enforce, so an operator
 * without it never sees a button that would 403.
 */
function ReportConcernOnBehalfForm({
  householdId,
}: {
  readonly householdId: string;
}): React.JSX.Element {
  return (
    <section className="user-detail__section">
      <h2>Report a concern for this household</h2>
      <p className="user-detail__hint">
        Files a trust &amp; safety incident on the household&apos;s behalf — use this when a family
        raises something on a call. The report is attributed to you as the filer. Welfare and safety
        concerns open at high severity and start an SLA timer immediately.
      </p>
      <form action={reportConcernOnBehalfAction} className="user-detail__action-form">
        <input type="hidden" name="householdId" value={householdId} />
        <label className="user-detail__action-label">
          <span>What is this about?</span>
          <select name="category" defaultValue="welfare">
            <option value="welfare">Welfare — a worry about the senior&apos;s wellbeing</option>
            <option value="safety">Safety or security</option>
            <option value="billing">Billing or payment</option>
            <option value="conduct">Conduct</option>
          </select>
        </label>
        <label className="user-detail__action-label">
          <span>Senior — id (optional)</span>
          <input type="text" name="seniorId" placeholder="sen_…" autoComplete="off" />
        </label>
        <label className="user-detail__action-label">
          <span>What was reported?</span>
          <textarea
            name="description"
            rows={5}
            required
            maxLength={TRUST_SAFETY_REPORT_DESCRIPTION_MAX_LENGTH}
            placeholder="What the caller described — who was involved, when, and what concerned them."
          />
        </label>
        <button type="submit" className="user-detail__action-button">
          File concern
        </button>
      </form>
    </section>
  );
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

function readHouseholdId(
  search: Record<string, string | string[] | undefined> | undefined,
): string | null {
  if (search === undefined) return null;
  const raw = search['householdId'];
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  return trimmed.length === 0 ? null : trimmed;
}

function ActionBanner({ banner }: { readonly banner: Banner }): React.JSX.Element {
  if (banner.kind === 'ok') {
    return (
      <p className="auth-alert auth-alert--success" role="status">
        Concierge assignment updated.
      </p>
    );
  }
  return (
    <p className="auth-alert" role="alert">
      {bannerMessageFor(banner.code)}
    </p>
  );
}

function bannerMessageFor(code: string): string {
  switch (code) {
    case 'household-required':
      return 'A household id is required.';
    case 'primary-required':
      return 'A primary concierge user id and display name are both required.';
    case 'backup-incomplete':
      return 'A backup concierge needs both a user id and a display name.';
    case 'backup-equals-primary':
      return 'The backup concierge must be a different person from the primary.';
    case 'conflict':
      return 'Another assignment for this household was created at the same time. Refresh and try again.';
    case 'not-found':
      return "We couldn't find that assignment — it may have already been ended.";
    case 'bad-request':
      return 'The request was rejected as malformed. Please refresh and try again.';
    case 'concern-incomplete':
      return 'A concern needs both a topic and a description of what was reported.';
    case 'concern-duplicate':
      return 'That exact concern was already filed for this household — it was not filed twice.';
    case 'concern-forbidden':
      return 'Filing on a household’s behalf requires the concierge:write permission.';
    case 'service-warning':
      return 'The concierge service is briefly unreachable. Please try again in a moment.';
    default:
      return 'Something went wrong. Please refresh and try again.';
  }
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

async function fetchAssignments(
  householdId: string,
): Promise<ConciergeAssignmentsListResponse | null> {
  const result = await callGateway<unknown>(
    `/api/v1/admin/concierge/assignments?householdId=${encodeURIComponent(householdId)}`,
  );
  if (result.kind === 'unauthorized') {
    redirect('/login?expired=1');
  }
  if (result.kind !== 'ok') return null;
  const parsed = ConciergeAssignmentsListResponseSchema.safeParse(result.body);
  return parsed.success ? parsed.data : null;
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
