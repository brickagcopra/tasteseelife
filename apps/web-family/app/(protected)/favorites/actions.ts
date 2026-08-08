'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';

import { deleteFavoriteProvider, upsertFavoriteProvider } from '@/lib/favorite-providers-api';
import { setFlash } from '@/lib/flash';

/**
 * Server actions for the favourites list page + the "save provider"
 * affordance on the provider directory (TS-215).
 *
 * Both actions read the relevant ids from the submitted form.
 * `revalidatePath` re-renders the favourites list + the providers list
 * so the heart state stays in sync without a hard navigation. Failures
 * emit a one-shot flash via {@link setFlash} (TS-215-followup-3).
 */

export async function addFavoriteAction(formData: FormData): Promise<void> {
  const providerId = formData.get('providerId');
  if (typeof providerId !== 'string' || providerId.length === 0) {
    return;
  }
  const seniorIdRaw = formData.get('seniorId');
  const notesRaw = formData.get('notes');
  const result = await upsertFavoriteProvider({
    providerId,
    ...(typeof seniorIdRaw === 'string' && seniorIdRaw.length > 0 ? { seniorId: seniorIdRaw } : {}),
    ...(typeof notesRaw === 'string' && notesRaw.length > 0 ? { notes: notesRaw } : {}),
  });
  if (result.kind === 'unauthorized') {
    redirect('/login?expired=1');
  }
  if (result.kind !== 'ok') {
    await setFlash({ kind: 'error', code: 'add_favorite.failed' });
  }
  revalidatePath('/favorites');
  revalidatePath('/providers');
}

export async function removeFavoriteAction(formData: FormData): Promise<void> {
  const id = formData.get('id');
  if (typeof id !== 'string' || id.length === 0) {
    return;
  }
  const result = await deleteFavoriteProvider(id);
  if (result.kind === 'unauthorized') {
    redirect('/login?expired=1');
  }
  if (result.kind !== 'ok') {
    await setFlash({ kind: 'error', code: 'remove_favorite.failed' });
  }
  revalidatePath('/favorites');
  revalidatePath('/providers');
}
