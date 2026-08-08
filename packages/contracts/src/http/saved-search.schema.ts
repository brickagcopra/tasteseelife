import { z } from 'zod';

import { SearchProvidersRequestSchema } from './provider-discovery.schema';

/**
 * Saved-search HTTP DTOs (TS-215; PRD §6.3, §6.4; PDD §14.1).
 *
 * A saved search is a named snapshot of a `SearchProvidersRequest` body
 * that the family payer (or another authorised household member) can
 * re-run with one click from the dashboard. The body payload is stored
 * verbatim so a future scoring change does not silently mutate what the
 * user pinned. The query shape is the same one the public search
 * endpoint accepts at `POST /api/v1/search/providers` — the only thing
 * persisted alongside is a human label.
 *
 * Optional `seniorId` association — a saved search is usually scoped to
 * a specific senior in the household ("Italian-speaking chefs near
 * Mom"). The contract allows null so a payer can save a generic search
 * that isn't tied to a particular senior.
 *
 * Tenant scoping happens at the service layer: the row's
 * `ownerUserId` MUST match the authenticated actor's `userId` on every
 * read / update / delete. The Prisma model carries `owner_user_id` as a
 * non-nullable column so a row can never end up unowned.
 *
 * `.strict()` everywhere — unknown fields are a 400 (CLAUDE.md §3.3).
 */

// ─── Length / count caps ────────────────────────────────────────────────

/** Server-issued id cap (CUID2-shaped). */
export const SAVED_SEARCH_ID_MAX_LENGTH = 64;

/** Soft-FK to a senior row living in service-household. */
export const SAVED_SEARCH_SENIOR_ID_MAX_LENGTH = 64;

/** User-given label cap. Sized for a card title, not an essay. */
export const SAVED_SEARCH_NAME_MAX_LENGTH = 120;

/**
 * Per-user cap. The list endpoint returns every row in one shot (no
 * cursor) so a sane upper bound keeps the payload bounded and the
 * dashboard render predictable. Lifted via a follow-up if a family ever
 * legitimately hits the wall.
 */
export const SAVED_SEARCHES_MAX_PER_OWNER = 50;

// ─── Field schemas ──────────────────────────────────────────────────────

const IdSchema = z.string().min(1).max(SAVED_SEARCH_ID_MAX_LENGTH);
const SeniorIdSchema = z.string().min(1).max(SAVED_SEARCH_SENIOR_ID_MAX_LENGTH);
const NameSchema = z
  .string()
  .min(1, 'name is required')
  .max(
    SAVED_SEARCH_NAME_MAX_LENGTH,
    `name must be at most ${SAVED_SEARCH_NAME_MAX_LENGTH} characters`,
  );

/**
 * Stored query body. The schema is the public search request body —
 * the saved-search service re-uses it verbatim so the JSON column
 * round-trips through the contract on both write and read.
 */
const QueryBodySchema = SearchProvidersRequestSchema;

// ─── Record / response shapes ───────────────────────────────────────────

/**
 * Full record shape returned by every read endpoint.
 *
 * `lastRunAt` is null until the family clicks "Run search". The
 * timestamp moves on every rerun so the dashboard can sort by recency.
 */
export const SavedSearchSchema = z
  .object({
    id: IdSchema,
    /** Server-stamped from the authenticated actor's userId. Never client-supplied. */
    ownerUserId: z.string().min(1).max(SAVED_SEARCH_ID_MAX_LENGTH),
    /** Optional senior association — null when the search is generic. */
    seniorId: SeniorIdSchema.nullable(),
    name: NameSchema,
    query: QueryBodySchema,
    lastRunAt: z.string().datetime({ offset: true }).nullable(),
    createdAt: z.string().datetime({ offset: true }),
    updatedAt: z.string().datetime({ offset: true }),
  })
  .strict();
export type SavedSearch = z.infer<typeof SavedSearchSchema>;

/**
 * `POST /api/v1/saved-searches` request body. The owner is derived from
 * the authenticated request context; the client only supplies the
 * editable fields.
 */
export const CreateSavedSearchRequestSchema = z
  .object({
    name: NameSchema,
    seniorId: SeniorIdSchema.nullable().optional(),
    query: QueryBodySchema,
  })
  .strict();
export type CreateSavedSearchRequest = z.infer<typeof CreateSavedSearchRequestSchema>;

/**
 * `PATCH /api/v1/saved-searches/:id` request body. Every editable field
 * is optional; the empty-body case is rejected at the service layer.
 *
 * `seniorId: null` clears the association; absence leaves it untouched.
 */
export const UpdateSavedSearchRequestSchema = z
  .object({
    name: NameSchema.optional(),
    seniorId: SeniorIdSchema.nullable().optional(),
    query: QueryBodySchema.optional(),
  })
  .strict();
export type UpdateSavedSearchRequest = z.infer<typeof UpdateSavedSearchRequestSchema>;

/**
 * `GET /api/v1/saved-searches` list response. Server-controlled order:
 * descending `lastRunAt` (nulls last), then descending `createdAt`, so
 * the most recently used searches surface first on the dashboard.
 */
export const SavedSearchesListResponseSchema = z
  .object({
    savedSearches: z.array(SavedSearchSchema),
  })
  .strict();
export type SavedSearchesListResponse = z.infer<typeof SavedSearchesListResponseSchema>;

/**
 * `POST /api/v1/saved-searches/:id/run` response. The service layer
 * bumps `lastRunAt` to now and echoes the refreshed row so the client
 * can update the list without a second round-trip. The actual search
 * is executed against the existing `POST /api/v1/search/providers`
 * endpoint via the stored `query` payload — the run endpoint just
 * touches the timestamp.
 */
export const RunSavedSearchResponseSchema = z
  .object({
    savedSearch: SavedSearchSchema,
  })
  .strict();
export type RunSavedSearchResponse = z.infer<typeof RunSavedSearchResponseSchema>;

/**
 * `GET /api/v1/saved-searches/:id` response (TS-215-followup-1). Used
 * by the `/providers` page to hydrate its filter form from a stored
 * query body when the family clicks "Run" on a saved search and lands
 * on `/providers?savedSearchId=…`. Row-level ownership is enforced at
 * the service layer; a caller asking for another actor's row gets a
 * 404 (same response shape as "doesn't exist") so the surface cannot
 * be used to probe for foreign row ids.
 */
export const GetSavedSearchResponseSchema = z
  .object({
    savedSearch: SavedSearchSchema,
  })
  .strict();
export type GetSavedSearchResponse = z.infer<typeof GetSavedSearchResponseSchema>;

/**
 * `DELETE /api/v1/saved-searches/:id` response. Idempotent — replaying
 * after the row is gone returns `not_found` rather than a 404 from the
 * gateway so the family-portal can collapse a duplicate-click without
 * surfacing an error toast.
 */
export const DeleteSavedSearchResponseSchema = z
  .object({
    outcome: z.enum(['deleted', 'not_found']),
    id: IdSchema,
  })
  .strict();
export type DeleteSavedSearchResponse = z.infer<typeof DeleteSavedSearchResponseSchema>;
