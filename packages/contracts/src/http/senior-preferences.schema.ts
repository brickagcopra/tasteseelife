import { z } from 'zod';

/**
 * Senior memory profile HTTP DTOs (PRD §6.5 — "Senior memory profile
 * (favorite childhood foods, regional traditions, family recipes)";
 * PDD §8.2 `senior_preferences`).
 *
 * Flat key/value cues that describe the senior as a person rather than
 * as a clinical case — favourite-childhood-food, regional-tradition,
 * comfort-food, Sunday-ritual. The store is intentionally schemaless:
 * the platform learns over time which keys matter, and a fixed-column
 * model would either over-fit Phase 1 or rot as Phase 2 / 3 expand
 * the question set.
 *
 * Storage: plain-column `(senior_id, key, value)` rows with a
 * composite PK. Same defence-in-depth posture as `MemoryRecipe` and
 * `EmergencyContact` — the family dashboard, visit-prep card, and
 * (eventually) chef-match query read these at speed; field-level
 * encryption would defeat the surface. Story-level PII protections
 * come from encryption-at-rest, audit, and row-level auth.
 *
 * `.strict()` everywhere — unknown fields are a 400.
 */

/**
 * Field caps. Same shape as the dietary/allergen tag floor on the
 * senior intake (TS-031) — snake_case key with a regex floor so the
 * vocabulary can grow additively without contract redeploys.
 *
 *   - key:    operational identifier; capped at 64 chars.
 *   - value:  free-form prose; capped at 1000 chars (about a paragraph)
 *             so the field can't be used as an exfil bucket.
 *
 * Per-senior cap (64 entries) lives at the service layer — exported
 * here so frontends mirror it.
 */
const KEY_MAX_LENGTH = 64;
const VALUE_MAX_LENGTH = 1000;

/** Service-layer cap on preference entries per senior. */
export const SENIOR_PREFERENCES_MAX_PER_SENIOR = 64;

/**
 * Snake_case preference key. Lowercase + underscore + digits; must
 * start with a letter so a numeric prefix can't sneak in. The
 * vocabulary is open — the platform documents canonical keys
 * (`favorite_childhood_dish`, `regional_tradition`, `comfort_food`,
 * `sunday_ritual`, `cultural_holiday`, …) but the contract accepts
 * any conforming snake_case identifier so the family dashboard can
 * introduce new prompts without a backend deploy.
 */
const PreferenceKeySchema = z
  .string()
  .min(1, 'preference key is required')
  .max(KEY_MAX_LENGTH, `preference key must be at most ${KEY_MAX_LENGTH} characters`)
  .regex(/^[a-z][a-z0-9_]*$/, 'preference key must be snake_case (a–z, 0–9, _)');

/**
 * Single preference entry as returned to the client. Audit timestamps
 * pair with each row so the dashboard can render "captured 2 weeks ago"
 * cues without a separate fetch.
 */
export const SeniorPreferenceEntrySchema = z
  .object({
    key: PreferenceKeySchema,
    value: z
      .string()
      .min(1, 'preference value is required')
      .max(VALUE_MAX_LENGTH, `preference value must be at most ${VALUE_MAX_LENGTH} characters`),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .strict();
export type SeniorPreferenceEntry = z.infer<typeof SeniorPreferenceEntrySchema>;

/**
 * List response. Wraps the array in an object so future additions
 * (aggregate counts, schema-version cues) are non-breaking schema
 * extensions. Order is server-controlled: ascending `key` so the
 * dashboard renders entries in a stable, scannable order regardless
 * of when they were entered.
 */
export const SeniorPreferencesResponseSchema = z
  .object({
    seniorId: z.string().min(1).max(64),
    preferences: z.array(SeniorPreferenceEntrySchema),
  })
  .strict();
export type SeniorPreferencesResponse = z.infer<typeof SeniorPreferencesResponseSchema>;

/**
 * Bulk-upsert PATCH request. Each entry is `{key, value}` where
 *
 *   - `value: string` upserts the row (insert if missing, update if
 *     present).
 *   - `value: null`   deletes the row (idempotent on already-missing
 *     keys).
 *
 * Merge semantics: keys NOT present in the entries array are
 * untouched. The contract permits an empty `entries: []` array (the
 * service layer rejects it as a no-op so a misconfigured client
 * doesn't silently succeed without writing anything). At-most-one
 * entry per key per request — the service layer rejects duplicates
 * with 400 to avoid ambiguity ("which value wins?").
 *
 * Per-request entry cap (64) bounds payload size and matches the
 * per-senior total cap.
 */
const ENTRIES_MAX_PER_REQUEST = 64;

export const BulkUpsertSeniorPreferenceEntrySchema = z
  .object({
    key: PreferenceKeySchema,
    value: z
      .string()
      .min(1, 'preference value is required')
      .max(VALUE_MAX_LENGTH, `preference value must be at most ${VALUE_MAX_LENGTH} characters`)
      .nullable(),
  })
  .strict();
export type BulkUpsertSeniorPreferenceEntry = z.infer<typeof BulkUpsertSeniorPreferenceEntrySchema>;

export const BulkUpsertSeniorPreferencesRequestSchema = z
  .object({
    entries: z
      .array(BulkUpsertSeniorPreferenceEntrySchema)
      .max(ENTRIES_MAX_PER_REQUEST, `at most ${ENTRIES_MAX_PER_REQUEST} entries per request`),
  })
  .strict();
export type BulkUpsertSeniorPreferencesRequest = z.infer<
  typeof BulkUpsertSeniorPreferencesRequestSchema
>;

export const SENIOR_PREFERENCE_KEY_MAX_LENGTH = KEY_MAX_LENGTH;
export const SENIOR_PREFERENCE_VALUE_MAX_LENGTH = VALUE_MAX_LENGTH;
export const SENIOR_PREFERENCES_ENTRIES_MAX_PER_REQUEST = ENTRIES_MAX_PER_REQUEST;
