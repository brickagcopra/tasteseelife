import { redirect } from 'next/navigation';
import Link from 'next/link';
import type { Metadata } from 'next';
import {
  MANDATED_REPORTER_STATUS_TRANSITIONS,
  MandatedReporterCaseResponseSchema,
  MeResponseSchema,
  type MandatedReporterCaseRecord,
  type MandatedReporterCaseStatus,
  type MeResponse,
} from '@taste-and-see/contracts';

import { callGateway } from '@/lib/api';
import { hasPermission } from '@/lib/admin-gate';
import { readDetailParam } from '@/lib/problem-detail';
import { isSignoffBlockedByFourEyes } from '@/lib/trust-safety-view';

import { advanceCaseAction, resolveIncidentAction } from '../actions';

export const metadata: Metadata = {
  title: 'Mandated-reporter case — Taste & See Admin',
};

/**
 * Mandated-reporter case detail (TS-303c2b; PRD §10.14, §11.4; PDD §16.1,
 * §16.4; CLAUDE.md §12).
 *
 * **Addressed by INCIDENT id, not case id.** `GET .../cases/by-incident/{id}`
 * is the only case detail read the platform has, and `incident_id` is UNIQUE
 * on the case table, so the incident is a faithful key for exactly one case.
 * The route segment says so rather than pretending to be a case id.
 *
 * Three things this page has to get right, all of them safety properties
 * rather than conveniences:
 *
 * 1. **Only legal transitions are offered.** The action list is built from
 *    `MANDATED_REPORTER_STATUS_TRANSITIONS` in `@taste-and-see/contracts` —
 *    the same matrix the service checks against (single-sourced in TS-303c2b
 *    for exactly this reason). A console that offered an illegal transition
 *    would be inviting an operator to file a 422 on a statutory deadline.
 *
 * 2. **The signoff control is hidden from the operator who opened the case.**
 *    Four eyes is enforced in the service AND by a DB CHECK, so the button
 *    would 409 regardless — but offering a control that cannot work reads as a
 *    system fault rather than as the rule it is. It is replaced with a sentence
 *    naming the rule, so the operator knows to find a colleague rather than to
 *    retry.
 *
 * 3. **The downstream explanation is rendered verbatim.** The 422s and 409s on
 *    this workflow were written for the operator; see `lib/problem-detail.ts`.
 *
 * `determinationNotes` / `reviewerNotes` appear here and ONLY here (the queue
 * read deliberately omits them, TS-303c2a). They are a named senior's
 * circumstances — this page is the authorised read, not a place to link from.
 */

export default async function MandatedReporterCasePage({
  params,
  searchParams,
}: {
  params: Promise<{ incidentId: string }>;
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}): Promise<React.JSX.Element> {
  const { incidentId } = await params;
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
  if (!hasPermission(me, 'trust_safety:write')) redirect('/dashboard/no-access');

  const found = await fetchCase(incidentId);

  return (
    <div className="dash-shell">
      <div className="admin-banner">
        <span>Admin console — mandated reporter</span>
        <span className="admin-banner__operator" title={me.userId}>
          {me.userId}
        </span>
      </div>
      <header className="dash-top">
        <span className="dash-brand">Taste &amp; See — Admin</span>
        <div className="dash-account">
          <Link href="/trust-safety/mandated-reporter" className="dash-logout">
            Back to queue
          </Link>
        </div>
      </header>
      <main className="dash-main">
        <h1>Mandated-reporter case</h1>
        <p className="user-detail__sub">
          incident <code>{incidentId}</code>
        </p>

        {banner !== null && <ActionBanner banner={banner} />}

        {found === 'missing' ? (
          <div className="user-empty">
            <p>
              No mandated-reporter case exists for this incident. If it should be in the statutory
              pathway, <Link href="/trust-safety/mandated-reporter/new">open one</Link> — that act
              is itself the determination, and it starts the clock.
            </p>
          </div>
        ) : found === null ? (
          <p className="auth-alert" role="alert">
            We couldn&apos;t load this case. The trust &amp; safety service may be unreachable — do
            not treat this as &ldquo;no case exists&rdquo;.
          </p>
        ) : (
          <CaseDetail record={found} actorUserId={me.userId} />
        )}
      </main>
    </div>
  );
}

