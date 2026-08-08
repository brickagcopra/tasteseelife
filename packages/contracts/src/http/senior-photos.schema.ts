import { z } from 'zod';

/**
 * Senior photo-gallery HTTP DTOs (TS-232; PRD §6.4 "Photo summaries (with
 * senior consent)" + §12; CLAUDE.md §12 "Senior consent gates ... the
 * default is opt-out").
 *
 * The family-portal photo gallery shows the `senior_photo` media assets a
 * senior has agreed to share with **family observers**. Two surfaces use
 * these schemas:
 *
 *   1. **media-svc** (`GET /api/v1/media/seniors/{seniorId}/photos`)
 *      returns the senior's `ready` `senior_photo` assets as trimmed
 *      gallery items (`SeniorPhotoGalleryResponse`). media-svc does NOT
 *      apply the consent gate — it has no household-membership or consent
 *      knowledge (the in-service gate is TS-110-followup-10 / -9). The
 *      gateway is the gate.
 *
 *   2. **api-gateway** (`GET /api/v1/seniors/{seniorId}/photos`)
 *      aggregates the consent check (service-household) with the media
 *      list and returns `FamilySeniorPhotoGalleryResponse` — the same
 *      gallery items plus a `shared` flag. The gateway consults the
 *      senior's `photos` consent flag (TS-238) before listing: a family
 *      observer sees photos only when the senior has turned `photos` on;
 *      the primary payer + senior end-user (the consent record's
 *      `canManage` capability) always see everything. **Default opt-out**
 *      — an observer of a senior with no consent row sees nothing.
 *
 * **The gallery item is deliberately trimmed.** It carries only what the
 * family needs to render a thumbnail — id, the short-lived signed
 * delivery URL, intrinsic dimensions, an optional original file name, and
 * the upload time. It does NOT echo the media asset's internal fields
 * (`ownerUserId`, `storageBucket`, `storageKey`, `sha256`, `scanStatus`,
 * `liveMode`) — those are owner/admin-only on `MediaAssetResponse` and
 * have no place on a family-observability surface.
 *
 * `.strict()` everywhere — a typo'd field name is a 400, not a silently
 * dropped knob (CLAUDE.md §3.3).
 */

// ─── Bounded length / size constants ────────────────────────────────────

/** Soft-FK senior / asset id cap (CUID-shaped). */
export const SENIOR_PHOTO_SENIOR_ID_MAX_LENGTH = 64;
export const SENIOR_PHOTO_ID_MAX_LENGTH = 64;

/** Signed delivery URLs grow with HMAC / sigv4 query params; cap defensively. */
export const SENIOR_PHOTO_SIGNED_URL_MAX_LENGTH = 2_000;

/** Original file name cap — mirrors `MEDIA_FILE_NAME_MAX_LENGTH`. */
export const SENIOR_PHOTO_FILE_NAME_MAX_LENGTH = 256;

/**
 * Gallery page size. The default keeps the first paint small for a
 * senior-mode grid; the max bounds the media-svc `findMany` so a
 * pathological cursor walk can't pull an unbounded page.
 */
export const SENIOR_PHOTO_GALLERY_LIMIT_DEFAULT = 24;
export const SENIOR_PHOTO_GALLERY_LIMIT_MAX = 60;

/** Opaque cursor cap — mirrors the media admin-list cursor cap. */
export const SENIOR_PHOTO_GALLERY_CURSOR_MAX_LENGTH = 256;

// ─── Item schema ────────────────────────────────────────────────────────

/**
 * A single gallery photo. Returned only for assets in `ready` status, so
 * `signedDeliveryUrl` is always present and non-null (a `ready` asset has
 * a `deliveryKey`). The URL is short-lived and minted fresh per read — it
 * is never persistently shareable (CLAUDE.md §3.4).
 */
