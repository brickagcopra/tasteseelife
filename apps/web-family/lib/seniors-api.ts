import {
  BulkUpsertSeniorPreferencesRequestSchema,
  MySeniorsResponseSchema,
  SeniorPreferencesResponseSchema,
  type BulkUpsertSeniorPreferencesRequest,
  type MySeniorSummary,
  type SeniorPreferenceEntry,
} from '@taste-and-see/contracts';

import { callGateway } from './api';

/**
 * Seniors + senior-preferences client for the family portal (TS-214).
 *
 * Calls the gateway BFF proxies (`/api/v1/me/seniors` and
 * `/api/v1/seniors/:seniorId/preferences`) and validates each response
 * at the portal boundary. Returns typed discriminated unions so server
 * components / actions can branch cleanly on
 * `unauthorized` / `forbidden` / `not_found` / `failure` / `ok`.
 */

export type MySeniorsResult =
  | { readonly kind: 'ok'; readonly seniors: readonly MySeniorSummary[] }
  | { readonly kind: 'unauthorized' }
  | { readonly kind: 'failure'; readonly detail: string };

export type SeniorPreferencesResult =
  | {
      readonly kind: 'ok';
      readonly seniorId: string;
      readonly preferences: readonly SeniorPreferenceEntry[];
    }
  | { readonly kind: 'unauthorized' }
  | { readonly kind: 'forbidden' }
  | { readonly kind: 'not_found' }
  | { readonly kind: 'failure'; readonly detail: string };

export type SeniorPreferencesMutationResult =
  | {
      readonly kind: 'ok';
      readonly seniorId: string;
      readonly preferences: readonly SeniorPreferenceEntry[];
    }
  | { readonly kind: 'unauthorized' }
  | { readonly kind: 'forbidden' }
  | { readonly kind: 'not_found' }
  | { readonly kind: 'client_error'; readonly status: number; readonly body: unknown }
  | { readonly kind: 'failure'; readonly detail: string };

export async function listMySeniors(): Promise<MySeniorsResult> {
  const result = await callGateway<unknown>('/api/v1/me/seniors');
  if (result.kind === 'unauthorized') return { kind: 'unauthorized' };
  if (result.kind !== 'ok') {
    return { kind: 'failure', detail: `gateway responded with ${result.kind}` };
  }
  const parsed = MySeniorsResponseSchema.safeParse(result.body);
  if (!parsed.success) {
    return { kind: 'failure', detail: 'gateway returned a malformed my-seniors response' };
  }
  return { kind: 'ok', seniors: parsed.data.seniors };
}

export async function getSeniorPreferences(seniorId: string): Promise<SeniorPreferencesResult> {
  const result = await callGateway<unknown>(
    `/api/v1/seniors/${encodeURIComponent(seniorId)}/preferences`,
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
  const parsed = SeniorPreferencesResponseSchema.safeParse(result.body);
  if (!parsed.success) {
    return { kind: 'failure', detail: 'gateway returned a malformed preferences response' };
  }
  return { kind: 'ok', seniorId: parsed.data.seniorId, preferences: parsed.data.preferences };
}

export async function bulkUpsertSeniorPreferences(
  seniorId: string,
  request: BulkUpsertSeniorPreferencesRequest,
  idempotencyKey: string,
): Promise<SeniorPreferencesMutationResult> {
  // Defence-in-depth: validate before sending so a malformed local body
  // surfaces as a client-side failure rather than a 400 from the gateway.
  const validated = BulkUpsertSeniorPreferencesRequestSchema.safeParse(request);
  if (!validated.success) {
    return { kind: 'failure', detail: 'preferences payload failed local validation' };
  }
  const result = await callGateway<unknown>(
    `/api/v1/seniors/${encodeURIComponent(seniorId)}/preferences`,
    {
      method: 'PATCH',
      body: validated.data,
      headers: { 'idempotency-key': idempotencyKey },
    },
  );
  if (result.kind === 'unauthorized') return { kind: 'unauthorized' };
  if (result.kind === 'client_error') {
    if (result.status === 403) return { kind: 'forbidden' };
    if (result.status === 404) return { kind: 'not_found' };
    return { kind: 'client_error', status: result.status, body: result.body };
  }
  if (result.kind !== 'ok') {
    return { kind: 'failure', detail: `gateway responded with ${result.kind}` };
  }
  const parsed = SeniorPreferencesResponseSchema.safeParse(result.body);
  if (!parsed.success) {
    return { kind: 'failure', detail: 'gateway returned a malformed preferences response' };
  }
  return { kind: 'ok', seniorId: parsed.data.seniorId, preferences: parsed.data.preferences };
}
