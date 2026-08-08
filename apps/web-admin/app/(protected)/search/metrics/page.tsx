import { redirect } from 'next/navigation';
import Link from 'next/link';
import type { Metadata } from 'next';
import {
  MeResponseSchema,
  SEARCH_RELEVANCE_PPM_SCALE,
  type MeResponse,
  type SearchRelevanceClickPositionStat,
  type SearchRelevanceDailySummary,
  type SearchRelevanceDayDetailResponse,
  type SearchRelevanceQueryStat,
  type SearchRelevanceSortStat,
} from '@taste-and-see/contracts';

import { callGateway } from '@/lib/api';
import { hasSuperAdminRole } from '@/lib/admin-gate';
import {
  fetchSearchRelevanceDetail,
  fetchSearchRelevanceSummary,
  type SearchRelevanceRange,
} from '@/lib/search-relevance-api';

export const metadata: Metadata = {
  title: 'Search relevance — Taste & See Admin',
};

const DEFAULT_WINDOW_DAYS = 90;
const MS_PER_DAY = 86_400_000;

/**
 * Search-relevance metrics dashboard (TS-217b; PRD §10.1, PDD §23.1/§23.2).
 *
 * Renders the search-quality signal the nightly analytics-aggregator
 * computes (TS-217-prep-3b/4b/4c) and the TS-217a admin read API serves:
 *
 *   - **Summary series** (`/summary?from=&to=`) — per-day headline KPIs,
 *     inline-SVG sparkline trends, and a daily table covering searches,
 *     zero-result rate, and the precise + approximate query→booking
 *     conversion funnels.
 *   - **Day detail** (`/detail?date=`) — a single UTC day's drill-down:
 *     top queries, zero-result queries, searches-per-sort, and
 *     CTR-by-position — the levers ops uses to tune ranking.
 *
 * A date-range picker scopes the summary window; a separate date picker
 * (which preserves the range) drives the detail day, defaulting to the
 * latest day in the summary window.
 *
 * Phase-1 admin gating mirrors the sibling SaaS-metrics page: only
 * super_admins land here (`fetchMe` → `mfaVerified` → `hasSuperAdminRole`).
 * Per-permission gating (`analytics:read`) arrives once gating lifts to
 * `packages/nest-auth` (TS-217a follow-up).
 */
