import { redirect } from 'next/navigation';
import Link from 'next/link';
import type { Metadata } from 'next';
import {
  MeResponseSchema,
  Provider360ResponseSchema,
  type MeResponse,
  type Provider360IncidentsSection,
  type Provider360Response,
  type ProviderCertificationRecord,
  type ProviderMetricsSection,
  type ProviderMetricsWindow,
  type ProviderTierHistoryRecord,
  type TrustSafetyIncidentSummary,
} from '@taste-and-see/contracts';

import { callGateway } from '@/lib/api';
import { hasPermission } from '@/lib/admin-gate';
import {
  formatMetricRate,
  formatResponseTime,
  lifetimeScopeLabel,
  metricsWindowHeadline,
} from '@/lib/provider-metrics-view';

export const metadata: Metadata = {
  title: 'Provider 360 — Taste & See Admin',
};

/**
 * Provider 360 — the review committee's deliberation surface (TS-305c;
 * PRD §10.14, PDD §16.1). web-admin's first `/providers` route.
 *
 * **Gated on `trust_safety:write` AND `provider:read`**, matching the
 * gateway aggregator behind it (TS-305b). Both are checked here so a
 * committee member missing one lands on /dashboard/no-access rather than
 * on a page that renders its shell and then fails.
 *
 * Three things this page refuses to do quietly:
 *
 *   1. **It never presents an incomplete complaint history as complete.**
 *      A provider-FILED incident carries a null `provider_id` (TS-301b),
 *      so the scroll under-counts until TS-301b-followup-1 lands the
 *      async linkage. The warning is rendered unconditionally above the
 *      history, not tucked into a tooltip. A committee-deliberation
 *      surface that quietly under-reports a provider's complaint history
 *      is worse than one that admits the gap.
 *
 *   2. **It never renders an unavailable section as an empty one.** The
 *      contract makes "no incidents" and "could not ask" different
 *      shapes; this page keeps them different on screen.
 *
 *   3. **It never renders an unmeasured metric as zero.** Ratings and
 *      performance are not measured anywhere on this platform
 *      (TS-305d / TS-305e). They appear as declared-absent panels, not
 *      as "0.0 ★" or "0% completion" — a number nobody computed is worse
 *      than an honest blank on a page someone makes a decision from.
 */

const HOUR_MS = 60 * 60 * 1000;

export default async function Provider360Page({
  params,
}: {
  params: Promise<{ providerId: string }>;
}): Promise<React.JSX.Element> {
  const { providerId } = await params;

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
  if (!hasPermission(me, 'trust_safety:write') || !hasPermission(me, 'provider:read')) {
    redirect('/dashboard/no-access');
  }

  const found = await fetchProvider360(providerId);

  return (
    <div className="dash-shell">
      <div className="admin-banner">
        <span>Admin console — provider review</span>
        <span className="admin-banner__operator" title={me.userId}>
          {me.userId}
        </span>
      </div>
      <header className="dash-top">
        <span className="dash-brand">Taste &amp; See — Admin</span>
        <div className="dash-account">
          <Link href="/providers" className="dash-logout">
            All providers
          </Link>
          <Link href="/trust-safety/incidents" className="dash-logout">
            Incident queue
          </Link>
        </div>
      </header>
      <main className="dash-main">
        <h1>Provider 360</h1>
        <p className="user-detail__sub">
          <code>{providerId}</code>
        </p>

        {found === 'missing' ? (
          <div className="user-empty">
            <p>No provider with that id.</p>
          </div>
        ) : found === null ? (
          <p className="auth-alert" role="alert">
            We couldn&apos;t load this provider. The provider service may be unreachable — do not
            treat this as &ldquo;no such provider&rdquo;.
          </p>
        ) : (
          <Provider360 view={found} />
        )}
      </main>
    </div>
  );
}

function Provider360({ view }: { readonly view: Provider360Response }): React.JSX.Element {
  return (
    <>
      <IdentitySection view={view} />
      <IncidentsSection section={view.incidents} />
      <CertificationsSection certifications={view.certifications} />
      <TierHistorySection history={view.tierHistory} />
      <PerformanceSection metrics={view.metrics} />
      <NotMeasuredSection />
      <p className="user-detail__hint">
        Composed {formatTimestamp(view.generatedAt)}. Each section is read live at page load.
      </p>
    </>
  );
}

// ─────────────────────────────────────────────────────────────────────
// Identity
// ─────────────────────────────────────────────────────────────────────

