import { z } from 'zod';

import {
  PROVIDER_BIO_MAX_LENGTH,
  PROVIDER_DISPLAY_NAME_MAX_LENGTH,
  PROVIDER_HEADLINE_MAX_LENGTH,
  PROVIDER_TIME_ZONE_MAX_LENGTH,
  ProviderStatusSchema,
  ProviderTierSchema,
} from './provider-application.schema';

/**
 * Provider profile-edit contracts (TS-200).
 *
 * Phase-1 ships the provider application + background-check surface
 * (TS-051), the certifications + tier surface (TS-052), and the
 * discovery surface (TS-111). What's been missing is the self-service
 * editable profile — an active provider has no way to update their
 * bio, swap in a new language, add a cuisine they specialise in, or
 * mark themselves as dementia-sensitive. This module fills that gap.
 *
 * Why a separate file from `provider-application.schema.ts`:
 *
 *   - The application flow's `ProviderRecord` projection is the
 *     minimal "we accepted your application" shape that downstream
 *     `submitProviderApplication` consumers depend on. Keeping it
 *     narrow bounds the blast radius of an additive change here.
 *
 *   - The richer `ProviderProfileRecord` projection adds tag arrays
 *     (languages / cuisines / dietary expertise) + the
 *     `dementiaSensitive` flag — fields whose data sources are the new
 *     `provider_profile_tags` table + a new `providers` column landed
 *     in the matching migration. Consumers that want the full profile
 *     (web-provider editor, search-indexer projection, future
 *     web-family detail page) project this shape; everyone else stays
 *     on the lean `ProviderRecord`.
 *
 *   - The event payload `provider.profile_updated` lives next to the
 *     contracts that change it (CLAUDE.md §5.3) — kept in
 *     `packages/contracts/src/events/provider.ts` to match the
 *     prior-art alongside `provider.tier_changed`.
 *
 * Authorization model (CLAUDE.md §3.2 / TS-141). The `PUT` endpoint
 * is self-service-first: the authenticated user must own the
 * `providers.user_id` row matching the `:providerId` path param. Admin
 * override (a future endpoint or permission-gated branch) lands as a
 * follow-up once `PermissionGuard` lifts to `packages/nest-auth` via
 * TS-052-followup-11 — captured as TS-200-followup-1.
 */

// ─────────────────────────────────────────────────────────────────────
// Tag dictionary — the polymorphic kinds the profile carries
// ─────────────────────────────────────────────────────────────────────

/**
 * The three tag kinds a provider profile carries. Modelled as a
 * polymorphic `provider_profile_tags(provider_id, kind, tag)` table
 * server-side (one row per (provider, kind, tag) triple) rather than
 * three sibling tables — fewer migrations, one repository, one event
 * composition, and the shape matches the flat tag arrays the
 * discovery doc already projects (TS-111
 * `ProviderDiscoveryDocument.languages` / `.cuisines` / `.dietary
 * Expertise`).
 *
 *   `language`           — ISO 639-1 language codes the provider can
 *                          converse in during a visit (e.g. `en`,
 *                          `es`, `zh-CN`). Surfaced as the discovery
 *                          doc's `languages[]`.
 *   `cuisine`            — cuisines the provider can prepare (e.g.
 *                          `italian`, `cantonese`, `jewish-deli`).
 *                          Surfaced as `cuisines[]`.
 *   `dietary_expertise`  — dietary expertise the provider holds
 *                          (e.g. `low-sodium`, `diabetic-friendly`,
 *                          `kosher`, `dysphagia`). Surfaced as
 *                          `dietaryExpertise[]`.
 *
 * The free-text `tag` column is normalised lowercase + hyphen on the
 * way in (`PROVIDER_PROFILE_TAG_REGEX`). The platform does NOT keep a
 * closed enumeration of tags — providers can supply any tag matching
 * the regex; the search index treats unfamiliar tags as long-tail.
 * A future tag-catalogue surface (TS-200-followup-2) can layer
 * suggestions on top without changing the wire shape.
 */
