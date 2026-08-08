import { z } from 'zod';

/**
 * Static-pages CMS admin HTTP DTOs (TS-284; PRD §10.11; PDD §19.2).
 *
 * The authenticated content-admin surface over the `service-content` page
 * aggregate — a marketing / legal `pages` row and its append-only
 * `page_versions` history (the two `content`-schema tables). Static legal +
 * marketing pages (privacy / terms / cookie / accessibility / about / press /
 * provider-code / partner-FAQ) live here; every saved revision is retained for
 * compliance reference and remains individually addressable by id.
 *
 * **Authoring vs. publishing.** Authoring (create a page, append a version,
 * edit metadata) is gated on `content:edit`; flipping a version live — the
 * compliance-sensitive `publish` action that stamps `effectiveAt` and moves the
 * page's rendered head — is gated on the higher-trust `content:publish` (PDD
 * Appendix B). Reads of the authoring surface are gated on `content:read`.
 *
 * **Platform-wide inventory.** A page carries no per-household tenant axis — it
 * is content-staff-managed editorial inventory (the `Page` / `PageVersion`
 * Prisma models sit in service-content's `unscopedModels`, mirroring `Plan` in
 * service-subscription and `AdCampaign` in service-ads).
 *
 * **Append-only history.** A `page_versions` row is never updated in place —
 * each save is a new row with a monotonically-increasing `versionNo`. The live
 * `pages.currentVersionId` soft pointer selects the rendered head; `publish`
 * repoints it. Prior versions stay reachable (the `/legal/{slug}/v/{versionId}`
 * compliance route — web surface carved to TS-284-followup-1 — reads them via
 * the single-version GET here).
 *
 * **`.strict()` everywhere** — an unknown field is a 400 (CLAUDE.md §3.3).
 */

// ─── Bounded length / numeric constants ─────────────────────────────────

/** CUID-shaped page / version row id cap. */
export const CONTENT_PAGE_ID_MAX_LENGTH = 36;

/**
 * URL-addressable page slug (e.g. `privacy`, `provider-code-of-conduct`).
 * Lowercase kebab-case; bounded so it survives a URL path segment + an index.
 */
export const CONTENT_PAGE_SLUG_MAX_LENGTH = 160;
export const CONTENT_PAGE_SLUG_REGEX = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Editorial title (per-page + per-version). */
export const CONTENT_PAGE_TITLE_MAX_LENGTH = 300;

/**
 * Rendered body (Markdown / serialized rich-text). Generous cap — a legal page
 * can be long — but bounded so a single request can't pin a row at an
 * unbounded size (CLAUDE.md §3.3 reject-oversized posture).
 */
export const CONTENT_PAGE_BODY_MAX_LENGTH = 200_000;

/** Soft-FK authoring staff user id (into service-identity). */
export const CONTENT_PAGE_CREATED_BY_MAX_LENGTH = 64;

/**
 * Editor's material-change note (TS-285) — the human summary of what changed
 * and why it is material, carried on the `content.page.material_changed` event
 * to `service-notification`. Bounded so a single publish can't pin an unbounded
 * string (CLAUDE.md §3.3). Mirrors `CONTENT_LEGAL_EVENT_NOTE_MAX_LENGTH`.
 */
export const CONTENT_PAGE_MATERIAL_CHANGE_NOTE_MAX_LENGTH = 2_000;

/** Admin pages-list caps. Bounded, no cursor at Phase-1 catalog volume. */
export const CONTENT_PAGES_LIST_LIMIT_DEFAULT = 50;
export const CONTENT_PAGES_LIST_LIMIT_MAX = 200;

// ─── Enum (mirrors the Prisma `ContentStatus` enum 1:1) ──────────────────

/**
 * Publication lifecycle of a page — mirrors the `ContentStatus` Prisma enum
 * (PDD §19). `draft` (authoring; not served) · `published` (live) · `archived`
 * (retired; retained for history). Additive only.
 */
