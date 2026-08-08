'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';

import { SearchProvidersRequestSchema } from '@taste-and-see/contracts';

import { setFlash } from '@/lib/flash';
import { createSavedSearch } from '@/lib/saved-searches-api';
import {
  deleteFavoriteProvider,
  listFavoriteProviders,
  upsertFavoriteProvider,
} from '@/lib/favorite-providers-api';

/**
 * Server actions exposed on the family-portal `/providers` browse page
 * (TS-215). Two affordances:
 *
 *   1. **Save current search.** The "Save this search" form posts the
 *      current `q` + `tier` + a user-supplied label. The action
 *      reassembles the saved-search query body (mirroring what the
 *      providers page sends to the gateway search proxy) and creates
 *      the row via the saved-searches API client.
 *
 *   2. **Toggle favourite.** The heart button on each provider card
 *      posts the provider id. If the actor has no favourite for the
 *      tuple `(this user, this provider, no senior)`, create one;
 *      otherwise delete the existing row.
 *
 * Both actions revalidate the relevant paths so the heart state and
 * the saved-searches list reflect the change without a hard reload.
 * Failures emit a one-shot flash via {@link setFlash} (TS-215-
 * followup-3) so the protected-layout banner surfaces a hint on the
 * next render.
 *
 * TS-215-followup-3b note: the missing-name redirect target used to
 * carry `?error=missing-name` as a parallel signal so the saved-searches
 * page could render an inline form-error. That dual signal is now
 * dropped — the flash channel is the canonical UX-hint surface, and the
 * URL no longer carries transient form state across the redirect.
 */

/**
 * Save the currently-applied filter set as a named saved search.
 *
 * The /providers page (TS-212) renders a single hidden `<input
 * name="body">` carrying a JSON-stringified `SearchProvidersRequest`
 * derived server-side from the active filter set (every multi-select
 * facet, minRating, and the text query — sans cursor / sans
 * savedSearchId). That gives the user a one-click "save my whole
 * search" affordance without having to mirror every filter as its own
 * hidden input. The body is re-validated against the canonical
 * contract schema before the round-trip; a malformed body falls back
 * to an empty saved-search query body so the user still gets a
 * saved-search row (the page they re-open just lands on the
 * unfiltered grid) and a flash hint surfaces the degraded path.
 */
export async function saveCurrentSearchAction(formData: FormData): Promise<void> {
  const name = formData.get('name');
  if (typeof name !== 'string' || name.trim().length === 0) {
    await setFlash({ kind: 'error', code: 'save_current_search.missing_name' });
    redirect('/saved-searches');
  }
  const trimmedName = name.trim();

  const queryBody = readQueryBody(formData);
  if (queryBody === null) {
    await setFlash({ kind: 'error', code: 'save_current_search.malformed_body' });
    redirect('/saved-searches');
  }

  const result = await createSavedSearch({
    name: trimmedName,
    query: queryBody,
  });
  if (result.kind === 'unauthorized') {
    redirect('/login?expired=1');
  }
  if (result.kind !== 'ok') {
    await setFlash({ kind: 'error', code: 'save_current_search.failed' });
    redirect('/saved-searches');
  }
  await setFlash({ kind: 'success', code: 'save_current_search.ok' });
  revalidatePath('/saved-searches');
  redirect('/saved-searches');
}

function readQueryBody(
  formData: FormData,
): import('@taste-and-see/contracts').SearchProvidersRequest | null {
  const raw = formData.get('body');
  if (typeof raw !== 'string') return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  // The body is server-derived from the page's current FormState so
  // it already round-trips through the canonical contract — but the
  // page boundary is a security boundary, so re-validate.
  const validated = SearchProvidersRequestSchema.safeParse(parsed);
  if (!validated.success) return null;
  return validated.data;
}

export async function toggleFavoriteAction(formData: FormData): Promise<void> {
  const providerId = formData.get('providerId');
  if (typeof providerId !== 'string' || providerId.length === 0) {
    return;
  }

  // Look up the existing no-senior favourite for this actor + provider.
  const lookup = await listFavoriteProviders({ providerId, seniorId: null });
  if (lookup.kind === 'unauthorized') {
    redirect('/login?expired=1');
  }
  if (lookup.kind !== 'ok') {
    // The list failed for a non-auth reason. Don't try to mutate state
    // when we can't read it; surface the failure via the flash channel
    // so the user knows the click didn't disappear silently.
    await setFlash({ kind: 'error', code: 'toggle_favorite.failed' });
    return;
  }

  if (lookup.favorites.length === 0) {
    const upsert = await upsertFavoriteProvider({ providerId });
    if (upsert.kind === 'unauthorized') {
      redirect('/login?expired=1');
    }
    if (upsert.kind !== 'ok') {
      await setFlash({ kind: 'error', code: 'toggle_favorite.failed' });
      return;
    }
  } else {
    // Multiple no-senior matches would be a schema violation (the
    // composite unique prevents it), but defensively delete the first.
    const existing = lookup.favorites[0];
    if (existing !== undefined) {
      const del = await deleteFavoriteProvider(existing.id);
      if (del.kind === 'unauthorized') {
        redirect('/login?expired=1');
      }
      if (del.kind !== 'ok') {
        await setFlash({ kind: 'error', code: 'toggle_favorite.failed' });
        return;
      }
    }
  }

  revalidatePath('/providers');
  revalidatePath('/favorites');
  // The provider-detail page hosts its own heart toggle (TS-215-followup-1)
  // so its cached render needs to invalidate too. Use the layout
  // revalidation so the `[id]` route segment refreshes regardless of
  // the concrete id under it.
  revalidatePath('/providers/[id]', 'page');
}
