'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';

import { setFlash } from '@/lib/flash';
import { deleteSavedSearch, runSavedSearch } from '@/lib/saved-searches-api';

/**
 * Server actions for the saved-searches list page (TS-215).
 *
 * Both actions read the row id from the submitted form's `id` field
 * (carried via a hidden input on the per-row form). They forward to the
 * gateway and revalidate the page so the list re-renders without a hard
 * navigation. Failures emit a one-shot flash via {@link setFlash}
 * (TS-215-followup-3).
 *
 * `runSavedSearchAction` follows the rerun with a redirect to
 * `/providers?savedSearchId=…` so the providers page can hydrate its
 * filter form from the saved query body (TS-215-followup-1).
 */

export async function runSavedSearchAction(formData: FormData): Promise<void> {
  const id = formData.get('id');
  if (typeof id !== 'string' || id.length === 0) {
    return;
  }
  const result = await runSavedSearch(id);
  if (result.kind === 'unauthorized') {
    redirect('/login?expired=1');
  }
  if (result.kind !== 'ok') {
    await setFlash({ kind: 'error', code: 'run_saved_search.failed' });
    redirect('/saved-searches');
  }
  revalidatePath('/saved-searches');
  redirect(`/providers?savedSearchId=${encodeURIComponent(id)}`);
}

export async function deleteSavedSearchAction(formData: FormData): Promise<void> {
  const id = formData.get('id');
  if (typeof id !== 'string' || id.length === 0) {
    return;
  }
  const result = await deleteSavedSearch(id);
  if (result.kind === 'unauthorized') {
    redirect('/login?expired=1');
  }
  if (result.kind !== 'ok') {
    await setFlash({ kind: 'error', code: 'delete_saved_search.failed' });
  }
  revalidatePath('/saved-searches');
}
