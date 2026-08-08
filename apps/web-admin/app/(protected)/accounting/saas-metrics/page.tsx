import { redirect } from 'next/navigation';
import Link from 'next/link';
import type { Metadata } from 'next';
import {
  MeResponseSchema,
  SAAS_METRICS_PPM_SCALE,
  type MeResponse,
  type SaasMetricsRecord,
} from '@taste-and-see/contracts';

import { callGateway } from '@/lib/api';
import { hasSuperAdminRole } from '@/lib/admin-gate';
import {
  buildSaasMetricsPath,
  fetchSaasMetrics,
  type SaasMetricsRange,
} from '@/lib/saas-metrics-api';

export const metadata: Metadata = {
  title: 'SaaS metrics — Taste & See Admin',
};

const DEFAULT_WINDOW_DAYS = 90;
const MS_PER_DAY = 86_400_000;

/**
 * SaaS-metrics dashboard (TS-266; PRD §10.1, PDD §23.2).
 *
 * Renders the platform-wide recurring-revenue series the nightly
 * `accounting-metrics` worker computes (TS-260): headline KPI cards for
 * the latest snapshot, inline-SVG sparklines for the MRR / ARR / ARPU /
 * NRR trends, and a per-day table of the full movement decomposition.
 * A date-range picker scopes the window; "Export CSV" streams the same
 * range.
 *
 * **Scope (TS-266).** The `saas_metrics_daily` source is platform-wide —
 * the per-tier / geography / channel / plan drill-down (TS-260-followup-2)
 * and the cohort-retention tab (the separate TS-262) are NOT yet backed by
 * data, so this dashboard ships the platform series + CSV export and the
 * drill-down + cohort surfaces land with their upstream data.
 *
 * Phase-1 admin gating: only super_admins land here (mirrors the sibling
 * accounting reads). Finance-role / `accounting:read` gating arrives once
 * per-permission gating lifts to `packages/nest-auth` (TS-052-followup-11).
 */
export default async function SaasMetricsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}): Promise<React.JSX.Element> {
  const params = await searchParams;
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

  const range = resolveRange(params);
  const result = await fetchSaasMetrics(range);
  if (result.kind === 'unauthorized') redirect('/login?expired=1');

  return (
    <div className="dash-shell">
      <div className="admin-banner">
        <span>Admin console — SaaS metrics</span>
        <span className="admin-banner__operator" title={me.userId}>
          {me.userId}
        </span>
      </div>
      <header className="dash-top">
        <span className="dash-brand">Taste &amp; See — Admin</span>
        <div className="dash-account">
          <Link href="/accounting" className="dash-logout">
            ← Accounting
          </Link>
        </div>
      </header>
      <main className="dash-main">
        <h1>SaaS metrics</h1>
        <p>
          Recurring-revenue health computed nightly from the accounting ledger — MRR, ARR, ARPU, and
          the new / expansion / contraction / churn movement that nets them, with net + gross
          revenue retention. Platform-wide at launch; per-tier and cohort drill-down follow as their
          data lands.
        </p>

        <RangeFilters range={range} />

        {result.kind === 'failure' ? (
          <p className="auth-alert">
            We couldn&apos;t load the SaaS-metrics series right now. The downstream accounting
            service may be unreachable.
          </p>
        ) : result.data.metrics.length === 0 ? (
          <div className="user-empty">
            <p>
              No metrics snapshots in this window. The nightly worker writes one row per day once
              subscriptions are active — widen the range, or check the accounting-metrics worker has
              run.
            </p>
          </div>
        ) : (
          <MetricsView metrics={result.data.metrics} range={range} />
        )}
      </main>
    </div>
  );
}