function IdentitySection({ view }: { readonly view: Provider360Response }): React.JSX.Element {
  const { provider, backgroundCheck } = view;
  return (
    <section className="user-detail__section">
      <h2>{provider.displayName}</h2>
      {provider.deletedAt !== null && (
        <p className="auth-alert" role="status">
          This provider was archived {formatTimestamp(provider.deletedAt)}. Their record is shown in
          full — an archived provider is still a provider a committee may need to review.
        </p>
      )}
      <dl className="concierge-detail__facts">
        <Fact label="Status">{formatWords(provider.status)}</Fact>
        <Fact label="Tier">{provider.tier}</Fact>
        <Fact label="Headline">{provider.headline ?? '—'}</Fact>
        <Fact label="Time zone">{provider.timeZone}</Fact>
        <Fact label="Dementia-sensitive">{provider.dementiaSensitive ? 'claimed' : 'no'}</Fact>
        <Fact label="Languages">{provider.languages.join(', ') || '—'}</Fact>
        <Fact label="Cuisines">{provider.cuisines.join(', ') || '—'}</Fact>
        <Fact label="Dietary expertise">{provider.dietaryExpertise.join(', ') || '—'}</Fact>
        <Fact label="On the platform since">{formatTimestamp(provider.createdAt)}</Fact>
        <Fact label="User account">
          <Link href={`/users/${encodeURIComponent(provider.userId)}`}>
            <code>{provider.userId}</code>
          </Link>
        </Fact>
        <Fact label="Background check">
          {backgroundCheck === null ? (
            <span className="concierge-sla concierge-sla--overdue">no check on file</span>
          ) : (
            <>
              {formatWords(backgroundCheck.status)}
              {backgroundCheck.completedAt !== null && (
                <> — completed {formatTimestamp(backgroundCheck.completedAt)}</>
              )}
            </>
          )}
        </Fact>
      </dl>
      {backgroundCheck === null && (
        <p className="user-detail__hint">
          No background check has ever been recorded for this provider. That is a finding in its own
          right, not a loading state.
        </p>
      )}
      <p className="user-detail__hint">
        The verdict is all this page carries. The underlying report is not shown here and is not
        reachable from this surface.
      </p>
    </section>
  );
}

// ─────────────────────────────────────────────────────────────────────
// Incidents
// ─────────────────────────────────────────────────────────────────────

