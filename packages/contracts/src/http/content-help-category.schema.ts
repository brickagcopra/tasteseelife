import { z } from 'zod';

/**
 * Help-center taxonomy (category tree) CMS admin HTTP DTOs
 * (TS-284-followup-3; PRD §10.11; PDD §19.3).
 *
 * The authenticated content-admin surface over the `service-content`
 * `help_categories` table — a self-nesting category tree (`parentId` +
 * `sortOrder`) that organises help articles. Unlike pages / articles there is
 * no version history: a category is a small, mutable taxonomy node, so it
 * carries a plain create + `PATCH` update (name / ordering / re-parent) rather
 * than an append-only version chain.
 *
 * **Authoring vs. reads.** Create + update are gated on `content:edit`; reads
 * on `content:read`. There is no `publish` lever (a category has no draft /
 * published lifecycle).
 *
 * **List shape.** `GET .../help-categories` returns a FLAT array ordered by
 * `(parentId NULLS FIRST, sortOrder, name)` — every node carries its `parentId`
 * so the client assembles the tree. A flat projection keeps the read a single
 * bounded query (no recursive CTE) at Phase-1 taxonomy volume; the tree walk is
 * a client-side group-by.
 *
 * **Cycle safety.** Re-parenting is validated server-side: a category may not
 * be its own parent, and may not be re-parented under one of its own
 * descendants (which would orphan a subtree into a cycle). The service walks the
 * ancestor chain and rejects with a 409.
 *
 * **Platform-wide inventory** — no per-household tenant axis (the `HelpCategory`
 * model sits in service-content's `unscopedModels`).
 *
 * **`.strict()` everywhere** — an unknown field is a 400 (CLAUDE.md §3.3).
 */

// ─── Bounded length / numeric constants ─────────────────────────────────

/** CUID-shaped category row id cap. */
export const CONTENT_HELP_CATEGORY_ID_MAX_LENGTH = 36;

/** URL-addressable category slug (e.g. `getting-started`). Lowercase kebab-case. */
export const CONTENT_HELP_CATEGORY_SLUG_MAX_LENGTH = 160;
export const CONTENT_HELP_CATEGORY_SLUG_REGEX = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Human display name. */
export const CONTENT_HELP_CATEGORY_NAME_MAX_LENGTH = 200;

/** Manual ordering within a parent. Non-negative, bounded. */
export const CONTENT_HELP_CATEGORY_SORT_ORDER_MAX = 1_000_000;

/** Admin list cap. Bounded, no cursor at Phase-1 taxonomy volume. */
export const CONTENT_HELP_CATEGORIES_LIST_LIMIT_DEFAULT = 500;
export const CONTENT_HELP_CATEGORIES_LIST_LIMIT_MAX = 2_000;

// ─── Field schemas ──────────────────────────────────────────────────────

const IdSchema = z.string().min(1).max(CONTENT_HELP_CATEGORY_ID_MAX_LENGTH);
const SlugSchema = z
  .string()
  .trim()
  .min(1, 'a slug is required')
  .max(CONTENT_HELP_CATEGORY_SLUG_MAX_LENGTH)
  .regex(
    CONTENT_HELP_CATEGORY_SLUG_REGEX,
    'slug must be lowercase kebab-case (a-z, 0-9, hyphen-separated)',
  );
const NameSchema = z
  .string()
  .trim()
  .min(1, 'a name is required')
  .max(CONTENT_HELP_CATEGORY_NAME_MAX_LENGTH);
const ParentIdSchema = z.string().min(1).max(CONTENT_HELP_CATEGORY_ID_MAX_LENGTH);
const SortOrderSchema = z.number().int().min(0).max(CONTENT_HELP_CATEGORY_SORT_ORDER_MAX);
const TimestampSchema = z.string().datetime({ offset: true });

// ─── Record shape ───────────────────────────────────────────────────────

/**
 * A help-center category node. `parentId` is null for a root category;
 * `sortOrder` is the manual display ordering within its parent (ascending).
 */
export const HelpCategoryRecordSchema = z
  .object({
    id: IdSchema,
    slug: SlugSchema,
    name: NameSchema,
    parentId: IdSchema.nullable(),
    sortOrder: SortOrderSchema,
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema,
  })
  .strict();
export type HelpCategoryRecord = z.infer<typeof HelpCategoryRecordSchema>;

// ─── Create ─────────────────────────────────────────────────────────────

/**
 * `POST /api/v1/admin/content/help-categories` body — create a category. `slug`
 * must be unique across categories (a collision is a 409). `parentId` is
 * optional (omitted = a root category); when supplied it must resolve to an
 * existing category (a miss is a 404). `sortOrder` defaults to 0.
 */
export const CreateHelpCategoryRequestSchema = z
  .object({
    slug: SlugSchema,
    name: NameSchema,
    parentId: ParentIdSchema.optional(),
    sortOrder: SortOrderSchema.optional(),
  })
  .strict();
export type CreateHelpCategoryRequest = z.infer<typeof CreateHelpCategoryRequestSchema>;

// ─── Update ─────────────────────────────────────────────────────────────

/**
 * `PATCH /api/v1/admin/content/help-categories/:id` body — update name,
 * ordering, or parent. All fields optional; at least one must be present.
 * `parentId: null` promotes the category to a root; a non-null `parentId`
 * re-parents it (rejected with a 409 if it would create a cycle — self-parent
 * or a descendant parent). `slug` is immutable (it is URL-addressable and
 * already published) — a rename creates a new category.
 */
export const UpdateHelpCategoryRequestSchema = z
  .object({
    name: NameSchema.optional(),
    parentId: ParentIdSchema.nullable().optional(),
    sortOrder: SortOrderSchema.optional(),
  })
  .strict()
  .refine((v) => v.name !== undefined || v.parentId !== undefined || v.sortOrder !== undefined, {
    message: 'at least one field (name, parentId, sortOrder) must be supplied',
  });
export type UpdateHelpCategoryRequest = z.infer<typeof UpdateHelpCategoryRequestSchema>;

// ─── List ───────────────────────────────────────────────────────────────

/**
 * `GET /api/v1/admin/content/help-categories` query. Optionally narrow to the
 * direct children of a `parentId`. Bounded by `limit`.
 */
export const ListHelpCategoriesQuerySchema = z
  .object({
    parentId: ParentIdSchema.optional(),
    limit: z.coerce
      .number()
      .int()
      .positive()
      .max(CONTENT_HELP_CATEGORIES_LIST_LIMIT_MAX)
      .default(CONTENT_HELP_CATEGORIES_LIST_LIMIT_DEFAULT),
  })
  .strict();
export type ListHelpCategoriesQuery = z.infer<typeof ListHelpCategoriesQuerySchema>;

// ─── Response envelopes ─────────────────────────────────────────────────

/** Single-category envelope returned by create / update / detail. */
export const HelpCategoryResponseSchema = z.object({ category: HelpCategoryRecordSchema }).strict();
export type HelpCategoryResponse = z.infer<typeof HelpCategoryResponseSchema>;

/**
 * `GET /api/v1/admin/content/help-categories` response — a FLAT array ordered by
 * `(parentId NULLS FIRST, sortOrder, name)`; the client assembles the tree from
 * each node's `parentId`.
 */
export const HelpCategoriesListResponseSchema = z
  .object({ categories: z.array(HelpCategoryRecordSchema) })
  .strict();
export type HelpCategoriesListResponse = z.infer<typeof HelpCategoriesListResponseSchema>;
