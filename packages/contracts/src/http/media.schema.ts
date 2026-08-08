import { z } from 'zod';

/**
 * Media HTTP DTOs (TS-110; PDD §21.5 image-upload pipeline + §7.2 service
 * inventory entry #20; CLAUDE.md §3.4 file-upload pipeline).
 *
 * Scope so far: signed-URL issuance + asset metadata + scan-event ingest.
 *
 *   1. **Issue upload URL** — a client (provider / family / academy)
 *      declares an intent to upload (kind + declared MIME + declared size
 *      + optional file name + owner scope). The service mints a single-
 *      use signed URL targeting S3, persists a `media_assets` row in
 *      `awaiting_upload` status, and returns the URL + the required
 *      headers + an expiry. The client uploads direct-to-S3.
 *
 *   2. **Asset metadata read** — provider / family / admin pull a row's
 *      current state by `assetId`. The schema exposes the lifecycle
 *      (status + scanStatus), the detected MIME post-magic-byte check,
 *      and (once `ready`) a delivery URL.
 *
 *   3. **Internal scan-event ingest** — the media-processor worker
 *      (TS-110-followup-1) calls this surface to report magic-byte +
 *      ClamAV + Sharp results. Idempotent on `assetId` × `eventKind`.
 *
 * **Live S3/ClamAV/Sharp wiring is Phase 1 stub-only.** When the AWS SDK
 * is absent the service mints deterministic `https://stub-uploads.tasteandsee.example.com/`
 * URLs with an HMAC-signed token; the media-processor worker doesn't yet
 * exist (TS-110-followup-1) so `awaiting_upload` → `uploaded` →
 * `ready` transitions arrive via the internal ingest surface for testing.
 * Live SDK wiring lands as TS-110-followup-2 / TS-110-followup-3 /
 * TS-110-followup-4 per dependency.
 *
 * **`.strict()` everywhere** — typo in a field name is a 400, not a
 * silently-dropped knob (CLAUDE.md §3.3).
 */

// ─── Bounded length / size constants ────────────────────────────────────

/** CUID/CUID2 ids. */
export const MEDIA_ID_MAX_LENGTH = 64;

/** Soft-FK to other services' user / scope identifiers. */
export const MEDIA_SOFT_FK_MAX_LENGTH = 64;

// ─── The cross-service assetKey seam (TS-282-followup-5a) ───────────────

/**
 * **An `assetKey` IS a `media_assets.id`.** That sentence is the whole
 * point of this section, and until TS-282-followup-5a it was written
 * nowhere.
 *
 * Three services carry a "media assetKey" field — `ads.ad_creatives.asset_keys`,
 * `content.authors.photo_asset_key`, and the article SEO `ogImageKey` /
 * `twitterImageKey` pair. Each declared its own local schema, each an
 * unconstrained bounded string, and **the three caps did not even agree**
 * (512 / 256 / 256 against a real media id's 64). Nothing enforced that the
 * value referenced media-svc at all; a storage key, a full URL and a typo
 * were all equally valid. That is why nothing on the platform could resolve
 * one, and why TS-282-followup-5 could not define a URL convention: there
 * was no key convention to build it on.
 *
 * **It is the id, not the storage key.** The storage key is an internal
 * detail of the bucket layout — it changes when the layout changes, it is
 * meaningless without the bucket, and `GET /api/v1/media/assets/{id}` cannot
 * look one up. Putting it in three other services' contracts would export
 * media-svc's filesystem to the whole platform.
 *
 * **Use `MediaAssetKeySchema` on WRITE paths only.** Rows written before
 * this landed carry free text that may be longer than 64 characters or may
 * never have been an id at all; validating it on the READ path would turn a
 * legacy row into a gateway 502 — a stricter schema breaking a page that
 * currently renders. Read/response shapes keep `StoredMediaAssetKeySchema`,
 * which is the old permissive bound with a name that says what it is. This
 * is the expand → migrate → contract shape CLAUDE.md §4.1 asks for; the
 * contract step happens once a backfill has proved the column is clean.
 */
