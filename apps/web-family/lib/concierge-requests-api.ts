import {
  ConciergeTicketsListResponseSchema,
  SubmitConciergeRequestRequestSchema,
  SubmitConciergeRequestResponseSchema,
  type ConciergeTicketRecord,
  type SubmitConciergeRequestRequest,
} from '@taste-and-see/contracts';

import { callGateway } from './api';

/**
 * Concierge custom-request client for the family portal (TS-223).
 *
 * Calls the gateway's `/api/v1/concierge/requests` BFF proxies and
 * validates each response at the portal boundary. service-concierge
 * resolves the household from the token's `tenantScope` claim — no
 * household id is supplied by the client.
 *
 * Returns typed discriminated unions so server components + actions can
 * branch cleanly on `unauthorized` / `client_error` / `failure` / `ok`.
 */

export type ConciergeRequestsListResult =
  | { readonly kind: 'ok'; readonly tickets: readonly ConciergeTicketRecord[] }
  | { readonly kind: 'unauthorized' }
  | { readonly kind: 'failure'; readonly detail: string };

export type SubmitConciergeRequestResult =
  | { readonly kind: 'ok'; readonly ticket: ConciergeTicketRecord }
  | { readonly kind: 'unauthorized' }
  | { readonly kind: 'client_error'; readonly status: number; readonly body: unknown }
  | { readonly kind: 'failure'; readonly detail: string };

export async function listMyConciergeRequests(): Promise<ConciergeRequestsListResult> {
  const result = await callGateway<unknown>('/api/v1/concierge/requests/me');
  if (result.kind === 'unauthorized') return { kind: 'unauthorized' };
  if (result.kind !== 'ok') {
    return { kind: 'failure', detail: `gateway responded with ${result.kind}` };
  }
  const parsed = ConciergeTicketsListResponseSchema.safeParse(result.body);
  if (!parsed.success) {
    return { kind: 'failure', detail: 'gateway returned a malformed requests list response' };
  }
  return { kind: 'ok', tickets: parsed.data.tickets };
}

export async function submitConciergeRequest(
  request: SubmitConciergeRequestRequest,
  idempotencyKey: string,
): Promise<SubmitConciergeRequestResult> {
  // Defence-in-depth: validate before sending so a malformed local body
  // surfaces as a client-side failure rather than a 400 from the gateway.
  const validated = SubmitConciergeRequestRequestSchema.safeParse(request);
  if (!validated.success) {
    return { kind: 'failure', detail: 'concierge request payload failed local validation' };
  }
  const result = await callGateway<unknown>('/api/v1/concierge/requests', {
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
  const parsed = SubmitConciergeRequestResponseSchema.safeParse(result.body);
  if (!parsed.success) {
    return { kind: 'failure', detail: 'gateway returned a malformed submit response' };
  }
  return { kind: 'ok', ticket: parsed.data.ticket };
}
