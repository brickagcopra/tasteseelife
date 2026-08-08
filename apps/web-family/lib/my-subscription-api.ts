import { MySubscriptionResponseSchema, type MySubscriptionSummary } from '@taste-and-see/contracts';

import { callGateway } from './api';

/**
 * The family's own membership (TS-042-followup-3a3-followup-1a).
 *
 * `GET /api/v1/subscriptions/me` — no id, no query. The household is
 * resolved from the token downstream.
 *
 * Three outcomes rather than two: **"you have no plan" is not the same
 * as "we couldn't ask"**, and a billing page that renders them
 * identically either tells a paying family they have nothing or tells a
 * prospect that something is broken. Both are wrong in a way the reader
 * would act on.
 */
export type MySubscriptionResult =
  | { readonly kind: 'ok'; readonly subscription: MySubscriptionSummary }
  | { readonly kind: 'none' }
  | { readonly kind: 'unauthorized' }
  | { readonly kind: 'unavailable' };

export async function readMySubscription(): Promise<MySubscriptionResult> {
  const result = await callGateway<unknown>('/api/v1/subscriptions/me');

  if (result.kind === 'unauthorized') return { kind: 'unauthorized' };
  if (result.kind !== 'ok') return { kind: 'unavailable' };

  const parsed = MySubscriptionResponseSchema.safeParse(result.body);
  if (!parsed.success) return { kind: 'unavailable' };
  if (parsed.data.subscription === null) return { kind: 'none' };
  return { kind: 'ok', subscription: parsed.data.subscription };
}
