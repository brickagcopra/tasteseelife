import {
  ReportConcernRequestSchema,
  ReportConcernResponseSchema,
  type ReportConcernReceipt,
  type ReportConcernRequest,
} from '@taste-and-see/contracts';

import { callGateway } from './api';

/**
 * Trust & Safety "Report a concern" client for the provider portal
 * (TS-301b).
 *
 * Calls the same gateway BFF proxy as the family portal —
 * `POST /api/v1/trust-safety/incidents` — and validates the response at the
 * portal boundary.
 *
 * **Nothing identifying is sent.** A provider's token carries
 * `tenantScope: global` plus the `provider` role, and service-trust-safety
 * derives `source: 'provider'` and the reporter id from that token alone. In
 * particular the client does NOT send a `providerId`: a self-asserted
 * provider id would let a provider pin a concern on a different provider, so
 * the incident anchors on the verified reporter and provider linkage is
 * resolved at triage.
 *
 * Returns a typed discriminated union so the server action can branch on
 * `unauthorized` / `client_error` / `failure` / `ok`. Mirrors
 * `apps/web-family/lib/trust-safety-api.ts` — this is the provider portal's
 * first `lib/*-api.ts` module (other surfaces call `callGateway` inline);
 * the shared contract validation earns the extra indirection here.
 */

export type ReportConcernResult =
  | { readonly kind: 'ok'; readonly receipt: ReportConcernReceipt }
  | { readonly kind: 'unauthorized' }
  | { readonly kind: 'client_error'; readonly status: number; readonly body: unknown }
  | { readonly kind: 'failure'; readonly detail: string };

export async function reportConcern(
  request: ReportConcernRequest,
  idempotencyKey: string,
): Promise<ReportConcernResult> {
  // Defence-in-depth: validate before sending so a malformed local body
  // surfaces as a client-side failure rather than a 400 from the gateway.
  const validated = ReportConcernRequestSchema.safeParse(request);
  if (!validated.success) {
    return { kind: 'failure', detail: 'concern report payload failed local validation' };
  }
  const result = await callGateway<unknown>('/api/v1/trust-safety/incidents', {
    method: 'POST',
    body: validated.data,
    headers: { 'idempotency-key': idempotencyKey },
  });
  if (result.kind === 'unauthorized') return { kind: 'unauthorized' };
  if (result.kind === 'client_error') {
    return { kind: 'client_error', status: result.status, body: result.body };
  }
  if (result.kind !== 'ok') {
    return { kind: 'failure', detail: `gateway responded with ${result.kind}` };
  }
  const parsed = ReportConcernResponseSchema.safeParse(result.body);
  if (!parsed.success) {
    return { kind: 'failure', detail: 'gateway returned a malformed report-concern response' };
  }
  return { kind: 'ok', receipt: parsed.data.receipt };
}
