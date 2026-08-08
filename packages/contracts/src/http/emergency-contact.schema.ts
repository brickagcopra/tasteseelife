import { z } from 'zod';

/**
 * Emergency-contact HTTP DTOs (PRD §6.1, PDD §8.2 `emergency_contacts`).
 *
 * Per-household roster of "who do we call when something's wrong" — the
 * adult son who handles medical decisions, the neighbour with a spare key,
 * the primary-care physician's office, the night-shift doorman. Stored
 * plain (no field-level encryption): the operational chef-match and
 * concierge flows read these directly, and the field-level cost of
 * encrypting a name + phone + relationship would force decrypt-on-read
 * for every visit-prep surface.
 *
 * Strict-mode everywhere — unknown fields are a 400, never a silent
 * round-trip (CLAUDE.md §3.3).
 *
 * Companion: `household-access.schema.ts` holds the encrypted
 * door-code / alarm-code blob; the two surfaces are siblings under
 * household onboarding but have very different storage profiles.
 */

/**
 * E.164 phone pattern — twin of the regex in `auth.schema.ts`. Permits
 * an optional leading `+` so clients can send either `+14155551212` or
 * `14155551212`; storage normalises to the leading-plus form.
 */
const E164_PATTERN = /^\+?[1-9]\d{7,14}$/;

/** Email max length — RFC 5321 cap (twin of auth.schema). */
const EMAIL_MAX_LENGTH = 254;

/** Display caps — sized for the family-dashboard contact card, not free essays. */
const NAME_MAX_LENGTH = 120;
const RELATIONSHIP_MAX_LENGTH = 60;
const NOTES_MAX_LENGTH = 500;

/**
 * Display-order priority within a household's emergency roster.
 *
 * 1 = "call first" (the adult-child decision-maker / spouse). The chef
 * or concierge always tries priorities in ascending order. Ties broken
 * by `createdAt` ascending so a stable order survives re-renders.
 *
 * 1–10 is plenty for a realistic emergency roster — most households
 * have 2–3 contacts; the cap defeats abusive payloads without
 * constraining legitimate use.
 */
const PRIORITY_MIN = 1;
const PRIORITY_MAX = 10;

/**
 * Service-layer cap on emergency contacts per household. Enforced in
 * `EmergencyContactsService.create` (not at the DB layer) so the error
 * surfaces as a clean 422 rather than a generic constraint violation.
 * Per-household, not per-senior — the contact roster belongs to the
 * household (PRD §6.1 phrasing).
 */
export const EMERGENCY_CONTACTS_MAX_PER_HOUSEHOLD = 10;

/**
 * A single emergency contact as returned to the client. The `id` is a
 * server-issued CUID; `householdId` is echoed so a single contact card
 * carries its own context when fanned out across multiple households.
 *
 * `updatedAt` lets the dashboard render "edited 2 minutes ago" hints;
 * `createdAt` is the tie-breaker for priority ordering. Both are
 * ISO-8601 UTC strings on the wire — the service casts the Prisma
 * `Date` via `.toISOString()` at the mapper layer.
 */