function MetricsView({
  metrics,
  range,
}: {
  readonly metrics: readonly SaasMetricsRecord[];
  readonly range: SaasMetricsRange;
}): React.JSX.Element {
  // metrics arrive ascending (oldest first); the latest snapshot is last.
  const latest = metrics[metrics.length - 1];
  const exportHref = `/accounting/saas-metrics/export${rangeQuery(range)}`;

  return (
    <>
      <div className="saas-summary">
        <p className="user-detail__sub">
          Showing <strong>{metrics.length}</strong> daily snapshot
          {metrics.length === 1 ? '' : 's'}
          {latest !== undefined ? (
            <>
              {' '}
              · latest <strong>{latest.metricDate}</strong>
            </>
          ) : null}
        </p>
        <a href={exportHref} className="saas-export" download>
          Export CSV ↓
        </a>
      </div>

      {latest !== undefined ? <KpiCards latest={latest} /> : null}

      <h2 className="saas-section-title">Trends</h2>
      <div className="saas-sparks">
        <SparkCard
          label="MRR"
          values={metrics.map((m) => m.mrrMinor)}
          latest={formatMoney(latest?.mrrMinor ?? 0)}
        />
        <SparkCard
          label="ARR"
          values={metrics.map((m) => m.arrMinor)}
          latest={formatMoney(latest?.arrMinor ?? 0)}
        />
        <SparkCard
          label="ARPU"
          values={metrics.map((m) => m.arpuMinor)}
          latest={formatMoney(latest?.arpuMinor ?? 0)}
        />
        <SparkCard
          label="Net revenue retention"
          values={metrics.map((m) => m.netRevenueRetentionPpm ?? 0)}
          latest={formatPpm(latest?.netRevenueRetentionPpm ?? null)}
        />
      </div>

      <h2 className="saas-section-title">Daily series</h2>
      <SeriesTable metrics={metrics} />
    </>
  );
}

function KpiCards({ latest }: { readonly latest: SaasMetricsRecord }): React.JSX.Element {
  const cards: readonly { readonly label: string; readonly value: string }[] = [
    { label: 'MRR', value: formatMoney(latest.mrrMinor) },
    { label: 'ARR', value: formatMoney(latest.arrMinor) },
    { label: 'ARPU', value: formatMoney(latest.arpuMinor) },
    { label: 'Active subscriptions', value: latest.activeSubscriptions.toLocaleString('en-US') },
    { label: 'Net new MRR', value: formatMoney(latest.netNewMrrMinor) },
    { label: 'Churned subs', value: latest.churnedSubscriptions.toLocaleString('en-US') },
    { label: 'Net revenue retention', value: formatPpm(latest.netRevenueRetentionPpm) },
    { label: 'Gross revenue retention', value: formatPpm(latest.grossRevenueRetentionPpm) },
  ];
  return (
    <div className="saas-kpis">
      {cards.map((card) => (
        <article className="saas-kpi" key={card.label}>
          <span className="saas-kpi__label">{card.label}</span>
          <span className="saas-kpi__value">{card.value}</span>
        </article>
      ))}
    </div>
  );
}

function SparkCard({
  label,
  values,
  latest,
}: {
  readonly label: string;
  readonly values: readonly number[];
  readonly latest: string;
}): React.JSX.Element {
  return (
    <article className="saas-spark">
      <div className="saas-spark__head">
        <span className="saas-spark__label">{label}</span>
        <span className="saas-spark__latest">{latest}</span>
      </div>
      <Sparkline values={values} label={`${label} trend`} />
    </article>
  );
}

/**
 * Pure server-rendered SVG sparkline (no client JS, no charting dep —
 * the TS-231-followup-4-endorsed lightweight path). Maps the value series
 * onto a fixed viewBox, min→bottom / max→top. A single point renders a
 * flat midline; an empty series renders nothing.
 */
