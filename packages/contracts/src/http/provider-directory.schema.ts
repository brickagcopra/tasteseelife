import { z } from 'zod';

import { ProviderStatusSchema, ProviderTierSchema } from './provider-application.schema';

/**
 * Admin provider directory (TS-305c-followup-1; PRD §10.14, PDD §16.1).
 *
 * Response and query shapes for `GET /api/v1/admin/providers` — the
 * list an operator uses to FIND a provider, which until now had no
 * surface anywhere on the platform.
 *
 * **Why this exists.** The Provider 360 (TS-305c) is reachable only
 * from an incident that already carries a `provider_id`. A committee
 * convened about a provider by name had no way in, and neither did
 * anyone opening a routine tier review — the common case, and the one
 * with no incident to enter from. Every other provider read is either
 * self-scoped (`/providers/me/...`), keyed on an id the caller must
 * already hold (`/providers/{id}/profile`, the dossier), or
 * family-facing and active-only (the discovery snapshot that feeds
 * service-search). None of them answers "which providers are there".
 *
 * **Offset pagination, not a cursor.** CLAUDE.md §5.1 reserves cursors
 * for activity feeds and bookings and allows offset for stable admin
 * tables; a provider directory ordered by display name is exactly that
 * table. The trade is deliberate: an operator scanning a directory
 * wants to jump and wants a `total` ("187 providers match"), and a
 * keyset cursor gives neither. Rows do shift under an offset when a
 * provider is created mid-scan, which for a directory read is a
 * cosmetic reorder, not a correctness problem — unlike a booking feed,
 * where a skipped row is a missed visit.
 */

// ─────────────────────────────────────────────────────────────────────
// Bounds
// ─────────────────────────────────────────────────────────────────────

export const PROVIDER_DIRECTORY_LIMIT_DEFAULT = 25;
export const PROVIDER_DIRECTORY_LIMIT_MAX = 100;
/**
 * Hard ceiling on `offset`. Not a page count — a bound on how far a
 * hand-typed query string can push the database into a deep-offset
 * scan. Nobody pages to row 10,000 of a directory; a request that
 * claims to is either a typo or a probe.
 */
export const PROVIDER_DIRECTORY_OFFSET_MAX = 10_000;
/** Bound on the free-text name filter, so a pathological `q` can't reach the scan. */
export const PROVIDER_DIRECTORY_SEARCH_MAX_LENGTH = 64;

// ─────────────────────────────────────────────────────────────────────
// Row
// ─────────────────────────────────────────────────────────────────────

/**
 * A directory row.
 *
 * **Carries no `bio` and no media keys.** The bio is a provider's own
 * prose about themselves and the photo/video keys are handles into
 * media storage; neither helps anyone pick a row out of a list, and a
 * list read lands in a browser cache, an RSC payload, and any error
 * report that captures a response body. Same split the incident queue
 * takes against `description` (TS-303c2d). The 360 is one click away
 * and carries the full record.
 *
 * `headline` IS here — it is the one-line public self-description, and
 * it is frequently the only thing that distinguishes two providers
 * with similar names.
 *
 * `userId` is the soft FK into `identity.users.id`, carried so the
 * console can cross-link to the user detail page. Admin-only; it never
 * appears on the public profile shape.
 *
 * `deletedAt` non-null means archived. A row is only ever returned
 * archived when the caller asked for archived rows — see the query
 * schema — but the field is always present so the console can badge it
 * rather than inferring archived-ness from the absence of a filter it
 * did not set.
 */
export const ProviderDirectoryRowSchema = z
  .object({
    id: z.string().min(1).max(64),
    userId: z.string().min(1).max(64),
    status: ProviderStatusSchema,
    tier: ProviderTierSchema,
    displayName: z.string().min(1),
    headline: z.string().nullable(),
    timeZone: z.string().min(1),
    dementiaSensitive: z.boolean(),
    createdAt: z.string().datetime(),
    deletedAt: z.string().datetime().nullable(),
  })
  .strict();
export type ProviderDirectoryRow = z.infer<typeof ProviderDirectoryRowSchema>;

// ─────────────────────────────────────────────────────────────────────
// Query
// ─────────────────────────────────────────────────────────────────────

/**
 * `GET /api/v1/admin/providers` query.
 *
 * `q` is a case-insensitive substring match on `display_name`. Not a
 * prefix match: operators search by surname at least as often as by
 * first name, and a prefix-only directory silently returns nothing for
 * the more common half of those searches — worse than a slower scan,
 * because an empty result reads as "no such provider".
 *
 * **`includeArchived` defaults to FALSE, unlike the dossier.** The
 * dossier serves an archived provider unconditionally, because a
 * caller who supplied that id is asking about that specific person.
 * A directory is a working set: defaulting to include every provider
 * ever archived makes the list an operator scans daily longer and
 * noisier for a case that comes up rarely. But it must be reachable —
 * a committee convened about someone archived last month has to be
 * able to find them — so it is an explicit opt-in rather than an
 * omission. Archived rows are always badged, never silently mixed in.
 *
 * `status` and `tier` are exact-match filters, each over its own
 * existing index (`providers_status_idx` / `providers_tier_idx`).
 */
export const ListProvidersQuerySchema = z
  .object({
    q: z.string().trim().min(1).max(PROVIDER_DIRECTORY_SEARCH_MAX_LENGTH).optional(),
    status: ProviderStatusSchema.optional(),
    tier: ProviderTierSchema.optional(),
    includeArchived: z
      .union([z.boolean(), z.enum(['true', 'false'])])
      .transform((value) => value === true || value === 'true')
      .default(false),
    limit: z.coerce
      .number()
      .int()
      .positive()
      .max(PROVIDER_DIRECTORY_LIMIT_MAX)
      .default(PROVIDER_DIRECTORY_LIMIT_DEFAULT),
    offset: z.coerce.number().int().min(0).max(PROVIDER_DIRECTORY_OFFSET_MAX).default(0),
  })
  .strict();
export type ListProvidersQuery = z.infer<typeof ListProvidersQuerySchema>;

// ─────────────────────────────────────────────────────────────────────
// Response
// ─────────────────────────────────────────────────────────────────────

/**
 * `GET /api/v1/admin/providers` response.
 *
 * Ordered by `displayName` ascending, then `id` ascending. The id
 * tiebreak is load-bearing, not decoration: two providers can share a
 * display name (they routinely will — "Maria G."), and without a
 * deterministic second key an offset page boundary can drop or repeat
 * one of them.
 *
 * `total` is the count matching the FILTERS, ignoring `limit` and
 * `offset` — the number a console renders as "187 providers match".
 * It is a second query, and it is worth it: a directory that shows a
 * page without saying how many pages there are pushes the operator
 * into paging blind.
 *
 * `limit` and `offset` are echoed back as APPLIED. A caller that sent
 * no `limit` gets the default reflected here rather than having to
 * know it, and a caller that sent `limit=5000` sees the clamp instead
 * of silently believing it got 5,000 rows.
 */
export const ProviderDirectoryListResponseSchema = z
  .object({
    providers: z.array(ProviderDirectoryRowSchema),
    total: z.number().int().min(0),
    limit: z.number().int().positive(),
    offset: z.number().int().min(0),
  })
  .strict();
export type ProviderDirectoryListResponse = z.infer<typeof ProviderDirectoryListResponseSchema>;
