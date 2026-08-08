import {
  MyConciergeOnboardingResponseSchema,
  type ConciergeOnboardingDetailRecord,
} from '@taste-and-see/contracts';

import { callGateway } from './api';

/**
 * Tier-3 onboarding read client for the family portal (TS-228).
 *
 * Calls the gateway BFF (`GET /api/v1/concierge/onboarding/me`) and validates
 * the response at the portal boundary. service-concierge resolves the
 * household from the token's `tenantScope` claim — no household id is supplied
 * by the client. The family surface is READ-ONLY: the family sees their
 * white-glove kickoff progress; the concierge team drives the work.
 *
 * Returns a typed discriminated union so the dashboard can branch cleanly:
 *   - `onboarding`  — the household has an onboarding in progress.
 *   - `none`        — no onboarding (a non-Tier-3 household, or one not yet
 *                     kicked off).
 *   - `unavailable` — the read failed (unauthorised / downstream blip); the
 *                     surface simply omits the card rather than erroring.
 */
export type MyOnboardingResult =
  | { readonly kind: 'onboarding'; readonly onboarding: ConciergeOnboardingDetailRecord }
  | { readonly kind: 'none' }
  | { readonly kind: 'unavailable' };

export async function getMyOnboarding(): Promise<MyOnboardingResult> {
  const result = await callGateway<unknown>('/api/v1/concierge/onboarding/me');
  if (result.kind !== 'ok') {
    return { kind: 'unavailable' };
  }
  const parsed = MyConciergeOnboardingResponseSchema.safeParse(result.body);
  if (!parsed.success) {
    return { kind: 'unavailable' };
  }
  if (parsed.data.onboarding === null) {
    return { kind: 'none' };
  }
  return { kind: 'onboarding', onboarding: parsed.data.onboarding };
}
