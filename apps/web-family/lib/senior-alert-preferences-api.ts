import {
  SeniorAlertPreferencesResponseSchema,
  SetSeniorAlertPreferencesRequestSchema,
  type SeniorAlertPreferencesFlags,
  type SeniorAlertPreferencesResponse,
} from '@taste-and-see/contracts';

import { callGateway } from './api';

/**
 * Per-(senior × family-member) alert subscription client for the family
 * portal (TS-234).
 *
 * Calls the gateway BFF proxies (`GET` / `PUT
 * /api/v1/seniors/:seniorId/alert-preferences`) and validates each
 * response at the portal boundary. Returns typed discriminated unions so
 * server components / actions can branch on
 * `unauthorized` / `forbidden` / `not_found` / `failure` / `ok`.
 *
 * Both surfaces operate on the authenticated member's *own* subscription —
 * the row is keyed to the caller downstream, never to client input. A
 * non-member of the senior's household gets a 403 → `forbidden`.
 */

export type SeniorAlertPreferencesResult =
  | { readonly kind: 'ok'; readonly preferences: SeniorAlertPreferencesResponse }
  | { readonly kind: 'unauthorized' }
  | { readonly kind: 'forbidden' }
  | { readonly kind: 'not_found' }
  | { readonly kind: 'failure'; readonly detail: string };

export async function getSeniorAlertPreferences(
  seniorId: string,
): Promise<SeniorAlertPreferencesResult> {
  const result = await callGateway<unknown>(
    `/api/v1/seniors/${encodeURIComponent(seniorId)}/alert-preferences`,
  );
  if (result.kind === 'unauthorized') return { kind: 'unauthorized' };
  if (result.kind === 'client_error') {
    if (result.status === 403) return { kind: 'forbidden' };
    if (result.status === 404) return { kind: 'not_found' };
    return { kind: 'failure', detail: `gateway responded with client error ${result.status}` };
  }
  if (result.kind !== 'ok') {
    return { kind: 'failure', detail: `gateway responded with ${result.kind}` };
  }
  const parsed = SeniorAlertPreferencesResponseSchema.safeParse(result.body);
  if (!parsed.success) {
    return { kind: 'failure', detail: 'gateway returned a malformed alert-preferences response' };
  }
  return { kind: 'ok', preferences: parsed.data };
}

export async function setSeniorAlertPreferences(
  seniorId: string,
  flags: SeniorAlertPreferencesFlags,
  idempotencyKey: string,
): Promise<SeniorAlertPreferencesResult> {
  // Defence-in-depth: validate before sending so a malformed local body
  // surfaces as a client-side failure rather than a 400 from the gateway.
  const validated = SetSeniorAlertPreferencesRequestSchema.safeParse(flags);
  if (!validated.success) {
    return { kind: 'failure', detail: 'alert-preferences payload failed local validation' };
  }
  const result = await callGateway<unknown>(
    `/api/v1/seniors/${encodeURIComponent(seniorId)}/alert-preferences`,
    {
      method: 'PUT',
      body: validated.data,
      headers: { 'idempotency-key': idempotencyKey },
    },
  );
  if (result.kind === 'unauthorized') return { kind: 'unauthorized' };
  if (result.kind === 'client_error') {
    if (result.status === 403) return { kind: 'forbidden' };
    if (result.status === 404) return { kind: 'not_found' };
    return { kind: 'failure', detail: `gateway responded with client error ${result.status}` };
  }
  if (result.kind !== 'ok') {
    return { kind: 'failure', detail: `gateway responded with ${result.kind}` };
  }
  const parsed = SeniorAlertPreferencesResponseSchema.safeParse(result.body);
  if (!parsed.success) {
    return { kind: 'failure', detail: 'gateway returned a malformed alert-preferences response' };
  }
  return { kind: 'ok', preferences: parsed.data };
}
