import {
  FamilyWellnessTrendsResponseSchema,
  WELLNESS_TREND_WINDOW_DAYS_VALUES,
  type FamilyWellnessTrendsResponse,
  type WellnessTrendWindowDays,
} from '@taste-and-see/contracts';

import { callGateway } from './api';

/**
 * Consent-gated wellness-trend client for the family portal (TS-231).
 *
 * Calls the gateway BFF aggregator
 * (`GET /api/v1/seniors/:seniorId/wellness-trends`) and validates the
 * response at the portal boundary. The gateway applies the senior's
 * `notes` consent flag (TS-238) — the response's `shared` flag tells the
 * page whether the caller may see the observations (manager / senior, or
 * an observer the senior shared with). A `shared: false` response
 * carries empty series — the default-opt-out empty state, not an error.
 *
 * Returns a typed discriminated union so the server component can branch
 * on `unauthorized` / `forbidden` / `not_found` (the membership gate from
 * the underlying consent read) / `unavailable` / `ok`.
 */
export type WellnessTrendsResult =
  | { readonly kind: 'ok'; readonly trends: FamilyWellnessTrendsResponse }
  | { readonly kind: 'unauthorized' }
  | { readonly kind: 'forbidden' }
  | { readonly kind: 'not_found' }
  | { readonly kind: 'unavailable'; readonly detail: string };

export async function getSeniorWellnessTrends(
  seniorId: string,
  windowDays?: WellnessTrendWindowDays,
): Promise<WellnessTrendsResult> {
  const search = new URLSearchParams();
  if (windowDays !== undefined) {
    search.set('windowDays', String(windowDays));
  }
  const qs = search.toString();
  const path = `/api/v1/seniors/${encodeURIComponent(seniorId)}/wellness-trends${qs.length > 0 ? `?${qs}` : ''}`;

  const result = await callGateway<unknown>(path);
  if (result.kind === 'unauthorized') return { kind: 'unauthorized' };
  if (result.kind === 'client_error') {
    if (result.status === 403) return { kind: 'forbidden' };
    if (result.status === 404) return { kind: 'not_found' };
    return { kind: 'unavailable', detail: `gateway responded with client error ${result.status}` };
  }
  if (result.kind !== 'ok') {
    return { kind: 'unavailable', detail: `gateway responded with ${result.kind}` };
  }
  const parsed = FamilyWellnessTrendsResponseSchema.safeParse(result.body);
  if (!parsed.success) {
    return { kind: 'unavailable', detail: 'gateway returned a malformed wellness-trends response' };
  }
  return { kind: 'ok', trends: parsed.data };
}

/**
 * Coerce an arbitrary query-param value into a valid window, defaulting
 * to 30. Keeps the page's `?windowDays=` handling honest (a hand-edited
 * URL degrades to the default rather than 400-ing the gateway).
 */
export function parseWindowDays(raw: string | string[] | undefined): WellnessTrendWindowDays {
  const value = Array.isArray(raw) ? raw[0] : raw;
  const numeric = value === undefined ? NaN : Number.parseInt(value, 10);
  return (WELLNESS_TREND_WINDOW_DAYS_VALUES as readonly number[]).includes(numeric)
    ? (numeric as WellnessTrendWindowDays)
    : 30;
}
