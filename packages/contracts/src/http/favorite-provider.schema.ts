import { z } from 'zod';

/**
 * Favorite-provider HTTP DTOs (TS-215; PRD §6.3, §6.4; PDD §14.1).
 *
 * A favourite-provider row is a per-actor bookmark of a provider, with
 * an optional senior association so the family-portal can surface
 * "providers we love for Mom" on the senior profile. The row is
 * deliberately bare — a soft-FK to the provider plus a free-text notes
 * field — because rich denormalised data lives on the provider
 * discovery doc the search backend already projects.
 *
 * Uniqueness is enforced at the DB layer on the tuple
 * `(owner_user_id, provider_id, senior_id)` — the same provider can be
 * favourited once per senior (or once-without-senior) per actor, so a
 * payer who has two parents in the household can independently bookmark
 * the same chef for each. The uniqueness clause treats `senior_id IS
 * NULL` as a distinct value (we use a partial unique index to make this
 * explicit at the schema level since Postgres' default NULLS-DISTINCT
 * semantics already do the right thing on a multi-column unique
 * constraint; the partial index is belt-and-braces).
 *
 * Tenant scoping happens at the service layer: the row's
 * `ownerUserId` MUST match the authenticated actor's `userId` on every
 * read / delete.
 *
 * `.strict()` everywhere — unknown fields are a 400 (CLAUDE.md §3.3).
 */

// ─── Length / count caps ────────────────────────────────────────────────

/** Server-issued id cap (CUID2-shaped). */
export const FAVORITE_PROVIDER_ID_MAX_LENGTH = 64;

/** Soft-FK to a provider row living in service-provider. */
export const FAVORITE_PROVIDER_PROVIDER_ID_MAX_LENGTH = 64;

/** Soft-FK to a senior row living in service-household. */
export const FAVORITE_PROVIDER_SENIOR_ID_MAX_LENGTH = 64;

/** Free-text notes cap. Sized for a sentence or two of context. */
export const FAVORITE_PROVIDER_NOTES_MAX_LENGTH = 500;

/**
 * Per-user cap. Generous enough that a power user can favourite every
 * provider they have ever interacted with, but bounded so a runaway
 * client cannot fill the dashboard with thousands of bookmarks.
 */
export const FAVORITE_PROVIDERS_MAX_PER_OWNER = 500;

// ─── Field schemas ──────────────────────────────────────────────────────

const IdSchema = z.string().min(1).max(FAVORITE_PROVIDER_ID_MAX_LENGTH);
const ProviderIdSchema = z.string().min(1).max(FAVORITE_PROVIDER_PROVIDER_ID_MAX_LENGTH);
const SeniorIdSchema = z.string().min(1).max(FAVORITE_PROVIDER_SENIOR_ID_MAX_LENGTH);
const NotesSchema = z
  .string()
  .min(1, 'notes must be non-empty when supplied; omit the field or send null to clear')
  .max(
    FAVORITE_PROVIDER_NOTES_MAX_LENGTH,
    `notes must be at most ${FAVORITE_PROVIDER_NOTES_MAX_LENGTH} characters`,
  );

// ─── Record / response shapes ───────────────────────────────────────────

/**
 * Full record shape returned by every read endpoint.
 */
export const FavoriteProviderSchema = z
  .object({
    id: IdSchema,
    /** Server-stamped from the authenticated actor's userId. Never client-supplied. */
    ownerUserId: z.string().min(1).max(FAVORITE_PROVIDER_ID_MAX_LENGTH),
    providerId: ProviderIdSchema,
    /** Optional senior association — null when the bookmark is generic. */
    seniorId: SeniorIdSchema.nullable(),
    notes: NotesSchema.nullable(),
    createdAt: z.string().datetime({ offset: true }),
  })
  .strict();
export type FavoriteProvider = z.infer<typeof FavoriteProviderSchema>;

/**
 * `POST /api/v1/favorite-providers` request body. The owner is derived
 * from the authenticated request context; the client only supplies the
 * provider + senior + notes.
 *
 * **Idempotent** — replaying the same `(providerId, seniorId)` tuple
 * returns `{ outcome: 'unchanged', favorite }` without bumping
 * `createdAt`. If the supplied `notes` differ from the stored value,
 * the service treats the call as an update (mirrors the
 * search-ranking-config upsert idiom).
 */
export const CreateFavoriteProviderRequestSchema = z
  .object({
    providerId: ProviderIdSchema,
    seniorId: SeniorIdSchema.nullable().optional(),
    notes: NotesSchema.nullable().optional(),
  })
  .strict();
export type CreateFavoriteProviderRequest = z.infer<typeof CreateFavoriteProviderRequestSchema>;

/**
 * `POST /api/v1/favorite-providers` response. Discriminated by
 * `outcome`:
 *
 *   - `created`   — first bookmark for the tuple.
 *   - `updated`   — bookmark existed; `notes` changed.
 *   - `unchanged` — byte-equal replay; no write performed.
 */
export const CreateFavoriteProviderResponseSchema = z
  .object({
    outcome: z.enum(['created', 'updated', 'unchanged']),
    favorite: FavoriteProviderSchema,
  })
  .strict();
export type CreateFavoriteProviderResponse = z.infer<typeof CreateFavoriteProviderResponseSchema>;

/**
 * `GET /api/v1/favorite-providers` list response. Server-controlled
 * order: descending `createdAt` so the most recently bookmarked
 * providers surface first.
 *
 * Optional query filters are documented on the controller — by senior
 * id (only favourites for the given senior, plus the generic
 * no-senior ones) and by provider id (used by the heart-toggle on the
 * provider-detail page to determine the current bookmark state).
 */
export const FavoriteProvidersListResponseSchema = z
  .object({
    favorites: z.array(FavoriteProviderSchema),
  })
  .strict();
export type FavoriteProvidersListResponse = z.infer<typeof FavoriteProvidersListResponseSchema>;

/**
 * `DELETE /api/v1/favorite-providers/:id` response. Idempotent —
 * replaying after the row is gone returns `not_found` rather than a 404
 * from the gateway so the family-portal can collapse a duplicate-click
 * without surfacing an error toast.
 */
export const DeleteFavoriteProviderResponseSchema = z
  .object({
    outcome: z.enum(['deleted', 'not_found']),
    id: IdSchema,
  })
  .strict();
export type DeleteFavoriteProviderResponse = z.infer<typeof DeleteFavoriteProviderResponseSchema>;
