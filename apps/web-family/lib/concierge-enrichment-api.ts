import {
  MyConciergeEnrichmentSummariesResponseSchema,
  MyConciergeEnrichmentSummaryResponseSchema,
  type ConciergeEnrichmentSummaryRecord,
} from '@taste-and-see/contracts';

import { callGateway } from './api';

/**
 * Tier-3 weekly enrichment-summary read client for the family portal (TS-229).
 *
 * Calls the gateway BFF — `GET /api/v1/concierge/enrichment-summaries/me` (the
 * household's PUBLISHED summaries) + `.../me/:summaryId` (the per-week
 * permalink) — and validates the response at the portal boundary.
 * service-concierge resolves the household from the token's `tenantScope`
 * claim, so no household id is supplied by the client. The family surface is
 * READ-ONLY and only ever sees PUBLISHED summaries.
 */

export type MyEnrichmentSummariesResult =
  | { readonly kind: 'summaries'; readonly summaries: readonly ConciergeEnrichmentSummaryRecord[] }
  | { readonly kind: 'none' }
  | { readonly kind: 'unavailable' };

export type MyEnrichmentSummaryResult =
  | { readonly kind: 'summary'; readonly summary: ConciergeEnrichmentSummaryRecord }
  | { readonly kind: 'not-found' }
  | { readonly kind: 'unavailable' };

export async function getMyEnrichmentSummaries(): Promise<MyEnrichmentSummariesResult> {
  const result = await callGateway<unknown>('/api/v1/concierge/enrichment-summaries/me');
  if (result.kind !== 'ok') {
    return { kind: 'unavailable' };
  }
  const parsed = MyConciergeEnrichmentSummariesResponseSchema.safeParse(result.body);
  if (!parsed.success) {
    return { kind: 'unavailable' };
  }
  if (parsed.data.summaries.length === 0) {
    return { kind: 'none' };
  }
  return { kind: 'summaries', summaries: parsed.data.summaries };
}

export async function getMyEnrichmentSummary(
  summaryId: string,
): Promise<MyEnrichmentSummaryResult> {
  const result = await callGateway<unknown>(
    `/api/v1/concierge/enrichment-summaries/me/${encodeURIComponent(summaryId)}`,
  );
  if (result.kind !== 'ok') {
    return { kind: 'unavailable' };
  }
  const parsed = MyConciergeEnrichmentSummaryResponseSchema.safeParse(result.body);
  if (!parsed.success) {
    return { kind: 'unavailable' };
  }
  if (parsed.data.summary === null) {
    return { kind: 'not-found' };
  }
  return { kind: 'summary', summary: parsed.data.summary };
}