function Sparkline({
  values,
  label,
}: {
  readonly values: readonly number[];
  readonly label: string;
}): React.JSX.Element {
  const width = 240;
  const height = 48;
  const pad = 3;
  if (values.length === 0) {
    return <div className="saas-spark__empty">No data</div>;
  }
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min;
  const n = values.length;
  const points = values.map((value, index) => {
    const x = n === 1 ? width / 2 : pad + (index / (n - 1)) * (width - 2 * pad);
    const y = span === 0 ? height / 2 : height - pad - ((value - min) / span) * (height - 2 * pad);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  return (
    <svg
      className="saas-spark__svg"
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      role="img"
      aria-label={label}
    >
      {n === 1 ? (
        <circle cx={width / 2} cy={height / 2} r={2.5} className="saas-spark__dot" />
      ) : (
        <polyline points={points.join(' ')} className="saas-spark__line" />
      )}
    </svg>
  );
}

function SeriesTable({
  metrics,
}: {
  readonly metrics: readonly SaasMetricsRecord[];
}): React.JSX.Element {
  // Newest first reads best in a table.
  const rows = [...metrics].reverse();
  return (
    <div className="user-table" role="table" aria-label="SaaS metrics daily series">
      <div className="user-table__head saas-table__head" role="row">
        <span role="columnheader">Date</span>
        <span role="columnheader">MRR</span>
        <span role="columnheader">Net new</span>
        <span role="columnheader">New</span>
        <span role="columnheader">Churned</span>
        <span role="columnheader">Active</span>
        <span role="columnheader">NRR</span>
        <span role="columnheader">GRR</span>
      </div>
      {rows.map((row) => (
        <div className="user-row saas-table__row" role="row" key={row.metricDate}>
          <span role="cell">
            <span className="user-row__email">{row.metricDate}</span>
          </span>
          <span role="cell">{formatMoney(row.mrrMinor)}</span>
          <span role="cell" className={row.netNewMrrMinor < 0 ? 'saas-neg' : undefined}>
            {formatMoney(row.netNewMrrMinor)}
          </span>
          <span role="cell">{formatMoney(row.newMrrMinor)}</span>
          <span role="cell">
            {formatMoney(row.churnedMrrMinor)}
            {row.churnedSubscriptions > 0 ? (
              <span className="user-row__date"> ({row.churnedSubscriptions})</span>
            ) : null}
          </span>
          <span role="cell">{row.activeSubscriptions.toLocaleString('en-US')}</span>
          <span role="cell">{formatPpm(row.netRevenueRetentionPpm)}</span>
          <span role="cell">{formatPpm(row.grossRevenueRetentionPpm)}</span>
        </div>
      ))}
    </div>
  );
}

function RangeFilters({ range }: { readonly range: SaasMetricsRange }): React.JSX.Element {
  return (
    <form action="/accounting/saas-metrics" method="get" className="filter-bar" role="search">
      <label className="filter-bar__field">
        <span>From</span>
        <input type="date" name="from" defaultValue={range.from ?? ''} autoComplete="off" />
      </label>
      <label className="filter-bar__field">
        <span>To</span>
        <input type="date" name="to" defaultValue={range.to ?? ''} autoComplete="off" />
      </label>
      <div className="filter-bar__actions">
        <button type="submit" className="filter-bar__submit">
          Apply
        </button>
        <Link href="/accounting/saas-metrics" className="filter-bar__reset">
          Last {DEFAULT_WINDOW_DAYS} days
        </Link>
      </div>
    </form>
  );
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

/**
 * Resolve the effective date range from the URL. A valid `from`/`to`
 * (`YYYY-MM-DD`) is honoured; anything else falls back to the default
 * trailing window so a hand-mangled URL degrades to a sensible view rather
 * than erroring. The gateway re-validates + the response echoes the real
 * window, so this is a UX convenience, not the trust boundary.
 */
function resolveRange(params: Record<string, string | string[] | undefined>): SaasMetricsRange {
  const from = dateParam(params['from']);
  const to = dateParam(params['to']);
  if (from !== null || to !== null) {
    return {
      ...(from !== null && { from }),
      ...(to !== null && { to }),
    };
  }
  const now = new Date();
  return {
    from: toDateKey(new Date(now.getTime() - (DEFAULT_WINDOW_DAYS - 1) * MS_PER_DAY)),
    to: toDateKey(now),
  };
}

function rangeQuery(range: SaasMetricsRange): string {
  const path = buildSaasMetricsPath(range);
  const q = path.indexOf('?');
  return q === -1 ? '' : path.slice(q);
}

function dateParam(value: string | string[] | undefined): string | null {
  if (typeof value !== 'string') return null;
  return /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : null;
}

function toDateKey(date: Date): string {
  const year = date.getUTCFullYear().toString().padStart(4, '0');
  const month = (date.getUTCMonth() + 1).toString().padStart(2, '0');
  const day = date.getUTCDate().toString().padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function formatMoney(minor: number): string {
  try {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: 'USD',
    }).format(minor / 100);
  } catch {
    return `$${(minor / 100).toFixed(2)}`;
  }
}

function formatPpm(ppm: number | null): string {
  if (ppm === null) return '—';
  return `${((ppm / SAAS_METRICS_PPM_SCALE) * 100).toFixed(1)}%`;
}
