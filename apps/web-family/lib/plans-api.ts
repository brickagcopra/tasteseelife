import { PlansListResponseSchema, type Plan } from '@taste-and-see/contracts';

import { callGateway } from './api';

/**
 * Fetch the active plan catalog through the gateway (TS-124).
 *
 * The portal calls `GET /api/v1/plans` via the BFF. The response is
 * validated against the contract schema at this boundary so any drift
 * between the published contract and the runtime response surfaces here
 * with a typed result rather than leaking into the UI.
 *
 * Returns the typed list on success, an empty array on the 401 /
 * unreachable / malformed branches — the caller is responsible for
 * surfacing a banner when the catalog is empty for an unexpected reason
 * (the marketing site never gates on this; the family portal does).
 */
export interface PlansLoadOk {
  readonly kind: 'ok';
  readonly plans: readonly Plan[];
}
export interface PlansLoadUnauthorized {
  readonly kind: 'unauthorized';
}
export interface PlansLoadFailure {
  readonly kind: 'failure';
  readonly detail: string;
}
export type PlansLoadResult = PlansLoadOk | PlansLoadUnauthorized | PlansLoadFailure;

export async function loadPlans(): Promise<PlansLoadResult> {
  const result = await callGateway<unknown>('/api/v1/plans');
  if (result.kind === 'unauthorized') {
    return { kind: 'unauthorized' };
  }
  if (result.kind !== 'ok') {
    return { kind: 'failure', detail: `gateway responded with ${result.kind}` };
  }
  const parsed = PlansListResponseSchema.safeParse(result.body);
  if (!parsed.success) {
    return { kind: 'failure', detail: 'gateway returned a malformed plans response' };
  }
  return { kind: 'ok', plans: parsed.data.plans };
}

/**
 * Render the minor-units price as a localized USD label (e.g. `$199.00`).
 * The contract guarantees integer minor units; we divide by 100 only at
 * the presentation boundary.
 */
export function formatUsdMinor(minor: number): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 0,
  }).format(minor / 100);
}