function IncidentsSection({
  section,
}: {
  readonly section: Provider360IncidentsSection;
}): React.JSX.Element {
  return (
    <section className="user-detail__section">
      <h2>Complaint history</h2>

      {/* Rendered unconditionally, and above the rows — see the page
          doc-block. This warning is the difference between a tool a
          committee can rely on and one that misleads it. */}
      <p className="auth-alert" role="status">
        This history is known to be incomplete. An incident filed <em>by</em> a provider is recorded
        without a provider id, so any concern this provider raised themselves does not appear below.
        Do not read the absence of a report as its non-existence.
      </p>

      {section.state === 'unavailable' ? (
        <p className="auth-alert" role="alert">
          We couldn&apos;t load this provider&apos;s incident history ({formatWords(section.reason)}
          ). The trust &amp; safety service may be unreachable —{' '}
          <strong>this is not an empty history</strong>. Do not deliberate on it.
        </p>
      ) : section.incidents.length === 0 ? (
        <div className="user-empty">
          <p>No incidents recorded against this provider.</p>
        </div>
      ) : (
        <>
          {section.truncated && (
            <p className="user-detail__hint">
              Showing the most recent incidents only — older ones exist beyond this page.
            </p>
          )}
          <ul className="concierge-queue">
            {section.incidents.map((incident) => (
              <IncidentRow key={incident.id} incident={incident} now={Date.now()} />
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

function IncidentRow({
  incident,
  now,
}: {
  readonly incident: TrustSafetyIncidentSummary;
  readonly now: number;
}): React.JSX.Element {
  const sla = slaLabel(incident.slaDueAt, incident.resolvedAt, now);
  return (
    <li className="concierge-queue__row">
      {/* Every viewer of this page holds `trust_safety:write`, which is
          exactly what the incident detail requires — so unlike the
          incident queue, the row here is always a link. */}
      <Link
        href={`/trust-safety/incidents/${encodeURIComponent(incident.id)}`}
        className="concierge-queue__link"
      >
        <span className="concierge-queue__subject">
          {formatWords(incident.category)} · {formatWords(incident.source)} report
        </span>
        <span className="concierge-queue__meta">
          <span className={severityChipClass(incident.severity)}>{incident.severity}</span>
          <span className="user-row__chip">{formatWords(incident.status)}</span>
          {incident.hasMandatedReporterCase && (
            <span className="user-row__chip concierge-chip--escalated">
              ↑ mandated-reporter case
            </span>
          )}
          <span className={sla.overdue ? 'concierge-sla concierge-sla--overdue' : 'concierge-sla'}>
            {sla.text}
          </span>
        </span>
        <span className="concierge-queue__household">
          opened {formatTimestamp(incident.openedAt)} · <code>{incident.id}</code>
        </span>
      </Link>
    </li>
  );
}

// ─────────────────────────────────────────────────────────────────────
// Certifications
// ─────────────────────────────────────────────────────────────────────

function CertificationsSection({
  certifications,
}: {
  readonly certifications: readonly ProviderCertificationRecord[];
}): React.JSX.Element {
  const active = certifications.filter((c) => c.active);
  const lapsed = certifications.filter((c) => !c.active);

  return (
    <section className="user-detail__section">
      <h2>Credentials</h2>
      {certifications.length === 0 ? (
        <div className="user-empty">
          <p>This provider holds no certifications and has never been granted one.</p>
        </div>
      ) : (
        <>
          <h3>Active</h3>
          {active.length === 0 ? (
            <p className="user-detail__hint">None currently active.</p>
          ) : (
            <ul className="concierge-queue">
              {active.map((cert) => (
                <CertificationRow key={cert.id} cert={cert} />
              ))}
            </ul>
          )}

          {/* Revoked and expired credentials are shown, not filtered. The
              provider's own portal hides them; a review surface must not —
              a revoked food-handler certification is frequently the row
              the committee convened about. */}
          <h3>Revoked or expired</h3>
          {lapsed.length === 0 ? (
            <p className="user-detail__hint">None.</p>
          ) : (
            <ul className="concierge-queue">
              {lapsed.map((cert) => (
                <CertificationRow key={cert.id} cert={cert} />
              ))}
            </ul>
          )}
        </>
      )}
    </section>
  );
}

function CertificationRow({
  cert,
}: {
  readonly cert: ProviderCertificationRecord;
}): React.JSX.Element {
  return (
    <li className="concierge-queue__row">
      <span className="concierge-queue__link">
        <span className="concierge-queue__subject">{cert.certification.name}</span>
        <span className="concierge-queue__meta">
          <span className="user-row__chip">{cert.certification.code}</span>
          {cert.revokedAt !== null ? (
            <span className="concierge-sla concierge-sla--overdue">
              revoked {formatTimestamp(cert.revokedAt)}
            </span>
          ) : cert.active ? (
            <span className="concierge-sla">active</span>
          ) : (
            <span className="concierge-sla concierge-sla--overdue">expired</span>
          )}
        </span>
        <span className="concierge-queue__household">
          issued {formatTimestamp(cert.issuedAt)}
          {cert.expiresAt !== null && <> · expires {formatTimestamp(cert.expiresAt)}</>}
          {cert.revocationReason !== null && <> · {cert.revocationReason}</>}
        </span>
      </span>
    </li>
  );
}

// ─────────────────────────────────────────────────────────────────────
// Tier history
// ─────────────────────────────────────────────────────────────────────

function TierHistorySection({
  history,
}: {
  readonly history: readonly ProviderTierHistoryRecord[];
}): React.JSX.Element {
  return (
    <section className="user-detail__section">
      <h2>Tier history</h2>
      {history.length === 0 ? (
        <p className="user-detail__hint">
          No tier transitions recorded — this provider has held their original tier throughout.
        </p>
      ) : (
        <ul className="concierge-queue">
          {history.map((entry) => (
            <li key={entry.id} className="concierge-queue__row">
              <span className="concierge-queue__link">
                <span className="concierge-queue__subject">
                  {entry.fromTier ?? 'new'} → {entry.toTier}
                </span>
                <span className="concierge-queue__meta">
                  <span className="user-row__chip">{formatWords(entry.reason)}</span>
                  <span className="concierge-sla">{formatTimestamp(entry.occurredAt)}</span>
                </span>
                <span className="concierge-queue__household">
                  {entry.triggeredByUserId === null ? (
                    'automatic'
                  ) : (
                    <>
                      by <code>{entry.triggeredByUserId}</code>
                    </>
                  )}
                  {entry.notes !== null && <> · {entry.notes}</>}
                </span>
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

// ─────────────────────────────────────────────────────────────────────
// Declared-absent sections
// ─────────────────────────────────────────────────────────────────────

/**
 * Performance (TS-305d), derived from service-booking's lifecycle
 * events. PRD §10.14 named this panel; until now it read "Not
 * computed".
 *
 * **Both windows are rendered, always, and neither is offered alone.**
 * "Is this provider dependable right now" and "over their whole time
 * with us" are different questions a committee legitimately asks, and
 * showing only one invites the reader to answer the other with it.
 *
 * **A window with no rate renders no rate.** The contract's three-way
 * state is carried straight onto the page rather than being flattened
 * to a number with a caveat beside it — a caveat next to "0%" loses to
 * the number every time, especially on a screenshot.
 *
 * The `switch` is exhaustive on the discriminator, so a fourth state
 * added to the contract is a compile error here rather than a blank
 * panel (the TS-308c-followup-2 rule).
 */
function PerformanceSection({
  metrics,
}: {
  readonly metrics: ProviderMetricsSection;
}): React.JSX.Element {
  const now = new Date();
  return (
    <section className="user-detail__section">
      <h2>Performance</h2>
      <p className="user-detail__hint">
        Counted from booking outcomes. These are measurements, not a verdict — and they say nothing
        about who was at fault for a cancellation, which this platform does not record.
      </p>
      <MetricsWindowBlock
        label={`Last ${metrics.windowDays} days`}
        window={metrics.recent}
        windowDays={metrics.windowDays}
      />
      <MetricsWindowBlock
        label={lifetimeScopeLabel(metrics.firstObservedAt, now)}
        window={metrics.lifetime}
        windowDays={0}
      />
      <p className="user-detail__hint">Computed {formatTimestamp(metrics.computedAt)}.</p>
    </section>
  );
}

function MetricsWindowBlock({
  label,
  window,
  windowDays,
}: {
  readonly label: string;
  readonly window: ProviderMetricsWindow;
  readonly windowDays: number;
}): React.JSX.Element {
  return (
    <div className="user-detail__subsection">
      <h3>{label}</h3>
      <p>{metricsWindowHeadline(window, windowDays)}</p>
      {window.state === 'no_activity' ? null : (
        <dl className="concierge-detail__facts">
          {window.state === 'measured' && (
            <>
              <Fact label="Completed">{formatMetricRate(window.completionRate)}</Fact>
              <Fact label="Cancelled after acceptance">
                {formatMetricRate(window.cancellationRate)} — by any party. We do not record who
                cancelled, so this is not a fault rate.
              </Fact>
              <Fact label="Accepted when asked">{formatMetricRate(window.acceptanceRate)}</Fact>
              <Fact label="Typical time to answer">
                {formatResponseTime(window.medianResponseSeconds)}
              </Fact>
            </>
          )}
          <Fact label="Requests received">{window.counts.bookingsOffered}</Fact>
          <Fact label="Accepted">{window.counts.bookingsAccepted}</Fact>
          <Fact label="Declined by the provider">{window.counts.bookingsDeclined}</Fact>
          <Fact label="Left unanswered until the window closed">
            {window.counts.bookingsExpiredUnanswered}
          </Fact>
          {window.counts.bookingsDeclinedByAdmin > 0 && (
            <Fact label="Declined by our team on their behalf">
              {window.counts.bookingsDeclinedByAdmin} — excluded from every rate above; not the
              provider&rsquo;s decision.
            </Fact>
          )}
          <Fact label="Visits completed">{window.counts.bookingsCompleted}</Fact>
          <Fact label="Cancelled after acceptance">
            {window.counts.bookingsCanceledAfterAcceptance}
          </Fact>
        </dl>
      )}
    </div>
  );
}

/**
 * PRD §10.14 names ratings and performance metrics as part of this view.
 * The performance half landed under TS-305d, above. **Ratings have
 * not**, and this section is what is left of the original: nothing on
 * this platform captures one, so it is rendered as explicitly-absent
 * rather than omitted, and a committee is never left wondering whether
 * the panel failed to load or the number is bad (TS-305e).
 */
function NotMeasuredSection(): React.JSX.Element {
  return (
    <section className="user-detail__section">
      <h2>Not measured</h2>
      <dl className="concierge-detail__facts">
        <Fact label="Rating">
          Taste &amp; See does not collect provider ratings. There is no rating for this provider —
          not a low one, and not a missing one.
        </Fact>
      </dl>
    </section>
  );
}

// ─────────────────────────────────────────────────────────────────────
// Shared bits
// ─────────────────────────────────────────────────────────────────────

/** A resolved incident stops its SLA clock. */
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

/** `'missing'` (404) stays distinct from `null` (unreachable). */
async function fetchProvider360(
  providerId: string,
): Promise<Provider360Response | 'missing' | null> {
  const result = await callGateway<unknown>(
    `/api/v1/admin/providers/${encodeURIComponent(providerId)}/360`,
  );
  if (result.kind === 'unauthorized') redirect('/login?expired=1');
  if (result.kind === 'client_error' && result.status === 404) return 'missing';
  if (result.kind !== 'ok') return null;
  const parsed = Provider360ResponseSchema.safeParse(result.body);
  return parsed.success ? parsed.data : null;
}
