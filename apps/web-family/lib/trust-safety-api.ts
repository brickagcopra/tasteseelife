import {
  ReportConcernRequestSchema,
  ReportConcernResponseSchema,
  type ReportConcernReceipt,
  type ReportConcernRequest,
} from '@taste-and-see/contracts';

import { callGateway } from './api';

/**
 * Trust & Safety "Report a concern" client for the family portal (TS-301a).
 *
 * Calls the gateway's `POST /api/v1/trust-safety/incidents` BFF proxy and
 * validates the response at the portal boundary. service-trust-safety
 * resolves the household from the token's `tenantScope` claim — no household
 * id is supplied by the client (the TS-225 emergency-channel posture).
 *
 * Returns a typed discriminated union so the server action can branch on
 * `unauthorized` / `client_error` / `failure` / `ok`.
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
