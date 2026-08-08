import Link from 'next/link';
import { redirect } from 'next/navigation';
import type { Metadata } from 'next';

import {
  WELLNESS_TREND_WINDOW_DAYS_VALUES,
  type WellnessAnomalyFlag,
} from '@taste-and-see/contracts';

import { getSeniorWellnessAnomalies } from '@/lib/wellness-anomaly-api';
import { WELLNESS_METRIC_TITLE } from '@/lib/wellness-metric-titles';
import { listMySeniors } from '@/lib/seniors-api';
import { getSeniorWellnessTrends, parseWindowDays } from '@/lib/wellness-trends-api';

import { WellnessSparklines } from './wellness-sparklines';

export const metadata: Metadata = {
  title: 'Wellness trends — Taste & See',
};

// Wellness data must always be fresh — never serve a stale read of
// "how mom has been lately".
const WINDOW_LABELS: Record<number, string> = {
  30: 'Last 30 days',
  90: 'Last 90 days',
};

/**
 * Per-senior wellness-trend surface (TS-231; PRD §6.4, §6.9).
 *
 * Server-rendered. Shows, for one senior the signed-in family member is
 * permitted to see:
 *   - a window selector (30 / 90 days), and
 *   - one sparkline per wellness scale (mood / appetite / hydration /
 *     company) drawn from the household's completed-visit notes.
 *
 * The data comes from the gateway BFF aggregator, which applies the
 * senior's `notes` consent gate (TS-238): a family observer the senior
 * hasn't shared `notes` with gets the "hasn't shared" state, not the
 * trends. The membership gate is the same consent read, so a foreign
 * senior id gets the same "couldn't find that loved one" page the other
 * per-senior surfaces show.
 */
export default async function SeniorWellnessPage({
  params,
  searchParams,
}: {
  readonly params: Promise<{ readonly seniorId: string }>;
  readonly searchParams?: Promise<Record<string, string | string[] | undefined>>;
}): Promise<React.JSX.Element> {
  const { seniorId } = await params;
  const query = (await searchParams) ?? {};
  const windowDays = parseWindowDays(query.window);

  const [trendsResult, anomaliesResult, seniorsResult] = await Promise.all([
    getSeniorWellnessTrends(seniorId, windowDays),
    getSeniorWellnessAnomalies(seniorId, windowDays),
    listMySeniors(),
  ]);

  if (trendsResult.kind === 'unauthorized' || seniorsResult.kind === 'unauthorized') {
    redirect('/login?expired=1');
  }

  if (trendsResult.kind === 'forbidden' || trendsResult.kind === 'not_found') {
    return (
      <Shell>
        <h1>We couldn&apos;t find that loved one</h1>
        <p className="providers-empty">
          This profile isn&apos;t in your household, or it may have been removed.{' '}
          <Link href="/seniors" className="link-inline">
            Back to your loved ones
          </Link>
          .
        </p>
      </Shell>
    );
  }

  if (trendsResult.kind !== 'ok') {
    return (
      <Shell>
        <h1>We&apos;re having a moment</h1>
        <p className="providers-empty">
          We couldn&apos;t load wellness trends right now. Please refresh in a moment.
        </p>
      </Shell>
    );
  }

  const senior =
    seniorsResult.kind === 'ok'
      ? seniorsResult.seniors.find((s) => s.seniorId === seniorId)
      : undefined;
  const name =
    senior !== undefined
      ? senior.displayName !== null && senior.displayName.length > 0
        ? senior.displayName
        : senior.firstName
      : 'your loved one';

  const { trends } = trendsResult;

  // The early-signal flags are additive — if the anomaly read failed or
  // the caller can't see this senior's notes, we simply show no banner
  // (the trends still render). `shared` mirrors the trends gate.
  const signals: readonly WellnessAnomalyFlag[] =
    anomaliesResult.kind === 'ok' && anomaliesResult.anomalies.shared
      ? anomaliesResult.anomalies.flags
      : [];

  return (
    <Shell>
      <h1>How {name} has been</h1>
      <p>
        A gentle look at {name}&apos;s recent visits — spirits, appetite, hydration, and company, as
        the chefs and companions who visited noted them.
      </p>

      <nav className="wellness-windows" aria-label="Trend window">
        {WELLNESS_TREND_WINDOW_DAYS_VALUES.map((value) => {
          const active = value === windowDays;
          return (
            <Link
              key={value}
              href={`/seniors/${encodeURIComponent(seniorId)}/wellness?window=${value}`}
              className="wellness-window"
              aria-current={active ? 'page' : undefined}
              data-active={active ? 'true' : undefined}
            >
              {WINDOW_LABELS[value] ?? `Last ${value} days`}
            </Link>
          );
        })}
      </nav>

      {!trends.shared ? (
        <div className="providers-empty">
          <p>
            {name} hasn&apos;t shared their wellness notes with you yet. When they (or the account
            manager) turn on the <strong>wellness notes</strong> sharing setting, their trends will
            appear here.
          </p>
          <p>
            <Link href={`/seniors/${encodeURIComponent(seniorId)}/sharing`} className="link-inline">
              Sharing settings
            </Link>
          </p>
        </div>
      ) : trends.totalCompletedVisits === 0 ? (
        <div className="providers-empty">
          <p>
            We don&apos;t have any completed visits for {name} in the{' '}
            {WINDOW_LABELS[windowDays] ?? `last ${windowDays} days`}. Once a chef or companion
            visits and notes how the day went, the trends will appear here.
          </p>
        </div>
      ) : (
        <>
          <p className="wellness-meta">
            {trends.totalCompletedVisits}{' '}
            {trends.totalCompletedVisits === 1 ? 'completed visit' : 'completed visits'} in the{' '}
            {(WINDOW_LABELS[windowDays] ?? `last ${windowDays} days`).toLowerCase()}.
          </p>
          <EarlySignals name={name} flags={signals} />
          <WellnessSparklines series={trends.series} />
          <p className="wellness-foot">
            These are gentle, at-a-glance impressions — not a medical record. If anything here
            concerns you, reach out to your care team.
          </p>
        </>
      )}
    </Shell>
  );
}

