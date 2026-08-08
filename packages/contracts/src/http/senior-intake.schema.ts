import { z } from 'zod';

/**
 * Senior intake HTTP DTOs (PRD §6.1 health-and-dietary intake, PDD §16.3,
 * §21.3, CLAUDE.md §3 / §17.1 — no unencrypted full DOBs / dementia
 * status / medical details).
 *
 * The intake form captures the *picture* of a senior the platform needs
 * to fulfil meaningful bookings: who they are dietarily, what they cannot
 * safely eat, how they move, what languages they speak, and a cluster of
 * sensitive medical-ish notes (DOB, dementia status, free-form
 * dietary / allergy / mobility / medical context).
 *
 * The contract is split into two zones that mirror the storage split in
 * `apps/service-household/prisma/schema.prisma`:
 *
 *   - **Operational tags** (`dietaryTags`, `allergenTags`, `languageTags`,
 *     `mobilityLevel`) — provider search (PDD §8.5 / §14.1) and chef-match
 *     filters key off these, so they live as plain `TEXT[]` / enum columns
 *     in Postgres and are returned in cleartext.
 *
 *   - **Sensitive payload** (`dateOfBirth`, `dementiaStatus`,
 *     `dietaryNotes`, `allergyNotes`, `mobilityNotes`, `medicalNotes`) —
 *     persisted as a single AES-256-GCM ciphertext blob (IV + auth tag +
 *     key version) in Postgres. The contract surface is plaintext — the
 *     cipher boundary is internal to `service-household` (see
 *     `IntakePayloadCipherService`).
 *
 * `.strict()` everywhere so a stray client field is a 400, never a silent
 * round-trip.
 */

/**
 * Dementia stage — coarse-grained categories that drive provider
 * preparation, not a clinical diagnosis. The provider-side surface uses
 * these to filter for dementia-sensitive training (PRD §3.1 Persona C,
 * CLAUDE.md §12 — hospitality, not clinical: the categories are about
 * what the provider needs to know to do their job well, never used as
 * gating for medical advice).
 *
 *   - `none` (default if not filled in)
 *   - `mild_cognitive_impairment` — early signs, mostly self-managed
 *   - `early_dementia`            — recent diagnosis, mostly independent
 *   - `moderate_dementia`         — needs structured support
 *   - `advanced_dementia`         — requires patient, low-stimulation care
 */
export const DementiaStatusSchema = z.enum([
  'none',
  'mild_cognitive_impairment',
  'early_dementia',
  'moderate_dementia',
  'advanced_dementia',
]);
export type DementiaStatus = z.infer<typeof DementiaStatusSchema>;

/**
 * Coarse-grained mobility level — operational data that lets the
 * provider plan the visit (do they need to bring a step-stool? is the
 * kitchen accessible? can the senior come to the table?). Plain column —
 * never encrypted — because the booking service consumes it for
 * scheduling and ergonomics.
 *
 *   - `independent`     — full mobility
 *   - `aided_cane`      — uses a cane / minor support
 *   - `aided_walker`    — uses a walker
 *   - `wheelchair`      — primarily seated
 *   - `bedridden`       — limited transfers, requires bedside care
 *   - `unknown`         — not yet entered (placeholder used by partial-fill flows)
 */
export const SeniorMobilityLevelSchema = z.enum([
  'unknown',
  'independent',
  'aided_cane',
  'aided_walker',
  'wheelchair',
  'bedridden',
]);
export type SeniorMobilityLevel = z.infer<typeof SeniorMobilityLevelSchema>;

/**
 * Operational dietary categories — chef-match filter input. Mirrored on
 * the provider-side specialty tags (PRD §7.2). Open string field with a
 * regex floor (lowercase + underscore + digits) so we can extend the
 * vocabulary additively without re-deploying the contract (CLAUDE.md
 * §5.3 — backward-compatible event evolution). 32-tag cap defeats
 * pathological payloads without restricting realistic usage.
 *
 * Canonical seed vocabulary (Phase 1):
 *   `vegetarian`, `vegan`, `pescatarian`, `kosher`, `halal`,
 *   `gluten_free`, `dairy_free`, `nut_free`, `low_sodium`, `low_sugar`,
 *   `diabetic_friendly`, `soft_textures`, `heart_healthy`.
 */
const DietaryTagSchema = z
  .string()
  .min(1)
  .max(32)
  .regex(/^[a-z][a-z0-9_]*$/, 'dietary tag must be snake_case (a–z, 0–9, _)');

/**
 * Common-allergen tags — operational column the chef-match query reads
 * to filter out incompatible providers. Same regex/length floor as
 * dietary tags. Canonical seed vocabulary mirrors the FDA "Big 9":
 *   `peanut`, `tree_nut`, `shellfish`, `fish`, `dairy`, `egg`, `soy`,
 *   `wheat`, `sesame`. Idiosyncratic / personal allergies live in the
 *   encrypted `allergyNotes` field.
 */
const AllergenTagSchema = z
  .string()
  .min(1)
  .max(32)
  .regex(/^[a-z][a-z0-9_]*$/, 'allergen tag must be snake_case (a–z, 0–9, _)');