export const MediaAssetKeySchema = z
  .string()
  .trim()
  .min(1, 'an assetKey is required')
  .max(MEDIA_ID_MAX_LENGTH, `an assetKey is a media asset id (max ${MEDIA_ID_MAX_LENGTH} chars)`);

/**
 * The permissive read-side bound for an `assetKey` column that predates the
 * convention above. Deliberately NOT an alias of `MediaAssetKeySchema` — the
 * two differ, that difference is the migration, and collapsing them now is
 * what would break the read path.
 */
export const StoredMediaAssetKeySchema = z.string().trim().min(1).max(512);

/**
 * Caps the `declaredFileName` field. Defensive: long file names are a
 * common path for header injection / metadata bloat. Mirrors the
 * `provider_documents.original_filename` cap.
 */
export const MEDIA_FILE_NAME_MAX_LENGTH = 256;

/**
 * Signed URLs grow with HMAC query params; cap defensively.
 */
export const MEDIA_SIGNED_URL_MAX_LENGTH = 2_000;

/**
 * Required-header value cap (HMAC token, content-type pin, etc.). 32 keys
 * × this many chars per value is plenty for the Phase-1 S3 upload shape.
 */
export const MEDIA_REQUIRED_HEADER_VALUE_MAX_LENGTH = 1_024;

/** Max distinct required-headers an upload-URL response carries. */
export const MEDIA_REQUIRED_HEADERS_MAX = 16;

/** SHA-256 hex digest length (64 characters). */
export const MEDIA_SHA256_HEX_LENGTH = 64;

/** S3 bucket name length cap (S3 max is 63). */
export const MEDIA_STORAGE_BUCKET_MAX_LENGTH = 63;

/** S3 object key length cap (S3 max is 1024). */
export const MEDIA_STORAGE_KEY_MAX_LENGTH = 1_024;

/** Free-text scan reason / failure detail. */
export const MEDIA_REASON_MAX_LENGTH = 512;

/**
 * Per-kind size caps in bytes. The contract caps the declared size at the
 * outer ceiling; the service-layer SignedUrlIssuer enforces the per-kind
 * cap before minting the URL.
 *
 *   - 20 MiB for images (covers high-resolution senior portraits and
 *     memory-recipe cards).
 *   - 200 MiB for provider video intros.
 *   - 25 MiB for PDFs (provider docs, certificates).
 */
export const MEDIA_MAX_SIZE_BYTES = 200 * 1024 * 1024;
export const MEDIA_MAX_IMAGE_SIZE_BYTES = 20 * 1024 * 1024;
export const MEDIA_MAX_VIDEO_SIZE_BYTES = 200 * 1024 * 1024;
export const MEDIA_MAX_PDF_SIZE_BYTES = 25 * 1024 * 1024;

/** Pagination caps for the admin list surface. */
export const MEDIA_LIST_LIMIT_DEFAULT = 50;
export const MEDIA_LIST_LIMIT_MAX = 200;

/** Admin list cursor cap. */
export const MEDIA_LIST_CURSOR_MAX_LENGTH = 256;

// ─── Enums ──────────────────────────────────────────────────────────────

/**
 * Asset kind — controls the per-kind size cap and the allowed MIME
 * subset. Mirrors `media.media_asset_kind` in the Prisma schema.
 *
 *   - `senior_photo`           — family / chef-uploaded photo of a senior
 *     (requires senior consent — CLAUDE.md §12).
 *   - `provider_profile_photo` — provider-uploaded headshot.
 *   - `provider_video_intro`   — provider-uploaded short video intro.
 *   - `memory_recipe_image`    — family / senior memory-recipe card art.
 *   - `provider_document`      — provider-uploaded ID / food handler /
 *     insurance proof (PDF).
 *   - `certification_evidence` — provider-uploaded course completion
 *     evidence (PDF or image).
 *   - `academy_lesson_attachment` — instructor-uploaded lesson asset
 *     (PDF or image; videos are out of scope for TS-110).
 *
 * Open-vocabulary kinds (e.g. partner co-marketing assets) land as
 * additive enum extensions per CLAUDE.md §4.1 forward-compatible
 * migrations.
 */