export const EmergencyContactSchema = z
  .object({
    id: z.string().min(1).max(64),
    householdId: z.string().min(1).max(64),
    name: z
      .string()
      .min(1, 'name is required')
      .max(NAME_MAX_LENGTH, `name must be at most ${NAME_MAX_LENGTH} characters`),
    relationship: z
      .string()
      .min(1, 'relationship is required')
      .max(
        RELATIONSHIP_MAX_LENGTH,
        `relationship must be at most ${RELATIONSHIP_MAX_LENGTH} characters`,
      ),
    phone: z.string().regex(E164_PATTERN, 'phone must be in E.164 format (e.g. +14155551212)'),
    email: z
      .string()
      .max(EMAIL_MAX_LENGTH, `email must be at most ${EMAIL_MAX_LENGTH} characters`)
      .email('email must be a valid address')
      .nullable(),
    priority: z
      .number()
      .int('priority must be an integer')
      .min(PRIORITY_MIN, `priority must be at least ${PRIORITY_MIN}`)
      .max(PRIORITY_MAX, `priority must be at most ${PRIORITY_MAX}`),
    notes: z
      .string()
      .max(NOTES_MAX_LENGTH, `notes must be at most ${NOTES_MAX_LENGTH} characters`)
      .nullable(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .strict();
export type EmergencyContact = z.infer<typeof EmergencyContactSchema>;

/**
 * Create request — every field the client controls, none of the
 * server-issued ones. `email` and `notes` are nullable rather than
 * optional so the client can explicitly send `null` to mean "no
 * email"; absence is also accepted (treated as null). `priority` is
 * required — no implicit "append to the end" because the family
 * dashboard's reorder UX needs deterministic positions.
 */
export const CreateEmergencyContactRequestSchema = z
  .object({
    name: z
      .string()
      .min(1, 'name is required')
      .max(NAME_MAX_LENGTH, `name must be at most ${NAME_MAX_LENGTH} characters`),
    relationship: z
      .string()
      .min(1, 'relationship is required')
      .max(
        RELATIONSHIP_MAX_LENGTH,
        `relationship must be at most ${RELATIONSHIP_MAX_LENGTH} characters`,
      ),
    phone: z.string().regex(E164_PATTERN, 'phone must be in E.164 format (e.g. +14155551212)'),
    email: z
      .string()
      .max(EMAIL_MAX_LENGTH, `email must be at most ${EMAIL_MAX_LENGTH} characters`)
      .email('email must be a valid address')
      .nullable()
      .optional(),
    priority: z
      .number()
      .int('priority must be an integer')
      .min(PRIORITY_MIN, `priority must be at least ${PRIORITY_MIN}`)
      .max(PRIORITY_MAX, `priority must be at most ${PRIORITY_MAX}`),
    notes: z
      .string()
      .max(NOTES_MAX_LENGTH, `notes must be at most ${NOTES_MAX_LENGTH} characters`)
      .nullable()
      .optional(),
  })
  .strict();
export type CreateEmergencyContactRequest = z.infer<typeof CreateEmergencyContactRequestSchema>;

/**
 * Update request — every editable field, all optional so a client can
 * patch a single attribute. `null` on `email`/`notes` clears the field;
 * absence leaves it untouched. The empty-body case (no fields set) is
 * rejected by the service layer so a misconfigured client doesn't
 * silently succeed without writing anything.
 */
export const UpdateEmergencyContactRequestSchema = z
  .object({
    name: z
      .string()
      .min(1, 'name is required')
      .max(NAME_MAX_LENGTH, `name must be at most ${NAME_MAX_LENGTH} characters`)
      .optional(),
    relationship: z
      .string()
      .min(1, 'relationship is required')
      .max(
        RELATIONSHIP_MAX_LENGTH,
        `relationship must be at most ${RELATIONSHIP_MAX_LENGTH} characters`,
      )
      .optional(),
    phone: z
      .string()
      .regex(E164_PATTERN, 'phone must be in E.164 format (e.g. +14155551212)')
      .optional(),
    email: z
      .string()
      .max(EMAIL_MAX_LENGTH, `email must be at most ${EMAIL_MAX_LENGTH} characters`)
      .email('email must be a valid address')
      .nullable()
      .optional(),
    priority: z
      .number()
      .int('priority must be an integer')
      .min(PRIORITY_MIN, `priority must be at least ${PRIORITY_MIN}`)
      .max(PRIORITY_MAX, `priority must be at most ${PRIORITY_MAX}`)
      .optional(),
    notes: z
      .string()
      .max(NOTES_MAX_LENGTH, `notes must be at most ${NOTES_MAX_LENGTH} characters`)
      .nullable()
      .optional(),
  })
  .strict();
export type UpdateEmergencyContactRequest = z.infer<typeof UpdateEmergencyContactRequestSchema>;

/**
 * List response — wraps the array in an object so future additions
 * (pagination cursors, aggregate counts) are non-breaking schema
 * extensions. Order is server-controlled: ascending `priority`, then
 * ascending `createdAt`.
 */
export const EmergencyContactsListResponseSchema = z
  .object({
    contacts: z.array(EmergencyContactSchema),
  })
  .strict();
export type EmergencyContactsListResponse = z.infer<typeof EmergencyContactsListResponseSchema>;

export const EMERGENCY_CONTACT_NAME_MAX_LENGTH = NAME_MAX_LENGTH;
export const EMERGENCY_CONTACT_RELATIONSHIP_MAX_LENGTH = RELATIONSHIP_MAX_LENGTH;
export const EMERGENCY_CONTACT_NOTES_MAX_LENGTH = NOTES_MAX_LENGTH;
export const EMERGENCY_CONTACT_PRIORITY_MIN = PRIORITY_MIN;
export const EMERGENCY_CONTACT_PRIORITY_MAX = PRIORITY_MAX;
