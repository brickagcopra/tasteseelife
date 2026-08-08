import { MeResponseSchema, type MeResponse } from '@taste-and-see/contracts';

import { callGateway } from './api';

/**
 * Session-identity client for the provider portal (TS-309d).
 *
 * `GET /api/v1/me` is the gateway's no-downstream-hop projection of the
 * verified access token (TS-140): who this session belongs to, whether it was
 * fully verified, and what it may do.
 *
 * The portal's first use for it is the Privacy Center, which needs to know
 * whether the session is MFA-verified BEFORE it invites someone to write out a
 * privacy request — the service will refuse one from a session it cannot treat
 * as proof of identity, and a form that always ends in a refusal is not an
 * honest page. It is a hint, not a gate: the server action still handles a
 * `mfa_required` refusal, because a token can go stale between the render and
 * the submit.
 */

export type MeResult =
  | { readonly kind: 'ok'; readonly me: MeResponse }
  | { readonly kind: 'unauthorized' }
  | { readonly kind: 'failure'; readonly detail: string };

export async function fetchMe(): Promise<MeResult> {
  const result = await callGateway<unknown>('/api/v1/me');
  if (result.kind === 'unauthorized') return { kind: 'unauthorized' };
  if (result.kind !== 'ok') {
    return { kind: 'failure', detail: `gateway responded with ${result.kind}` };
  }

  const parsed = MeResponseSchema.safeParse(result.body);
  if (!parsed.success) {
    return { kind: 'failure', detail: 'gateway returned a malformed session projection' };
  }
  return { kind: 'ok', me: parsed.data };
}
