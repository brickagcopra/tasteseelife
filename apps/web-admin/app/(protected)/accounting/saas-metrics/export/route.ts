import {
  MeResponseSchema,
  SAAS_METRICS_PPM_SCALE,
  type MeResponse,
  type SaasMetricsRecord,
} from '@taste-and-see/contracts';

import { callGateway } from '@/lib/api';
import { hasSuperAdminRole } from '@/lib/admin-gate';
import { fetchSaasMetrics, type SaasMetricsRange } from '@/lib/saas-metrics-api';

/**
 * SaaS-metrics CSV export (TS-266; PRD §10.1, PDD §23.2 / §10.17 export).
 *
 *   GET /accounting/saas-metrics/export?from=&to=
 *
 * Streams the same date-range series the dashboard renders as a
 * `text/csv` attachment. Re-checks `super_admin` server-side (the route
 * handler is its own trust boundary — it doesn't rely on the page gate)
 * and forwards the portal access-token cookie to the gateway via
 * `callGateway`, so the browser never reaches service-accounting directly.
 *
 * Money columns are emitted in dollars (minor ÷ 100, 2 dp); retention
 * columns as percentages; everything else verbatim.
 */
export async function GET(request: Request): Promise<Response> {
  const me = await fetchMe();
  if (me === null) {
    return forbidden('Authentication required.');
  }
  if (!me.mfaVerified || !hasSuperAdminRole(me)) {
    return forbidden('Super-admin access required.');
  }

  const range = resolveRange(new URL(request.url).searchParams);
  const result = await fetchSaasMetrics(range);
  if (result.kind === 'unauthorized') {
    return forbidden('Authentication required.');
  }
  if (result.kind === 'failure') {
    return new Response('Unable to load SaaS metrics for export.', {
      status: 502,
      headers: { 'content-type': 'text/plain; charset=utf-8' },
    });
  }

  const csv = toCsv(result.data.metrics);
  const filename = `saas-metrics_${result.data.from ?? 'start'}_${result.data.to ?? 'end'}.csv`;
  return new Response(csv, {
    status: 200,
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="${filename}"`,
      'cache-control': 'no-store',
    },
  });
}

const CSV_HEADER = [
  'metric_date',
  'currency',
  'mrr',
  'arr',
  'arpu',
  'active_subscriptions',
  'new_mrr',
  'expansion_mrr',
  'contraction_mrr',
  'churned_mrr',
  'churned_subscriptions',
  'net_new_mrr',
  'prior_mrr',
  'net_revenue_retention_pct',
  'gross_revenue_retention_pct',
  'ltv',
  'cac',
  'comparison_date',
  'computed_at',
] as const;

function toCsv(metrics: readonly SaasMetricsRecord[]): string {
  const lines: string[] = [CSV_HEADER.join(',')];
  for (const m of metrics) {
    lines.push(
      [
        m.metricDate,
        m.currency,
        dollars(m.mrrMinor),
        dollars(m.arrMinor),
        dollars(m.arpuMinor),
        m.activeSubscriptions.toString(),
        dollars(m.newMrrMinor),
        dollars(m.expansionMrrMinor),
        dollars(m.contractionMrrMinor),
        dollars(m.churnedMrrMinor),
        m.churnedSubscriptions.toString(),
        dollars(m.netNewMrrMinor),
        dollars(m.priorMrrMinor),
        pct(m.netRevenueRetentionPpm),
        pct(m.grossRevenueRetentionPpm),
        m.ltvMinor === null ? '' : dollars(m.ltvMinor),
        m.cacMinor === null ? '' : dollars(m.cacMinor),
        m.comparisonDate ?? '',
        m.computedAt,
      ].join(','),
    );
  }
  // Trailing newline keeps POSIX tools happy.
  return `${lines.join('\n')}\n`;
}

function dollars(minor: number): string {
  return (minor / 100).toFixed(2);
}

function pct(ppm: number | null): string {
  if (ppm === null) return '';
  return ((ppm / SAAS_METRICS_PPM_SCALE) * 100).toFixed(2);
}

function resolveRange(params: URLSearchParams): SaasMetricsRange {
  const from = dateParam(params.get('from'));
  const to = dateParam(params.get('to'));
  return {
    ...(from !== null && { from }),
    ...(to !== null && { to }),
  };
}

function dateParam(value: string | null): string | null {
  if (value === null) return null;
  return /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : null;
}

async function fetchMe(): Promise<MeResponse | null> {
  const result = await callGateway<unknown>('/api/v1/me');
  if (result.kind !== 'ok') return null;
  const parsed = MeResponseSchema.safeParse(result.body);
  return parsed.success ? parsed.data : null;
}

function forbidden(detail: string): Response {
  return new Response(detail, {
    status: 403,
    headers: { 'content-type': 'text/plain; charset=utf-8' },
  });
}
