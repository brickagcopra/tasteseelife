import {
  TriggerEmergencyAssistanceRequestSchema,
  TriggerEmergencyAssistanceResponseSchema,
  type ConciergeTicketRecord,
  type TriggerEmergencyAssistanceRequest,
} from '@taste-and-see/contracts';

import { callGateway } from './api';

/**
 * Emergency concierge-assistance client for the family portal (TS-225).
 *
 * Calls the gateway's `POST /api/v1/concierge/emergency` BFF proxy and
 * validates the response at the portal boundary. service-concierge resolves
 * the household from the token's `tenantScope` claim — no household id is
 * supplied by the client.
 *
 * Returns a typed discriminated union so the server action can branch on
 * `unauthorized` / `client_error` / `failure` / `ok`.
 */

export type TriggerEmergencyAssistanceResult =
  | { readonly kind: 'ok'; readonly ticket: ConciergeTicketRecord }
  | { readonly kind: 'unauthorized' }
  | { readonly kind: 'client_error'; readonly status: number; readonly body: unknown }
  | { readonly kind: 'failure'; readonly detail: string };

export async function triggerEmergencyAssistance(
  request: TriggerEmergencyAssistanceRequest,
  idempotencyKey: string,
): Promise<TriggerEmergencyAssistanceResult> {
  // Defence-in-depth: validate before sending so a malformed local body
  // surfaces as a client-side failure rather than a 400 from the gateway.
  const validated = TriggerEmergencyAssistanceRequestSchema.safeParse(request);
  if (!validated.success) {
    return { kind: 'failure', detail: 'emergency payload failed local validation' };
  }
  const result = await callGateway<unknown>('/api/v1/concierge/emergency', {
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
  const parsed = TriggerEmergencyAssistanceResponseSchema.safeParse(result.body);
  if (!parsed.success) {
    return { kind: 'failure', detail: 'gateway returned a malformed emergency response' };
  }
  return { kind: 'ok', ticket: parsed.data.ticket };
}
