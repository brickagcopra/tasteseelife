import { z } from 'zod';

/**
 * Memory-recipe HTTP DTOs (PRD §6.5 — "Memory Meal Library & Cultural
 * Recipes"; PDD §8.2 `memory_recipes`).
 *
 * Per-senior catalog of culturally / personally meaningful dishes. Three
 * provenance buckets — family contribution, cultural-catalog import,
 * senior-requested specific dish for an upcoming visit. Plain-column
 * storage (no field-level encryption): the family dashboard, visit-
 * prep card, and chef-portal read these at speed; the field-level cost
 * of decrypting every render would defeat the surface. Story-level PII
 * (free-form descriptions that can carry family history) is defended
 * by the platform's other PII layers — encryption-at-rest, audit log,
 * row-level auth — same posture as `EmergencyContact`.
 *
 * `.strict()` everywhere — unknown fields are a 400, never a silent
 * round-trip (CLAUDE.md §3.3).
 */

/**
 * Provenance of a memory-recipe row. Mirrors the
 * `household.memory_recipe_source` Postgres enum.
 *
 *   - `family_contribution` — uploaded by an active household member.
 *     The `contributedByUserId` field on the read DTO carries the
 *     soft-FK to that user.
 *   - `cultural_catalog`    — imported from the platform-wide curated
 *     catalog (admin-managed, Phase 2). Never set by a client request
 *     — the create contract restricts the source enum to the two
 *     family-controlled values.
 *   - `senior_request`      — a specific dish the senior asked for
 *     at a recent visit. Either the family entered it on the senior's
 *     behalf, or ops did via admin tooling.
 */
export const MemoryRecipeSourceSchema = z.enum([
  'family_contribution',
  'cultural_catalog',
  'senior_request',
]);
export type MemoryRecipeSource = z.infer<typeof MemoryRecipeSourceSchema>;

/**
 * Source enum the create endpoint accepts from a client. `cultural_catalog`
 * is service-internal — a Phase-2 admin import flips the enum to that
 * value via a service-only path, never via this controller. Restricting
 * the create surface here keeps the catalog provenance honest.
 */
export const ClientCreatableMemoryRecipeSourceSchema = z.enum([
  'family_contribution',
  'senior_request',
]);
export type ClientCreatableMemoryRecipeSource = z.infer<
  typeof ClientCreatableMemoryRecipeSourceSchema
>;

/**
 * Field caps. Sized for "a recipe card" not "a chapter of a memoir".
 *
 *   - title:           a few words ("Bobchi's pierogi"); 200 char ceiling.
 *   - description:     the story behind the dish — half-a-page of prose.
 *   - cuisine_tag:     snake_case operational tag (italian, korean, …).
 *   - image_key:       S3 object key (TS-110 media-svc forward ref).
 *
 * Per-senior cap (200 recipes) lives at the service layer — the contract
 * exports the constant so frontends mirror the limit without re-deriving.
 */
const TITLE_MAX_LENGTH = 200;
const DESCRIPTION_MAX_LENGTH = 4000;
const CUISINE_TAG_MAX_LENGTH = 32;
const IMAGE_KEY_MAX_LENGTH = 256;

/** Service-layer cap on memory recipes per senior. */
export const MEMORY_RECIPES_MAX_PER_SENIOR = 200;

/**
 * Cuisine tag — operational column the chef-match query reads. Same
 * snake_case shape as the dietary / allergen tags on the senior intake
 * (TS-031). Open vocabulary so we can extend it additively without a
 * contract redeploy.
 */
const CuisineTagSchema = z
  .string()
  .min(1)
  .max(CUISINE_TAG_MAX_LENGTH, `cuisine tag must be at most ${CUISINE_TAG_MAX_LENGTH} characters`)
  .regex(/^[a-z][a-z0-9_]*$/, 'cuisine tag must be snake_case (a–z, 0–9, _)');

/**
 * S3 object key for the optional dish / recipe-card image. The contract
 * here is a string-shape gate only — TS-110 media-svc owns the actual
 * "is this a real, virus-scanned asset?" question. The family-dashboard
 * treats a non-null key as "image uploaded; render placeholder until
 * media-svc confirms".
 */
const ImageKeySchema = z
  .string()
  .min(1)
  .max(IMAGE_KEY_MAX_LENGTH, `image key must be at most ${IMAGE_KEY_MAX_LENGTH} characters`);

/**
 * Read DTO. Server-owned identifiers (`id`, `seniorId`,
 * `contributedByUserId`, audit timestamps, `sortPosition`) come back
 * alongside the family-controlled fields.
 */
