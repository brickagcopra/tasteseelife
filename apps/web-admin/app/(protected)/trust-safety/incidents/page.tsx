import { redirect } from 'next/navigation';
import Link from 'next/link';
import type { Metadata } from 'next';
import {
  MeResponseSchema,
  TrustSafetyIncidentListResponseSchema,
  type MeResponse,
  type TrustSafetyIncidentListResponse,
  type TrustSafetyIncidentSummary,
} from '@taste-and-see/contracts';

import { callGateway } from '@/lib/api';
import { hasPermission } from '@/lib/admin-gate';

export const metadata: Metadata = {
  title: 'Trust & safety incidents — Taste & See Admin',
};

/**
 * Trust & safety incident queue (TS-303c2b-followup-2; PRD §10.14; PDD
 * §16.1).
 *
 * Reads `GET /api/v1/admin/trust-safety/incidents` (TS-303c2d) — summary rows
 * only, ordered by SLA deadline.
 *
 * **Gated on `trust_safety:read`, and that is deliberately the WEAKER gate.**
 * This page shows the shape of the queue — what kind of concern, how urgent,
 * how the SLA clock stands — and nothing a person said. The narrative lives on
 * the detail page behind `trust_safety:write`. Someone triaging workload can
 * work here without being handed families' accounts of what happened to named
 * seniors.
 *
 * Rows carry `hasMandatedReporterCase`, so the queue shows at a glance which
 * incidents are in the statutory pathway and therefore cannot be closed.
 */

const STATUS_FILTERS = [
  { value: '', label: 'Live work (everything unresolved)' },
  { value: 'open', label: 'Open' },
  { value: 'triaging', label: 'Triaging' },
  { value: 'awaiting_review', label: 'Awaiting review' },
  { value: 'resolved', label: 'Resolved (closed)' },
] as const;

const SEVERITY_FILTERS = [
  { value: '', label: 'Any severity' },
  { value: 'critical', label: 'Critical' },
  { value: 'high', label: 'High' },
  { value: 'medium', label: 'Medium' },
  { value: 'low', label: 'Low' },
] as const;

const VALID_STATUSES = new Set<string>(
  STATUS_FILTERS.map((s) => s.value).filter((v) => v.length > 0),
);
const VALID_SEVERITIES = new Set<string>(
  SEVERITY_FILTERS.map((s) => s.value).filter((v) => v.length > 0),
);

const HOUR_MS = 60 * 60 * 1000;

