import {
  ListSaasMetricsResponseSchema,
  type ListSaasMetricsResponse,
} from '@taste-and-see/contracts';

import { callGateway } from '@/lib/api';

/**
 * SaaS-metrics dashboard gateway client (TS-266).
 *
 * Wraps the `GET /api/v1/admin/accounting/saas-metrics` BFF read so both
 * the dashboard page and the CSV export route share one typed fetch +
 * one contract-validation point. The `unauthorized` arm is distinguished
 * from `failure` so the page can bounce to `/login` on a 401 without
 * conflating it with a transient gateway outage.
 */

export type SaasMetricsFetchResult =
  | { readonly kind: 'ok'; readonly data: ListSaasMetricsResponse }
  | { readonly kind: 'unauthorized' }
  | { readonly kind: 'failure' };

export interface SaasMetricsRange {
  readonly from?: string;
  readonly to?: string;
}

/** Build the gateway path for a (possibly partial) date range. */
export function buildSaasMetricsPath(range: SaasMetricsRange): string {
  const params = new URLSearchParams();
  if (range.from !== undefined) params.set('from', range.from);
  if (range.to !== undefined) params.set('to', range.to);
  const qs = params.toString();
  return qs.length > 0
    ? `/api/v1/admin/accounting/saas-metrics?${qs}`
    : '/api/v1/admin/accounting/saas-metrics';
}

export async function fetchSaasMetrics(range: SaasMetricsRange): Promise<SaasMetricsFetchResult> {
  const result = await callGateway<unknown>(buildSaasMetricsPath(range));
  if (result.kind === 'unauthorized') return { kind: 'unauthorized' };
  if (result.kind !== 'ok') return { kind: 'failure' };
  const parsed = ListSaasMetricsResponseSchema.safeParse(result.body);
  return parsed.success ? { kind: 'ok', data: parsed.data } : { kind: 'failure' };
}
