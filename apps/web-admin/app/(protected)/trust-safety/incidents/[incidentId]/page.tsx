import { redirect } from 'next/navigation';
import Link from 'next/link';
import type { Metadata } from 'next';
import {
  MeResponseSchema,
  TrustSafetyIncidentResponseSchema,
  type MeResponse,
  type TrustSafetyIncidentRecord,
} from '@taste-and-see/contracts';

import { callGateway } from '@/lib/api';
import { hasPermission } from '@/lib/admin-gate';
import { describeSystemEvidence, detectorLabel } from '@/lib/system-evidence';

export const metadata: Metadata = {
  title: 'Incident — Taste & See Admin',
};

/**
 * Trust & safety incident detail (TS-303c2b-followup-2; PRD §10.14; PDD
 * §16.1).
 *
 * **Gated on `trust_safety:write`, and this is the surface that justifies the
 * split.** The queue is a `trust_safety:read` view of shape and urgency; this
 * page renders `description` — a family member's free-text account of what
 * they believe happened to a named senior. The route behind it is gated the
 * same way (TS-303c2d), so this is not the only check.
 *
 * The page's other job is the hand-off into the statutory pathway. An
 * incident either already has a mandated-reporter case (link to it) or does
 * not (offer to open one, with the id pre-filled). Opening a case is the
 * determination that an incident may be reportable — the link says so rather
 * than presenting it as a routine next step.
 */

const HOUR_MS = 60 * 60 * 1000;

export default async function IncidentDetailPage({
  params,
}: {
  params: Promise<{ incidentId: string }>;
}): Promise<React.JSX.Element> {
  const { incidentId } = await params;

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

  const found = await fetchIncident(incidentId);

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
          <Link href="/trust-safety/incidents" className="dash-logout">
            Back to queue
          </Link>
        </div>
      </header>
      <main className="dash-main">
        <h1>Incident</h1>
        <p className="user-detail__sub">
          <code>{incidentId}</code>
        </p>

        {found === 'missing' ? (
          <div className="user-empty">
            <p>No incident with that id.</p>
          </div>
        ) : found === null ? (
          <p className="auth-alert" role="alert">
            We couldn&apos;t load this incident. The trust &amp; safety service may be unreachable —
            do not treat this as &ldquo;no such incident&rdquo;.
          </p>
        ) : (
          <IncidentDetail incident={found} />
        )}
      </main>
    </div>
  );
}

function IncidentDetail({
  incident,
}: {
  readonly incident: TrustSafetyIncidentRecord;
}): React.JSX.Element {
  const sla = slaLabel(incident.slaDueAt, incident.resolvedAt, Date.now());

  return (
    <>
      <section className="user-detail__section">
        <h2>Facts</h2>
        <dl className="concierge-detail__facts">
          <Fact label="Category">{formatWords(incident.category)}</Fact>
          <Fact label="Severity">{incident.severity}</Fact>
          <Fact label="Status">{formatWords(incident.status)}</Fact>
          <Fact label="Source">{formatWords(incident.source)}</Fact>
          <Fact label="SLA">
            <span className={sla.overdue ? 'concierge-sla concierge-sla--overdue' : undefined}>
              {sla.text}
            </span>
            {' — due '}
            {formatTimestamp(incident.slaDueAt)}
          </Fact>
          <Fact label="Opened">{formatTimestamp(incident.openedAt)}</Fact>
          <Fact label="Household">
            {incident.householdId === null ? 'not attributed' : <code>{incident.householdId}</code>}
          </Fact>
          <Fact label="Senior">
            {incident.seniorId === null ? 'not attributed' : <code>{incident.seniorId}</code>}
          </Fact>
          <Fact label="Provider">
            {incident.providerId === null ? (
              <>
                not attributed
                {incident.source === 'provider' && (
                  <>
                    {' '}
                    <span className="user-detail__hint">
                      (a provider-filed report carries no provider id — the linkage is resolved at
                      triage)
                    </span>
                  </>
                )}
              </>
            ) : (
              <>
                <code>{incident.providerId}</code>{' '}
                <Link
                  href={`/providers/${encodeURIComponent(incident.providerId)}/360`}
                  className="user-detail__hint"
                >
                  (open Provider 360 →)
                </Link>
              </>
            )}
          </Fact>
          <Fact label="Filed by">
            {incident.reporterUserId === null ? 'system' : <code>{incident.reporterUserId}</code>}
          </Fact>
          <Fact label="Resolved">
            {incident.resolvedAt === null ? 'open' : formatTimestamp(incident.resolvedAt)}
          </Fact>
        </dl>
      </section>

      <section className="user-detail__section">
        <h2>Report</h2>
        <p className="user-detail__hint">
          Confidential. This is what the reporter told us about a named senior.
        </p>
        {incident.description === null ? (
          <p className="user-detail__hint">
            No narrative — this incident was opened by the system, not by a person.
          </p>
        ) : (
          <p className="concierge-detail__body">{incident.description}</p>
        )}
        {incident.resolutionNotes !== null && (
          <>
            <h3>Resolution</h3>
            <p className="concierge-detail__body">{incident.resolutionNotes}</p>
          </>
        )}
      </section>

      {incident.source === 'system' && (
        <section className="user-detail__section">
          <h2>What the system detected</h2>
          <SystemEvidence incident={incident} />
        </section>
      )}

      <section className="user-detail__section">
        <h2>Mandated-reporter pathway</h2>
        {incident.hasMandatedReporterCase ? (
          <>
            <p>
              This incident is in the statutory pathway. It cannot be closed until a reviewer signs
              the case off.
            </p>
            <p className="user-detail__hint">
              <Link href={`/trust-safety/mandated-reporter/${encodeURIComponent(incident.id)}`}>
                Open the case →
              </Link>
            </p>
          </>
        ) : (
          <>
            <p>
              No mandated-reporter case. Opening one is the determination that this may be a
              reportable case of abuse or neglect — a legal judgement, not a routine next step, and
              nothing in the platform makes it automatically.
            </p>
            <p className="user-detail__hint">
              <Link
                href={`/trust-safety/mandated-reporter/new?incidentId=${encodeURIComponent(incident.id)}`}
              >
                Open a mandated-reporter case on this incident →
              </Link>
            </p>
          </>
        )}
      </section>
    </>
  );
}

