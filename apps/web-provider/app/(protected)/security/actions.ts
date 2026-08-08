'use server';

import { redirect } from 'next/navigation';

import { beginEnrollment, confirmEnrollment, removeMethod } from '@/lib/mfa-api';

/**
 * MFA enrolment server actions — provider portal (TS-309d-followup-1).
 *
 * Mirrors the family portal's actions with one difference: this portal has no
 * flash-cookie channel, so `removeMethodAction` signals through the query
 * string like the rest of its surfaces (`?action=err&code=…`). That is fine
 * here precisely because removal produces nothing secret.
 *
 * **The enrol/confirm pair still returns state rather than redirecting**, and
 * the reason is the same on both portals: `POST .../totp/confirm` returns the
 * recovery codes exactly once — the server keeps only hashes and
 * `MfaListResponse` has no field for them — so a redirect would destroy the
 * only copy. A query string would then put live account-recovery credentials
 * into browser history, into any proxy log along the way, and into the next
 * navigation's referer. Neither is acceptable for a credential.
 */

const PAGE = '/security';

export type EnrollState =
  | { readonly status: 'idle' }
  | {
      readonly status: 'started';
      readonly methodId: string;
      readonly secretBase32: string;
      readonly otpauthUrl: string;
    }
  | {
      readonly status: 'confirmed';
      /** Shown once, on this render only. Never re-readable. */
      readonly recoveryCodes: readonly string[];
    }
  | { readonly status: 'error'; readonly code: string };

export async function beginEnrollmentAction(
  _previous: EnrollState,
  formData: FormData,
): Promise<EnrollState> {
  const label = readString(formData, 'label');

  const result = await beginEnrollment(label);
  if (result.kind === 'unauthorized') redirect('/login?expired=1');
  if (result.kind === 'conflict') return { status: 'error', code: 'already-enrolled' };
  if (result.kind !== 'ok') return { status: 'error', code: 'unavailable' };

  return {
    status: 'started',
    methodId: result.enrollment.methodId,
    secretBase32: result.enrollment.secretBase32,
    otpauthUrl: result.enrollment.otpauthUrl,
  };
}

export async function confirmEnrollmentAction(
  previous: EnrollState,
  formData: FormData,
): Promise<EnrollState> {
  const methodId = readString(formData, 'methodId');
  const code = readString(formData, 'code');
  if (methodId === '' || code === '') return { status: 'error', code: 'invalid-input' };

  const result = await confirmEnrollment(methodId, code);
  if (result.kind === 'unauthorized') redirect('/login?expired=1');
  if (result.kind === 'invalid_code') {
    // Hand the started state back so a mistyped digit does not discard the
    // secret and force a restart — which here means deleting an authenticator
    // entry and starting over.
    return previous.status === 'started' ? { ...previous } : { status: 'error', code: 'bad-code' };
  }
  if (result.kind !== 'ok') return { status: 'error', code: 'unavailable' };

  return { status: 'confirmed', recoveryCodes: result.confirmation.recoveryCodes };
}

export async function removeMethodAction(formData: FormData): Promise<void> {
  const methodId = readString(formData, 'methodId');
  if (methodId === '') redirect(`${PAGE}?action=err&code=invalid`);

  const result = await removeMethod(methodId);
  if (result.kind === 'unauthorized') redirect('/login?expired=1');
  if (result.kind === 'not_found') redirect(`${PAGE}?action=err&code=not-found`);
  if (result.kind !== 'ok') redirect(`${PAGE}?action=err&code=failed`);

  redirect(`${PAGE}?action=removed`);
}

function readString(formData: FormData, key: string): string {
  const raw = formData.get(key);
  return typeof raw === 'string' ? raw.trim() : '';
}
