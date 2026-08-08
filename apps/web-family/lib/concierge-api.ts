import {
  ConciergeAssignmentSnapshotResponseSchema,
  type ConciergeAssignmentRecord,
} from '@taste-and-see/contracts';

import { callGateway } from './api';

/**
 * Dedicated-concierge client for the family portal (TS-222).
 *
 * Calls the gateway BFF (`GET /api/v1/concierge/assignments/me`) and
 * validates the response at the portal boundary. service-concierge
 * resolves the household from the token's `tenantScope` claim — no
 * household id is supplied by the client.
 *
 * Returns a typed discriminated union so the dashboard can branch cleanly:
 *   - `assigned`   — the household has an active dedicated concierge.
 *   - `none`       — no dedicated concierge (e.g. a non-Tier-3 household,
 *                    or a Tier-3 household awaiting its kickoff).
 *   - `unavailable`— the read failed (unauthorised / downstream blip); the
 *                    dashboard simply omits the card rather than erroring.
 */
export type MyConciergeResult =
  | { readonly kind: 'assigned'; readonly assignment: ConciergeAssignmentRecord }
  | { readonly kind: 'none' }
  | { readonly kind: 'unavailable' };

export async function getMyConcierge(): Promise<MyConciergeResult> {
  const result = await callGateway<unknown>('/api/v1/concierge/assignments/me');
  if (result.kind !== 'ok') {
    return { kind: 'unavailable' };
  }
  const parsed = ConciergeAssignmentSnapshotResponseSchema.safeParse(result.body);
  if (!parsed.success) {
    return { kind: 'unavailable' };
  }
  if (parsed.data.assignment === null) {
    return { kind: 'none' };
  }
  return { kind: 'assigned', assignment: parsed.data.assignment };
}