/**
 * The evidence panel for a system-opened incident (TS-308c-followup-2).
 *
 * Before this, one of these incidents reached an operator as a category, a
 * severity, a subject and nothing at all — the numbers that justified it
 * lived only on the outbox event and in a log line. The `description` is
 * null by design and stays null; this section is where the explanation goes.
 *
 * Three states, and they are deliberately different from each other:
 *   - evidence present → the labelled facts;
 *   - detector known, evidence unreadable → say so and name the detector,
 *     rather than rendering an empty panel that reads like "nothing here";
 *   - neither → an incident opened by the system before detectors recorded
 *     anything, which is a real and shrinking set of rows.
 */
function SystemEvidence({
  incident,
}: {
  readonly incident: TrustSafetyIncidentRecord;
}): React.JSX.Element {
  const label = detectorLabel(incident.detector);

  if (incident.systemEvidence === null) {
    return (
      <>
        <p className="user-detail__hint">
          {label === null
            ? 'This incident was opened by the system, and no detector evidence was recorded with it.'
            : `Opened by ${label}, but the recorded evidence could not be read. The event id below is the handle to trace it.`}
        </p>
        {incident.sourceEventId !== null && (
          <p className="user-detail__hint">
            <code>{incident.sourceEventId}</code>
          </p>
        )}
      </>
    );
  }

  const view = describeSystemEvidence(incident.systemEvidence);

  return (
    <>
      <p className="concierge-detail__body">{view.headline}</p>
      <p className="user-detail__hint">
        Detected by {label ?? 'the system'}. These are measurements, not a conclusion — the
        judgement is yours.
      </p>
      <dl className="concierge-detail__facts">
        {view.rows.map((row) => (
          <Fact key={row.label} label={row.label}>
            {row.isId === true ? <code>{row.value}</code> : row.value}
          </Fact>
        ))}
        {incident.sourceEventId !== null && (
          <Fact label="Source event">
            <code>{incident.sourceEventId}</code>
          </Fact>
        )}
      </dl>
    </>
  );
}

function slaLabel(
  slaDueAt: string,
  resolvedAt: string | null,
  now: number,
): { readonly text: string; readonly overdue: boolean } {
  if (resolvedAt !== null) return { text: 'clock stopped at resolution', overdue: false };
  const due = new Date(slaDueAt).getTime();
  if (Number.isNaN(due)) return { text: 'SLA unreadable', overdue: true };
  const diffMs = due - now;
  const overdue = diffMs < 0;
  const hours = Math.round(Math.abs(diffMs) / HOUR_MS);
  const label = hours >= 48 ? `${Math.round(hours / 24)}d` : `${hours}h`;
  return { text: overdue ? `breached ${label} ago` : `due in ${label}`, overdue };
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

function formatWords(value: string): string {
  return value.replace(/_/g, ' ');
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

/** `'missing'` (404) stays distinct from `null` (unreachable) — see the
 * mandated-reporter surfaces for why that matters on this workflow. */
async function fetchIncident(
  incidentId: string,
): Promise<TrustSafetyIncidentRecord | 'missing' | null> {
  const result = await callGateway<unknown>(
    `/api/v1/admin/trust-safety/incidents/${encodeURIComponent(incidentId)}`,
  );
  if (result.kind === 'unauthorized') redirect('/login?expired=1');
  if (result.kind === 'client_error' && result.status === 404) return 'missing';
  if (result.kind !== 'ok') return null;
  const parsed = TrustSafetyIncidentResponseSchema.safeParse(result.body);
  return parsed.success ? parsed.data.incident : null;
}
