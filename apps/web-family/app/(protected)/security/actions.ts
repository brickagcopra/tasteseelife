'use server';

import { redirect } from 'next/navigation';

import { setFlash } from '@/lib/flash';
import { beginEnrollment, confirmEnrollment, removeMethod } from '@/lib/mfa-api';

/**
 * MFA enrolment server actions (TS-309d-followup-1).
 *
 * **The one-shot problem shapes all three.** `POST .../totp/confirm` returns
 * the customer's ten recovery codes exactly once — the server keeps only
 * hashes, and `MfaListResponse` has no field for them. So the codes cannot be
 * fetched by the page on a later render, and a redirect that dropped them
 * would destroy the only copy.
 *
 * They are therefore returned to the page **in the action's return value**,
 * not through the flash cookie and not through the query string. A cookie is
 * written to disk and travels on every subsequent request; a query string
 * lands in browser history, in any proxy log along the way, and in the
 * referer of the next navigation. Neither is a place to put a set of live
 * account-recovery credentials.
 *
 * That is why enrol/confirm return state instead of redirecting, while
 * `removeMethodAction` — which produces nothing secret — redirects with a
 * flash like every other action in this portal.
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
    // Hand the started-enrolment state BACK so a mistyped digit does not throw
    // away the secret and force the customer to start over — which, on a page
    // where starting over means deleting an authenticator entry, is a good way
    // to lose someone entirely.
    return previous.status === 'started' ? { ...previous } : { status: 'error', code: 'bad-code' };
  }
  if (result.kind !== 'ok') return { status: 'error', code: 'unavailable' };

  return { status: 'confirmed', recoveryCodes: result.confirmation.recoveryCodes };
}

export async function removeMethodAction(formData: FormData): Promise<void> {
  const methodId = readString(formData, 'methodId');
  if (methodId === '') {
    await setFlash({ kind: 'error', code: 'mfa.invalid' });
    redirect(PAGE);
  }

  const result = await removeMethod(methodId);
  if (result.kind === 'unauthorized') redirect('/login?expired=1');
  if (result.kind === 'not_found') {
    await setFlash({ kind: 'error', code: 'mfa.not_found' });
    redirect(PAGE);
  }
  if (result.kind !== 'ok') {
    await setFlash({ kind: 'error', code: 'mfa.failed' });
    redirect(PAGE);
  }

  await setFlash({ kind: 'success', code: 'mfa.removed' });
  redirect(PAGE);
}

function readString(formData: FormData, key: string): string {
  const raw = formData.get(key);
  return typeof raw === 'string' ? raw.trim() : '';
}