/**
 * Early-signal banner (TS-236). A gentle, non-clinical heads-up when one
 * or more wellness scales have been declining relative to the senior's
 * own recent baseline. Rendered above the sparklines so the family sees
 * the "worth a look" cue before the detail. High-severity signals lead.
 *
 * Deliberately warm + reassuring (CLAUDE.md §12): this is a nudge to pay
 * attention, never a diagnosis. The page's existing footer reinforces
 * "reach out to your care team" framing.
 */
function EarlySignals({
  name,
  flags,
}: {
  readonly name: string;
  readonly flags: readonly WellnessAnomalyFlag[];
}): React.JSX.Element | null {
  if (flags.length === 0) return null;

  // High severity first, otherwise keep the metric (display) order.
  const ordered = [...flags].sort((a, b) => {
    if (a.severity === b.severity) return 0;
    return a.severity === 'high' ? -1 : 1;
  });

  return (
    <section className="wellness-signals" aria-label="Things worth a gentle look">
      <h2 className="wellness-signals__title">A gentle heads-up</h2>
      <p className="wellness-signals__lead">
        A few things about {name}&apos;s recent visits we thought were worth bringing to your
        attention.
      </p>
      <ul className="wellness-signals__list">
        {ordered.map((flag) => (
          <li key={flag.metric} className="wellness-signals__item" data-severity={flag.severity}>
            <span className="wellness-signals__metric">{WELLNESS_METRIC_TITLE[flag.metric]}</span>{' '}
            has eased off a little lately — most recently{' '}
            <strong>{titleCaseLevel(flag.latestLevel)}</strong>.
          </li>
        ))}
      </ul>
    </section>
  );
}

function titleCaseLevel(level: string): string {
  return level.length === 0 ? level : `${level.charAt(0).toUpperCase()}${level.slice(1)}`;
}

function Shell({ children }: { readonly children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="dash-shell">
      <header className="dash-top">
        <span className="dash-brand">Taste &amp; See</span>
        <Link href="/seniors" className="dash-logout">
          Your loved ones
        </Link>
      </header>
      <main className="dash-main">{children}</main>
    </div>
  );
}