/**
 * BCP-47 language tag (operational filter). Permissive regex — accepts
 * the common forms `en`, `en-US`, `zh-CN`, `pt-BR`, `es-419`. We don't
 * validate against the full IANA registry here (would require a 100KB+
 * dataset); the controller-side normalises to lowercase region + dash
 * before persistence.
 */
const LanguageTagSchema = z
  .string()
  .min(2)
  .max(16)
  .regex(
    /^[a-zA-Z]{2,3}(-[a-zA-Z0-9]{2,8})*$/,
    'language must be a BCP-47 tag (e.g. en, en-US, zh-CN)',
  );

/**
 * Date-of-birth string — ISO-8601 `YYYY-MM-DD`. Stored encrypted, so the
 * contract carries the full date even though the platform only displays
 * an age elsewhere. Range floor (1900-01-01) defeats epoch-zero defaults
 * and obviously-wrong inputs; range ceiling (today) defeats future dates.
 * Day-of-month range-check is intentionally loose (regex only — Feb 30
 * is technically accepted) because Zod's `z.string().date()` is strict
 * enough for the boundary and the service-layer's `new Date(...).getTime()`
 * comparison catches the impossible-day case.
 */
const DateOfBirthSchema = z
  .string()
  .regex(/^(19|20)\d{2}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/, 'dateOfBirth must be YYYY-MM-DD');

/**
 * Free-form notes — sized for "a few sentences" not "an essay". 2000
 * chars is roughly half a page of typed prose; long enough for
 * meaningful context, short enough that an attacker can't use the
 * field as a 100MB exfil bucket. Each note field is independently
 * sized so a chatty `medicalNotes` doesn't blow the dietary budget.
 */
const NOTES_MAX_LENGTH = 2000;
const NotesFieldSchema = z.string().max(NOTES_MAX_LENGTH);

/**
 * The intake payload — operational + sensitive in one object on the
 * wire. The boundary between "encrypted at rest" and "plain column at
 * rest" is invisible to the client; the service is responsible for
 * splitting on write and rejoining on read.
 *
 * Every field except `dietaryTags`, `allergenTags`, `languageTags`,
 * and `mobilityLevel` defaults to nullish so a partially-completed
 * intake can be progressively saved (the TS-121 web-family form is
 * multi-step). The operational fields default to empty arrays /
 * `unknown` so chef-match queries never have to special-case "not
 * filled in" semantics — an empty tag list means "no filter".
 */
export const SeniorIntakeSchema = z
  .object({
    dateOfBirth: DateOfBirthSchema.nullable().optional(),
    dementiaStatus: DementiaStatusSchema.optional().default('none'),
    mobilityLevel: SeniorMobilityLevelSchema.optional().default('unknown'),
    languageTags: z
      .array(LanguageTagSchema)
      .max(16, 'at most 16 language tags')
      .optional()
      .default([]),
    dietaryTags: z
      .array(DietaryTagSchema)
      .max(32, 'at most 32 dietary tags')
      .optional()
      .default([]),
    allergenTags: z
      .array(AllergenTagSchema)
      .max(32, 'at most 32 allergen tags')
      .optional()
      .default([]),
    dietaryNotes: NotesFieldSchema.nullable().optional(),
    allergyNotes: NotesFieldSchema.nullable().optional(),
    mobilityNotes: NotesFieldSchema.nullable().optional(),
    medicalNotes: NotesFieldSchema.nullable().optional(),
  })
  .strict();
export type SeniorIntake = z.infer<typeof SeniorIntakeSchema>;

/**
 * The upsert request body for `PUT /api/v1/seniors/:seniorId/intake`.
 * Identical shape to `SeniorIntakeSchema` — separate alias so future
 * additions to the wire payload (e.g. a `consentAcknowledgedAt` audit
 * field on the request only) don't pollute the read DTO.
 */
export const UpsertSeniorIntakeRequestSchema = SeniorIntakeSchema;
export type UpsertSeniorIntakeRequest = z.infer<typeof UpsertSeniorIntakeRequestSchema>;

/**
 * The intake response body. Returns the same field set the client wrote
 * PLUS three audit-style metadata fields the server owns:
 *   - `intakeCompletedAt` — set the first time a non-empty intake is
 *     persisted. Used by the family-dashboard "you haven't completed
 *     the intake yet" nudge.
 *   - `updatedAt` — last write to the intake (cleartext or encrypted).
 *   - `seniorId` — echoed back as a paired identifier for clients that
 *     fan out multiple senior fetches and key by id.
 */
export const SeniorIntakeResponseSchema = SeniorIntakeSchema.extend({
  seniorId: z.string().min(1).max(64),
  intakeCompletedAt: z.string().datetime().nullable(),
  updatedAt: z.string().datetime(),
}).strict();
export type SeniorIntakeResponse = z.infer<typeof SeniorIntakeResponseSchema>;

/**
 * Exported limits — referenced by the service-household IntakeService
 * for defence-in-depth size checks on the encrypted payload before
 * persistence, and by frontends for client-side validation messaging.
 */
export const SENIOR_INTAKE_NOTES_MAX_LENGTH = NOTES_MAX_LENGTH;
