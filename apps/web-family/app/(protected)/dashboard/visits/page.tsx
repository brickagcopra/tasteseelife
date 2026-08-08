import Link from 'next/link';
import { redirect } from 'next/navigation';
import type { Metadata } from 'next';
import {
  DASHBOARD_WINDOW_DAYS_DEFAULT,
  DASHBOARD_WINDOW_DAYS_VALUES,
  type DashboardPastVisit,
  type DashboardWindowDays,
  type FamilyVisitsDashboardResponse,
} from '@taste-and-see/contracts';

import { formatServiceKind, formatStatus, formatVisitTime } from '@/lib/bookings-api';
import { getFamilyVisitsDashboard, toWellnessChips } from '@/lib/family-dashboard-api';
import { listMySeniors } from '@/lib/seniors-api';

export const metadata: Metadata = {
  title: 'Visits & wellness — Taste & See',
};

// Visit + wellness data must always be fresh — never serve a stale
// cache of "the next visit" or "how mom is doing".
const WINDOW_LABELS: Record<DashboardWindowDays, string> = {
  7: 'Next 7 days',
  30: 'Next 30 days',
  90: 'Next 90 days',
};

/**
 * Family peace-of-mind dashboard (TS-230; PRD §6.4, §6.9; PDD §10).
 *
 * Server-rendered. Shows, for the household resolved downstream from
 * the token:
 *   - a window selector (7 / 30 / 90 days) over the upcoming visits,
 *   - the upcoming-visit list (soonest-first),
 *   - the completed-visit history with collapsible visit-note
 *     summaries (cursor-paginated), and
 *   - per-senior tabs for multi-senior households (default "All").
 *
 * Photos are not rendered here — the visit-note summary surfaces only
 * how many were shared; consent-gated photo display is TS-232.
 */
export default async function VisitsDashboardPage({
  searchParams,
}: {
  readonly searchParams?: Promise<Record<string, string | string[] | undefined>>;
}): Promise<React.JSX.Element> {
  const params = (await searchParams) ?? {};
  const windowDays = parseWindow(params.window);
  const requestedSenior = typeof params.senior === 'string' ? params.senior : undefined;
  const historyCursor = typeof params.historyCursor === 'string' ? params.historyCursor : undefined;

  const [seniorsResult, dashboardResult] = await Promise.all([
    listMySeniors(),
    // The active senior is validated against the household's roster below;
    // pass it through optimistically (the service ignores a non-matching
    // seniorId by returning an empty per-senior view, which is harmless).
    getFamilyVisitsDashboard({
      windowDays,
      ...(requestedSenior !== undefined && { seniorId: requestedSenior }),
      ...(historyCursor !== undefined && { historyCursor }),
    }),
  ]);

  if (seniorsResult.kind === 'unauthorized' || dashboardResult.kind === 'unauthorized') {
    redirect('/login?expired=1');
  }

  const seniors = seniorsResult.kind === 'ok' ? seniorsResult.seniors : [];
  const nameById = new Map(seniors.map((s) => [s.seniorId, seniorDisplayName(s)]));
  // The active tab is honoured only when it names a real senior; an
  // unknown id falls back to the combined "All" view.
  const activeSenior =
    requestedSenior !== undefined && nameById.has(requestedSenior) ? requestedSenior : undefined;

  return (
    <div className="dash-shell">
      <header className="dash-top">
        <span className="dash-brand">Taste &amp; See</span>
        <Link href="/dashboard" className="dash-logout">
          Dashboard
        </Link>
      </header>
      <main className="dash-main">
        <h1>Visits &amp; wellness</h1>
        <p>
          The rhythm of your loved one&apos;s care — what&apos;s coming up, and warm notes from
          every visit that&apos;s already happened.
        </p>

        {seniors.length > 1 ? (
          <SeniorTabs
            seniors={seniors.map((s) => ({ id: s.seniorId, name: seniorDisplayName(s) }))}
            activeSenior={activeSenior}
            windowDays={windowDays}
          />
        ) : null}

        {dashboardResult.kind !== 'ok' ? (
          <p className="providers-empty">
            We couldn&apos;t load your visits just now. Please refresh in a moment.
          </p>
        ) : (
          <VisitsDashboardBody
            dashboard={dashboardResult.dashboard}
            windowDays={windowDays}
            activeSenior={activeSenior}
            nameById={nameById}
            multiSenior={seniors.length > 1}
          />
        )}
      </main>
    </div>
  );
}