export const PROVIDER_PROFILE_TAG_KIND_LANGUAGE = 'language' as const;
export const PROVIDER_PROFILE_TAG_KIND_CUISINE = 'cuisine' as const;
export const PROVIDER_PROFILE_TAG_KIND_DIETARY_EXPERTISE = 'dietary_expertise' as const;

export const ProviderProfileTagKindSchema = z.enum([
  PROVIDER_PROFILE_TAG_KIND_LANGUAGE,
  PROVIDER_PROFILE_TAG_KIND_CUISINE,
  PROVIDER_PROFILE_TAG_KIND_DIETARY_EXPERTISE,
]);
export type ProviderProfileTagKind = z.infer<typeof ProviderProfileTagKindSchema>;

/**
 * Tag string discipline.
 *
 *   - `PROVIDER_PROFILE_TAG_MAX_LENGTH` (48) caps the column at a
 *     length that comfortably handles every ISO 639-1 BCP-47
 *     specifier (e.g. `zh-Hant-HK` at 10 chars) + the longest
 *     cuisine identifier we expect in practice. Captured as a
 *     constant so the editor UI shares the limit.
 *   - `PROVIDER_PROFILE_TAG_REGEX` enforces lowercase alphanumerics +
 *     hyphen + underscore. No spaces (URL/slug friendly), no upper
 *     case (case-insensitive search keeps the index size bounded),
 *     no punctuation (no shell-escape concerns; clean for log lines).
 *   - `PROVIDER_PROFILE_TAGS_MAX_PER_KIND` (32) bounds the per-kind
 *     array length. A provider claiming 32 cuisines is already
 *     exceptional; the cap keeps the search index shape predictable
 *     and the row count per provider bounded (max 96 rows across
 *     three kinds).
 */
export const PROVIDER_PROFILE_TAG_MAX_LENGTH = 48;
export const PROVIDER_PROFILE_TAG_REGEX = /^[a-z0-9][a-z0-9_-]*$/;
export const PROVIDER_PROFILE_TAGS_MAX_PER_KIND = 32;

const ProviderProfileTagSchema = z
  .string()
  .min(1)
  .max(PROVIDER_PROFILE_TAG_MAX_LENGTH)
  .regex(
    PROVIDER_PROFILE_TAG_REGEX,
    'tag must be lowercase alphanumeric with optional `-` / `_` separators',
  );

const ProviderProfileTagArraySchema = z
  .array(ProviderProfileTagSchema)
  .max(PROVIDER_PROFILE_TAGS_MAX_PER_KIND)
  // Reject duplicate entries inside a single kind — the server
  // de-dupes anyway via the UNIQUE (provider_id, kind, tag) index, but
  // rejecting at the boundary surfaces the UX bug at the form layer
  // rather than via a 409 round-trip.
  .superRefine((tags, ctx) => {
    const seen = new Set<string>();
    for (const tag of tags) {
      if (seen.has(tag)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `duplicate tag: ${tag}`,
        });
        return;
      }
      seen.add(tag);
    }
  });

// ─────────────────────────────────────────────────────────────────────
// Request shapes
// ─────────────────────────────────────────────────────────────────────