export const ContentStatusSchema = z.enum(['draft', 'published', 'archived']);
export type ContentStatus = z.infer<typeof ContentStatusSchema>;

// ─── Field schemas ──────────────────────────────────────────────────────

const IdSchema = z.string().min(1).max(CONTENT_PAGE_ID_MAX_LENGTH);
const SlugSchema = z
  .string()
  .trim()
  .min(1, 'a slug is required')
  .max(CONTENT_PAGE_SLUG_MAX_LENGTH)
  .regex(CONTENT_PAGE_SLUG_REGEX, 'slug must be lowercase kebab-case (a-z, 0-9, hyphen-separated)');
const TitleSchema = z
  .string()
  .trim()
  .min(1, 'a title is required')
  .max(CONTENT_PAGE_TITLE_MAX_LENGTH);
const BodySchema = z.string().min(1, 'a body is required').max(CONTENT_PAGE_BODY_MAX_LENGTH);
const CreatedBySchema = z.string().min(1).max(CONTENT_PAGE_CREATED_BY_MAX_LENGTH);
const VersionNoSchema = z.number().int().positive();
const TimestampSchema = z.string().datetime({ offset: true });

// ─── Record shapes ──────────────────────────────────────────────────────

/**
 * An append-only saved revision of a page. `effectiveAt` is null until the
 * version is published (the `publish` action stamps it); a published-then-
 * superseded version keeps its historical `effectiveAt`.
 */
export const PageVersionRecordSchema = z
  .object({
    id: IdSchema,
    pageId: IdSchema,
    versionNo: VersionNoSchema,
    title: TitleSchema,
    body: BodySchema,
    effectiveAt: TimestampSchema.nullable(),
    /**
     * Whether this version was published as a **material change** (TS-285) — a
     * substantive Terms / Privacy / etc. change subscribers must be notified of
     * (and, for Terms / Privacy, re-acknowledge). Set at publish time; false for
     * an ordinary publish or an unpublished draft.
     */
    isMaterialChange: z.boolean(),
    /** The editor's summary of what changed / why it is material. Null unless flagged with a note. */
    materialChangeNote: z
      .string()
      .min(1)
      .max(CONTENT_PAGE_MATERIAL_CHANGE_NOTE_MAX_LENGTH)
      .nullable(),
    createdBy: CreatedBySchema,
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema,
  })
  .strict();
export type PageVersionRecord = z.infer<typeof PageVersionRecordSchema>;

/**
 * Full page record (shallow — no nested versions). Returned by the list + the
 * single-page create / publish envelopes. `currentVersionId` is the soft
 * pointer to the live `page_versions` row (null for a page with no version /
 * never published).
 */
export const PageRecordSchema = z
  .object({
    id: IdSchema,
    slug: SlugSchema,
    status: ContentStatusSchema,
    title: TitleSchema,
    currentVersionId: IdSchema.nullable(),
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema,
  })
  .strict();
export type PageRecord = z.infer<typeof PageRecordSchema>;

/**
 * Page record WITH its version history (newest-first). Returned by
 * `GET /api/v1/admin/content/pages/:pageId` (the page-editor hydration).
 */
export const PageDetailSchema = PageRecordSchema.extend({
  versions: z.array(PageVersionRecordSchema),
}).strict();
export type PageDetail = z.infer<typeof PageDetailSchema>;

// ─── Create page ────────────────────────────────────────────────────────

/**
 * `POST /api/v1/admin/content/pages` body — create a page shell. A page is
 * created in `draft` with no version; the first renderable revision is added
 * via the append-version endpoint and goes live via `publish`. `slug` must be
 * unique across pages (a collision is a 409).
 */
export const CreatePageRequestSchema = z
  .object({
    slug: SlugSchema,
    title: TitleSchema,
  })
  .strict();
export type CreatePageRequest = z.infer<typeof CreatePageRequestSchema>;

// ─── Append version ─────────────────────────────────────────────────────

