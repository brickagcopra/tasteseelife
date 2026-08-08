import {
  PROVIDER_DISCOVERY_CURSOR_MAX_LENGTH,
  PROVIDER_DISCOVERY_FILTER_VALUES_MAX,
  PROVIDER_DISCOVERY_QUERY_MAX_LENGTH,
  PROVIDER_DISCOVERY_RATING_MAX,
  PROVIDER_DISCOVERY_RATING_MIN,
  PROVIDER_DISCOVERY_TAG_MAX_LENGTH,
  ProviderDiscoveryTierSchema,
  type ProviderDiscoveryTier,
  type SearchProvidersRequest,
} from '@taste-and-see/contracts';

/**
 * URL ↔ `SearchProvidersRequest` serialization for the family-portal
 * `/providers` browse surface (TS-212).
 *
 * The page is a server component. Filters live in the URL so the page
 * is shareable and idempotent under refresh / browser-back. This
 * module is the single place where URL params turn into a gateway
 * request body + a render-side `FormState` (so default-checked
 * checkboxes and default-value inputs reflect the active filters).
 *
 * **Multi-value filters** ride on repeated URL keys — a multi-checkbox
 * `<input name="lang">` group natively serialises to
 * `?lang=en&lang=es`. Single-value and multi-value both parse.
 *
 * **Defensive bounds**. Every filter list is capped at
 * `PROVIDER_DISCOVERY_FILTER_VALUES_MAX` (16); over-cap entries are
 * dropped silently so URL tampering degrades gracefully rather than
 * returning a 400. Tag-shape values that don't pass the contract's
 * `^[a-z0-9][a-z0-9._-]*$` pattern are dropped (defence against
 * fragment / hash bleed). `minRating` is clamped to [0, 5]; non-finite
 * values drop. `query` is trimmed and truncated to the contract cap.
 *
 * **Filter / cursor coupling**. Cursors are opaque page tokens whose
 * meaning is tied to the filter set that produced them. Helpers
 * `withCursor` / `withoutCursor` make the "filter changed → reset
 * cursor" invariant explicit at every call site that builds a Next
 * page URL.
 */

const FILTER_TAG_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;
const VALID_TIERS = ProviderDiscoveryTierSchema.options;

export interface ProviderSearchFormState {
  readonly query: string;
  readonly tiers: readonly ProviderDiscoveryTier[];
  readonly languages: readonly string[];
  readonly specialties: readonly string[];
  readonly cuisines: readonly string[];
  readonly dietaryExpertise: readonly string[];
  readonly certifications: readonly string[];
  readonly minRating: number | null;
  readonly cursor: string | null;
  readonly savedSearchId: string | null;
}

export interface ParsedSearchInput {
  readonly request: SearchProvidersRequest;
  readonly formState: ProviderSearchFormState;
}

export type SearchParamRecord = Readonly<Record<string, string | string[] | undefined>>;

export const EMPTY_FORM_STATE: ProviderSearchFormState = {
  query: '',
  tiers: [],
  languages: [],
  specialties: [],
  cuisines: [],
  dietaryExpertise: [],
  certifications: [],
  minRating: null,
  cursor: null,
  savedSearchId: null,
};

export function parseProviderSearchParams(params: SearchParamRecord): ParsedSearchInput {
  const rawQuery = readScalarString(params, 'q');
  const cursor = readScalarString(params, 'cursor');
  const savedSearchId = readScalarString(params, 'savedSearchId');

  const tiers = clampList(
    readList(params, 'tier').filter((v): v is ProviderDiscoveryTier =>
      (VALID_TIERS as readonly string[]).includes(v),
    ),
  );
  const languages = sanitizeTagList(readList(params, 'lang'));
  const specialties = sanitizeTagList(readList(params, 'specialty'));
  const cuisines = sanitizeTagList(readList(params, 'cuisine'));
  const dietaryExpertise = sanitizeTagList(readList(params, 'diet'));
  const certifications = sanitizeTagList(readList(params, 'cert'));
  const minRating = readMinRating(params);

  const query =
    rawQuery !== null ? rawQuery.slice(0, PROVIDER_DISCOVERY_QUERY_MAX_LENGTH).trim() : '';
  const safeCursor =
    cursor !== null && cursor.length > 0 && cursor.length <= PROVIDER_DISCOVERY_CURSOR_MAX_LENGTH
      ? cursor
      : null;

  const formState: ProviderSearchFormState = {
    query,
    tiers,
    languages,
    specialties,
    cuisines,
    dietaryExpertise,
    certifications,
    minRating,
    cursor: safeCursor,
    savedSearchId,
  };

  return { request: formStateToRequest(formState), formState };
}

export function formStateToRequest(state: ProviderSearchFormState): SearchProvidersRequest {
  const request: Record<string, unknown> = {};
  if (state.query.length > 0) request['query'] = state.query;

  const filters: Record<string, unknown> = {};
  if (state.tiers.length > 0) filters['tiers'] = [...state.tiers];
  if (state.languages.length > 0) filters['languages'] = [...state.languages];
  if (state.specialties.length > 0) filters['specialties'] = [...state.specialties];
  if (state.cuisines.length > 0) filters['cuisines'] = [...state.cuisines];
  if (state.dietaryExpertise.length > 0) filters['dietaryExpertise'] = [...state.dietaryExpertise];
  if (state.certifications.length > 0) filters['certifications'] = [...state.certifications];
  if (state.minRating !== null) filters['minRating'] = state.minRating;
  if (Object.keys(filters).length > 0) request['filters'] = filters;

  if (state.cursor !== null) request['cursor'] = state.cursor;

  return request as SearchProvidersRequest;
}

