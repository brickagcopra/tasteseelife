import {
  FamilyWellnessAnomalyResponseSchema,
  type FamilyWellnessAnomalyResponse,
  type WellnessTrendWindowDays,
} from '@taste-and-see/contracts';

import { callGateway } from './api';

/**
 * Consent-gated wellness-anomaly client for the family portal (TS-236).
 *
 * Calls the gateway BFF aggregator
 * (`GET /api/v1/seniors/:seniorId/wellness-anomalies`) and validates the
 * response at the portal boundary. The gateway applies the senior's
 * `notes` consent flag (TS-238) — the response's `shared` flag mirrors
 * the wellness trends. A `shared: false` response carries empty `flags`
 * (the default-opt-out state, not an error).
 *
 * Returns a typed discriminated union so the wellness page can branch on
 * `unauthorized` / `forbidden` / `not_found` (the membership gate from
 * the underlying consent read) / `unavailable` / `ok`. The page treats
 * any non-`ok` anomaly result as "no early-signal banner" so an
 * anomaly-fetch hiccup never breaks the trends render (graceful
 * degradation — the banner is additive).
 */
export type WellnessAnomaliesResult =
  | { readonly kind: 'ok'; readonly anomalies: FamilyWellnessAnomalyResponse }
  | { readonly kind: 'unauthorized' }
  | { readonly kind: 'forbidden' }
  | { readonly kind: 'not_found' }
  | { readonly kind: 'unavailable'; readonly detail: string };

export async function getSeniorWellnessAnomalies(
  seniorId: string,
  windowDays?: WellnessTrendWindowDays,
): Promise<WellnessAnomaliesResult> {
  const search = new URLSearchParams();
  if (windowDays !== undefined) {
    search.set('windowDays', String(windowDays));
  }
  const qs = search.toString();
  const path = `/api/v1/seniors/${encodeURIComponent(seniorId)}/wellness-anomalies${qs.length > 0 ? `?${qs}` : ''}`;

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
  const parsed = FamilyWellnessAnomalyResponseSchema.safeParse(result.body);
  if (!parsed.success) {
    return {
      kind: 'unavailable',
      detail: 'gateway returned a malformed wellness-anomaly response',
    };
  }
  return { kind: 'ok', anomalies: parsed.data };
}
