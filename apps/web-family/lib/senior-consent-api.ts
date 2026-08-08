import {
  SeniorConsentResponseSchema,
  SetSeniorConsentRequestSchema,
  type SeniorConsentFlags,
  type SeniorConsentResponse,
} from '@taste-and-see/contracts';

import { callGateway } from './api';

/**
 * Senior family-observability consent client for the family portal
 * (TS-238).
 *
 * Calls the gateway BFF proxies (`GET` / `PUT
 * /api/v1/seniors/:seniorId/consent`) and validates each response at the
 * portal boundary. Returns typed discriminated unions so server
 * components / actions can branch on
 * `unauthorized` / `forbidden` / `not_found` / `failure` / `ok`.
 *
 * The GET surface is readable by any active household member (a family
 * observer sees the flags + `canManage: false`); the PUT surface is
 * authorised downstream for the primary payer + senior end-user only,
 * surfacing a 403 → `forbidden` to a family observer.
 */

export type SeniorConsentResult =
  | { readonly kind: 'ok'; readonly consent: SeniorConsentResponse }
  | { readonly kind: 'unauthorized' }
  | { readonly kind: 'forbidden' }
  | { readonly kind: 'not_found' }
  | { readonly kind: 'failure'; readonly detail: string };

export async function getSeniorConsent(seniorId: string): Promise<SeniorConsentResult> {
  const result = await callGateway<unknown>(
    `/api/v1/seniors/${encodeURIComponent(seniorId)}/consent`,
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
  const parsed = SeniorConsentResponseSchema.safeParse(result.body);
  if (!parsed.success) {
    return { kind: 'failure', detail: 'gateway returned a malformed consent response' };
  }
  return { kind: 'ok', consent: parsed.data };
}

export async function setSeniorConsent(
  seniorId: string,
  flags: SeniorConsentFlags,
  idempotencyKey: string,
): Promise<SeniorConsentResult> {
  // Defence-in-depth: validate before sending so a malformed local body
  // surfaces as a client-side failure rather than a 400 from the gateway.
  const validated = SetSeniorConsentRequestSchema.safeParse(flags);
  if (!validated.success) {
    return { kind: 'failure', detail: 'consent payload failed local validation' };
  }
  const result = await callGateway<unknown>(
    `/api/v1/seniors/${encodeURIComponent(seniorId)}/consent`,
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
  const parsed = SeniorConsentResponseSchema.safeParse(result.body);
  if (!parsed.success) {
    return { kind: 'failure', detail: 'gateway returned a malformed consent response' };
  }
  return { kind: 'ok', consent: parsed.data };
}
