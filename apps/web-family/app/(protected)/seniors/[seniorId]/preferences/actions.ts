'use server';

import { randomUUID } from 'node:crypto';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';

import type { BulkUpsertSeniorPreferenceEntry } from '@taste-and-see/contracts';

import { setFlash } from '@/lib/flash';
import { SENIOR_PREFERENCE_KEYS } from '@/lib/senior-preference-fields';
import { bulkUpsertSeniorPreferences, getSeniorPreferences } from '@/lib/seniors-api';

/**
 * Save the senior preference editor (TS-214).
 *
 * `seniorId` is bound at the call site (a route param signed by Next's
 * server-action encoding — not user-tamperable). The action:
 *
 *   1. Re-reads the senior's current preferences (also the row-level
 *      auth gate — a non-member gets 403 here, surfaced as a flash).
 *   2. Diffs the submitted curated fields against the current values:
 *        - a non-empty value that DIFFERS from current  → upsert entry.
 *        - an empty field that currently has a value     → delete entry
 *          (value: null).
 *        - everything else is untouched (merge semantics — the PATCH
 *          never disturbs custom keys outside the curated catalog).
 *   3. Short-circuits with an info flash when nothing changed (avoids a
 *      no-op round-trip and a spurious `updated_at` bump).
 *   4. Otherwise bulk-merge-upserts via the gateway with a fresh
 *      Idempotency-Key.
 *
 * Outcomes funnel through the one-shot flash channel + a redirect back
 * to the editor so the protected-layout banner surfaces the result.
 */
export async function saveSeniorPreferencesAction(
  seniorId: string,
  formData: FormData,
): Promise<void> {
  const editorPath = `/seniors/${encodeURIComponent(seniorId)}/preferences`;

  const current = await getSeniorPreferences(seniorId);
  if (current.kind === 'unauthorized') {
    redirect('/login?expired=1');
  }
  if (current.kind === 'forbidden' || current.kind === 'not_found') {
    await setFlash({ kind: 'error', code: 'senior_preferences.not_found' });
    redirect('/seniors');
  }
  if (current.kind !== 'ok') {
    await setFlash({ kind: 'error', code: 'senior_preferences.load_failed' });
    redirect(editorPath);
  }

  const currentByKey = new Map(current.preferences.map((p) => [p.key, p.value]));

  const entries: BulkUpsertSeniorPreferenceEntry[] = [];
  for (const key of SENIOR_PREFERENCE_KEYS) {
    const raw = formData.get(key);
    const value = typeof raw === 'string' ? raw.trim() : '';
    const existing = currentByKey.get(key);
    if (value.length > 0) {
      if (existing !== value) entries.push({ key, value });
    } else if (existing !== undefined) {
      entries.push({ key, value: null });
    }
  }

  if (entries.length === 0) {
    await setFlash({ kind: 'success', code: 'senior_preferences.unchanged' });
    redirect(editorPath);
  }

  const result = await bulkUpsertSeniorPreferences(seniorId, { entries }, randomUUID());
  if (result.kind === 'unauthorized') {
    redirect('/login?expired=1');
  }
  if (result.kind === 'forbidden' || result.kind === 'not_found') {
    await setFlash({ kind: 'error', code: 'senior_preferences.not_found' });
    redirect('/seniors');
  }
  if (result.kind !== 'ok') {
    await setFlash({ kind: 'error', code: 'senior_preferences.save_failed' });
    redirect(editorPath);
  }

  await setFlash({ kind: 'success', code: 'senior_preferences.saved' });
  revalidatePath(editorPath);
  redirect(editorPath);
}
