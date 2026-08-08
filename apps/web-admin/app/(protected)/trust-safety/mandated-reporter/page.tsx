import { redirect } from 'next/navigation';
import Link from 'next/link';
import type { Metadata } from 'next';
import {
  MandatedReporterCaseListResponseSchema,
  MeResponseSchema,
  type MandatedReporterCaseListResponse,
  type MandatedReporterCaseSummary,
  type MeResponse,
} from '@taste-and-see/contracts';

import { callGateway } from '@/lib/api';
import { hasPermission } from '@/lib/admin-gate';
import { deadlineLabel } from '@/lib/trust-safety-view';

export const metadata: Metadata = {
  title: 'Mandated-reporter cases — Taste & See Admin',
};

/**
 * Mandated-reporter case queue (TS-303c2b; PRD §10.14, §11.4; PDD §16.1,
 * §16.4; CLAUDE.md §12).
 *
 * The operator surface over the statutory pathway for suspected elder abuse.
 * Reads `GET /api/v1/admin/trust-safety/mandated-reporter/cases` (TS-303c2a)
 * through the gateway BFF, which gates `trust_safety:write` and re-checks it
 * downstream.
 *
 * **Gated on `trust_safety:write`, not `:read`, and deliberately so.** Every
 * route behind this surface carries the write permission (TS-303c1 settled the
 * same question for the jurisdiction reads). A `:read`-only view of this queue
 * would be a list of which seniors are suspected abuse victims.
 *
 * **The deadline column is the point of the page.** `statutoryDueAt` is
 * nullable, and a null is NOT "no deadline" — it means nobody has established
 * that state's statutory window, so the case has no clock at all. That renders
 * as an explicit compliance to-do, and the back end sorts those rows to the
 * top (TS-303c2a) rather than letting them age quietly at the bottom.
 */

const STATUS_FILTERS = [
  { value: '', label: 'Live work (everything not signed off)' },
  { value: 'screening', label: 'Screening — reportability call pending' },
  { value: 'filing_prep', label: 'Filing prep' },
  { value: 'filed', label: 'Filed — awaiting signoff' },
  { value: 'not_reportable', label: 'Not reportable — awaiting signoff' },
  { value: 'signed_off', label: 'Signed off (closed)' },
] as const;

const VALID_STATUSES = new Set<string>(
  STATUS_FILTERS.map((s) => s.value).filter((v) => v.length > 0),
);

export default async function MandatedReporterQueuePage({
  searchParams,
}: {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}): Promise<React.JSX.Element> {
  const search = searchParams ? await searchParams : undefined;
  const status = readStatus(search);

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

  const queue = await fetchQueue(status);

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
          <Link href="/dashboard" className="dash-logout">
            Back to console
          </Link>
        </div>
      </header>
      <main className="dash-main">
        <h1>Mandated-reporter cases</h1>
        <p>
          Incidents routed into the statutory pathway for suspected abuse or neglect, soonest
          deadline first. Opening a case is itself the determination that an incident may be
          reportable — nothing here is derived automatically.
        </p>

        <section className="user-detail__section">
          <form
            action="/trust-safety/mandated-reporter"
            method="GET"
            className="user-detail__action-form"
          >
            <label className="user-detail__action-label">
              <span>Show</span>
              <select name="status" defaultValue={status ?? ''}>
                {STATUS_FILTERS.map((s) => (
                  <option key={s.value || 'live'} value={s.value}>
                    {s.label}
                  </option>
                ))}
              </select>
            </label>
            <button type="submit" className="user-detail__action-button">
              Apply
            </button>
          </form>
          <p className="user-detail__hint">
            <Link href="/trust-safety/mandated-reporter/new">+ Open a case on an incident</Link>
            {' · '}
            <Link href="/trust-safety/mandated-reporter/jurisdictions">Jurisdiction kit</Link>
            {' · '}
            <Link href="/trust-safety/incidents">Incident queue</Link>
          </p>
        </section>

        {queue === null ? (
          <p className="auth-alert" role="alert">
            We couldn&apos;t load the mandated-reporter queue right now. The trust &amp; safety
            service may be unreachable — if this persists, escalate rather than assuming the queue
            is empty.
          </p>
        ) : (
          <QueueList queue={queue} status={status} />
        )}
      </main>
    </div>
  );
}

function QueueList({
  queue,
  status,
}: {
  readonly queue: MandatedReporterCaseListResponse;
  readonly status: string | null;
}): React.JSX.Element {
  if (queue.cases.length === 0) {
    return (
      <div className="user-empty">
        <p>
          {status === null
            ? 'No open mandated-reporter cases.'
            : 'No cases in this state of the workflow.'}
        </p>
      </div>
    );
  }
  const now = Date.now();
  return (
    <ul className="concierge-queue">
      {queue.cases.map((row) => (
        <CaseRow key={row.id} row={row} now={now} />
      ))}
    </ul>
  );
}

function CaseRow({
  row,
  now,
}: {
  readonly row: MandatedReporterCaseSummary;
  readonly now: number;
}): React.JSX.Element {
  const deadline = deadlineLabel(row.statutoryDueAt, now);
  return (
    <li className="concierge-queue__row">
      <Link
        href={`/trust-safety/mandated-reporter/${encodeURIComponent(row.incidentId)}`}
        className="concierge-queue__link"
      >
        <span className="concierge-queue__subject">
          {row.stateCode} · case {row.id}
        </span>
        <span className="concierge-queue__meta">
          <span className={statusChipClass(row.status)}>{formatStatus(row.status)}</span>
          <span className={deadline.className}>{deadline.text}</span>
          {row.filedAt !== null && <span className="user-row__chip user-row__chip--ok">filed</span>}
        </span>
        <span className="concierge-queue__household">
          incident <code>{row.incidentId}</code>
          {' · '}opened by <code>{row.openedByUserId}</code>
          {row.reviewerUserId !== null && (
            <>
              {' · '}reviewed by <code>{row.reviewerUserId}</code>
            </>
          )}
        </span>
      </Link>
    </li>
  );
}

function statusChipClass(status: MandatedReporterCaseSummary['status']): string {
  if (status === 'signed_off') return 'user-row__chip user-row__chip--ok';
  if (status === 'filing_prep' || status === 'filed') {
    return 'user-row__chip concierge-chip--escalated';
  }
  return 'user-row__chip';
}

function formatStatus(status: string): string {
  return status.replace(/_/g, ' ');
}

function readStatus(
  search: Record<string, string | string[] | undefined> | undefined,
): string | null {
  if (search === undefined) return null;
  const raw = search['status'];
  if (typeof raw !== 'string') return null;
  return VALID_STATUSES.has(raw) ? raw : null;
}

async function fetchMe(): Promise<MeResponse | null> {
  const result = await callGateway<unknown>('/api/v1/me');
  if (result.kind === 'unauthorized') redirect('/login?expired=1');
  if (result.kind !== 'ok') return null;
  const parsed = MeResponseSchema.safeParse(result.body);
  return parsed.success ? parsed.data : null;
}

async function fetchQueue(status: string | null): Promise<MandatedReporterCaseListResponse | null> {
  const query = status === null ? '' : `?status=${encodeURIComponent(status)}`;
  const result = await callGateway<unknown>(
    `/api/v1/admin/trust-safety/mandated-reporter/cases${query}`,
  );
  if (result.kind === 'unauthorized') redirect('/login?expired=1');
  if (result.kind !== 'ok') return null;
  const parsed = MandatedReporterCaseListResponseSchema.safeParse(result.body);
  return parsed.success ? parsed.data : null;
}
