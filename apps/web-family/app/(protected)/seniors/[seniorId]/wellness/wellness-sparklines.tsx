'use client';

import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  type TooltipProps,
  XAxis,
  YAxis,
} from 'recharts';

import {
  WELLNESS_TREND_SCORE_MAX,
  WELLNESS_TREND_SCORE_MIN,
  wellnessLevelsForMetric,
  type WellnessTrendSeries,
} from '@taste-and-see/contracts';

import { WELLNESS_METRIC_TITLE } from '@/lib/wellness-metric-titles';

/**
 * Wellness-trend sparklines (TS-231).
 *
 * Client component (Recharts requires the DOM). Renders one compact line
 * chart per wellness scale — each completed visit that recorded the
 * scale is a point, the y-axis is the 1..5 ordinal labelled with the
 * scale's own warm words, and the x is visit order (dates live in the
 * tooltip to keep the sparkline uncluttered).
 *
 * **Accessibility.** The SVG chart is decorative-by-nature for a screen
 * reader, so each card leads with a text reading ("Most recent: Bright ·
 * 4 visits") and the chart container carries an `aria-label` summarising
 * the trend. Recharts' `accessibilityLayer` adds keyboard navigation of
 * the points. A scale with no recorded visits renders a plain
 * "not recorded yet" line instead of an empty chart.
 */

const TICK_SCORES = Array.from(
  { length: WELLNESS_TREND_SCORE_MAX - WELLNESS_TREND_SCORE_MIN + 1 },
  (_unused, i) => WELLNESS_TREND_SCORE_MIN + i,
);

function titleCase(level: string): string {
  return level.length === 0 ? level : `${level.charAt(0).toUpperCase()}${level.slice(1)}`;
}

interface ChartDatum {
  readonly visit: number;
  readonly score: number;
  readonly level: string;
  readonly shortDate: string;
}

function shortDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function WellnessTooltip({
  active,
  payload,
}: TooltipProps<number, string>): React.JSX.Element | null {
  if (active !== true || payload === undefined || payload.length === 0) return null;
  const datum = payload[0]?.payload as ChartDatum | undefined;
  if (datum === undefined) return null;
  return (
    <div className="wellness-tooltip">
      <span className="wellness-tooltip__date">{datum.shortDate}</span>
      <span className="wellness-tooltip__level">{titleCase(datum.level)}</span>
    </div>
  );
}

function MetricCard({ series }: { readonly series: WellnessTrendSeries }): React.JSX.Element {
  const title = WELLNESS_METRIC_TITLE[series.metric];
  const axisLabels = wellnessLevelsForMetric(series.metric);

  if (series.points.length === 0) {
    return (
      <section className="wellness-card" aria-label={`${title}: not recorded on recent visits`}>
        <header className="wellness-card__head">
          <h2 className="wellness-card__title">{title}</h2>
        </header>
        <p className="wellness-card__empty">Not recorded on recent visits.</p>
      </section>
    );
  }

  const data: ChartDatum[] = series.points.map((point, index) => ({
    visit: index + 1,
    score: point.score,
    level: point.level,
    shortDate: shortDate(point.visitDate),
  }));
  const latestLevel = series.points[series.points.length - 1]?.level ?? '';
  const summary = `${title}: most recent ${titleCase(latestLevel)}, across ${series.visitsRecorded} ${series.visitsRecorded === 1 ? 'visit' : 'visits'}.`;

  return (
    <section className="wellness-card">
      <header className="wellness-card__head">
        <h2 className="wellness-card__title">{title}</h2>
        <p className="wellness-card__latest">
          Most recent: <strong>{titleCase(latestLevel)}</strong>
          <span className="wellness-card__count">
            {' '}
            · {series.visitsRecorded} {series.visitsRecorded === 1 ? 'visit' : 'visits'}
          </span>
        </p>
      </header>
      <div className="wellness-chart" role="img" aria-label={summary}>
        <ResponsiveContainer width="100%" height={150}>
          <LineChart
            data={data}
            margin={{ top: 8, right: 12, bottom: 4, left: 4 }}
            accessibilityLayer
          >
            <CartesianGrid stroke="var(--rule)" strokeDasharray="2 4" vertical={false} />
            <XAxis dataKey="shortDate" hide />
            <YAxis
              type="number"
              domain={[WELLNESS_TREND_SCORE_MIN, WELLNESS_TREND_SCORE_MAX]}
              ticks={TICK_SCORES}
              tickFormatter={(value: number) => titleCase(axisLabels[value - 1] ?? '')}
              tick={{ fontSize: 11, fill: 'var(--ink-soft)' }}
              width={84}
              axisLine={false}
              tickLine={false}
            />
            <Tooltip content={<WellnessTooltip />} cursor={{ stroke: 'var(--rule)' }} />
            <Line
              type="monotone"
              dataKey="score"
              stroke="var(--clay)"
              strokeWidth={2}
              dot={{ r: 3, fill: 'var(--clay)', stroke: 'var(--clay)' }}
              activeDot={{ r: 5 }}
              isAnimationActive={false}
            />
          </LineChart>
        </ResponsiveContainer>
      </div>
    </section>
  );
}

export function WellnessSparklines({
  series,
}: {
  readonly series: readonly WellnessTrendSeries[];
}): React.JSX.Element {
  return (
    <div className="wellness-grid">
      {series.map((s) => (
        <MetricCard key={s.metric} series={s} />
      ))}
    </div>
  );
}