function VisitsDashboardBody({
  dashboard,
  windowDays,
  activeSenior,
  nameById,
  multiSenior,
}: {
  readonly dashboard: FamilyVisitsDashboardResponse;
  readonly windowDays: DashboardWindowDays;
  readonly activeSenior: string | undefined;
  readonly nameById: ReadonlyMap<string, string>;
  readonly multiSenior: boolean;
}): React.JSX.Element {
  return (
    <>
      <section className="visits-section" aria-label="Upcoming visits">
        <div className="visits-section__head">
          <h2>Upcoming</h2>
          <WindowSelector windowDays={windowDays} activeSenior={activeSenior} />
        </div>
        {dashboard.upcoming.length === 0 ? (
          <p className="providers-empty">
            No visits scheduled in the {WINDOW_LABELS[windowDays].toLowerCase()}.{' '}
            <Link href="/bookings/new" className="link-inline">
              Request a visit
            </Link>
            .
          </p>
        ) : (
          <ul className="visits-list">
            {dashboard.upcoming.map((b) => (
              <li key={b.id} className="visit-card">
                <header className="visit-card__head">
                  <h3>{formatServiceKind(b.serviceKind)}</h3>
                  <span className={`bookings-status bookings-status--${b.status}`}>
                    {formatStatus(b.status)}
                  </span>
                </header>
                <p className="visit-card__time">{formatVisitTime(b.scheduledStart)}</p>
                {b.onHold ? <VisitOnHoldNotice /> : null}
                {multiSenior ? (
                  <p className="visit-card__senior">
                    For {nameById.get(b.seniorId) ?? 'your loved one'}
                  </p>
                ) : null}
                <Link href={`/bookings/${encodeURIComponent(b.id)}`} className="link-inline">
                  View details
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="visits-section" aria-label="Recent visits">
        <h2>Recent visits</h2>
        {dashboard.history.length === 0 ? (
          <p className="providers-empty">No completed visits yet.</p>
        ) : (
          <>
            <ul className="visits-list">
              {dashboard.history.map((visit) => (
                <PastVisitCard
                  key={visit.booking.id}
                  visit={visit}
                  seniorName={multiSenior ? nameById.get(visit.booking.seniorId) : undefined}
                />
              ))}
            </ul>
            {dashboard.historyNextCursor !== null ? (
              <div className="bookings-more">
                <Link
                  href={historyHref(windowDays, activeSenior, dashboard.historyNextCursor)}
                  className="link-inline"
                >
                  Load earlier visits
                </Link>
              </div>
            ) : null}
          </>
        )}
      </section>
    </>
  );
}

function PastVisitCard({
  visit,
  seniorName,
}: {
  readonly visit: DashboardPastVisit;
  readonly seniorName: string | undefined;
}): React.JSX.Element {
  const { booking, visitNotes } = visit;
  const chips = visitNotes !== null ? toWellnessChips(visitNotes) : [];
  return (
    <li className="visit-card">
      <header className="visit-card__head">
        <h3>{formatServiceKind(booking.serviceKind)}</h3>
        <span className="bookings-status bookings-status--completed">
          {formatStatus('completed')}
        </span>
      </header>
      <p className="visit-card__time">{formatVisitTime(booking.scheduledStart)}</p>
      {seniorName !== undefined ? <p className="visit-card__senior">For {seniorName}</p> : null}
      {visitNotes === null ? (
        <p className="visit-card__no-notes">No notes were recorded for this visit.</p>
      ) : (
        <details className="visit-notes">
          <summary className="visit-notes__summary">How the visit went</summary>
          <div className="visit-notes__body">
            {chips.length > 0 ? (
              <ul className="visit-notes__chips">
                {chips.map((chip) => (
                  <li key={chip.label} className="visit-notes__chip">
                    <span className="visit-notes__chip-label">{chip.label}</span>
                    <span className="visit-notes__chip-value">{chip.value}</span>
                  </li>
                ))}
              </ul>
            ) : null}
            {visitNotes.freeform !== null && visitNotes.freeform.length > 0 ? (
              <p className="visit-notes__freeform">{visitNotes.freeform}</p>
            ) : null}
            {visitNotes.photoCount > 0 ? (
              <p className="visit-notes__photos">
                {visitNotes.photoCount} photo{visitNotes.photoCount === 1 ? '' : 's'} shared from
                this visit.
              </p>
            ) : null}
          </div>
        </details>
      )}
    </li>
  );
}

function SeniorTabs({
  seniors,
  activeSenior,
  windowDays,
}: {
  readonly seniors: readonly { readonly id: string; readonly name: string }[];
  readonly activeSenior: string | undefined;
  readonly windowDays: DashboardWindowDays;
}): React.JSX.Element {
  return (
    <nav className="visits-tabs" aria-label="Filter by loved one">
      <Link
        href={tabHref(windowDays, undefined)}
        className={`visits-tab${activeSenior === undefined ? ' visits-tab--active' : ''}`}
        aria-current={activeSenior === undefined ? 'page' : undefined}
      >
        All
      </Link>
      {seniors.map((s) => (
        <Link
          key={s.id}
          href={tabHref(windowDays, s.id)}
          className={`visits-tab${activeSenior === s.id ? ' visits-tab--active' : ''}`}
          aria-current={activeSenior === s.id ? 'page' : undefined}
        >
          {s.name}
        </Link>
      ))}
    </nav>
  );
}

function WindowSelector({
  windowDays,
  activeSenior,
}: {
  readonly windowDays: DashboardWindowDays;
  readonly activeSenior: string | undefined;
}): React.JSX.Element {
  return (
    <div className="visits-window" role="group" aria-label="Upcoming window">
      {DASHBOARD_WINDOW_DAYS_VALUES.map((value) => (
        <Link
          key={value}
          href={windowHref(value, activeSenior)}
          className={`visits-window__opt${windowDays === value ? ' visits-window__opt--active' : ''}`}
          aria-current={windowDays === value ? 'true' : undefined}
        >
          {value}d
        </Link>
      ))}
    </div>
  );
}

function seniorDisplayName(s: {
  readonly displayName: string | null;
  readonly firstName: string;
  readonly lastName: string;
}): string {
  if (s.displayName !== null && s.displayName.length > 0) return s.displayName;
  return `${s.firstName} ${s.lastName}`.trim();
}

function parseWindow(raw: string | string[] | undefined): DashboardWindowDays {
  if (typeof raw !== 'string') return DASHBOARD_WINDOW_DAYS_DEFAULT;
  const n = Number(raw);
  return (DASHBOARD_WINDOW_DAYS_VALUES as readonly number[]).includes(n)
    ? (n as DashboardWindowDays)
    : DASHBOARD_WINDOW_DAYS_DEFAULT;
}

function baseParams(
  windowDays: DashboardWindowDays,
  seniorId: string | undefined,
): URLSearchParams {
  const params = new URLSearchParams();
  if (windowDays !== DASHBOARD_WINDOW_DAYS_DEFAULT) params.set('window', String(windowDays));
  if (seniorId !== undefined) params.set('senior', seniorId);
  return params;
}

function hrefFrom(params: URLSearchParams): string {
  const query = params.toString();
  return query.length > 0 ? `/dashboard/visits?${query}` : '/dashboard/visits';
}

function tabHref(windowDays: DashboardWindowDays, seniorId: string | undefined): string {
  return hrefFrom(baseParams(windowDays, seniorId));
}

function windowHref(windowDays: DashboardWindowDays, seniorId: string | undefined): string {
  return hrefFrom(baseParams(windowDays, seniorId));
}

function historyHref(
  windowDays: DashboardWindowDays,
  seniorId: string | undefined,
  cursor: string,
): string {
  const params = baseParams(windowDays, seniorId);
  params.set('historyCursor', cursor);
  return hrefFrom(params);
}

/**
 * The family-facing trust & safety hold notice (TS-304-followup-1).
 *
 * **The copy is TS-304's booking-create 409, not new prose.** That message was
 * written for exactly this reader and this situation, and reviewed then: it
 * says the visit is temporarily unavailable, it does not say why, and it
 * points at a human. A hold means the provider, the senior, or the household
 * is under review for a `high` or `critical` concern, and the person reading
 * this is often the family member who booked — sometimes the very person a
 * conduct report names. Naming the category, the severity, or the incident
 * would leak an allegation through a visit card (CLAUDE.md §3.9, §12).
 *
 * "Temporarily unavailable" is accurate rather than a euphemism: a hold is
 * reversible and lifts when the review closes.
 *
 * `role="status"` rather than `role="alert"` — the family should notice this
 * without a screen reader interrupting them mid-sentence for something that
 * is not an emergency.
 */
function VisitOnHoldNotice(): React.JSX.Element {
  return (
    <p className="visit-card__hold" role="status">
      This visit is temporarily unavailable while our care team completes a review. Please contact
      support and we will help you arrange it.
    </p>
  );
}
