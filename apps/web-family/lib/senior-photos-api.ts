import {
  FamilySeniorPhotoGalleryResponseSchema,
  type FamilySeniorPhotoGalleryResponse,
} from '@taste-and-see/contracts';

import { callGateway } from './api';

/**
 * Consent-gated senior photo-gallery client for the family portal
 * (TS-232).
 *
 * Calls the gateway BFF aggregator
 * (`GET /api/v1/seniors/:seniorId/photos`) and validates the response at
 * the portal boundary. The gateway applies the senior's `photos` consent
 * flag (TS-238) — the response's `shared` flag tells the page whether the
 * caller may see photos (manager / senior, or an observer the senior
 * shared with). A `shared: false` response carries an empty gallery — the
 * default-opt-out empty state, not an error.
 *
 * Returns a typed discriminated union so the server component can branch
 * on `unauthorized` / `forbidden` / `not_found` (the membership gate from
 * the underlying consent read) / `unavailable` / `ok`.
 */

export type SeniorPhotosResult =
  | { readonly kind: 'ok'; readonly gallery: FamilySeniorPhotoGalleryResponse }
  | { readonly kind: 'unauthorized' }
  | { readonly kind: 'forbidden' }
  | { readonly kind: 'not_found' }
  | { readonly kind: 'unavailable'; readonly detail: string };

export async function getSeniorPhotos(
  seniorId: string,
  cursor?: string,
): Promise<SeniorPhotosResult> {
  const search = new URLSearchParams();
  if (cursor !== undefined && cursor.length > 0) {
    search.set('cursor', cursor);
  }
  const qs = search.toString();
  const path = `/api/v1/seniors/${encodeURIComponent(seniorId)}/photos${qs.length > 0 ? `?${qs}` : ''}`;

  const result = await callGateway<unknown>(path);
  if (result.kind === 'unauthorized') return { kind: 'unauthorized' };
  if (result.kind === 'client_error') {
    if (result.status === 403) return { kind: 'forbidden' };
    if (result.status === 404) return { kind: 'not_found' };
    return { kind: 'unavailable', detail: `gateway responded with client error ${result.status}` };
  }
  if (result.kind !== 'ok') {
    return { kind: 'unavailable', detail: `gateway responded with ${result.kind}` };
  }
  const parsed = FamilySeniorPhotoGalleryResponseSchema.safeParse(result.body);
  if (!parsed.success) {
    return { kind: 'unavailable', detail: 'gateway returned a malformed photo-gallery response' };
  }
  return { kind: 'ok', gallery: parsed.data };
}