function CaseDetail({
  record,
  actorUserId,
}: {
  readonly record: MandatedReporterCaseRecord;
  readonly actorUserId: string;
}): React.JSX.Element {
  const transitions = MANDATED_REPORTER_STATUS_TRANSITIONS[record.status];
  const isTerminal = transitions.length === 0;

  return (
    <>
      <section className="user-detail__section">
        <h2>Case</h2>
        <dl className="concierge-detail__facts">
          <Fact label="Case id">
            <code>{record.id}</code>
          </Fact>
          <Fact label="Jurisdiction">{record.stateCode}</Fact>
          <Fact label="Status">{formatStatus(record.status)}</Fact>
          <Fact label="Statutory deadline">
            <DeadlineFact statutoryDueAt={record.statutoryDueAt} />
          </Fact>
          <Fact label="Opened">
            {formatTimestamp(record.openedAt)} by <code>{record.openedByUserId}</code>
          </Fact>
          <Fact label="Filed">
            {record.filedAt === null ? (
              'not filed'
            ) : (
              <>
                {formatTimestamp(record.filedAt)}
                {record.filingReference !== null && (
                  <>
                    {' — agency reference '}
                    <code>{record.filingReference}</code>
                  </>
                )}
              </>
            )}
          </Fact>
          <Fact label="Reviewer signoff">
            {record.reviewerUserId === null ? (
              'not signed off'
            ) : (
              <>
                <code>{record.reviewerUserId}</code>
                {record.reviewedAt !== null && <> on {formatTimestamp(record.reviewedAt)}</>}
              </>
            )}
          </Fact>
        </dl>
      </section>

      <section className="user-detail__section">
        <h2>Documentation packet</h2>
        <p className="user-detail__hint">
          Confidential. These notes concern a named senior and are readable only on this surface.
        </p>
        <h3>Determination</h3>
        {record.determinationNotes === null ? (
          <p className="user-detail__hint">No determination recorded yet.</p>
        ) : (
          <p className="concierge-detail__body">{record.determinationNotes}</p>
        )}
        <h3>Reviewer notes</h3>
        {record.reviewerNotes === null ? (
          <p className="user-detail__hint">No reviewer notes recorded yet.</p>
        ) : (
          <p className="concierge-detail__body">{record.reviewerNotes}</p>
        )}
      </section>

      <section className="user-detail__section">
        <h2>Advance the case</h2>
        {isTerminal ? (
          <p className="user-detail__hint">
            This case is signed off. Nothing transitions out of it, and the parent incident is now
            free to be resolved below.
          </p>
        ) : (
          <div className="user-detail__actions-grid">
            {transitions.map((to) => (
              <TransitionCard
                key={to}
                to={to}
                record={record}
                blockedByFourEyes={isSignoffBlockedByFourEyes({
                  to,
                  openedByUserId: record.openedByUserId,
                  actorUserId,
                })}
              />
            ))}
          </div>
        )}
      </section>

      <section className="user-detail__section">
        <h2>Resolve the incident</h2>
        <p className="user-detail__hint">
          An incident with a live mandated-reporter case cannot be closed. Only a reviewer signoff
          releases it — the service refuses the closure otherwise, and will say so here.
        </p>
        <form action={resolveIncidentAction} className="user-detail__action-form">
          <input type="hidden" name="incidentId" value={record.incidentId} />
          <label className="user-detail__action-label">
            <span>Why this incident is being closed (required)</span>
            <textarea name="resolutionNotes" rows={3} required />
          </label>
          <button type="submit" className="user-detail__action-button">
            Resolve incident
          </button>
        </form>
      </section>
    </>
  );
}

/**
 * One transition, as a disclosure card carrying only the fields that
 * transition actually needs. `filed` requires an agency reference (the service
 * 400s without it, and a DB CHECK pairs it with `filed_at`), so the field is
 * marked required here rather than letting the operator discover it by
 * failing.
 */
function TransitionCard({
  to,
  record,
  blockedByFourEyes,
}: {
  readonly to: MandatedReporterCaseStatus;
  readonly record: MandatedReporterCaseRecord;
  readonly blockedByFourEyes: boolean;
}): React.JSX.Element {
  if (blockedByFourEyes) {
    return (
      <div className="user-detail__action-card user-detail__action-card--disabled">
        <p>
          <strong>Sign off</strong> — not available to you.
        </p>
        <p className="user-detail__hint">
          You opened this case. A determination on suspected elder abuse needs a second pair of
          eyes, so the signoff has to come from another operator with{' '}
          <code>trust_safety:write</code>.
        </p>
      </div>
    );
  }

  return (
    <details className="user-detail__action-card">
      <summary>{TRANSITION_LABELS[to]}</summary>
      <form action={advanceCaseAction} className="user-detail__action-form">
        <input type="hidden" name="caseId" value={record.id} />
        <input type="hidden" name="incidentId" value={record.incidentId} />
        <input type="hidden" name="to" value={to} />
        <p className="user-detail__hint">{TRANSITION_HINTS[to]}</p>
        {to === 'filed' && (
          <label className="user-detail__action-label">
            <span>Agency confirmation / case number (required)</span>
            <input type="text" name="filingReference" required />
          </label>
        )}
        {to === 'signed_off' ? (
          <label className="user-detail__action-label">
            <span>Reviewer notes</span>
            <textarea name="reviewerNotes" rows={3} />
          </label>
        ) : (
          <label className="user-detail__action-label">
            <span>Determination notes</span>
            <textarea name="determinationNotes" rows={3} />
          </label>
        )}
        <button type="submit" className="user-detail__action-button">
          {TRANSITION_LABELS[to]}
        </button>
      </form>
    </details>
  );
}