/**
 * `POST /api/v1/admin/content/pages/:pageId/versions` body — append a new
 * revision. `versionNo` is assigned server-side (monotonically increasing per
 * page). The version is NOT live on creation; `publish` stamps `effectiveAt`
 * and moves the page's head. `effectiveAt` is therefore not accepted here.
 */
export const CreatePageVersionRequestSchema = z
  .object({
    title: TitleSchema,
    body: BodySchema,
  })
  .strict();
export type CreatePageVersionRequest = z.infer<typeof CreatePageVersionRequestSchema>;

// ─── Publish version ────────────────────────────────────────────────────

/**
 * `POST /api/v1/admin/content/pages/:pageId/versions/:versionId/publish` body —
 * flip a version live. Sets the version's `effectiveAt`, repoints the page's
 * `currentVersionId`, and moves the page to `published`. `effectiveAt` is
 * optional — omitted means "effective now" (the server stamps the publish
 * instant); supplied means a future / backdated effective date for compliance
 * scheduling. The body may be empty (`{}`) for an immediate publish.
 */
export const PublishPageVersionRequestSchema = z
  .object({
    effectiveAt: TimestampSchema.optional(),
    /**
     * Flag this publish as a **material change** (TS-285). When true, the
     * publish additionally emits `content.page.material_changed` (inside the
     * publish transaction) so `service-notification` can notify active
     * subscribers + capture consent re-acknowledgment for Terms / Privacy.
     * Omitted / false = an ordinary publish (audit trail only).
     */
    isMaterialChange: z.boolean().optional(),
    /** Optional editor summary of what changed / why it is material. */
    materialChangeNote: z
      .string()
      .trim()
      .min(1)
      .max(CONTENT_PAGE_MATERIAL_CHANGE_NOTE_MAX_LENGTH)
      .optional(),
  })
  .strict()
  .superRefine((body, ctx) => {
    // A note without the flag is a request error — the note only rides the
    // material-change event, so it is meaningless (and silently dropped)
    // unless `isMaterialChange` is set. Reject rather than swallow.
    if (body.materialChangeNote !== undefined && body.isMaterialChange !== true) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['materialChangeNote'],
        message: 'materialChangeNote requires isMaterialChange to be true',
      });
    }
  });
export type PublishPageVersionRequest = z.infer<typeof PublishPageVersionRequestSchema>;

// ─── List ───────────────────────────────────────────────────────────────

/**
 * `GET /api/v1/admin/content/pages` query. With no filter the list returns all
 * pages ordered by `createdAt` descending. `status` narrows the result.
 */
export const ListPagesQuerySchema = z
  .object({
    status: ContentStatusSchema.optional(),
    limit: z.coerce
      .number()
      .int()
      .positive()
      .max(CONTENT_PAGES_LIST_LIMIT_MAX)
      .default(CONTENT_PAGES_LIST_LIMIT_DEFAULT),
  })
  .strict();
export type ListPagesQuery = z.infer<typeof ListPagesQuerySchema>;

// ─── Response envelopes ─────────────────────────────────────────────────

/** Single-page envelope returned by create / publish. */
export const PageResponseSchema = z.object({ page: PageRecordSchema }).strict();
export type PageResponse = z.infer<typeof PageResponseSchema>;

/** Page-detail envelope returned by `GET .../pages/:pageId`. */
export const PageDetailResponseSchema = z.object({ page: PageDetailSchema }).strict();
export type PageDetailResponse = z.infer<typeof PageDetailResponseSchema>;

/** `GET /api/v1/admin/content/pages` response — the matching pages. */
export const PagesListResponseSchema = z.object({ pages: z.array(PageRecordSchema) }).strict();
export type PagesListResponse = z.infer<typeof PagesListResponseSchema>;

/** Single-version envelope returned by append + the single-version GET. */
export const PageVersionResponseSchema = z.object({ version: PageVersionRecordSchema }).strict();
export type PageVersionResponse = z.infer<typeof PageVersionResponseSchema>;