export const MediaAssetKindSchema = z.enum([
  'senior_photo',
  'provider_profile_photo',
  'provider_video_intro',
  'memory_recipe_image',
  'provider_document',
  'certification_evidence',
  'academy_lesson_attachment',
]);
export type MediaAssetKind = z.infer<typeof MediaAssetKindSchema>;

/**
 * Asset lifecycle status. Mirrors `media.media_asset_status` in the
 * Prisma schema.
 *
 *   - `awaiting_upload` — row minted; the signed URL has been issued but
 *     the client has not yet PUT the bytes to S3.
 *   - `uploaded`        — S3 reports the object exists; the media-
 *     processor has not yet inspected it.
 *   - `scanning`        — the media-processor has started magic-byte +
 *     ClamAV + Sharp work.
 *   - `ready`           — fully processed; safe to render. Delivery URL
 *     is non-null.
 *   - `rejected`        — content failed validation (magic-byte mismatch,
 *     virus hit, decompression bomb, format unsupported). The bytes are
 *     deleted from S3 by the media-processor; the row remains for audit.
 *   - `failed`          — the pipeline encountered an unexpected error
 *     (Sharp crash, ClamAV down). Ops can retry via admin tooling.
 *   - `expired`         — the signed URL expired before the client PUT
 *     completed. Row remains for audit; client must request a new URL.
 */
export const MediaAssetStatusSchema = z.enum([
  'awaiting_upload',
  'uploaded',
  'scanning',
  'ready',
  'rejected',
  'failed',
  'expired',
]);
export type MediaAssetStatus = z.infer<typeof MediaAssetStatusSchema>;

/**
 * Virus-scan outcome (independent of the overall asset status because the
 * pipeline runs magic-byte + ClamAV + Sharp in sequence and each can fail
 * independently). Mirrors `media.media_scan_status` in the Prisma schema.
 *
 *   - `pending` — no scan attempted yet.
 *   - `clean`   — ClamAV cleared the file.
 *   - `infected` — ClamAV signature match. Bytes deleted from S3.
 *   - `failed`  — ClamAV could not finish (transient error). Retryable.
 */
export const MediaScanStatusSchema = z.enum(['pending', 'clean', 'infected', 'failed']);
export type MediaScanStatus = z.infer<typeof MediaScanStatusSchema>;

/**
 * Declared owner-scope kind. `media-svc` doesn't enforce referential
 * integrity into other service schemas (CLAUDE.md §2.3 — soft FK), so
 * the scope is identified at the contract layer by `(scopeKind, scopeId)`
 * and the service layer is responsible for cross-service authorization
 * gates (e.g. "is this user X a member of household Y?" — TS-141-followup-3).
 *
 *   - `user`      — the asset is owned by a single user (provider
 *     headshots, provider video intros).
 *   - `household` — the asset is scoped to a household (senior photos,
 *     memory-recipe images).
 *   - `senior`    — the asset is scoped to a specific senior under a
 *     household.
 *   - `provider`  — the asset is scoped to a provider entity.
 *   - `course`    — the asset is scoped to a Cooking Academy course
 *     (instructor-uploaded lesson asset).
 */
export const MediaOwnerScopeKindSchema = z.enum([
  'user',
  'household',
  'senior',
  'provider',
  'course',
]);
export type MediaOwnerScopeKind = z.infer<typeof MediaOwnerScopeKindSchema>;

