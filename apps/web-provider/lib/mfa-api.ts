import {
  MfaConfirmResponseSchema,
  MfaEnrollResponseSchema,
  MfaListResponseSchema,
  MfaRemoveResponseSchema,
  type MfaConfirmResponse,
  type MfaEnrollResponse,
  type MfaMethodSummary,
} from '@taste-and-see/contracts';

import { callGateway } from './api';

/**
 * MFA enrolment client for the provider portal (TS-309d-followup-1).
 *
 * Byte-for-byte the family portal's client apart from this note. Deliberately
 * NOT extracted into a shared package yet: the two portals' gateway clients
 * (`lib/api.ts`) are already per-app by design, and a shared package would have
 * to take `callGateway` as an injected dependency to avoid depending on both.
 * Two copies is the rule-of-three's second copy; extract at the third, which is
 * whenever web-admin gains staff enrolment (TS-023-followup-1a).
 *
 * Wraps the gateway proxies this task added:
 *
 *   POST   /api/v1/auth/mfa/totp/enroll     begin
 *   POST   /api/v1/auth/mfa/totp/confirm    finish, receive recovery codes
 *   GET    /api/v1/auth/mfa/methods         what is enrolled
 *   DELETE /api/v1/auth/mfa/methods/:id     remove one
 *
 * **What was broken.** The portal could COMPLETE an MFA challenge at login but
 * could not ENROL a factor, because the gateway proxied `mfa/verify` and
 * nothing else. A customer who never enrolled could not obtain an
 * `mfaVerified` session by any route the product offered — so TS-309a's
 * Privacy Center filing gate was shut to them permanently, and every future
 * step-up-protected action with it.
 *
 * These routes carry no permission gate; being the authenticated user is the
 * authorisation, and the subject comes from the verified token rather than
 * from anything this client sends.
 */

export type MfaEnrollResult =
  | { readonly kind: 'ok'; readonly enrollment: MfaEnrollResponse }
  | { readonly kind: 'unauthorized' }
  /** A confirmed factor already exists; the service refuses a second begin. */
  | { readonly kind: 'conflict' }
  | { readonly kind: 'failure'; readonly detail: string };

export type MfaConfirmResult =
  | { readonly kind: 'ok'; readonly confirmation: MfaConfirmResponse }
  | { readonly kind: 'unauthorized' }
  /**
   * The six-digit code did not match. Its own result rather than a generic
   * failure: it is the ONLY outcome here that the customer can fix by trying
   * again, and telling them to "try again later" instead of "check the code"
   * is how somebody abandons enrolment.
   */
  | { readonly kind: 'invalid_code' }
  | { readonly kind: 'failure'; readonly detail: string };

export type MfaListResult =
  | { readonly kind: 'ok'; readonly methods: readonly MfaMethodSummary[] }
  | { readonly kind: 'unauthorized' }
  | { readonly kind: 'failure' };

export type MfaRemoveResult =
  | { readonly kind: 'ok' }
  | { readonly kind: 'unauthorized' }
  | { readonly kind: 'not_found' }
  | { readonly kind: 'failure'; readonly detail: string };

export async function beginEnrollment(label?: string): Promise<MfaEnrollResult> {
  const result = await callGateway<unknown>('/api/v1/auth/mfa/totp/enroll', {
    method: 'POST',
    body: label !== undefined && label.length > 0 ? { label } : {},
  });
  if (result.kind === 'unauthorized') return { kind: 'unauthorized' };
  if (result.kind === 'ok') {
    const parsed = MfaEnrollResponseSchema.safeParse(result.body);
    return parsed.success
      ? { kind: 'ok', enrollment: parsed.data }
      : { kind: 'failure', detail: 'unreadable-response' };
  }
  if (result.kind === 'client_error' && result.status === 409) return { kind: 'conflict' };
  return { kind: 'failure', detail: 'unavailable' };
}

export async function confirmEnrollment(methodId: string, code: string): Promise<MfaConfirmResult> {
  const result = await callGateway<unknown>('/api/v1/auth/mfa/totp/confirm', {
    method: 'POST',
    body: { methodId, code },
  });
  if (result.kind === 'unauthorized') return { kind: 'unauthorized' };
  if (result.kind === 'ok') {
    const parsed = MfaConfirmResponseSchema.safeParse(result.body);
    // A confirmation whose recovery codes did not survive the hop is NOT a
    // success we can render: they appear exactly once, and a page that shows
    // "you're all set" without them has silently cost the customer their only
    // way back in from a lost device.
    return parsed.success
      ? { kind: 'ok', confirmation: parsed.data }
      : { kind: 'failure', detail: 'unreadable-response' };
  }
  if (result.kind === 'client_error' && (result.status === 400 || result.status === 422)) {
    return { kind: 'invalid_code' };
  }
  return { kind: 'failure', detail: 'unavailable' };
}

export async function listMethods(): Promise<MfaListResult> {
  const result = await callGateway<unknown>('/api/v1/auth/mfa/methods');
  if (result.kind === 'unauthorized') return { kind: 'unauthorized' };
  if (result.kind !== 'ok') return { kind: 'failure' };
  const parsed = MfaListResponseSchema.safeParse(result.body);
  return parsed.success ? { kind: 'ok', methods: parsed.data.methods } : { kind: 'failure' };
}

export async function removeMethod(methodId: string): Promise<MfaRemoveResult> {
  const result = await callGateway<unknown>(
    `/api/v1/auth/mfa/methods/${encodeURIComponent(methodId)}`,
    { method: 'DELETE' },
  );
  if (result.kind === 'unauthorized') return { kind: 'unauthorized' };
  if (result.kind === 'ok') {
    const parsed = MfaRemoveResponseSchema.safeParse(result.body);
    return parsed.success ? { kind: 'ok' } : { kind: 'failure', detail: 'unreadable-response' };
  }
  if (result.kind === 'client_error' && result.status === 404) return { kind: 'not_found' };
  return { kind: 'failure', detail: 'unavailable' };
}

/**
 * Is this method a live second factor?
 *
 * `confirmedAt === null` means enrolment was begun and never finished — a
 * half-enrolled row that protects nothing. Counting it as security is how a
 * settings page tells someone they are covered when they are not.
 */
export function isConfirmed(method: MfaMethodSummary): boolean {
  return method.confirmedAt !== null;
}
