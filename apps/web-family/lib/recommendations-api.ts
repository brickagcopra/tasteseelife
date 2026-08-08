import {
  SeniorRecommendedProvidersResponseSchema,
  type RecommendedProvider,
} from '@taste-and-see/contracts';

import { callGateway } from './api';

/**
 * Senior match-recommendations client for the family portal (TS-213).
 *
 * Calls the gateway BFF aggregator
 * (`GET /api/v1/seniors/:seniorId/recommended-providers`) and validates
 * the response at the portal boundary. Returns a typed discriminated
 * union so the server component can branch cleanly on
 * `unauthorized` / `forbidden` / `not_found` / `failure` / `ok` — the
 * `forbidden` / `not_found` cases render the same "we couldn't find that
 * loved one" page the preferences editor uses, so a foreign senior id
 * can't be probed.
 */

export type SeniorRecommendationsResult =
  | {
      readonly kind: 'ok';
      readonly seniorId: string;
      readonly recommendations: readonly RecommendedProvider[];
      readonly generatedAt: string;
    }
  | { readonly kind: 'unauthorized' }
  | { readonly kind: 'forbidden' }
  | { readonly kind: 'not_found' }
  | { readonly kind: 'failure'; readonly detail: string };

export async function getSeniorRecommendations(
  seniorId: string,
): Promise<SeniorRecommendationsResult> {
  const result = await callGateway<unknown>(
    `/api/v1/seniors/${encodeURIComponent(seniorId)}/recommended-providers`,
  );
  if (result.kind === 'unauthorized') return { kind: 'unauthorized' };
  if (result.kind === 'client_error') {
    if (result.status === 403) return { kind: 'forbidden' };
    if (result.status === 404) return { kind: 'not_found' };
    return { kind: 'failure', detail: `gateway responded with client error ${result.status}` };
  }
  if (result.kind !== 'ok') {
    return { kind: 'failure', detail: `gateway responded with ${result.kind}` };
  }
  const parsed = SeniorRecommendedProvidersResponseSchema.safeParse(result.body);
  if (!parsed.success) {
    return { kind: 'failure', detail: 'gateway returned a malformed recommendations response' };
  }
  return {
    kind: 'ok',
    seniorId: parsed.data.seniorId,
    recommendations: parsed.data.recommendations,
    generatedAt: parsed.data.generatedAt,
  };
}