export default async function SearchMetricsPage({
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
  const summaryResult = await fetchSearchRelevanceSummary(range);
  if (summaryResult.kind === 'unauthorized') redirect('/login?expired=1');

  const summaries = summaryResult.kind === 'ok' ? summaryResult.data.summaries : [];
  // Detail day: explicit `?date=`, else the latest day in the window, else
  // the upper range bound. summaries arrive ascending, so the last is newest.
  const detailDate =
    dateParam(params['date']) ?? summaries[summaries.length - 1]?.metricDate ?? range.to ?? null;

  const detailResult = detailDate !== null ? await fetchSearchRelevanceDetail(detailDate) : null;
  if (detailResult !== null && detailResult.kind === 'unauthorized') {
    redirect('/login?expired=1');
  }

  return (
    <div className="dash-shell">
      <div className="admin-banner">
        <span>Admin console — search relevance</span>
        <span className="admin-banner__operator" title={me.userId}>
          {me.userId}
        </span>
      </div>
      <header className="dash-top">
        <span className="dash-brand">Taste &amp; See — Admin</span>
        <div className="dash-account">
          <Link href="/dashboard" className="dash-logout">
            ← Console
          </Link>
        </div>
      </header>
      <main className="dash-main">
        <h1>Search relevance</h1>
        <p>
          Search-quality signal computed nightly from raw query, click, and booking events — what
          people search for, how often searches come back empty, how often each result position is
          clicked, and how searches convert to bookings. Use it to tune the ranking weights on the{' '}
          <Link href="/search/ranking-config">search ranking</Link> page.
        </p>

        <RangeFilters range={range} />

        {summaryResult.kind === 'failure' ? (
          <p className="auth-alert">
            We couldn&apos;t load the search-relevance series right now. The downstream analytics
            service may be unreachable.
          </p>
        ) : summaries.length === 0 ? (
          <div className="user-empty">
            <p>
              No search-relevance snapshots in this window. The nightly worker writes one row per
              day once searches are flowing — widen the range, or check the analytics-aggregator
              worker has run.
            </p>
          </div>
        ) : (
          <SummaryView summaries={summaries} />
        )}

        <DetailSection detailDate={detailDate} range={range} result={detailResult} />
      </main>
    </div>
  );
}

function SummaryView({
  summaries,
}: {
  readonly summaries: readonly SearchRelevanceDailySummary[];
}): React.JSX.Element {
  // summaries arrive ascending (oldest first); the latest snapshot is last.
  const latest = summaries[summaries.length - 1];

  return (
    <>
      <div className="saas-summary">
        <p className="user-detail__sub">
          Showing <strong>{summaries.length}</strong> daily snapshot
          {summaries.length === 1 ? '' : 's'}
          {latest !== undefined ? (
            <>
              {' '}
              · latest <strong>{latest.metricDate}</strong>
            </>
          ) : null}
        </p>
      </div>

      {latest !== undefined ? <KpiCards latest={latest} /> : null}

      <h2 className="saas-section-title">Trends</h2>
      <div className="saas-sparks">
        <SparkCard
          label="Searches / day"
          values={summaries.map((s) => s.totalSearches)}
          latest={(latest?.totalSearches ?? 0).toLocaleString('en-US')}
        />
        <SparkCard
          label="Zero-result rate"
          values={summaries.map((s) => s.zeroResultRatePpm ?? 0)}
          latest={formatPercent(latest?.zeroResultRatePpm ?? null)}
        />
        <SparkCard
          label="Conversion (precise)"
          values={summaries.map((s) => s.attributedConversionPpm ?? 0)}
          latest={formatPercent(latest?.attributedConversionPpm ?? null)}
        />
        <SparkCard
          label="Conversion (approx)"
          values={summaries.map((s) => s.approxConversionPpm ?? 0)}
          latest={formatPercent(latest?.approxConversionPpm ?? null)}
        />
      </div>

      <h2 className="saas-section-title">Daily series</h2>
      <SeriesTable summaries={summaries} />
    </>
  );
}

function KpiCards({ latest }: { readonly latest: SearchRelevanceDailySummary }): React.JSX.Element {
  const cards: readonly { readonly label: string; readonly value: string }[] = [
    { label: 'Searches', value: latest.totalSearches.toLocaleString('en-US') },
    { label: 'Distinct searchers', value: latest.distinctSearchers.toLocaleString('en-US') },
    { label: 'Zero-result rate', value: formatPercent(latest.zeroResultRatePpm) },
    { label: 'Zero-result searches', value: latest.zeroResultSearches.toLocaleString('en-US') },
    { label: 'Conversion (precise)', value: formatPercent(latest.attributedConversionPpm) },
    { label: 'Conversion (approx)', value: formatPercent(latest.approxConversionPpm) },
    { label: 'Attributed bookings', value: latest.attributedBookings.toLocaleString('en-US') },
    { label: 'Bookings created', value: latest.bookingsCreated.toLocaleString('en-US') },
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
 * Pure server-rendered SVG sparkline (no client JS, no charting dep) —
 * the same lightweight path the SaaS-metrics dashboard uses. Maps the
 * value series onto a fixed viewBox, min→bottom / max→top. A single
 * point renders a dot; an empty series renders nothing.
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
  summaries,
}: {
  readonly summaries: readonly SearchRelevanceDailySummary[];
}): React.JSX.Element {
  // Newest first reads best in a table.
  const rows = [...summaries].reverse();
  return (
    <div className="user-table" role="table" aria-label="Search-relevance daily series">
      <div className="user-table__head srm-table__head" role="row">
        <span role="columnheader">Date</span>
        <span role="columnheader">Searches</span>
        <span role="columnheader">Zero-result</span>
        <span role="columnheader">Zero %</span>
        <span role="columnheader">Searchers</span>
        <span role="columnheader">Bookings</span>
        <span role="columnheader">Conv. (precise)</span>
        <span role="columnheader">Conv. (approx)</span>
      </div>
      {rows.map((row) => (
        <div className="user-row srm-table__row" role="row" key={row.metricDate}>
          <span role="cell">
            <span className="user-row__email">{row.metricDate}</span>
          </span>
          <span role="cell">{row.totalSearches.toLocaleString('en-US')}</span>
          <span role="cell">{row.zeroResultSearches.toLocaleString('en-US')}</span>
          <span role="cell">{formatPercent(row.zeroResultRatePpm)}</span>
          <span role="cell">{row.distinctSearchers.toLocaleString('en-US')}</span>
          <span role="cell">
            {row.bookingsCreated.toLocaleString('en-US')}
            {row.attributedBookings > 0 ? (
              <span className="user-row__date"> ({row.attributedBookings})</span>
            ) : null}
          </span>
          <span role="cell">{formatPercent(row.attributedConversionPpm)}</span>
          <span role="cell">{formatPercent(row.approxConversionPpm)}</span>
        </div>
      ))}
    </div>
  );
}

function DetailSection({
  detailDate,
  range,
  result,
}: {
  readonly detailDate: string | null;
  readonly range: SearchRelevanceRange;
  // The `unauthorized` arm is handled (redirect) at the call site, so it is
  // narrowed out here.
  readonly result:
    | { readonly kind: 'ok'; readonly data: SearchRelevanceDayDetailResponse }
    | { readonly kind: 'failure' }
    | null;
}): React.JSX.Element {
  return (
    <>
      <h2 className="saas-section-title">Day detail</h2>
      <DetailDayPicker detailDate={detailDate} range={range} />
      {result === null ? (
        <div className="user-empty">
          <p>Pick a day above to drill into its top queries, zero-result queries, and CTR.</p>
        </div>
      ) : result.kind === 'failure' ? (
        <p className="auth-alert">
          We couldn&apos;t load the day detail right now. The downstream analytics service may be
          unreachable.
        </p>
      ) : (
        <DetailView data={result.data} />
      )}
    </>
  );
}

function DetailView({
  data,
}: {
  readonly data: SearchRelevanceDayDetailResponse;
}): React.JSX.Element {
  const empty =
    data.summary === null &&
    data.topQueries.length === 0 &&
    data.zeroResultQueries.length === 0 &&
    data.sortBreakdown.length === 0 &&
    data.clickPositions.length === 0;

  if (empty) {
    return (
      <div className="user-empty">
        <p>
          No search activity aggregated for <strong>{data.metricDate}</strong>. The nightly worker
          may not have run for this day, or there were no searches.
        </p>
      </div>
    );
  }

  return (
    <>
      <p className="user-detail__sub">
        Drill-down for <strong>{data.metricDate}</strong>
      </p>

      <h3 className="saas-section-title">Top queries</h3>
      {data.topQueries.length === 0 ? (
        <p className="user-detail__sub">No queries recorded for this day.</p>
      ) : (
        <QueryTable rows={data.topQueries} ariaLabel="Top queries" showZeroColumn />
      )}

      <h3 className="saas-section-title">Zero-result queries</h3>
      {data.zeroResultQueries.length === 0 ? (
        <p className="user-detail__sub">No zero-result queries — every search returned hits.</p>
      ) : (
        <QueryTable rows={data.zeroResultQueries} ariaLabel="Zero-result queries" showZeroColumn />
      )}

      <h3 className="saas-section-title">Searches by sort</h3>
      {data.sortBreakdown.length === 0 ? (
        <p className="user-detail__sub">No sort breakdown for this day.</p>
      ) : (
        <SortTable rows={data.sortBreakdown} />
      )}

      <h3 className="saas-section-title">CTR by position</h3>
      {data.clickPositions.length === 0 ? (
        <p className="user-detail__sub">No clicks recorded for this day.</p>
      ) : (
        <ClickPositionTable rows={data.clickPositions} />
      )}
    </>
  );
}

function QueryTable({
  rows,
  ariaLabel,
  showZeroColumn,
}: {
  readonly rows: readonly SearchRelevanceQueryStat[];
  readonly ariaLabel: string;
  readonly showZeroColumn: boolean;
}): React.JSX.Element {
  return (
    <div className="user-table" role="table" aria-label={ariaLabel}>
      <div className="user-table__head srm-q-table__head" role="row">
        <span role="columnheader">Query</span>
        <span role="columnheader">Searches</span>
        {showZeroColumn ? <span role="columnheader">Zero-result</span> : null}
      </div>
      {rows.map((row) => (
        <div className="user-row srm-q-table__row" role="row" key={row.queryText}>
          <span role="cell">
            <span className="user-row__email">{row.queryText}</span>
          </span>
          <span role="cell">{row.searchCount.toLocaleString('en-US')}</span>
          {showZeroColumn ? (
            <span role="cell" className={row.zeroResultCount > 0 ? 'saas-neg' : undefined}>
              {row.zeroResultCount.toLocaleString('en-US')}
            </span>
          ) : null}
        </div>
      ))}
    </div>
  );
}

function SortTable({
  rows,
}: {
  readonly rows: readonly SearchRelevanceSortStat[];
}): React.JSX.Element {
  return (
    <div className="user-table" role="table" aria-label="Searches by sort">
      <div className="user-table__head srm-sort-table__head" role="row">
        <span role="columnheader">Sort</span>
        <span role="columnheader">Searches</span>
        <span role="columnheader">Zero-result</span>
      </div>
      {rows.map((row) => (
        <div className="user-row srm-sort-table__row" role="row" key={row.sort}>
          <span role="cell">
            <span className="user-row__email">{row.sort}</span>
          </span>
          <span role="cell">{row.searchCount.toLocaleString('en-US')}</span>
          <span role="cell" className={row.zeroResultCount > 0 ? 'saas-neg' : undefined}>
            {row.zeroResultCount.toLocaleString('en-US')}
          </span>
        </div>
      ))}
    </div>
  );
}

function ClickPositionTable({
  rows,
}: {
  readonly rows: readonly SearchRelevanceClickPositionStat[];
}): React.JSX.Element {
  return (
    <div className="user-table" role="table" aria-label="CTR by result position">
      <div className="user-table__head srm-ctr-table__head" role="row">
        <span role="columnheader">Position</span>
        <span role="columnheader">Clicks</span>
        <span role="columnheader">Impressions</span>
        <span role="columnheader">CTR</span>
      </div>
      {rows.map((row) => (
        <div className="user-row srm-ctr-table__row" role="row" key={row.position}>
          <span role="cell">
            <span className="user-row__email">#{row.position + 1}</span>
          </span>
          <span role="cell">{row.clickCount.toLocaleString('en-US')}</span>
          <span role="cell">{row.impressionCount.toLocaleString('en-US')}</span>
          <span role="cell">{formatPercent(row.ctrPpm)}</span>
        </div>
      ))}
    </div>
  );
}

function RangeFilters({ range }: { readonly range: SearchRelevanceRange }): React.JSX.Element {
  return (
    <form action="/search/metrics" method="get" className="filter-bar" role="search">
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
        <Link href="/search/metrics" className="filter-bar__reset">
          Last {DEFAULT_WINDOW_DAYS} days
        </Link>
      </div>
    </form>
  );
}

function DetailDayPicker({
  detailDate,
  range,
}: {
  readonly detailDate: string | null;
  readonly range: SearchRelevanceRange;
}): React.JSX.Element {
  return (
    <form action="/search/metrics" method="get" className="filter-bar" role="search">
      {/* Preserve the summary window when changing the detail day. */}
      {range.from !== undefined ? <input type="hidden" name="from" value={range.from} /> : null}
      {range.to !== undefined ? <input type="hidden" name="to" value={range.to} /> : null}
      <label className="filter-bar__field">
        <span>Detail day</span>
        <input type="date" name="date" defaultValue={detailDate ?? ''} autoComplete="off" />
      </label>
      <div className="filter-bar__actions">
        <button type="submit" className="filter-bar__submit">
          View day
        </button>
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
 * Resolve the effective summary date range from the URL. A valid
 * `from`/`to` (`YYYY-MM-DD`) is honoured; anything else falls back to the
 * default trailing window so a hand-mangled URL degrades to a sensible
 * view rather than erroring. The gateway re-validates + the response
 * echoes the real window, so this is a UX convenience, not the trust
 * boundary.
 */
function resolveRange(params: Record<string, string | string[] | undefined>): SearchRelevanceRange {
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

/** Format an integer parts-per-million rate (or null) as a percentage. */
function formatPercent(ppm: number | null): string {
  if (ppm === null) return '—';
  return `${((ppm / SEARCH_RELEVANCE_PPM_SCALE) * 100).toFixed(1)}%`;
}
