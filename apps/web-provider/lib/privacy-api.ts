import {
  CreateDataSubjectRequestSchema,
  DataSubjectRequestListResponseSchema,
  DataSubjectRequestReceiptResponseSchema,
  type CreateDataSubjectRequest,
  type DataSubjectRequestReceipt,
} from '@taste-and-see/contracts';

import { callGateway } from './api';

/**
 * Privacy Center client for the provider portal (TS-309d).
 *
 * Byte-equivalent to the family portal's client — each portal owns its own
 * gateway clients (the `trust-safety-api.ts` precedent), because they are
 * separate deployables with separate cookie names and no shared runtime.
 *
 * Wraps the gateway's requester-facing proxies (TS-309a-followup-1):
 *
 *   POST   /api/v1/privacy/requests                 file a request
 *   GET    /api/v1/privacy/requests                 your requests
 *   GET    /api/v1/privacy/requests/:id             one of them
 *   POST   /api/v1/privacy/requests/:id/withdraw    take it back
 *
 * Those routes carry no permission gate — the gate is being the requester —
 * and someone else's request 404s rather than 403s, because confirming that a
 * request exists is itself a disclosure. Both properties belong to the service
 * and the gateway; this client just has to not paper over them.
 *
 * **`mfa_required` is a first-class result, not a generic client error.** The
 * service refuses to accept a filing from a session it cannot treat as
 * verification (TS-309a), and the page's whole job is to say so honestly
 * BEFORE someone writes out a request. Flattening it into `client_error` would
 * leave the portal guessing.
 */

export type PrivacyRequestResult =
  | { readonly kind: 'ok'; readonly request: DataSubjectRequestReceipt }
  | { readonly kind: 'unauthorized' }
  | { readonly kind: 'mfa_required' }
  | { readonly kind: 'not_found' }
  | { readonly kind: 'conflict' }
  | { readonly kind: 'failure'; readonly detail: string };

export type PrivacyRequestListResult =
  | { readonly kind: 'ok'; readonly requests: readonly DataSubjectRequestReceipt[] }
  | { readonly kind: 'unauthorized' }
  | { readonly kind: 'failure'; readonly detail: string };

export async function listPrivacyRequests(): Promise<PrivacyRequestListResult> {
  const result = await callGateway<unknown>('/api/v1/privacy/requests');
  if (result.kind === 'unauthorized') return { kind: 'unauthorized' };
  if (result.kind !== 'ok') {
    return { kind: 'failure', detail: `gateway responded with ${result.kind}` };
  }

  const parsed = DataSubjectRequestListResponseSchema.safeParse(result.body);
  if (!parsed.success) {
    return { kind: 'failure', detail: 'gateway returned a malformed privacy-request list' };
  }
  return { kind: 'ok', requests: parsed.data.requests };
}

export async function getPrivacyRequest(requestId: string): Promise<PrivacyRequestResult> {
  const result = await callGateway<unknown>(
    `/api/v1/privacy/requests/${encodeURIComponent(requestId)}`,
  );
  return interpret(result);
}

export async function filePrivacyRequest(
  request: CreateDataSubjectRequest,
  idempotencyKey: string,
): Promise<PrivacyRequestResult> {
  // Defence-in-depth: a malformed local body should surface here rather than
  // as a 400 the page has to translate back into plain language.
  const validated = CreateDataSubjectRequestSchema.safeParse(request);
  if (!validated.success) {
    return { kind: 'failure', detail: 'privacy request payload failed local validation' };
  }

  const result = await callGateway<unknown>('/api/v1/privacy/requests', {
    method: 'POST',
    body: validated.data,
    headers: { 'idempotency-key': idempotencyKey },
  });
  return interpret(result);
}

export async function withdrawPrivacyRequest(
  requestId: string,
  idempotencyKey: string,
): Promise<PrivacyRequestResult> {
  const result = await callGateway<unknown>(
    `/api/v1/privacy/requests/${encodeURIComponent(requestId)}/withdraw`,
    { method: 'POST', body: {}, headers: { 'idempotency-key': idempotencyKey } },
  );
  return interpret(result);
}

type GatewayResult = Awaited<ReturnType<typeof callGateway<unknown>>>;

/**
 * One place where a gateway result becomes a portal result.
 *
 * The three client errors that get their own branch are the three the page
 * renders differently: `mfa_required` (we cannot accept this yet, and here is
 * why), 404 (someone else's request, or none — the same answer deliberately),
 * and 409 (already withdrawn or already closed). Everything else is a failure.
 */
function interpret(result: GatewayResult): PrivacyRequestResult {
  if (result.kind === 'unauthorized') return { kind: 'unauthorized' };

  if (result.kind === 'client_error') {
    if (result.status === 403 && isMfaRequired(result.body)) return { kind: 'mfa_required' };
    if (result.status === 404) return { kind: 'not_found' };
    if (result.status === 409) return { kind: 'conflict' };
    return { kind: 'failure', detail: `gateway rejected the request (${result.status})` };
  }

  if (result.kind !== 'ok') {
    return { kind: 'failure', detail: `gateway responded with ${result.kind}` };
  }

  const parsed = DataSubjectRequestReceiptResponseSchema.safeParse(result.body);
  if (!parsed.success) {
    return { kind: 'failure', detail: 'gateway returned a malformed privacy-request response' };
  }
  return { kind: 'ok', request: parsed.data.request };
}

/**
 * The service sets a `code` field on this one Problem Detail precisely so a
 * client can distinguish "verify yourself" from every other 403 — read it
 * rather than matching on prose, which is written for people and will change.
 */
function isMfaRequired(body: unknown): boolean {
  if (typeof body !== 'object' || body === null) return false;
  const code = (body as { readonly code?: unknown }).code;
  return code === 'mfa_required';
}