export function buildProviderSearchUrl(basePath: string, next: ProviderSearchFormState): string {
  const sp = new URLSearchParams();
  if (next.query.length > 0) sp.set('q', next.query);
  for (const t of next.tiers) sp.append('tier', t);
  for (const v of next.languages) sp.append('lang', v);
  for (const v of next.specialties) sp.append('specialty', v);
  for (const v of next.cuisines) sp.append('cuisine', v);
  for (const v of next.dietaryExpertise) sp.append('diet', v);
  for (const v of next.certifications) sp.append('cert', v);
  if (next.minRating !== null) sp.set('minRating', formatMinRating(next.minRating));
  if (next.cursor !== null) sp.set('cursor', next.cursor);
  if (next.savedSearchId !== null) sp.set('savedSearchId', next.savedSearchId);
  const qs = sp.toString();
  return qs.length > 0 ? `${basePath}?${qs}` : basePath;
}

/**
 * Re-derive a `FormState` from a stored saved-search query body
 * (TS-215). The body is itself a `SearchProvidersRequest`; we drop
 * cursor / sort / limit / geo and lift the editable filter surface so
 * the page's filter form can render the saved selection.
 */
export function requestToFormState(
  request: SearchProvidersRequest,
  savedSearchId: string | null = null,
): ProviderSearchFormState {
  const filters = request.filters;
  return {
    query: typeof request.query === 'string' ? request.query : '',
    tiers: clampList((filters?.tiers ?? []) as readonly ProviderDiscoveryTier[]),
    languages: sanitizeTagList(filters?.languages ?? []),
    specialties: sanitizeTagList(filters?.specialties ?? []),
    cuisines: sanitizeTagList(filters?.cuisines ?? []),
    dietaryExpertise: sanitizeTagList(filters?.dietaryExpertise ?? []),
    certifications: sanitizeTagList(filters?.certifications ?? []),
    minRating: typeof filters?.minRating === 'number' ? filters.minRating : null,
    cursor: null,
    savedSearchId,
  };
}

export function withCursor(
  state: ProviderSearchFormState,
  cursor: string,
): ProviderSearchFormState {
  return { ...state, cursor };
}

export function withoutCursor(state: ProviderSearchFormState): ProviderSearchFormState {
  return { ...state, cursor: null };
}

export function hasAnyFilter(state: ProviderSearchFormState): boolean {
  return (
    state.query.length > 0 ||
    state.tiers.length > 0 ||
    state.languages.length > 0 ||
    state.specialties.length > 0 ||
    state.cuisines.length > 0 ||
    state.dietaryExpertise.length > 0 ||
    state.certifications.length > 0 ||
    state.minRating !== null
  );
}

function readScalarString(params: SearchParamRecord, key: string): string | null {
  const v = params[key];
  if (typeof v === 'string' && v.length > 0) return v;
  if (Array.isArray(v)) {
    const first = v.find((s): s is string => typeof s === 'string' && s.length > 0);
    return first ?? null;
  }
  return null;
}

function readList(params: SearchParamRecord, key: string): string[] {
  const v = params[key];
  if (v === undefined) return [];
  if (typeof v === 'string') return v.length > 0 ? [v] : [];
  if (Array.isArray(v)) {
    return v.filter((s): s is string => typeof s === 'string' && s.length > 0);
  }
  return [];
}

function clampList<T extends string>(list: readonly T[]): readonly T[] {
  const seen = new Set<T>();
  const result: T[] = [];
  for (const v of list) {
    if (seen.has(v)) continue;
    seen.add(v);
    result.push(v);
    if (result.length >= PROVIDER_DISCOVERY_FILTER_VALUES_MAX) break;
  }
  return result;
}

function sanitizeTagList(list: readonly string[]): readonly string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const raw of list) {
    const trimmed = raw.toLowerCase();
    if (trimmed.length === 0 || trimmed.length > PROVIDER_DISCOVERY_TAG_MAX_LENGTH) continue;
    if (!FILTER_TAG_PATTERN.test(trimmed)) continue;
    if (seen.has(trimmed)) continue;
    seen.add(trimmed);
    result.push(trimmed);
    if (result.length >= PROVIDER_DISCOVERY_FILTER_VALUES_MAX) break;
  }
  return result;
}

function readMinRating(params: SearchParamRecord): number | null {
  const v = readScalarString(params, 'minRating');
  if (v === null) return null;
  const n = Number.parseFloat(v);
  if (!Number.isFinite(n)) return null;
  if (n < PROVIDER_DISCOVERY_RATING_MIN) return null;
  if (n > PROVIDER_DISCOVERY_RATING_MAX) return PROVIDER_DISCOVERY_RATING_MAX;
  return Math.round(n * 10) / 10;
}

function formatMinRating(value: number): string {
  if (Number.isInteger(value)) return String(value);
  return value.toFixed(1);
}
