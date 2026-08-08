import {
  CreateSavedSearchRequestSchema,
  DeleteSavedSearchResponseSchema,
  GetSavedSearchResponseSchema,
  RunSavedSearchResponseSchema,
  SavedSearchSchema,
  SavedSearchesListResponseSchema,
  type CreateSavedSearchRequest,
  type DeleteSavedSearchResponse,
  type RunSavedSearchResponse,
  type SavedSearch,
  type SavedSearchesListResponse,
} from '@taste-and-see/contracts';

import { callGateway } from './api';

/**
 * Saved-searches client for the family portal (TS-215).
 *
 * Calls the gateway's `/api/v1/saved-searches` BFF proxies and validates
 * each response at the portal boundary. Returns a typed discriminated
 * union so server components can branch cleanly on
 * `unauthorized` / `failure` / `ok`.
 */

export type SavedSearchesListResult =
  | { readonly kind: 'ok'; readonly savedSearches: readonly SavedSearch[] }
  | { readonly kind: 'unauthorized' }
  | { readonly kind: 'failure'; readonly detail: string };

export type SavedSearchMutationResult<T> =
  | { readonly kind: 'ok'; readonly value: T }
  | { readonly kind: 'unauthorized' }
  | { readonly kind: 'client_error'; readonly status: number; readonly body: unknown }
  | { readonly kind: 'failure'; readonly detail: string };

export type SavedSearchFetchResult =
  | { readonly kind: 'ok'; readonly savedSearch: SavedSearch }
  | { readonly kind: 'unauthorized' }
  | { readonly kind: 'not_found' }
  | { readonly kind: 'failure'; readonly detail: string };

/**
 * Fetch a single saved search by id (TS-215-followup-1).
 *
 * Used by the `/providers` page to hydrate its filter form from a stored
 * query body when the family lands on `/providers?savedSearchId=…`.
 * Returns `not_found` on a 404 from the gateway — covers both "row
 * doesn't exist" and "row belongs to another actor" (same downstream
 * shape).
 */
export async function getSavedSearch(id: string): Promise<SavedSearchFetchResult> {
  const result = await callGateway<unknown>(`/api/v1/saved-searches/${encodeURIComponent(id)}`);
  if (result.kind === 'unauthorized') return { kind: 'unauthorized' };
  if (result.kind === 'client_error' && result.status === 404) {
    return { kind: 'not_found' };
  }
  if (result.kind !== 'ok') {
    return { kind: 'failure', detail: `gateway responded with ${result.kind}` };
  }
  const parsed = GetSavedSearchResponseSchema.safeParse(result.body);
  if (!parsed.success) {
    return { kind: 'failure', detail: 'gateway returned a malformed saved-search response' };
  }
  return { kind: 'ok', savedSearch: parsed.data.savedSearch };
}

export async function listSavedSearches(): Promise<SavedSearchesListResult> {
  const result = await callGateway<unknown>('/api/v1/saved-searches');
  if (result.kind === 'unauthorized') return { kind: 'unauthorized' };
  if (result.kind !== 'ok') {
    return { kind: 'failure', detail: `gateway responded with ${result.kind}` };
  }
  const parsed = parseList(result.body);
  if (parsed === undefined) {
    return { kind: 'failure', detail: 'gateway returned a malformed saved-searches list response' };
  }
  return { kind: 'ok', savedSearches: parsed.savedSearches };
}

export async function createSavedSearch(
  request: CreateSavedSearchRequest,
): Promise<SavedSearchMutationResult<SavedSearch>> {
  // Defence-in-depth: validate before sending so a malformed local body
  // surfaces as a client-side error rather than a 400 from the gateway.
  const validated = CreateSavedSearchRequestSchema.safeParse(request);
  if (!validated.success) {
    return { kind: 'failure', detail: 'createSavedSearch payload failed local validation' };
  }
  const result = await callGateway<unknown>('/api/v1/saved-searches', {
    method: 'POST',
    body: validated.data,
  });
  if (result.kind === 'unauthorized') return { kind: 'unauthorized' };
  if (result.kind === 'client_error') {
    return { kind: 'client_error', status: result.status, body: result.body };
  }
  if (result.kind !== 'ok') {
    return { kind: 'failure', detail: `gateway responded with ${result.kind}` };
  }
  const parsed = SavedSearchSchema.safeParse(result.body);
  if (!parsed.success) {
    return { kind: 'failure', detail: 'gateway returned a malformed saved-search create response' };
  }
  return { kind: 'ok', value: parsed.data };
}

export async function runSavedSearch(
  id: string,
): Promise<SavedSearchMutationResult<RunSavedSearchResponse>> {
  const result = await callGateway<unknown>(
    `/api/v1/saved-searches/${encodeURIComponent(id)}/run`,
    { method: 'POST' },
  );
  if (result.kind === 'unauthorized') return { kind: 'unauthorized' };
  if (result.kind === 'client_error') {
    return { kind: 'client_error', status: result.status, body: result.body };
  }
  if (result.kind !== 'ok') {
    return { kind: 'failure', detail: `gateway responded with ${result.kind}` };
  }
  const parsed = RunSavedSearchResponseSchema.safeParse(result.body);
  if (!parsed.success) {
    return { kind: 'failure', detail: 'gateway returned a malformed run response' };
  }
  return { kind: 'ok', value: parsed.data };
}

export async function deleteSavedSearch(
  id: string,
): Promise<SavedSearchMutationResult<DeleteSavedSearchResponse>> {
  const result = await callGateway<unknown>(`/api/v1/saved-searches/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  });
  if (result.kind === 'unauthorized') return { kind: 'unauthorized' };
  if (result.kind === 'client_error') {
    return { kind: 'client_error', status: result.status, body: result.body };
  }
  if (result.kind !== 'ok') {
    return { kind: 'failure', detail: `gateway responded with ${result.kind}` };
  }
  const parsed = DeleteSavedSearchResponseSchema.safeParse(result.body);
  if (!parsed.success) {
    return { kind: 'failure', detail: 'gateway returned a malformed delete response' };
  }
  return { kind: 'ok', value: parsed.data };
}

function parseList(body: unknown): SavedSearchesListResponse | undefined {
  const parsed = SavedSearchesListResponseSchema.safeParse(body);
  return parsed.success ? parsed.data : undefined;
}
