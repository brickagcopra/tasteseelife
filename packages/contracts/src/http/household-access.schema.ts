import { z } from 'zod';

/**
 * Household-access-instructions HTTP DTOs (PRD §6.1 — "Emergency contact
 * and household access instructions"; PDD §16.3, §21.3; CLAUDE.md §3,
 * §17.1).
 *
 * Everything in this contract is sensitive: door codes, lockbox
 * locations, alarm codes, alarm-disarm sequences. A leak gives a
 * physical-entry attacker the keys to a senior's home — strictly
 * higher impact than the medical-ish payload behind senior intake.
 *
 * Storage. Persisted as a single AES-256-GCM ciphertext blob on
 * `household.households` (see `apps/service-household/prisma/schema.prisma`).
 * Mirrors the same envelope-encryption pattern as senior intake but
 * with an independent key (`HOUSEHOLD_ACCESS_ENC_KEY`) so the door-code
 * blast radius is decoupled from the medical-notes blast radius. The
 * cipher boundary lives entirely inside `AccessInstructionsCipherService`.
 *
 * Wire shape. Plaintext over TLS — the contract surfaces decrypted
 * fields. Field-level `null` means "the family has not entered this
 * fact"; an entirely-empty object writes NULL across the four ciphertext
 * columns and clears `access_instructions_updated_at`.
 *
 * `.strict()` everywhere — unknown fields are a 400.
 */

/**
 * Per-field cap — sized for "a paragraph" not "an essay". 2000 chars
 * is roughly half a page; long enough for "Lockbox to the left of the
 * front door, code 4242. There's also a hidden key under the third
 * planter on the left side of the porch — only for true emergencies"
 * with room to spare. Each field is independently sized so a chatty
 * `generalNotes` doesn't blow other budgets.
 *
 * Mirrors `SENIOR_INTAKE_NOTES_MAX_LENGTH`.
 */
const FIELD_MAX_LENGTH = 2000;
const FieldSchema = z.string().max(FIELD_MAX_LENGTH);

/**
 * The full payload — every field optional and independently nullable.
 *
 * Field meanings (operational guidance for providers and concierge):
 *
 *   - `doorCode`               PIN for an electronic lock on the front
 *                              door. Phase-1 deliberately stores this
 *                              cleartext-on-wire-to-the-client; the
 *                              encrypted-at-rest layer is the protection.
 *   - `keyLocation`            Where to find a physical key when no
 *                              electronic lock exists ("lockbox combo
 *                              4242 to left of door").
 *   - `alarmCode`              Disarm code for a home security system.
 *   - `alarmDisarmInstructions`  Sequence to disarm (some systems need
 *                              specific button presses or panel codes
 *                              that are easy to get wrong).
 *   - `parkingInstructions`    Where the provider parks; building
 *                              permits, guest spots, restrictions.
 *   - `doormanInfo`            Doorman name(s), shift times, what to
 *                              say to identify oneself as a Taste &
 *                              See provider.
 *   - `petInfo`                Pets in the home — names, temperaments,
 *                              "do not let outside" warnings. Important
 *                              for provider safety + senior-pet welfare.
 *   - `generalNotes`           Catch-all for anything else the family
 *                              wants the provider to know on arrival.
 */
export const HouseholdAccessInstructionsSchema = z
  .object({
    doorCode: FieldSchema.nullable().optional(),
    keyLocation: FieldSchema.nullable().optional(),
    alarmCode: FieldSchema.nullable().optional(),
    alarmDisarmInstructions: FieldSchema.nullable().optional(),
    parkingInstructions: FieldSchema.nullable().optional(),
    doormanInfo: FieldSchema.nullable().optional(),
    petInfo: FieldSchema.nullable().optional(),
    generalNotes: FieldSchema.nullable().optional(),
  })
  .strict();
export type HouseholdAccessInstructions = z.infer<typeof HouseholdAccessInstructionsSchema>;

/**
 * Upsert request — identical to the read shape today. Separate alias
 * so future request-only fields (e.g. `consentAcknowledgedAt`) don't
 * pollute the response.
 */
export const UpsertHouseholdAccessInstructionsRequestSchema = HouseholdAccessInstructionsSchema;
export type UpsertHouseholdAccessInstructionsRequest = z.infer<
  typeof UpsertHouseholdAccessInstructionsRequestSchema
>;

/**
 * Response body — the eight access fields plus three audit-style
 * metadata fields the server owns:
 *
 *   - `householdId`            echoed so multi-household clients can
 *                              fan out reads and key by id.
 *   - `accessInstructionsUpdatedAt`  the timestamp of the last write
 *                              that produced a non-empty payload.
 *                              `null` while the family has never
 *                              filled the form in.
 *   - `updatedAt`              the row's `updatedAt` (any change to
 *                              the household record — useful for
 *                              optimistic-concurrency clients).
 */
export const HouseholdAccessInstructionsResponseSchema = HouseholdAccessInstructionsSchema.extend({
  householdId: z.string().min(1).max(64),
  accessInstructionsUpdatedAt: z.string().datetime().nullable(),
  updatedAt: z.string().datetime(),
}).strict();
export type HouseholdAccessInstructionsResponse = z.infer<
  typeof HouseholdAccessInstructionsResponseSchema
>;

export const HOUSEHOLD_ACCESS_FIELD_MAX_LENGTH = FIELD_MAX_LENGTH;