export const SeniorPhotoSchema = z
  .object({
    id: z.string().min(1).max(SENIOR_PHOTO_ID_MAX_LENGTH),
    /** Short-lived signed delivery URL minted by media-svc for this read. */
    signedDeliveryUrl: z.string().url().max(SENIOR_PHOTO_SIGNED_URL_MAX_LENGTH),
    signedDeliveryUrlExpiresAt: z.string().datetime({ offset: true }),
    /** Intrinsic image dimensions (populated by the Sharp processing stage). */
    width: z.number().int().positive().nullable(),
    height: z.number().int().positive().nullable(),
    /** Original client-declared file name, when supplied at upload time. */
    declaredFileName: z.string().min(1).max(SENIOR_PHOTO_FILE_NAME_MAX_LENGTH).nullable(),
    createdAt: z.string().datetime({ offset: true }),
  })
  .strict();
export type SeniorPhoto = z.infer<typeof SeniorPhotoSchema>;

// ─── Query schema ─────────────────────────────────────────────────────

/**
 * Query for both `GET /api/v1/media/seniors/{seniorId}/photos` (media-svc)
 * and `GET /api/v1/seniors/{seniorId}/photos` (gateway). Cursor-paginated,
 * newest-first.
 */
export const SeniorPhotoGalleryQuerySchema = z
  .object({
    limit: z.coerce
      .number()
      .int()
      .positive()
      .max(SENIOR_PHOTO_GALLERY_LIMIT_MAX)
      .default(SENIOR_PHOTO_GALLERY_LIMIT_DEFAULT),
    cursor: z.string().min(1).max(SENIOR_PHOTO_GALLERY_CURSOR_MAX_LENGTH).optional(),
  })
  .strict();
export type SeniorPhotoGalleryQuery = z.infer<typeof SeniorPhotoGalleryQuerySchema>;

// ─── Response schemas ─────────────────────────────────────────────────

/**
 * media-svc response for `GET /api/v1/media/seniors/{seniorId}/photos`.
 * The raw senior-photo list with cursor pagination — no consent gate (the
 * gateway is the gate; see the file header).
 */
export const SeniorPhotoGalleryResponseSchema = z
  .object({
    seniorId: z.string().min(1).max(SENIOR_PHOTO_SENIOR_ID_MAX_LENGTH),
    photos: z.array(SeniorPhotoSchema),
    nextCursor: z.string().min(1).max(SENIOR_PHOTO_GALLERY_CURSOR_MAX_LENGTH).nullable(),
  })
  .strict();
export type SeniorPhotoGalleryResponse = z.infer<typeof SeniorPhotoGalleryResponseSchema>;

/**
 * Gateway response for `GET /api/v1/seniors/{seniorId}/photos`. The
 * consent-gated family-observability shape:
 *
 *   - `shared: true`  — the caller may see photos (the senior turned the
 *     `photos` surface on, OR the caller is the primary payer / senior
 *     end-user). `photos` carries the page; `nextCursor` paginates.
 *   - `shared: false` — the caller is a family observer of a senior who
 *     has not shared photos. `photos` is empty and `nextCursor` is null.
 *     The portal renders a "not shared yet" empty state rather than a
 *     hard 403 (a 403 would tell a non-member nothing the membership gate
 *     hasn't already enforced; an observed-but-empty state is friendlier
 *     and still leaks nothing — the photos themselves never cross).
 */
export const FamilySeniorPhotoGalleryResponseSchema = z
  .object({
    seniorId: z.string().min(1).max(SENIOR_PHOTO_SENIOR_ID_MAX_LENGTH),
    shared: z.boolean(),
    photos: z.array(SeniorPhotoSchema),
    nextCursor: z.string().min(1).max(SENIOR_PHOTO_GALLERY_CURSOR_MAX_LENGTH).nullable(),
  })
  .strict();
export type FamilySeniorPhotoGalleryResponse = z.infer<
  typeof FamilySeniorPhotoGalleryResponseSchema
>;