/**
 * Internal scan-event kind. The media-processor (or its stub during
 * Phase 1) reports each stage of the pipeline via this discriminator.
 * Mirrors `media.media_asset_event_kind` in the Prisma schema.
 *
 *   - `upload_completed`  — S3 has the bytes; processor has not yet
 *     inspected them. Transitions `awaiting_upload` → `uploaded`.
 *   - `magic_byte_passed` — declared MIME matches the magic-byte
 *     detection. Adds `detected_mime` + `sha256` + `size_bytes` to the
 *     row. Transitions `uploaded` → `scanning`.
 *   - `magic_byte_failed` — declared MIME / extension mismatch. Bytes
 *     deleted. Transitions `uploaded` → `rejected`.
 *   - `scan_passed`       — ClamAV cleared the file. Transitions
 *     `scanning` → `ready` once any subsequent Sharp work also passes.
 *   - `scan_failed`       — ClamAV reported infection. Bytes deleted.
 *     Transitions `scanning` → `rejected`.
 *   - `process_passed`    — Sharp resize / Sharp PDF render OK. Adds
 *     dimensions / delivery-key.
 *   - `process_failed`    — Sharp crashed (decompression bomb, format
 *     unsupported). Transitions to `rejected`.
 *   - `expired`           — signed URL expired before S3 saw the PUT.
 *     Transitions `awaiting_upload` → `expired`.
 */
export const MediaAssetEventKindSchema = z.enum([
  'upload_completed',
  'magic_byte_passed',
  'magic_byte_failed',
  'scan_passed',
  'scan_failed',
  'process_passed',
  'process_failed',
  'expired',
]);
export type MediaAssetEventKind = z.infer<typeof MediaAssetEventKindSchema>;

// ─── Field schemas (re-used) ────────────────────────────────────────────

const MediaIdSchema = z.string().min(1).max(MEDIA_ID_MAX_LENGTH);
const SoftFkIdSchema = z.string().min(1).max(MEDIA_SOFT_FK_MAX_LENGTH);

/**
 * MIME type — `type/subtype` (no parameters). The contract cap matches
 * IANA's hard cap (~127 chars). The service-layer's allow-list defines
 * which MIMEs are actually accepted per kind.
 */