const TRANSITION_LABELS: Readonly<Record<MandatedReporterCaseStatus, string>> = {
  screening: 'Return to screening',
  filing_prep: 'Move to filing prep',
  filed: 'Record the filing',
  not_reportable: 'Mark not reportable',
  signed_off: 'Sign off',
};

const TRANSITION_HINTS: Readonly<Record<MandatedReporterCaseStatus, string>> = {
  screening: 'Nothing transitions back into screening.',
  filing_prep:
    "Blocked unless compliance has verified this state's kit — the platform does not assemble a filing against agency details nobody checked.",
  filed: 'Records that the report was made. The agency reference is the evidence of it.',
  not_reportable:
    'A negative determination. Not terminal — it still needs a signoff, and it can be reopened to filing prep if new facts arrive.',
  signed_off:
    'The terminal state, and the only one that releases the parent incident for resolution.',
};

function DeadlineFact({
  statutoryDueAt,
}: {
  readonly statutoryDueAt: string | null;
}): React.JSX.Element {
  if (statutoryDueAt === null) {
    return (
      <>
        <strong>State window not established.</strong>{' '}
        <span className="user-detail__hint">
          This is a compliance gap, not the absence of a deadline — the statutory clock is running
          and nobody has recorded how long it is. Populate the jurisdiction kit for this state.
        </span>
      </>
    );
  }
  return <>{formatTimestamp(statutoryDueAt)}</>;
}

function Fact({
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

type Banner =
  | { readonly kind: 'ok'; readonly code: string }
  | { readonly kind: 'err'; readonly code: string; readonly detail: string | null };

function readBanner(
  search: Record<string, string | string[] | undefined> | undefined,
): Banner | null {
  if (search === undefined) return null;
  const action = search['action'];
  const code = typeof search['code'] === 'string' ? search['code'] : 'unknown';
  if (action === 'ok') return { kind: 'ok', code };
  if (action === 'err') return { kind: 'err', code, detail: readDetailParam(search) };
  return null;
}

function ActionBanner({ banner }: { readonly banner: Banner }): React.JSX.Element {
  if (banner.kind === 'ok') {
    return (
      <p className="auth-alert auth-alert--success" role="status">
        {banner.code === 'opened'
          ? 'Case opened. The statutory clock is running.'
          : banner.code === 'resolved'
            ? 'Incident resolved.'
            : 'Saved.'}
      </p>
    );
  }
  // The downstream explanation is the useful half — show it first and in full.
  // React escapes it as text; it is never injected as markup.
  return (
    <p className="auth-alert" role="alert">
      {banner.detail ?? 'Something went wrong. Please try again.'}
      {banner.detail !== null && banner.code === 'rejected' && (
        <>
          {' '}
          <span className="user-detail__hint">The case was not changed.</span>
        </>
      )}
    </p>
  );
}

function formatStatus(status: string): string {
  return status.replace(/_/g, ' ');
}

function formatTimestamp(iso: string): string {
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return iso;
  return parsed.toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
}

async function fetchMe(): Promise<MeResponse | null> {
  const result = await callGateway<unknown>('/api/v1/me');
  if (result.kind === 'unauthorized') redirect('/login?expired=1');
  if (result.kind !== 'ok') return null;
  const parsed = MeResponseSchema.safeParse(result.body);
  return parsed.success ? parsed.data : null;
}

/**
 * `'missing'` (a real 404 — triage never routed this incident here) is
 * distinguished from `null` (we could not reach the service). Collapsing the
 * two would let an outage render as "no case exists" on a surface where that
 * sentence means "no statutory obligation was recorded".
 */
async function fetchCase(
  incidentId: string,
): Promise<MandatedReporterCaseRecord | 'missing' | null> {
  const result = await callGateway<unknown>(
    `/api/v1/admin/trust-safety/mandated-reporter/cases/by-incident/${encodeURIComponent(incidentId)}`,
  );
  if (result.kind === 'unauthorized') redirect('/login?expired=1');
  if (result.kind === 'client_error' && result.status === 404) return 'missing';
  if (result.kind !== 'ok') return null;
  const parsed = MandatedReporterCaseResponseSchema.safeParse(result.body);
  return parsed.success ? parsed.data.case : null;
}
