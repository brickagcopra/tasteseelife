import {
  CreateFavoriteProviderRequestSchema,
  CreateFavoriteProviderResponseSchema,
  DeleteFavoriteProviderResponseSchema,
  FavoriteProvidersListResponseSchema,
  type CreateFavoriteProviderRequest,
  type CreateFavoriteProviderResponse,
  type DeleteFavoriteProviderResponse,
  type FavoriteProvider,
  type FavoriteProvidersListResponse,
} from '@taste-and-see/contracts';

import { callGateway } from './api';

/**
 * Favourite-providers client for the family portal (TS-215).
 *
 * Calls the gateway's `/api/v1/favorite-providers` BFF proxies and
 * validates each response at the portal boundary.
 */

export type FavoritesListResult =
  | { readonly kind: 'ok'; readonly favorites: readonly FavoriteProvider[] }
  | { readonly kind: 'unauthorized' }
  | { readonly kind: 'failure'; readonly detail: string };

export type FavoriteMutationResult<T> =
  | { readonly kind: 'ok'; readonly value: T }
  | { readonly kind: 'unauthorized' }
  | { readonly kind: 'client_error'; readonly status: number; readonly body: unknown }
  | { readonly kind: 'failure'; readonly detail: string };

export interface ListFavoritesQuery {
  readonly providerId?: string;
  readonly seniorId?: string | null;
}

export async function listFavoriteProviders(
  query: ListFavoritesQuery = {},
): Promise<FavoritesListResult> {
  const params = new URLSearchParams();
  if (typeof query.providerId === 'string' && query.providerId.length > 0) {
    params.set('providerId', query.providerId);
  }
  if (query.seniorId === null) {
    params.set('seniorId', 'null');
  } else if (typeof query.seniorId === 'string' && query.seniorId.length > 0) {
    params.set('seniorId', query.seniorId);
  }
  const qs = params.toString();
  const path = qs.length > 0 ? `/api/v1/favorite-providers?${qs}` : '/api/v1/favorite-providers';

  const result = await callGateway<unknown>(path);
  if (result.kind === 'unauthorized') return { kind: 'unauthorized' };
  if (result.kind !== 'ok') {
    return { kind: 'failure', detail: `gateway responded with ${result.kind}` };
  }
  const parsed = parseList(result.body);
  if (parsed === undefined) {
    return { kind: 'failure', detail: 'gateway returned a malformed favorites list response' };
  }
  return { kind: 'ok', favorites: parsed.favorites };
}

export async function upsertFavoriteProvider(
  request: CreateFavoriteProviderRequest,
): Promise<FavoriteMutationResult<CreateFavoriteProviderResponse>> {
  const validated = CreateFavoriteProviderRequestSchema.safeParse(request);
  if (!validated.success) {
    return { kind: 'failure', detail: 'upsertFavoriteProvider payload failed local validation' };
  }
  const result = await callGateway<unknown>('/api/v1/favorite-providers', {
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
  const parsed = CreateFavoriteProviderResponseSchema.safeParse(result.body);
  if (!parsed.success) {
    return { kind: 'failure', detail: 'gateway returned a malformed upsert response' };
  }
  return { kind: 'ok', value: parsed.data };
}

export async function deleteFavoriteProvider(
  id: string,
): Promise<FavoriteMutationResult<DeleteFavoriteProviderResponse>> {
  const result = await callGateway<unknown>(
    `/api/v1/favorite-providers/${encodeURIComponent(id)}`,
    { method: 'DELETE' },
  );
  if (result.kind === 'unauthorized') return { kind: 'unauthorized' };
  if (result.kind === 'client_error') {
    return { kind: 'client_error', status: result.status, body: result.body };
  }
  if (result.kind !== 'ok') {
    return { kind: 'failure', detail: `gateway responded with ${result.kind}` };
  }
  const parsed = DeleteFavoriteProviderResponseSchema.safeParse(result.body);
  if (!parsed.success) {
    return { kind: 'failure', detail: 'gateway returned a malformed delete response' };
  }
  return { kind: 'ok', value: parsed.data };
}

function parseList(body: unknown): FavoriteProvidersListResponse | undefined {
  const parsed = FavoriteProvidersListResponseSchema.safeParse(body);
  return parsed.success ? parsed.data : undefined;
}