export default async function IncidentQueuePage({
  searchParams,
}: {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}): Promise<React.JSX.Element> {
  const search = searchParams ? await searchParams : undefined;
  const status = readEnum(search, 'status', VALID_STATUSES);
  const severity = readEnum(search, 'severity', VALID_SEVERITIES);
  const providerId = readFreeform(search, 'providerId');

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
  if (!hasPermission(me, 'trust_safety:read')) redirect('/dashboard/no-access');

  const canReadDetail = hasPermission(me, 'trust_safety:write');
  const queue = await fetchQueue({ status, severity, providerId });

  return (
    <div className="dash-shell">
      <div className="admin-banner">
        <span>Admin console — trust &amp; safety</span>
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
        <h1>Trust &amp; safety incidents</h1>
        <p>
          Concerns reported by families, seniors, providers, and concierges, soonest SLA first. This
          view shows what kind of concern and how urgent — never what was said. Open an incident to
          read the report.
        </p>

        <section className="user-detail__section">
          <form action="/trust-safety/incidents" method="GET" className="user-detail__action-form">
            <label className="user-detail__action-label">
              <span>Status</span>
              <select name="status" defaultValue={status ?? ''}>
                {STATUS_FILTERS.map((s) => (
                  <option key={s.value || 'live'} value={s.value}>
                    {s.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="user-detail__action-label">
              <span>Severity</span>
              <select name="severity" defaultValue={severity ?? ''}>
                {SEVERITY_FILTERS.map((s) => (
                  <option key={s.value || 'any'} value={s.value}>
                    {s.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="user-detail__action-label">
              <span>Provider id (optional)</span>
              <input type="text" name="providerId" defaultValue={providerId ?? ''} />
            </label>
            <button type="submit" className="user-detail__action-button">
              Apply
            </button>
          </form>
          {providerId !== null && (
            <p className="user-detail__hint">
              Note: an incident FILED BY a provider carries no provider id yet (the linkage is
              resolved at triage), so this scroll can under-count.
            </p>
          )}
          <p className="user-detail__hint">
            <Link href="/trust-safety/mandated-reporter">Mandated-reporter cases</Link>
          </p>
        </section>

        {queue === null ? (
          <p className="auth-alert" role="alert">
            We couldn&apos;t load the incident queue right now. The trust &amp; safety service may
            be unreachable — do not read this as an empty queue.
          </p>
        ) : (
          <QueueList queue={queue} canReadDetail={canReadDetail} />
        )}
      </main>
    </div>
  );
}

function QueueList({
  queue,
  canReadDetail,
}: {
  readonly queue: TrustSafetyIncidentListResponse;
  readonly canReadDetail: boolean;
}): React.JSX.Element {
  if (queue.incidents.length === 0) {
    return (
      <div className="user-empty">
        <p>No incidents match this view.</p>
      </div>
    );
  }
  const now = Date.now();
  return (
    <ul className="concierge-queue">
      {queue.incidents.map((incident) => (
        <IncidentRow
          key={incident.id}
          incident={incident}
          now={now}
          canReadDetail={canReadDetail}
        />
      ))}
    </ul>
  );
}

function IncidentRow({
  incident,
  now,
  canReadDetail,
}: {
  readonly incident: TrustSafetyIncidentSummary;
  readonly now: number;
  readonly canReadDetail: boolean;
}): React.JSX.Element {
  const sla = slaLabel(incident.slaDueAt, incident.resolvedAt, now);
  const body = (
    <>
      <span className="concierge-queue__subject">
        {formatWords(incident.category)} · {formatWords(incident.source)} report
      </span>
      <span className="concierge-queue__meta">
        <span className={severityChipClass(incident.severity)}>{incident.severity}</span>
        <span className="user-row__chip">{formatWords(incident.status)}</span>
        {incident.hasMandatedReporterCase && (
          <span className="user-row__chip concierge-chip--escalated">↑ mandated-reporter case</span>
        )}
        <span className={sla.overdue ? 'concierge-sla concierge-sla--overdue' : 'concierge-sla'}>
          {sla.text}
        </span>
      </span>
      <span className="concierge-queue__household">
        <code>{incident.id}</code>
        {incident.householdId !== null && (
          <>
            {' · '}household <code>{incident.householdId}</code>
          </>
        )}
        {incident.providerId !== null && (
          <>
            {' · '}provider <code>{incident.providerId}</code>
          </>
        )}
      </span>
    </>
  );

  return (
    <li className="concierge-queue__row">
      {canReadDetail ? (
        <Link
          href={`/trust-safety/incidents/${encodeURIComponent(incident.id)}`}
          className="concierge-queue__link"
        >
          {body}
        </Link>
      ) : (
        // No link without `trust_safety:write` — the detail page would bounce
        // to /dashboard/no-access, and a link that only ever refuses reads as
        // a broken console rather than as the permission boundary it is.
        <span className="concierge-queue__link">{body}</span>
      )}
    </li>
  );
}

/**
 * SLA countdown. A resolved incident stops its clock — showing "overdue 40d"
 * on something that was closed on time would be a false alarm on a surface
 * whose whole job is to flag real ones.
 */
function slaLabel(
  slaDueAt: string,
  resolvedAt: string | null,
  now: number,
): { readonly text: string; readonly overdue: boolean } {
  if (resolvedAt !== null) return { text: 'resolved', overdue: false };
  const due = new Date(slaDueAt).getTime();
  if (Number.isNaN(due)) return { text: 'SLA unreadable', overdue: true };
  const diffMs = due - now;
  const overdue = diffMs < 0;
  const hours = Math.round(Math.abs(diffMs) / HOUR_MS);
  const label = hours >= 48 ? `${Math.round(hours / 24)}d` : `${hours}h`;
  return { text: overdue ? `SLA breached ${label} ago` : `due in ${label}`, overdue };
}

function severityChipClass(severity: TrustSafetyIncidentSummary['severity']): string {
  if (severity === 'critical' || severity === 'high') {
    return 'user-row__chip concierge-chip--escalated';
  }
  return 'user-row__chip';
}

function formatWords(value: string): string {
  return value.replace(/_/g, ' ');
}

function readEnum(
  search: Record<string, string | string[] | undefined> | undefined,
  key: string,
  allowed: ReadonlySet<string>,
): string | null {
  if (search === undefined) return null;
  const raw = search[key];
  if (typeof raw !== 'string') return null;
  return allowed.has(raw) ? raw : null;
}

function readFreeform(
  search: Record<string, string | string[] | undefined> | undefined,
  key: string,
): string | null {
  if (search === undefined) return null;
  const raw = search[key];
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  return trimmed.length === 0 ? null : trimmed;
}

async function fetchMe(): Promise<MeResponse | null> {
  const result = await callGateway<unknown>('/api/v1/me');
  if (result.kind === 'unauthorized') redirect('/login?expired=1');
  if (result.kind !== 'ok') return null;
  const parsed = MeResponseSchema.safeParse(result.body);
  return parsed.success ? parsed.data : null;
}

async function fetchQueue(filters: {
  readonly status: string | null;
  readonly severity: string | null;
  readonly providerId: string | null;
}): Promise<TrustSafetyIncidentListResponse | null> {
  const search = new URLSearchParams();
  if (filters.status !== null) search.set('status', filters.status);
  if (filters.severity !== null) search.set('severity', filters.severity);
  if (filters.providerId !== null) search.set('providerId', filters.providerId);
  const query = search.toString();

  const result = await callGateway<unknown>(
    `/api/v1/admin/trust-safety/incidents${query.length > 0 ? `?${query}` : ''}`,
  );
  if (result.kind === 'unauthorized') redirect('/login?expired=1');
  if (result.kind !== 'ok') return null;
  const parsed = TrustSafetyIncidentListResponseSchema.safeParse(result.body);
  return parsed.success ? parsed.data : null;
}
