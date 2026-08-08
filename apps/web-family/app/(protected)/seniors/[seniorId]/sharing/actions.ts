'use server';

import { randomUUID } from 'node:crypto';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';

import type { SeniorConsentFlags } from '@taste-and-see/contracts';

import { setFlash } from '@/lib/flash';
import { setSeniorConsent } from '@/lib/senior-consent-api';

/**
 * Save the senior sharing-settings editor (TS-238).
 *
 * `seniorId` is bound at the call site (a route param signed by Next's
 * server-action encoding — not user-tamperable). The four checkboxes map
 * to the four consent surfaces; an unchecked checkbox is absent from the
 * FormData, so each surface is `formData.get(surface) === 'on'`. The PUT
 * is a full-replace, which matches the form semantics exactly.
 *
 * Authorisation is enforced downstream: a family observer reaching this
 * action gets a 403 → `forbidden`, surfaced as a flash explaining that
 * only the primary payer or the senior themselves may change sharing.
 *
 * Outcomes funnel through the one-shot flash channel + a redirect back
 * to the editor so the protected-layout banner surfaces the result.
 */
export async function saveSeniorConsentAction(seniorId: string, formData: FormData): Promise<void> {
  const editorPath = `/seniors/${encodeURIComponent(seniorId)}/sharing`;

  const flags: SeniorConsentFlags = {
    photos: formData.get('photos') === 'on',
    notes: formData.get('notes') === 'on',
    location: formData.get('location') === 'on',
    health: formData.get('health') === 'on',
  };

  const result = await setSeniorConsent(seniorId, flags, randomUUID());
  if (result.kind === 'unauthorized') {
    redirect('/login?expired=1');
  }
  if (result.kind === 'forbidden') {
    await setFlash({ kind: 'error', code: 'senior_consent.forbidden' });
    redirect(editorPath);
  }
  if (result.kind === 'not_found') {
    await setFlash({ kind: 'error', code: 'senior_consent.not_found' });
    redirect('/seniors');
  }
  if (result.kind !== 'ok') {
    await setFlash({ kind: 'error', code: 'senior_consent.save_failed' });
    redirect(editorPath);
  }

  await setFlash({ kind: 'success', code: 'senior_consent.saved' });
  revalidatePath(editorPath);
  redirect(editorPath);
}