/**
 * Request body for `PUT /api/v1/providers/:providerId/profile`.
 *
 * Update semantics:
 *   - `bio` is a full-replace nullable scalar. A `null` clears the
 *     existing bio; a string overwrites it. Omitting the field is not
 *     supported — the request shape is `.strict()` and every field is
 *     required, so the editor always sends the full intended state.
 *     This keeps the contract close to PUT-shaped semantics (sender
 *     names the resource representation post-write) rather than
 *     PATCH-shaped (sender names the diff).
 *   - The three tag arrays are full-set replacements per kind. The
 *     server runs `DELETE WHERE provider_id = ? AND kind = ?` then
 *     bulk-inserts the new set inside one transaction; consumers see
 *     the resulting set atomically.
 *   - `dementiaSensitive` is a boolean flag the provider toggles on
 *     when they have dementia-sensitive dining training. Search +
 *     family-portal filter on this flag (TS-111 already exposes it
 *     via the `dementia_sensitive` query knob — TS-200 supplies the
 *     write-side surface that populates it).
 *
 * Notes deliberately NOT carried here:
 *   - `displayName`, `headline`, `timeZone`, `profilePhotoKey`,
 *     `videoIntroKey` are owned by sibling endpoints (TS-200-followup-3
 *     for basic-info edits; TS-201 for media uploads). The TS-200
 *     surface is the tag + bio + flag tab of the editor; basic info +
 *     media land in their own PRs so each diff stays reviewable.
 *   - `certifications` are owned by the TS-052 admin-side grant /
 *     revoke flow. A provider cannot self-grant credentials.
 *   - Tier + status are derived from certifications + ops review;
 *     never client-editable.
 */
export const UpdateProviderProfileRequestSchema = z
  .object({
    bio: z.string().max(PROVIDER_BIO_MAX_LENGTH).nullable(),
    languages: ProviderProfileTagArraySchema,
    cuisines: ProviderProfileTagArraySchema,
    dietaryExpertise: ProviderProfileTagArraySchema,
    dementiaSensitive: z.boolean(),
  })
  .strict();
export type UpdateProviderProfileRequest = z.infer<typeof UpdateProviderProfileRequestSchema>;

// ─────────────────────────────────────────────────────────────────────
// Response shapes
// ─────────────────────────────────────────────────────────────────────

/**
 * Richer provider record — the lean `ProviderRecord` shape plus the
 * tag arrays + `dementiaSensitive` flag the TS-200 editor populates.
 *
 * Used by:
 *   - `PUT  /api/v1/providers/:providerId/profile` response (TS-200).
 *   - `GET  /api/v1/providers/:providerId/profile` response
 *     (TS-200-followup-4 — bare record on hit, 404 on missing /
 *     soft-deleted). Different shape from the sibling
 *     `me/profile-snapshot` endpoint which wraps the same record in
 *     `{ profile: ProviderProfileRecord | null }` for the editor's
 *     "no application yet" branch.
 *   - `service-search` discovery-snapshot read companion (TS-111
 *     today projects from the source-of-truth `Provider` row +
 *     denormalises tags; once TS-200 lands the tag tables the
 *     snapshot will read from them instead).
 */
export const ProviderProfileRecordSchema = z
  .object({
    id: z.string().min(1).max(64),
    status: ProviderStatusSchema,
    tier: ProviderTierSchema,
    displayName: z.string().min(1).max(PROVIDER_DISPLAY_NAME_MAX_LENGTH),
    headline: z.string().max(PROVIDER_HEADLINE_MAX_LENGTH).nullable(),
    bio: z.string().max(PROVIDER_BIO_MAX_LENGTH).nullable(),
    profilePhotoKey: z.string().max(1024).nullable(),
    videoIntroKey: z.string().max(1024).nullable(),
    timeZone: z.string().min(1).max(PROVIDER_TIME_ZONE_MAX_LENGTH),
    dementiaSensitive: z.boolean(),
    languages: ProviderProfileTagArraySchema,
    cuisines: ProviderProfileTagArraySchema,
    dietaryExpertise: ProviderProfileTagArraySchema,
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .strict();
export type ProviderProfileRecord = z.infer<typeof ProviderProfileRecordSchema>;

/**
 * Response body for `PUT /api/v1/providers/:providerId/profile`.
 * Wrapped in `{ profile: ... }` so the shape is forward-compatible
 * with future side-payloads (e.g. a derived discovery snapshot for
 * client-side cache pre-warm) without a v1 break.
 */
export const UpdateProviderProfileResponseSchema = z
  .object({
    profile: ProviderProfileRecordSchema,
  })
  .strict();
export type UpdateProviderProfileResponse = z.infer<typeof UpdateProviderProfileResponseSchema>;