const MimeTypeSchema = z
  .string()
  .min(3)
  .max(127)
  .regex(/^[a-z0-9!#$&^_+\-.]+\/[a-z0-9!#$&^_+\-.]+$/i, 'mime must be IANA-shaped type/subtype');

const FileNameSchema = z.string().min(1).max(MEDIA_FILE_NAME_MAX_LENGTH);

const Sha256HexSchema = z
  .string()
  .length(MEDIA_SHA256_HEX_LENGTH)
  .regex(/^[0-9a-f]{64}$/, 'sha256 must be 64 lower-case hex characters');

const StorageBucketSchema = z.string().min(1).max(MEDIA_STORAGE_BUCKET_MAX_LENGTH);
const StorageKeySchema = z.string().min(1).max(MEDIA_STORAGE_KEY_MAX_LENGTH);
const SignedUrlSchema = z
  .string()
  .url('signed URL must be a valid URL')
  .max(MEDIA_SIGNED_URL_MAX_LENGTH);

const RequiredHeadersSchema = z
  .record(z.string().min(1).max(64), z.string().min(1).max(MEDIA_REQUIRED_HEADER_VALUE_MAX_LENGTH))
  .refine(
    (h) => Object.keys(h).length <= MEDIA_REQUIRED_HEADERS_MAX,
    `at most ${MEDIA_REQUIRED_HEADERS_MAX} required headers`,
  );

const ReasonSchema = z.string().min(1).max(MEDIA_REASON_MAX_LENGTH);

const OwnerScopeSchema = z
  .object({
    kind: MediaOwnerScopeKindSchema,
    id: SoftFkIdSchema,
  })
  .strict();

// ─── Request schemas ────────────────────────────────────────────────────

/**
 * Client request: mint a single-use signed URL for direct-to-S3 upload.
 *
 * Service-layer rules (CLAUDE.md §3.4):
 *   - Allowed MIME set is per-`kind`. Image kinds accept `image/jpeg`,
 *     `image/png`, `image/webp`, `image/avif`. Video accepts
 *     `video/mp4`, `video/webm`. PDF kinds accept `application/pdf`.
 *   - `declaredSizeBytes` must be <= the per-kind cap.
 *   - The client MUST NOT trust the declared MIME — magic-byte detection
 *     in the media-processor is authoritative (CLAUDE.md §17.16).
 */
export const IssueUploadUrlRequestSchema = z
  .object({
    kind: MediaAssetKindSchema,
    declaredMime: MimeTypeSchema,
    declaredSizeBytes: z
      .number()
      .int()
      .positive()
      .max(MEDIA_MAX_SIZE_BYTES, `declared size exceeds ${MEDIA_MAX_SIZE_BYTES} bytes`),
    declaredFileName: FileNameSchema.optional(),
    ownerScope: OwnerScopeSchema,
  })
  .strict();
export type IssueUploadUrlRequest = z.infer<typeof IssueUploadUrlRequestSchema>;

/**
 * Internal request: media-processor reports a pipeline-stage outcome.
 * Idempotent on `(assetId, eventKind)` — replay of the same stage event
 * returns the existing row state.
 *
 * `detectedMime` / `sha256` / `sizeBytes` are populated on
 * `magic_byte_passed`; `width` / `height` / `deliveryKey` on
 * `process_passed`; `reason` on any failure event.
 */
export const RecordAssetEventRequestSchema = z
  .object({
    assetId: MediaIdSchema,
    eventKind: MediaAssetEventKindSchema,
    occurredAt: z.string().datetime({ offset: true }),
    detectedMime: MimeTypeSchema.optional(),
    sha256: Sha256HexSchema.optional(),
    sizeBytes: z.number().int().positive().max(MEDIA_MAX_SIZE_BYTES).optional(),
    width: z.number().int().positive().max(60_000).optional(),
    height: z.number().int().positive().max(60_000).optional(),
    deliveryKey: StorageKeySchema.optional(),
    reason: ReasonSchema.optional(),
  })
  .strict();
export type RecordAssetEventRequest = z.infer<typeof RecordAssetEventRequestSchema>;

// ─── Response schemas ───────────────────────────────────────────────────

/**
 * Outwards-facing asset metadata. Visible to:
 *   - The owner (provider / family) for assets in their scope.
 *   - Admin staff with `media:read` (TS-110-followup-9 lifts the gate).
 *
 * Sensitive fields:
 *   - `signedDeliveryUrl` is null until status is `ready`. The service
 *     mints a fresh short-lived URL per read (so the URL is never
 *     persistently shareable; CLAUDE.md §3.4 file pipeline).
 *   - `sha256` is included for client-side dedup; safe to disclose.
 */
export const MediaAssetResponseSchema = z
  .object({
    id: MediaIdSchema,
    kind: MediaAssetKindSchema,
    ownerUserId: SoftFkIdSchema,
    ownerScopeKind: MediaOwnerScopeKindSchema,
    ownerScopeId: SoftFkIdSchema,
    status: MediaAssetStatusSchema,
    scanStatus: MediaScanStatusSchema,
    scanReason: ReasonSchema.nullable(),
    declaredMime: MimeTypeSchema,
    detectedMime: MimeTypeSchema.nullable(),
    declaredFileName: FileNameSchema.nullable(),
    declaredSizeBytes: z.number().int().positive().max(MEDIA_MAX_SIZE_BYTES),
    actualSizeBytes: z.number().int().positive().max(MEDIA_MAX_SIZE_BYTES).nullable(),
    width: z.number().int().positive().nullable(),
    height: z.number().int().positive().nullable(),
    sha256: Sha256HexSchema.nullable(),
    storageBucket: StorageBucketSchema,
    storageKey: StorageKeySchema,
    deliveryKey: StorageKeySchema.nullable(),
    /**
     * Short-lived signed delivery URL minted by the service for this
     * read. Null when status != `ready`. Live SDK wiring stubs return
     * `https://stub-delivery.tasteandsee.example.com/<key>?...`.
     */
    signedDeliveryUrl: SignedUrlSchema.nullable(),
    signedDeliveryUrlExpiresAt: z.string().datetime({ offset: true }).nullable(),
    /** Whether the S3 SDK is wired live (true) or running in stub mode (false). */
    liveMode: z.boolean(),
    /** Expiry of the original upload signed URL (for `awaiting_upload` debugging). */
    uploadUrlExpiresAt: z.string().datetime({ offset: true }).nullable(),
    uploadedAt: z.string().datetime({ offset: true }).nullable(),
    scannedAt: z.string().datetime({ offset: true }).nullable(),
    processedAt: z.string().datetime({ offset: true }).nullable(),
    createdAt: z.string().datetime({ offset: true }),
    updatedAt: z.string().datetime({ offset: true }),
  })
  .strict();
export type MediaAssetResponse = z.infer<typeof MediaAssetResponseSchema>;

/**
 * Response for `POST /api/v1/media/upload-urls`. Carries the upload URL,
 * required HTTP method, required headers, and the asset metadata row in
 * `awaiting_upload` state. The client uploads direct-to-S3 with the
 * supplied method + headers; once S3 confirms the object exists, the
 * media-processor (TS-110-followup-1) advances the row via the internal
 * scan-event ingest surface.
 */
export const IssueUploadUrlResponseSchema = z
  .object({
    asset: MediaAssetResponseSchema,
    uploadUrl: SignedUrlSchema,
    uploadMethod: z.enum(['PUT', 'POST']),
    requiredHeaders: RequiredHeadersSchema,
    expiresAt: z.string().datetime({ offset: true }),
    /** Whether the S3 SDK is wired live (true) or running in stub mode (false). */
    liveMode: z.boolean(),
  })
  .strict();
export type IssueUploadUrlResponse = z.infer<typeof IssueUploadUrlResponseSchema>;

/**
 * Response for the internal scan-event ingest. `outcome` is `applied`
 * on first delivery of a given `(assetId, eventKind)` pair, or `replayed`
 * when the same pair has already been recorded.
 */
export const RecordAssetEventResponseSchema = z
  .object({
    outcome: z.enum(['applied', 'replayed']),
    asset: MediaAssetResponseSchema,
  })
  .strict();
export type RecordAssetEventResponse = z.infer<typeof RecordAssetEventResponseSchema>;

// ─── Admin list / query schemas ─────────────────────────────────────────

/**
 * Admin: list media assets with optional kind / status / owner filters +
 * cursor pagination. The list surface is gated behind `media:read` at the
 * permission layer (TS-110-followup-9 lifts the gate from "any admin" to
 * the explicit permission).
 */
export const ListMediaAssetsQuerySchema = z
  .object({
    limit: z.coerce
      .number()
      .int()
      .positive()
      .max(MEDIA_LIST_LIMIT_MAX)
      .default(MEDIA_LIST_LIMIT_DEFAULT),
    kind: MediaAssetKindSchema.optional(),
    status: MediaAssetStatusSchema.optional(),
    ownerScopeKind: MediaOwnerScopeKindSchema.optional(),
    ownerScopeId: SoftFkIdSchema.optional(),
    cursor: z.string().min(1).max(MEDIA_LIST_CURSOR_MAX_LENGTH).optional(),
  })
  .strict();
export type ListMediaAssetsQuery = z.infer<typeof ListMediaAssetsQuerySchema>;

export const MediaAssetsListResponseSchema = z
  .object({
    rows: z.array(MediaAssetResponseSchema),
    nextCursor: z.string().min(1).max(MEDIA_LIST_CURSOR_MAX_LENGTH).nullable(),
  })
  .strict();
export type MediaAssetsListResponse = z.infer<typeof MediaAssetsListResponseSchema>;

// ─── Admin preview resolution (TS-282-followup-5b) ──────────────────────

/**
 * How many keys one admin resolve call may carry. Matched to
 * `AD_CREATIVE_ASSET_KEYS_MAX` — the widest assetKey-bearing record on the
 * platform is an ad creative, so a page never needs a second call, and the
 * gateway's fan-out is bounded by construction rather than by hope.
 */
export const ADMIN_MEDIA_RESOLVE_MAX = 10;

/**
 * **Is this asset kind previewable on an admin console?**
 *
 * TS-282-followup-5b puts a resolution endpoint behind `media:read`, and a
 * resolution endpoint that will render any id its caller can name is an open
 * proxy for the most sensitive bytes on the platform: a senior's photograph, a
 * provider's government ID, a background-check evidence PDF. `media:read` is
 * granted to marketing and content editors — personas with no business
 * whatsoever seeing any of those — so the permission alone is not the control.
 *
 * **The switch is exhaustive on purpose.** A deny-list is normally the wrong
 * shape precisely because a new member lands on the permissive side by
 * default; enumerating every kind removes that failure mode — adding a value
 * to `MediaAssetKindSchema` is a COMPILE ERROR here until somebody decides
 * which side it belongs on. That matters immediately: TS-282-followup-5d adds
 * the editorial kinds this task's two surfaces will eventually reference.
 *
 * **Today's honest state**: the enum has no value an ad creative image or a
 * blog author photo could have been uploaded as (TS-282-followup-5, finding
 * 4), so the three permissive kinds below are not the ones the fixed surfaces
 * carry. That is finding 4 showing through, not a gap in this policy — and it
 * is exactly why the compile error is worth having.
 */
export function isAdminPreviewableMediaKind(kind: MediaAssetKind): boolean {
  switch (kind) {
    // Household-private imagery. A senior's photograph is consent-gated
    // (CLAUDE.md §12) and a memory-recipe card is a family's own artwork;
    // neither belongs on an ops console reached by an ads permission.
    case 'senior_photo':
    case 'memory_recipe_image':
      return false;
    // Statutory / identity evidence. `provider_document` is government ID and
    // insurance proof; `certification_evidence` backs a credential decision.
    // TS-305a already refuses to let these leave the database on the dossier
    // read path — resolving them by id here would undo that.
    case 'provider_document':
    case 'certification_evidence':
      return false;
    // Provider-authored public-facing collateral: the headshot and the intro
    // video are what the directory shows, so an admin looking at them
    // discloses nothing the customer surface does not.
    case 'provider_profile_photo':
    case 'provider_video_intro':
      return true;
    // Curriculum material, authored by an instructor for the admin catalog
    // surface (TS-251) that already reads it.
    case 'academy_lesson_attachment':
      return true;
  }
}

/**
 * The outcome of resolving one assetKey for an admin preview.
 *
 * **Five outcomes, and the discrimination is the safety property.** The defect
 * this endpoint exists to fix (TS-277a gates ad-creative approval on an
 * accessibility review — alt-text adequacy, WCAG contrast, motion — while
 * web-admin renders `assetKeys.join(', ')` as literal text) is a reviewer
 * approving what they cannot see. Rendering nothing, for any reason, without
 * saying which reason, reproduces that defect in a nicer typeface:
 *
 *   - `ready`       — a short-lived signed URL. Render it.
 *   - `not_ready`   — the asset exists but is not renderable (still uploading,
 *     mid-scan, rejected by the virus/magic-byte pipeline, expired). Carries
 *     the lifecycle status because "we rejected these bytes" and "we have not
 *     looked at them yet" are different answers to the reviewer.
 *   - `not_found`   — no such asset. The COMMON case today: assetKey columns
 *     predate the TS-282-followup-5a convention and were free text, so a key
 *     may never have referenced media-svc at all. Saying so out loud is the
 *     point — a reviewer who learns the accessibility review is unperformable
 *     can bounce the creative instead of rubber-stamping it.
 *   - `restricted`  — the asset is real but its kind is not previewable on an
 *     admin console (see `isAdminPreviewableMediaKind`). Deliberately does NOT
 *     name the kind: the operator needs to know it is a policy refusal rather
 *     than a broken link, and does not need to learn that a given id is a
 *     senior's photograph.
 *   - `unavailable` — media-svc could not be asked. Distinct from every answer
 *     above; an outage must never read as "this asset does not exist".
 *
 * `assetKey` is echoed on every variant so a caller maps results back by key
 * rather than by array position.
 */
const ResolveOutcomeBaseShape = {
  assetKey: StoredMediaAssetKeySchema,
} as const;

export const ResolvedMediaAssetSchema = z.discriminatedUnion('outcome', [
  z
    .object({
      ...ResolveOutcomeBaseShape,
      outcome: z.literal('ready'),
      /**
       * Short-lived signed delivery URL, minted by media-svc for THIS read.
       * Minutes-scale expiry is correct here and the contrast with the public
       * convention (TS-282-followup-5c) is the point: an admin page is
       * rendered per request for an authenticated human looking at it now.
       */
      signedUrl: SignedUrlSchema,
      expiresAt: z.string().datetime({ offset: true }).nullable(),
      /**
       * The DETECTED mime where the pipeline has one, falling back to the
       * declared mime. A consumer decides whether it can render inline from
       * this — an ad creative may be a video, and an `<img>` around one shows
       * a broken icon to the reviewer who is meant to be judging it.
       */
      mime: MimeTypeSchema,
      width: z.number().int().positive().nullable(),
      height: z.number().int().positive().nullable(),
      fileName: FileNameSchema.nullable(),
      sizeBytes: z.number().int().positive().max(MEDIA_MAX_SIZE_BYTES).nullable(),
    })
    .strict(),
  z
    .object({
      ...ResolveOutcomeBaseShape,
      outcome: z.literal('not_ready'),
      status: MediaAssetStatusSchema,
    })
    .strict(),
  z.object({ ...ResolveOutcomeBaseShape, outcome: z.literal('not_found') }).strict(),
  z.object({ ...ResolveOutcomeBaseShape, outcome: z.literal('restricted') }).strict(),
  z.object({ ...ResolveOutcomeBaseShape, outcome: z.literal('unavailable') }).strict(),
]);
export type ResolvedMediaAsset = z.infer<typeof ResolvedMediaAssetSchema>;

/**
 * Query for `GET /api/v1/admin/media/assets/resolve`.
 *
 * **Repeated `id` params, not a comma-joined list.** A legacy assetKey is
 * unvalidated free text (`StoredMediaAssetKeySchema`) and may contain a comma;
 * splitting on one would silently mangle a single bad key into two bogus ones
 * and lose the value the response is supposed to echo back. Repetition has no
 * delimiter to collide with.
 */
export const ResolveMediaAssetsQuerySchema = z
  .object({
    id: z.preprocess(
      (value) => (Array.isArray(value) ? value : value === undefined ? [] : [value]),
      z
        .array(StoredMediaAssetKeySchema)
        .min(1, 'at least one id is required')
        .max(ADMIN_MEDIA_RESOLVE_MAX, `at most ${ADMIN_MEDIA_RESOLVE_MAX} ids per call`),
    ),
  })
  .strict();
export type ResolveMediaAssetsQuery = z.infer<typeof ResolveMediaAssetsQuerySchema>;

/**
 * Response for `GET /api/v1/admin/media/assets/resolve`.
 *
 * **Deliberately NOT `MediaAssetResponse`.** That row carries
 * `storageBucket`, `storageKey`, `deliveryKey`, `sha256`, `ownerUserId` and
 * `ownerScopeId` — media-svc's bucket layout and the asset's owner. Handing
 * those to a browser-facing app to draw a picture is the same mistake
 * TS-282-followup-5a refused when it pinned assetKey to the asset ID rather
 * than the storage key: it exports one service's filesystem to the platform.
 * This shape carries what a rendering surface needs and nothing else.
 */
export const ResolveMediaAssetsResponseSchema = z
  .object({
    assets: z.array(ResolvedMediaAssetSchema).max(ADMIN_MEDIA_RESOLVE_MAX),
  })
  .strict();
export type ResolveMediaAssetsResponse = z.infer<typeof ResolveMediaAssetsResponseSchema>;
