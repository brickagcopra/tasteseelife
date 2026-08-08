'use server';

import { randomUUID } from 'node:crypto';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';

import { callGateway } from '@/lib/api';
import { clearImpersonationCookies, readImpersonationFamilyId } from '@/lib/session';

/**
 * End the current impersonation session (TS-297).
 *
 * Reads the family id from the impersonation family cookie (which
 * outlives the 15-minute access token, so "End impersonation" works
 * for the whole session window), revokes the family downstream with
 * the OPERATOR's own credentials, and clears both impersonation
 * cookies. Idempotent end-to-end: the downstream reports
 * `ended: false` on an already-revoked family and we clear the
 * cookies either way — a double-click converges to "not
 * impersonating".
 */
export async function endImpersonationAction(): Promise<void> {
  const familyId = await readImpersonationFamilyId();

  if (familyId !== null) {
    const idempotencyKey = `admin-impersonation-end-${familyId}-${randomUUID()}`;
    const result = await callGateway<unknown>('/api/v1/admin/impersonation/end', {
      method: 'POST',
      body: { sessionFamilyId: familyId },
      headers: { 'idempotency-key': idempotencyKey },
    });
    if (result.kind === 'unauthorized') {
      // The operator's own session lapsed — the impersonation cookies
      // die with their own max-age; send the operator to re-auth.
      await clearImpersonationCookies();
      redirect('/login?expired=1');
    }
    // 404 / 409 / network failures still clear the local cookies: the
    // worst case is a short-capped family expiring on its own, and the
    // operator's intent ("stop impersonating") is honoured locally.
  }

  await clearImpersonationCookies();
  revalidatePath('/', 'layout');
  redirect('/dashboard?impersonation=ended');
}
