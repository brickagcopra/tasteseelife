'use server';

import { randomUUID } from 'node:crypto';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';

import type { SeniorAlertPreferencesFlags } from '@taste-and-see/contracts';

import { setFlash } from '@/lib/flash';
import { setSeniorAlertPreferences } from '@/lib/senior-alert-preferences-api';

/**
 * Save the per-senior alert-subscription editor (TS-234).
 *
 * `seniorId` is bound at the call site (a route param signed by Next's
 * server-action encoding — not user-tamperable). The three checkboxes map
 * to the three alert types; an unchecked checkbox is absent from the
 * FormData, so each type is `formData.get(type) === 'on'`. The PUT is a
 * full-replace, which matches the form semantics exactly. The subscription
 * is keyed to the authenticated caller downstream — the action never sends
 * a userId.
 *
 * Authorisation is enforced downstream: a non-member reaching this action
 * gets a 403 → `forbidden`, surfaced as a flash. Outcomes funnel through
 * the one-shot flash channel + a redirect back to the editor so the
 * protected-layout banner surfaces the result.
 */
export async function saveSeniorAlertsAction(seniorId: string, formData: FormData): Promise<void> {
  const editorPath = `/seniors/${encodeURIComponent(seniorId)}/alerts`;

  const flags: SeniorAlertPreferencesFlags = {
    missedVisit: formData.get('missedVisit') === 'on',
    concerningObservation: formData.get('concerningObservation') === 'on',
    emergencyFlag: formData.get('emergencyFlag') === 'on',
  };

  const result = await setSeniorAlertPreferences(seniorId, flags, randomUUID());
  if (result.kind === 'unauthorized') {
    redirect('/login?expired=1');
  }
  if (result.kind === 'not_found') {
    await setFlash({ kind: 'error', code: 'senior_alerts.not_found' });
    redirect('/seniors');
  }
  if (result.kind !== 'ok') {
    // `forbidden` (non-member) and `failure` both fall through to the
    // generic save-failed copy — a non-member shouldn't have reached the
    // editor in the first place, so there's no member-facing distinction
    // worth drawing.
    await setFlash({ kind: 'error', code: 'senior_alerts.save_failed' });
    redirect(editorPath);
  }

  await setFlash({ kind: 'success', code: 'senior_alerts.saved' });
  revalidatePath(editorPath);
  redirect(editorPath);
}
