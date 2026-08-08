import {
  ListSearchRelevanceDailyResponseSchema,
  SearchRelevanceDayDetailResponseSchema,
  type ListSearchRelevanceDailyResponse,
  type SearchRelevanceDayDetailResponse,
} from '@taste-and-see/contracts';

import { callGateway } from '@/lib/api';

/**
 * Search-relevance dashboard gateway client (TS-217b).
 *
 * Wraps the two TS-217a admin READ proxies the dashboard consumes:
 *
 *   - `GET /api/v1/admin/analytics/search-relevance/summary?from=&to=`
 *     — the per-day summary series (`search_relevance_daily`).
 *   - `GET /api/v1/admin/analytics/search-relevance/detail?date=`
 *     — a single UTC day's drill-down (top queries, zero-result
 *     queries, searches-per-sort, CTR-by-position).
 *
 * Mirrors `lib/saas-metrics-api.ts`: one typed fetch + one
 * contract-validation point per read, with the `unauthorized` arm
 * distinguished from `failure` so the page bounces to `/login` on a 401
 * without conflating it with a transient downstream outage.
 */

export interface SearchRelevanceRange {
  readonly from?: string;
  readonly to?: string;
}

export type SearchRelevanceSummaryResult =
  | { readonly kind: 'ok'; readonly data: ListSearchRelevanceDailyResponse }
  | { readonly kind: 'unauthorized' }
  | { readonly kind: 'failure' };

export type SearchRelevanceDetailResult =
  | { readonly kind: 'ok'; readonly data: SearchRelevanceDayDetailResponse }
  | { readonly kind: 'unauthorized' }
  | { readonly kind: 'failure' };

/** Build the gateway path for a (possibly partial) summary date range. */
export function buildSummaryPath(range: SearchRelevanceRange): string {
  const params = new URLSearchParams();
  if (range.from !== undefined) params.set('from', range.from);
  if (range.to !== undefined) params.set('to', range.to);
  const qs = params.toString();
  return qs.length > 0
    ? `/api/v1/admin/analytics/search-relevance/summary?${qs}`
    : '/api/v1/admin/analytics/search-relevance/summary';
}

/** Build the gateway path for a single-day detail read. */
export function buildDetailPath(date: string): string {
  const params = new URLSearchParams({ date });
  return `/api/v1/admin/analytics/search-relevance/detail?${params.toString()}`;
}

export async function fetchSearchRelevanceSummary(
  range: SearchRelevanceRange,
): Promise<SearchRelevanceSummaryResult> {
  const result = await callGateway<unknown>(buildSummaryPath(range));
  if (result.kind === 'unauthorized') return { kind: 'unauthorized' };
  if (result.kind !== 'ok') return { kind: 'failure' };
  const parsed = ListSearchRelevanceDailyResponseSchema.safeParse(result.body);
  return parsed.success ? { kind: 'ok', data: parsed.data } : { kind: 'failure' };
}

export async function fetchSearchRelevanceDetail(
  date: string,
): Promise<SearchRelevanceDetailResult> {
  const result = await callGateway<unknown>(buildDetailPath(date));
  if (result.kind === 'unauthorized') return { kind: 'unauthorized' };
  if (result.kind !== 'ok') return { kind: 'failure' };
  const parsed = SearchRelevanceDayDetailResponseSchema.safeParse(result.body);
  return parsed.success ? { kind: 'ok', data: parsed.data } : { kind: 'failure' };
}
