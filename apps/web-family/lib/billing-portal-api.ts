import { BillingPortalSessionResponseSchema } from '@taste-and-see/contracts';

import { callGateway } from './api';

/**
 * Stripe Billing Portal client for the family portal
 * (TS-042-followup-3a3-followup-1).
 *
 * Calls the gateway's `POST /api/v1/billing/portal-sessions` and
 * validates the response at the portal boundary. **No request payload
 * at all** — the Stripe customer is derived from the token's
 * `tenantScope`, so there is nothing for this client to name and no way
 * for it to name someone else's.
 */

export type BillingPortalSessionResult =
  | { readonly kind: 'ok'; readonly url: string }
  | { readonly kind: 'unauthorized' }
  | { readonly kind: 'no_plan' }
  | { readonly kind: 'failure' };

export async function createBillingPortalSession(
  idempotencyKey: string,
): Promise<BillingPortalSessionResult> {
  const result = await callGateway<unknown>('/api/v1/billing/portal-sessions', {
    method: 'POST',
    body: {},
    headers: { 'idempotency-key': idempotencyKey },
  });

  if (result.kind === 'unauthorized') return { kind: 'unauthorized' };
  if (result.kind === 'client_error') {
    // 404 is the only 4xx a signed-in family member should be able to
    // provoke: they have no family subscription. Everything else here
    // (400 for a scope we did not send, 422 for a broken Stripe link) is
    // ours to fix, not theirs to understand, so it reads as a failure.
    if (result.status === 404) return { kind: 'no_plan' };
    return { kind: 'failure' };
  }
  if (result.kind !== 'ok') return { kind: 'failure' };

  const parsed = BillingPortalSessionResponseSchema.safeParse(result.body);
  if (!parsed.success) return { kind: 'failure' };
  return { kind: 'ok', url: parsed.data.url };
}