export const MemoryRecipeSchema = z
  .object({
    id: z.string().min(1).max(64),
    seniorId: z.string().min(1).max(64),
    title: z
      .string()
      .min(1, 'title is required')
      .max(TITLE_MAX_LENGTH, `title must be at most ${TITLE_MAX_LENGTH} characters`),
    description: z
      .string()
      .min(1, 'description is required')
      .max(
        DESCRIPTION_MAX_LENGTH,
        `description must be at most ${DESCRIPTION_MAX_LENGTH} characters`,
      ),
    source: MemoryRecipeSourceSchema,
    cuisineTag: CuisineTagSchema.nullable(),
    imageKey: ImageKeySchema.nullable(),
    requestedForUpcomingVisit: z.boolean(),
    contributedByUserId: z.string().min(1).max(64).nullable(),
    sortPosition: z.number().int(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .strict();
export type MemoryRecipe = z.infer<typeof MemoryRecipeSchema>;

/**
 * Create request. The client controls everything except the audit
 * timestamps, the server-issued id, the sort position (auto-assigned
 * to next-available by the service layer), and `contributedByUserId`
 * (filled in from the request context when source = family_contribution).
 *
 * `cuisineTag` and `imageKey` are nullable + optional — the family can
 * upload a recipe with no image and no cuisine pinned, and explicitly
 * clear either by sending `null`. `requestedForUpcomingVisit` defaults
 * false so the family can pin later via PATCH.
 */
export const CreateMemoryRecipeRequestSchema = z
  .object({
    title: z
      .string()
      .min(1, 'title is required')
      .max(TITLE_MAX_LENGTH, `title must be at most ${TITLE_MAX_LENGTH} characters`),
    description: z
      .string()
      .min(1, 'description is required')
      .max(
        DESCRIPTION_MAX_LENGTH,
        `description must be at most ${DESCRIPTION_MAX_LENGTH} characters`,
      ),
    source: ClientCreatableMemoryRecipeSourceSchema,
    cuisineTag: CuisineTagSchema.nullable().optional(),
    imageKey: ImageKeySchema.nullable().optional(),
    requestedForUpcomingVisit: z.boolean().optional().default(false),
  })
  .strict();
export type CreateMemoryRecipeRequest = z.infer<typeof CreateMemoryRecipeRequestSchema>;

/**
 * Update request. Every editable field is optional so the client can
 * patch a single attribute. `null` on `cuisineTag` / `imageKey` clears
 * the field; absence leaves it untouched. The empty-body case (no
 * fields set) is rejected by the service layer so a misconfigured
 * client doesn't silently succeed without writing anything.
 *
 * `source` is intentionally NOT updatable — the provenance enum is
 * write-once on create; rewriting it would let a family member relabel
 * a `cultural_catalog` import as a `family_contribution` (false
 * attribution) or vice versa. Same reason `contributedByUserId` is
 * write-once.
 *
 * `sortPosition` is updatable so a future drag-and-drop reorder UX
 * (TS-033 follow-up) lands without a contract change.
 */
export const UpdateMemoryRecipeRequestSchema = z
  .object({
    title: z
      .string()
      .min(1, 'title is required')
      .max(TITLE_MAX_LENGTH, `title must be at most ${TITLE_MAX_LENGTH} characters`)
      .optional(),
    description: z
      .string()
      .min(1, 'description is required')
      .max(
        DESCRIPTION_MAX_LENGTH,
        `description must be at most ${DESCRIPTION_MAX_LENGTH} characters`,
      )
      .optional(),
    cuisineTag: CuisineTagSchema.nullable().optional(),
    imageKey: ImageKeySchema.nullable().optional(),
    requestedForUpcomingVisit: z.boolean().optional(),
    sortPosition: z.number().int().optional(),
  })
  .strict();
export type UpdateMemoryRecipeRequest = z.infer<typeof UpdateMemoryRecipeRequestSchema>;

/**
 * List response. Wraps the array in an object so future additions
 * (pagination cursors at scale, aggregate counts) are non-breaking
 * schema extensions. Order is server-controlled: ascending
 * `sortPosition`, then ascending `createdAt`.
 */
export const MemoryRecipesListResponseSchema = z
  .object({
    recipes: z.array(MemoryRecipeSchema),
  })
  .strict();
export type MemoryRecipesListResponse = z.infer<typeof MemoryRecipesListResponseSchema>;

export const MEMORY_RECIPE_TITLE_MAX_LENGTH = TITLE_MAX_LENGTH;
export const MEMORY_RECIPE_DESCRIPTION_MAX_LENGTH = DESCRIPTION_MAX_LENGTH;
export const MEMORY_RECIPE_CUISINE_TAG_MAX_LENGTH = CUISINE_TAG_MAX_LENGTH;
export const MEMORY_RECIPE_IMAGE_KEY_MAX_LENGTH = IMAGE_KEY_MAX_LENGTH;
